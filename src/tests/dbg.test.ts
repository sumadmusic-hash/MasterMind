import { describe, it, vi } from 'vitest';
import type { AppSettings, ChatSession } from '../types';
vi.mock('../services/provider', () => ({ callProvider: vi.fn() }));
vi.mock('../services/database', () => ({
  saveChatSession: vi.fn().mockResolvedValue(undefined),
  addLog: vi.fn().mockResolvedValue(undefined),
}));
import { callProvider } from '../services/provider';
import { ChatOrchestrator } from '../services/chat';
const mockedCall = vi.mocked(callProvider);
const settings = { primaryModel: { provider: 'groq', modelId: 'test-model' }, maxToolSteps: 10 } as unknown as AppSettings;
const sseCall = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function scriptSteps(steps: Array<{ content?: string; toolCalls?: any[] }>) {
  let i = 0;
  mockedCall.mockImplementation(async (_s, _m, _t, cb: any) => {
    const step = steps[Math.min(i, steps.length - 1)]; i++;
    for (const tc of step.toolCalls ?? []) cb?.onToolCall?.(tc);
    if (step.content) cb?.onToken?.(step.content);
    cb?.onComplete?.(step.content ?? '', { totalTokens: 10 });
    return { content: step.content ?? '', usage: { totalTokens: 10, provider: 'groq', model: 'test-model', promptTokens: 5, completionTokens: 5, cachedInputTokens: 0 } as any, model: 'test-model', provider: 'groq' };
  });
}
function dump(label: string) {
  console.log('=====', label, 'CALLS:', mockedCall.mock.calls.length);
  mockedCall.mock.calls.forEach((c: any, n: number) => {
    console.log('--- call', n, 'tools=', c[2]?.map?.((t: any) => t.name));
    c[1].forEach((m: any) => console.log(' ', m.role, m.tool_call_id ?? '', '|', String(m.content).slice(0, 90).replace(/\n/g, ' '), '|', m.tool_calls ? JSON.stringify(m.tool_calls.map((x: any) => x.id)) : ''));
  });
}
describe('dbg', () => {
  it('cross-step dedup', async () => {
    mockedCall.mockReset();
    const same = sseCall('c1', 'calculator', { expression: '2+2' });
    scriptSteps([{ toolCalls: [same] }, { toolCalls: [{ ...same, id: 'c2' }] }, { content: 'Fertig.' }]);
    const session = { id: 's1', title: 't', messages: [{ id: 'm1', role: 'user', content: 'Wieviel Mitarbeiter hat Lidl?', timestamp: Date.now() }], createdAt: 0, updatedAt: 0 } as unknown as ChatSession;
    await new ChatOrchestrator().sendMessage(settings, session, undefined, { onToken: () => {}, onToolCall: () => {}, onToolResult: () => {}, onComplete: () => {}, onError: (e) => console.log('ERRCB', e), onStatus: () => {} });
    dump('cross-step');
  });
  it('within batch dup', async () => {
    mockedCall.mockReset();
    const a = sseCall('a1', 'calculator', { expression: '1+1' });
    const b = sseCall('b1', 'calculator', { expression: '1+1' });
    scriptSteps([{ toolCalls: [a, b] }, { content: 'Antwort.' }]);
    const session = { id: 's1', title: 't', messages: [{ id: 'm1', role: 'user', content: 'Rechne 1+1 und noch mal 1+1 aus?', timestamp: Date.now() }], createdAt: 0, updatedAt: 0 } as unknown as ChatSession;
    await new ChatOrchestrator().sendMessage(settings, session, undefined, { onToken: () => {}, onToolCall: () => {}, onToolResult: () => {}, onComplete: () => {}, onError: (e) => console.log('ERRCB', e), onStatus: () => {} });
    dump('within-batch');
  });
});
