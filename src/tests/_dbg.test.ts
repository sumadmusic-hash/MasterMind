import { describe, it, expect, vi, beforeEach } from 'vitest';
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
function makeSession(): ChatSession {
  return { id: 's1', title: 'test', messages: [{ id: 'm1', role: 'user', content: 'Wieviel Mitarbeiter hat Lidl?', timestamp: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() } as unknown as ChatSession;
}
const sseCall = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

describe('dbg', () => {
  beforeEach(() => mockedCall.mockReset());
  it('cross-step dup', async () => {
    const same = sseCall('c1', 'calculator', { expression: '2+2' });
    let i = 0;
    const steps = [{ toolCalls: [same] }, { toolCalls: [{ ...same, id: 'c2' }] }, { content: 'Fertig.' }];
    mockedCall.mockImplementation(async (_s: any, _m: any, _t: any, cb: any) => {
      const step = steps[Math.min(i, steps.length - 1)]; i++;
      for (const tc of step.toolCalls ?? []) cb?.onToolCall?.(tc);
      if (step.content) cb?.onToken?.(step.content);
      cb?.onComplete?.(step.content ?? '', { totalTokens: 10 });
      return { content: step.content ?? '', usage: { totalTokens: 10, provider: 'groq', model: 'test-model', promptTokens: 5, completionTokens: 5, cachedInputTokens: 0 } as any, model: 'test-model', provider: 'groq' };
    });
    const errors: string[] = [];
    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: (r: any) => { if (!r.success) errors.push(r.error); },
      onComplete: () => {}, onError: (e: string) => errors.push('ONERROR:' + e), onStatus: () => {},
    });
    console.log('provider calls:', mockedCall.mock.calls.length);
    console.log('errors:', errors);
    for (let n = 0; n < mockedCall.mock.calls.length; n++) {
      console.log('prompt', n, JSON.stringify((mockedCall.mock.calls[n] as any)[1].filter((m: any) => m.role === 'tool').map((m: any) => ({ id: m.tool_call_id, c: String(m.content).slice(0, 90) }))));
    }
    expect(true).toBe(true);
  });
});
