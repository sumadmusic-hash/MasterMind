import { describe, it, expect } from 'vitest';
import { handleStreamingResponse } from '../services/provider';

/** Build a Response whose body streams the given SSE lines in small chunks. */
function makeSSEResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const sse = (obj: any) => `data: ${JSON.stringify(obj)}`;

describe('Streaming tool-call reassembly (regression: fragmented deltas)', () => {
  it('merges argument fragments into ONE complete tool call', async () => {
    // Exactly the wire format OpenAI-compatible providers (OpenRouter/Groq)
    // use: first chunk has id+name, following chunks only argument fragments
    // without id/name. Previously every fragment was forwarded as its own
    // "tool call" -> empty names ("Tool not found: ") and half-parsed args
    // ('Pflicht-Parameter "query" fehlt').
    const lines = [
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query"' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "wieviel mitarbeiter hat lidl' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ', "maxResults": 3}' } }] } }] }),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      'data: [DONE]',
    ];

    const calls: any[] = [];
    const result = await handleStreamingResponse(
      makeSSEResponse(lines),
      {
        onToken: () => {},
        onToolCall: (tc) => calls.push(tc),
        onComplete: () => {},
        onError: () => {},
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_1');
    expect(calls[0].function.name).toBe('web_search');
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.query).toBe('wieviel mitarbeiter hat lidl');
    expect(args.maxResults).toBe(3);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('keeps multiple parallel tool calls separated by index', async () => {
    const lines = [
      sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'web_search', arguments: '{"qu' } },
        { index: 1, id: 'call_b', function: { name: 'news_search', arguments: '{"qu' } },
      ] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery": "A"}' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'ery": "B"}' } }] } }] }),
      'data: [DONE]',
    ];

    const calls: any[] = [];
    await handleStreamingResponse(makeSSEResponse(lines), {
      onToken: () => {}, onToolCall: (tc) => calls.push(tc), onComplete: () => {}, onError: () => {},
    });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].function.arguments).query).toBe('A');
    expect(JSON.parse(calls[1].function.arguments).query).toBe('B');
    expect(calls.map(c => c.function.name)).toEqual(['web_search', 'news_search']);
  });

  it('synthesizes ids when the provider omits them and flushes without [DONE]', async () => {
    // Stream ends abruptly (no [DONE] sentinel) — accumulated calls must still
    // be emitted exactly once, with usable ids so the tool protocol stays valid.
    const lines = [
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }] } }] }),
    ];

    const calls: any[] = [];
    await handleStreamingResponse(makeSSEResponse(lines), {
      onToken: () => {}, onToolCall: (tc) => calls.push(tc), onComplete: () => {}, onError: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(typeof calls[0].id).toBe('string');
    expect(calls[0].id.length).toBeGreaterThan(0);
    expect(calls[0].function.name).toBe('calculator');
  });

  it('does not emit phantom calls for content-only streams', async () => {
    const lines = [
      sse({ choices: [{ delta: { content: 'Hallo' } }] }),
      sse({ choices: [{ delta: { content: ' Welt' } }] }),
      'data: [DONE]',
    ];
    const calls: any[] = [];
    let content = '';
    const res = await handleStreamingResponse(makeSSEResponse(lines), {
      onToken: (t) => { content += t; }, onToolCall: (tc) => calls.push(tc), onComplete: () => {}, onError: () => {},
    });
    expect(content).toBe('Hallo Welt');
    expect(res.content).toBe('Hallo Welt');
    expect(calls).toHaveLength(0);
  });
});
