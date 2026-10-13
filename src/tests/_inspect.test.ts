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

const settings: AppSettings = {
  primaryModel: { provider: 'groq', modelId: 'test-model' },
  maxToolSteps: 10,
} as unknown as AppSettings;

function makeSession(q = 'Wieviel Mitarbeiter hat Lidl?'): ChatSession {
  return {
    id: 's1', title: 'test',
    messages: [{ id: 'm1', role: 'user', content: q, timestamp: Date.now() }],
    createdAt: Date.now(), updatedAt: Date.now(),
  } as unknown as ChatSession;
}

const sseCall = (id: string, name: string, args: Record<string, any>) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

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
      usage: { totalTokens: 10, provider: 'groq', model: 'test-model', promptTokens: 5, completionTokens: 5, cachedInputTokens: 0 } as any,
      model: 'test-model', provider: 'groq',
    };
  });
}

describe('inspect', () => {
  beforeEach(() => { mockedCall.mockReset(); });

  it('dump budget synthesis prompt', async () => {
    const calls = [1, 2, 3, 4].map(n => sseCall(`b${n}`, 'calculator', { expression: `${n}+0` }));
    scriptSteps([
      { content: 'Ich rechne.', toolCalls: calls },
      { content: 'Finale Antwort aus gesammeltem Material.' },
    ]);
    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
      onComplete: () => {}, onError: (e: any) => console.log('ONERROR:', e), onStatus: () => {},
    });
    const p = mockedCall.mock.calls[1][1] as any[];
    console.log('ROLES:', p.map(m => m.role).join(','));
    console.log('USER CONTENTS:', JSON.stringify(p.filter(m => m.role === 'user').map(m => String(m.content).slice(0, 80))));
    expect(true).toBe(true);
  });

  it('dump dedup repeat-call test', async () => {
    const same = sseCall('c1', 'calculator', { expression: '2+2' });
    scriptSteps([
      { toolCalls: [same] },
      { toolCalls: [{ ...same, id: 'c2' }] },
      { content: 'Fertig.' },
    ]);
    await new ChatOrchestrator().sendMessage(settings, makeSession(), undefined, {
      onToken: () => {}, onToolCall: () => {}, onToolResult: () => {},
      onComplete: () => {}, onError: () => {}, onStatus: () => {},
    });
    console.log('NUM CALLS:', mockedCall.mock.calls.length);
    expect(true).toBe(true);
  });
});
