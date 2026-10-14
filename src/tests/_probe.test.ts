import { describe, it, vi, beforeEach } from 'vitest';
import type { AppSettings, ChatSession } from '../types';

vi.mock('../services/provider', () => ({ callProvider: vi.fn() }));
vi.mock('../services/database', () => ({
  saveChatSession: vi.fn().mockResolvedValue(undefined),
  addLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/tools', async (importOriginal) => {
  const actual = await importOriginal<any>();
  for (const def of actual.toolRegistry.getAllTools()) {
    actual.toolRegistry.register(def, async (args: any) => ({ query: args.query, url: args.url, expression: args.expression, result: 42, formatted: '42', found: true }));
  }
  return actual;
});

import { callProvider } from '../services/provider';
import { ChatOrchestrator } from '../services/chat';
const mockedCall = vi.mocked(callProvider);

const settings = { primaryModel: { provider: 'groq', modelId: 'test-model' }, maxToolSteps: 10 } as unknown as AppSettings;
function makeSession(q: string): ChatSession {
  return { id: 's1', title: 't', messages: [{ id: 'm1', role: 'user', content: q, timestamp: Date.now() }], createdAt: 0, updatedAt: 0 } as any;
}
const sseCall = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function script(steps: any[]) {
  let i = 0;
  mockedCall.mockImplementation(async (_s, _m, _t, cb: any) => {
    const step = steps[Math.min(i, steps.length - 1)]; i++;
    for (const tc of step.toolCalls ?? []) cb?.onToolCall?.(tc);
    if (step.content) cb?.onToken?.(step.content);
    cb?.onComplete?.(step.content ?? '', { totalTokens: 10 });
    return { content: step.content ?? '', usage: { totalTokens: 10, provider: 'groq', model: 'test-model', promptTokens: 5, completionTokens: 5, cachedInputTokens: 0 } as any, model: 'test-model', provider: 'groq' };
  });
}

async function run(label: string, q: string, tools?: any) {
  mockedCall.mockReset();
  const executed: string[] = [];
  await new ChatOrchestrator().sendMessage(settings, makeSession(q), undefined, {
    onToken: () => {}, onToolCall: (c: any) => executed.push(c.id), onToolResult: () => {}, onComplete: () => {}, onError: () => {}, onStatus: () => {},
  });
  console.log(`${label}: QUERY=${JSON.stringify(q)} calls=${mockedCall.mock.calls.length} announced=${JSON.stringify(executed)} toolnames=${JSON.stringify((mockedCall.mock.calls[0] as any)[2]?.map?.((t:any)=>t.name))}`);
}

describe('probe', () => {
  beforeEach(() => mockedCall.mockReset());
  it('queries', async () => {
    const a = sseCall('a1', 'calculator', { expression: '1+1' });
    const b = sseCall('b1', 'calculator', { expression: '1+1' });
    script([{ toolCalls: [a, b] }, { content: 'Antwort.' }]);
    await run('intra-dup', 'Wieviel Mitarbeiter hat Lidl?');
    const same = sseCall('c1', 'calculator', { expression: '2+2' });
    script([{ toolCalls: [same] }, { toolCalls: [{ ...same, id: 'c2' }] }, { content: 'Fertig.' }]);
    await run('cross-dup', 'Wieviel Mitarbeiter hat Lidl?');
    const calls5 = [1,2,3,4,5].map(n => sseCall(`y${n}`, 'calculator', { expression: `${n}+0` }));
    script([{ toolCalls: calls5 }, { content: 'OK.' }]);
    await run('budget5', 'Wieviel Mitarbeiter hat Lidl?');
    script([{ toolCalls: calls5 }, { content: 'OK.' }]);
    await run('budget5-simple', 'wer ist bundeskanzler?');
  });
});
