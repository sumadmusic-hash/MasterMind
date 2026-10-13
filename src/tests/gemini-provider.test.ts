import { describe, it, expect } from 'vitest';
import { toGeminiContents, handleGeminiStreamingResponse } from '../services/provider';
import type { ProviderMessage } from '../services/provider';

describe('Gemini provider adapter', () => {
  it('maps system messages to systemInstruction (not into contents)', () => {
    const msgs: ProviderMessage[] = [
      { role: 'system', content: 'Du bist ein Assistent.' },
      { role: 'user', content: 'Hallo' },
    ];
    const { contents, systemInstruction } = toGeminiContents(msgs);
    expect(systemInstruction?.parts[0].text).toBe('Du bist ein Assistent.');
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'Hallo' }] }]);
  });

  it('maps assistant tool_calls to functionCall parts with parsed args', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'Suche XYZ' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"XYZ"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: '{"results":[]}' },
    ];
    const { contents } = toGeminiContents(msgs);
    // user -> model(functionCall) -> user(functionResponse), alternating roles
    expect(contents.map(c => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[1].parts[0].functionCall).toEqual({
      name: 'web_search',
      args: { query: 'XYZ' },
    });
    expect(contents[2].parts[0].functionResponse).toEqual({
      name: 'web_search',
      response: { results: [] },
    });
  });

  it('wraps non-JSON tool results and merges consecutive same-role messages', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'tool', name: 't', content: 'plain text result' },
    ];
    const { contents } = toGeminiContents(msgs);
    expect(contents.length).toBe(1); // all three map to the same 'user' turn
    expect(contents[0].parts).toEqual([
      { text: 'a' },
      { text: 'b' },
      { functionResponse: { name: 't', response: { result: 'plain text result' } } },
    ]);
  });

  it('parses a Gemini SSE stream (text + functionCall + usageMetadata)', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hal"}],"role":"model"}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n',
    ].join('');
    const chunks = [sse.slice(0, 40), sse.slice(40)]; // split mid-line on purpose
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const response = new Response(body);

    const tokens: string[] = [];
    const toolCalls: any[] = [];
    let completed: { content: string; total: number } | null = null;
    const callbacks = {
      onToken: (t: string) => tokens.push(t),
      onToolCall: (tc: any) => toolCalls.push(tc),
      onComplete: (content: string, usage: any) => { completed = { content, total: usage.totalTokens }; },
      onError: (e: Error) => { throw e; },
    };

    const result = await handleGeminiStreamingResponse(response as any, callbacks as any, []);
    expect(result.content).toBe('Hallo');
    expect(tokens.join('')).toBe('Hallo');
    expect(result.toolCallCount).toBe(0);
    expect(toolCalls.length).toBe(0);
    expect(completed).toEqual({ content: 'Hallo', total: 12 });
    expect(result.usage.promptTokens).toBe(10);
  });

  it('emits streamed functionCalls as OpenAI-shaped tool calls', async () => {
    const payload = JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'news_search', args: { query: 'Tesla' } } }],
        },
        finishReason: 'STOP',
      }],
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
        controller.close();
      },
    });
    const response = new Response(body);

    const toolCalls: any[] = [];
    const callbacks = {
      onToken: () => {},
      onToolCall: (tc: any) => toolCalls.push(tc),
      onComplete: () => {},
      onError: (e: Error) => { throw e; },
    };

    const result = await handleGeminiStreamingResponse(response as any, callbacks as any, []);
    expect(result.toolCallCount).toBe(1);
    expect(toolCalls[0].function.name).toBe('news_search');
    // chat.ts expects arguments as JSON STRING (OpenAI wire format)
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ query: 'Tesla' });
    expect(result.finishReason).toBe('STOP');
  });
});
