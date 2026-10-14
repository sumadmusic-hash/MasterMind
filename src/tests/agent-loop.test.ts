import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, ChatSession } from '../types';

// Mock the provider so we can script multi-step model responses and inspect
// the EXACT message list the agent loop sends on every provider call.
vi.mock('../services/provider', () => ({
  callProvider: vi.fn(),
}));
// Database (IndexedDB) is not available in jsdom — stub persistence.
vi.mock('../services/database', () => ({
  saveChatSession: vi.fn().mockResolvedValue(undefined),
  addLog: vi.fn().mockResolvedValue(undefined),
}));
// The registry must NOT hit the network inside unit tests: swap every tool
// implementation for a deterministic echo while keeping the REAL validation,
// coercion and timeout logic of ToolRegistry.execute() intact.
vi.mock('../services/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tools')>();
  for (const def of actual.toolRegistry.getAllTools()) {
    actual.toolRegistry.register(def, async (args: Record<string, any>) => ({
      expression: args.expression,
      result: evalSafe(args.expression),
      query: args.query,
      url: args.url,
    }));
  }
  return actual;
});

/** Tiny safe evaluator for the mocked calculator (`"2+2"` → 4). */
function evalSafe(expression: unknown): number | undefined {
  if (typeof expression !== 'string' || !/^[\d+\-*/().\s]+$/.test(expression)) return undefined;
  try {
    return Function(`"use strict"; return (${expression});`)();
  } catch {
    return undefined;
  }
}

import { callProvider } from '../services/provider';
import {
  ChatOrchestrator,
  COMPACT_RESULT_MAX_STRING,
  COMPACT_RESULT_MAX_ARRAY,
  DEDUP_CACHED_NOTE,
} from '../services/chat';
import { toolRegistry, compactToolData } from '../services/tools';

const mockedCall = vi.mocked(callProvider);

const settings: AppSettings = {
  primaryModel: { provider: 'groq', modelId: 'test-model' },
  maxToolSteps: 10,
} as unknown as AppSettings;

function makeSession(query = 'Wieviel Mitarbeiter hat Lidl?'): ChatSession {
  return {
    id: 's1',
    title: 'test',
    messages: [
      { id: 'm1', role: 'user', content: query, timestamp: Date.now() },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as ChatSession;
}

const sseCall = (id: string, name: string, args: Record<string, any>) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** Script N sequential provider responses (one per agent step). */
function scriptSteps(steps: Array<{ content?: string; toolCalls?: any[] }>) {
  let i = 0;
  mockedCall.mockImplementation(async (_s, _m, _t, cb: any) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    for (const tc of step.toolCalls ?? []) cb?.onToolCall?.(tc);
    if (step.content) cb?.onToken?.(step.content);
    cb?.onComplete?.(step.content ?? '', { totalTokens: 10 });
    return {
      content: step.content ?? '',
      usage: {
        totalTokens: 10, provider: 'groq', model: 'test-model',
        promptTokens: 5, completionTokens: 5, cachedInputTokens: 0,
      } as any,
      model: 'test-model', provider: 'groq',
    };
  });
}

/** The `messages` array passed to callProvider on step n (0-based). */
const promptAt = (n: number) => mockedCall.mock.calls[n][1] as any[];

const runLoop = (session: ChatSession = makeSession(), callbacks: Record<string, any> = {}) =>
  new ChatOrchestrator().sendMessage(settings, session, undefined, {
    onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
    onComplete: () => {}, onError: () => {}, onStatus: () => {},
    ...callbacks,
  });

beforeEach(() => {
  mockedCall.mockReset();
});

describe('agent loop tool-call deduplication (token optimization)', () => {
  it('executes an identical repeat call only once and replays the CACHED RESULT to the model', async () => {
    const same = sseCall('c1', 'calculator', { expression: '2+2' });
    scriptSteps([
      { toolCalls: [same] },                                   // step 1: execute
      { toolCalls: [{ ...same, id: 'c2' }] },                  // step 2: identical again
      { content: 'Fertig.' },                                  // step 3: final answer
    ]);

    await runLoop();

    // Step 2's prompt must contain the real calculator result…
    const step2 = promptAt(1);
    const firstResult = step2.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(JSON.parse(firstResult.content).result).toBe(4);

    // …and step 3 must receive the cached replay for the duplicate call c2,
    // NOT just a bare "returned earlier" hint (which models ignore and retry).
    const step3 = promptAt(2);
    const dupReply = step3.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(dupReply).toBeDefined();
    const parsed = JSON.parse(dupReply.content);
    expect(parsed.result).toBe(4);
    expect(parsed.note).toContain('cached result');
    expect(parsed.skipped).toBeUndefined();
  });

  it('keeps the tool protocol valid when duplicates appear WITHIN one parallel batch', async () => {
    const a = sseCall('a1', 'calculator', { expression: '1+1' });
    const b = sseCall('b1', 'calculator', { expression: '1+1' }); // identical, same step
    scriptSteps([
      { toolCalls: [a, b] },
      { content: 'Antwort.' },
    ]);

    await runLoop();

    const step2 = promptAt(1);
    // Every tool_call in the assistant message needs exactly one tool reply…
    const calls = step2.find((m: any) => m.role === 'assistant')!.tool_calls.map((c: any) => c.id);
    const replies = step2.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(calls.sort()).toEqual(replies.sort());
    // …the second identical call was skipped but still got the cached value.
    const dup = step2.find((m: any) => m.role === 'tool' && m.tool_call_id === 'b1');
    expect(JSON.parse(dup.content).result).toBe(2);
    // Only ONE execution happened: exactly one non-skip tool result exists.
    const executed = step2.filter((m: any) => m.role === 'tool' && !JSON.parse(m.content).note);
    expect(executed).toHaveLength(1);
  });

  it('answers budget-skipped calls via the protocol so no tool_call is left unmatched', async () => {
    // 5 calls in one step while maxToolCallsPerTurn is 4 → last one skipped.
    const calls = [1, 2, 3, 4, 5].map(n => sseCall(`x${n}`, 'calculator', { expression: `${n}+0` }));
    scriptSteps([{ toolCalls: calls }, { content: 'OK.' }]);

    await runLoop();

    const step2 = promptAt(1);
    const assistant = step2.find((m: any) => m.role === 'assistant');
    const ids = assistant.tool_calls.map((c: any) => c.id);
    const replied = step2.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(ids.every((id: string) => replied.includes(id))).toBe(true);
    const skipped = step2.find((m: any) => m.role === 'tool' && m.tool_call_id === 'x5');
    expect(JSON.parse(skipped.content).skipped).toContain('Budget');
  });

  it('stops the loop with a synthesis answer once the tool budget is exhausted (no wasted round-trips)', async () => {
    // Regression: after the per-turn tool budget was spent, the loop kept
    // iterating until maxToolSteps — every extra provider call re-billed the
    // whole history for answers that were then discarded by the max-steps
    // fallback. Now exactly ONE final synthesis call (with tools disabled)
    // must run and its text becomes the persisted final answer.
    const calls = [1, 2, 3, 4].map(n => sseCall(`b${n}`, 'calculator', { expression: `${n}+0` }));
    scriptSteps([
      { content: 'Ich rechne.', toolCalls: calls },   // step 1: budget fully used
      { content: 'Finale Antwort aus gesammeltem Material.' }, // synthesis call
    ]);

    const completed: any[] = [];
    await runLoop(makeSession(), { onComplete: (m: any) => completed.push(m) });

    // Exactly two provider calls: the tool step + ONE synthesis call — not 10.
    expect(mockedCall).toHaveBeenCalledTimes(2);
    // The synthesis call must NOT offer tools (forcing a text answer).
    expect(mockedCall.mock.calls[1][2]).toBeUndefined();
    // The synthesis prompt carries the budget nudge from the loop.
    const synthPrompt = promptAt(1);
    expect(synthPrompt.some((m: any) => m.role === 'user' && m.content.includes('Tool-Budget erschöpft'))).toBe(true);
    // Final message contains BOTH the planning step text and the synthesis answer.
    expect(completed).toHaveLength(1);
    expect(completed[0].content).toContain('Ich rechne.');
    expect(completed[0].content).toContain('Finale Antwort aus gesammeltem Material.');
  });

  it('replays the cached payload verbatim (single stringify, note appended)', async () => {
    // The dedup replay must send EXACTLY the compacted payload the producer's
    // executed result produced, plus the cache note — no second compaction
    // pass over the same data, and never corrupted/truncated JSON.
    const args = { expression: '3+3' };
    scriptSteps([
      { toolCalls: [sseCall('p1', 'calculator', args)] },
      { toolCalls: [sseCall('p2', 'calculator', args)] },
      { content: 'Fertig.' },
    ]);

    await runLoop();

    const expectedPayload = JSON.stringify(
      compactToolData({ expression: '3+3', result: 6 }, COMPACT_RESULT_MAX_STRING, COMPACT_RESULT_MAX_ARRAY)
    );
    const step3 = promptAt(2);
    const replay = step3.find((m: any) => m.role === 'tool' && m.tool_call_id === 'p2');
    expect(replay.content).toBe(
      `${expectedPayload.slice(0, -1)},"note":"${DEDUP_CACHED_NOTE}"}`
    );
    expect(() => JSON.parse(replay.content)).not.toThrow();
  });

  it('does not announce budget-skipped calls as started (onToolCall fires only for executions)', async () => {
    const calls = [1, 2, 3, 4, 5].map(n => sseCall(`y${n}`, 'calculator', { expression: `${n}+0` }));
    scriptSteps([{ toolCalls: calls }, { content: 'OK.' }]);

    const announced: string[] = [];
    await runLoop(makeSession(), { onToolCall: (c: any) => announced.push(c.id) });

    // Budget is 4 — the fifth call must never be reported as running.
    expect(announced).toEqual(['y1', 'y2', 'y3', 'y4']);
  });
});

describe('simple fact question cheap path (token runaway fix)', () => {
  // Regression: "wer ist bundeskanzler?" burned ~12k tokens on FOUR tool
  // calls (3x ddg_web_search + url_fetch) and the model still answered from
  // stale training data when the searches failed. Simple factual questions
  // must now get a runtime budget of exactly ONE executed tool call, after
  // which the loop forces a short synthesis answer from the search result.

  it('isSimpleFactQuery classifies typical one-fact questions as simple', async () => {
    const { isSimpleFactQuery } = await import('../services/chat');
    expect(isSimpleFactQuery('wer ist bundeskanzler?')).toBe(true);
    expect(isSimpleFactQuery('Wer ist Bundeskanzler')).toBe(true);
    expect(isSimpleFactQuery('wie hoch ist der turm von aachen?')).toBe(true);
    expect(isSimpleFactQuery('wann wurde köln gegründet?')).toBe(true);
  });

  it('isSimpleFactQuery keeps complex/research tasks on the normal budget', async () => {
    const { isSimpleFactQuery } = await import('../services/chat');
    expect(isSimpleFactQuery('recherchiere die Lage des deutschen Arbeitsmarkts und erstelle einen bericht')).toBe(false);
    expect(isSimpleFactQuery('vergleiche Siemens und AEG hinsichtlich Umsatz, Marge und Zukunftsaussichten über die letzten 10 jahre')).toBe(false);
    expect(isSimpleFactQuery('danke, sag Bescheid wenn du fertig bist')).toBe(false);
    expect(isSimpleFactQuery('wer ist bundeskanzler? und wie wird er gewählt?')).toBe(false);
  });

  it('executes only ONE tool call for a simple question even if the model wants more', async () => {
    const search1 = sseCall('s1', 'ddg_web_search', { query: 'bundeskanzler', maxResults: 3 });
    const search2 = sseCall('s2', 'ddg_web_search', { query: 'bundeskanzler aktuell', maxResults: 3 });
    const fetch1 = sseCall('f1', 'url_fetch', { url: 'https://de.wikipedia.org/wiki/Olaf_Scholz' });
    scriptSteps([
      { content: 'Ich suche.', toolCalls: [search1, search2, fetch1] }, // all in one step
      { content: 'Aktueller Bundeskanzler ist Friedrich Merz (CDU). Quelle: https://…' },
    ]);

    const executed: string[] = [];
    const session = makeSession('wer ist bundeskanzler?');
    await runLoop(session, { onToolCall: (c: any) => executed.push(c.toolId) });

    // Only the FIRST call executed; the other two were budget-skipped.
    expect(executed).toEqual(['ddg_web_search']);

    // The synthesis prompt carries the strict "answer from search result only"
    // nudge so the model cannot fall back to its stale training knowledge.
    const synthPrompt = promptAt(1);
    const nudge = synthPrompt.find((m: any) => m.role === 'user' && m.content.includes('Keine weiteren Tools erlaubt'));
    expect(nudge).toBeDefined();
    expect(nudge.content).toContain('NICHT anhand deines Trainingswissens');
    // Protocol stays valid: every tool_call got a reply (skipped ones included).
    const assistant = synthPrompt.find((m: any) => m.role === 'assistant');
    const ids = assistant.tool_calls.map((c: any) => c.id);
    const replied = synthPrompt.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(ids.every((id: string) => replied.includes(id))).toBe(true);
  });

  it('complex queries keep the regular per-turn tool budget (4)', async () => {
    const calls = [1, 2, 3, 4].map(n => sseCall(`k${n}`, 'calculator', { expression: `${n}+0` }));
    scriptSteps([
      { toolCalls: calls },
      { content: 'Fertig.' },
    ]);

    const executed: string[] = [];
    const session = makeSession('recherchiere und vergleiche die Quartalszahlen: rechne 1+0, 2+0, 3+0, 4+0 aus');
    await runLoop(session, { onToolCall: (c: any) => executed.push(c.toolId) });

    expect(executed).toHaveLength(4);
  });
});
