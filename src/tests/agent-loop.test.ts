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

import { callProvider } from '../services/provider';
import { ChatOrchestrator } from '../services/chat';

const mockedCall = vi.mocked(callProvider);

const settings: AppSettings = {
  primaryModel: { provider: 'groq', modelId: 'test-model' },
  maxToolSteps: 10,
} as unknown as AppSettings;

function makeSession(): ChatSession {
  return {
    id: 's1',
    title: 'test',
    messages: [
      { id: 'm1', role: 'user', content: 'Wieviel Mitarbeiter hat Lidl?', timestamp: Date.now() },
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

    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
      onComplete: () => {}, onError: () => {}, onStatus: () => {},
    });

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

    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
      onComplete: () => {}, onError: () => {}, onStatus: () => {},
    });

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

    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
      onComplete: () => {}, onError: () => {}, onStatus: () => {},
    });

    const step2 = promptAt(1);
    const assistant = step2.find((m: any) => m.role === 'assistant');
    const ids = assistant.tool_calls.map((c: any) => c.id);
    const replied = step2.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(ids.every((id: string) => replied.includes(id))).toBe(true);
    const skipped = step2.find((m: any) => m.role === 'tool' && m.tool_call_id === 'x5');
    expect(JSON.parse(skipped.content).skipped).toContain('Budget');
  });
});
