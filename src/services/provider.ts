import type { ModelConfig, ChatMessage, TokenUsage, AppSettings } from '../types';
import { recordTokenUsage } from './database';
import { tpmManager } from './tpm';

export interface ProviderMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: any) => void;
  onComplete: (fullContent: string, usage: TokenUsage) => void;
  onError: (error: Error) => void;
  /**
   * Optional: fired while the request waits for the TPM budget to free up
   * (waitMs = estimated pause until the next attempt, waitedMs = total time
   * already spent waiting). Lets the UI show progress instead of looking stuck.
   */
  onBudgetWait?: (waitMs: number, waitedMs: number) => void;
  /**
   * Optional: fired when a model call is about to be made so the caller knows
   * WHICH model/provider is currently active. This matters for the fallback
   * chain: if model A refuses or fails and model B takes over, the UI must not
   * attribute B's answer to A — it also lets the caller reset its per-attempt
   * streaming buffer before tokens of the new model arrive.
   */
  onModelSwitch?: (modelId: string, provider: string, attempt: number) => void;
}

const MODEL_CATALOGS: Record<string, { id: string; name: string; contextWindow: number; supportsTools: boolean }[]> = {
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 128000, supportsTools: true },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 128000, supportsTools: true },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, supportsTools: true },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B', contextWindow: 8192, supportsTools: false },
  ],
  openrouter: [
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, supportsTools: true },
    { id: 'openai/gpt-4o', name: 'GPT-4o', contextWindow: 128000, supportsTools: true },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, supportsTools: true },
    { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', contextWindow: 128000, supportsTools: true },
    { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', contextWindow: 2000000, supportsTools: true },
    { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B', contextWindow: 32768, supportsTools: true },
  ],
};

export function getModelCatalog(provider: string) {
  return MODEL_CATALOGS[provider] || [];
}

/**
 * Detect content refusals ("policy blocks") in a model's reply.
 *
 * A refusal is NOT a technical error (HTTP 429/5xx): the request succeeded but
 * the model declined to answer. Without this check the fallback chain would
 * never kick in on refusals and the user would get an empty/useless answer
 * from the primary model. Detection is language-aware (English + German) and
 * deliberately conservative — it only fires when the message STARTS with a
 * clear refusal phrase, so answers that merely *mention* safety policies are
 * not misclassified.
 */
const REFUSAL_PATTERNS = [
  /^(?:i'?m|i am)\s+sorry[,.\s]+(?:but\s+)?i\s+(?:can'?t|cannot|am unable|won'?t)\b/i,
  /^i\s+(?:can'?t|cannot|am unable to|won'?t|do n'?t|don'?t)\s+(?:be able to\s+)?(?:help|assist|answer|respond|comply|provide|discuss|engage)/i,
  /^i\s+(?:must|have to)\s+decline\b/i,
  /^as an ai[,.]?\s+i\s+(?:can'?t|cannot|don'?t|do not|am not able|am unable)/i,
  /^i\s+(?:'?m|am)\s+(?:unable|not able|not permitted|not allowed)\s+to\b/i,
  /^i\s+(?:'?m|am)\s+(?:designed|programmed|required)\s+to\s+(?:follow|respect|adhere)\b/i,
  // OpenAI-style moderation refusal signal
  /content_policy_violation|new_sensitive_unavailable_content/i,
  // German refusal phrases
  /^leider\s+(?:kann|darf|muss)\b/i,
  /^(?:als\s+ki|als\s+sprachmodell)\s+kann\s+ich\s+(?:nicht|leider)/i,
  /^das\s+(?:liegt\s+nicht\s+in\s+meinen?\s+(?:aufgaben|fähigkeiten)|fällt\s+außerhalb)/i,
];

export function detectRefusal(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/** Error thrown when a model answers but refuses the request (content policy). */
export class ModelRefusalError extends Error {
  readonly refusal = true as const;
  readonly refusedModel: string;
  readonly refusedProvider: string;
  readonly refusedContent: string;

  constructor(model: string, provider: string, content: string) {
    super(`Model "${model}" refused the request (likely content policy); trying fallback…`);
    this.name = 'ModelRefusalError';
    this.refusedModel = model;
    this.refusedProvider = provider;
    this.refusedContent = content;
  }
}

export function getAllModels() {
  return {
    groq: MODEL_CATALOGS.groq,
    openrouter: MODEL_CATALOGS.openrouter,
  };
}

function getApiUrl(provider: string): string {
  switch (provider) {
    case 'groq': return 'https://api.groq.com/openai/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function getApiKey(settings: AppSettings, provider: string): string | undefined {
  switch (provider) {
    case 'groq': return settings.groqApiKey;
    case 'openrouter': return settings.openRouterApiKey;
    default: return undefined;
  }
}

function estimateTokens(messages: ProviderMessage[]): number {
  // Rough estimation: ~4 chars per token. Tool-call payloads must be counted
  // too — they are part of the prompt but were previously ignored entirely,
  // which made the TPM reservation systematically underestimate real usage.
  let totalChars = 0;
  for (const m of messages) {
    totalChars += m.content?.length || 0;
    if (m.tool_calls) {
      try {
        totalChars += JSON.stringify(m.tool_calls).length;
      } catch { /* ignore unserializable payloads */ }
    }
    if (m.name) totalChars += m.name.length;
  }
  return Math.ceil(totalChars / 4);
}

export async function callProvider(
  settings: AppSettings,
  messages: ProviderMessage[],
  tools?: any[],
  callbacks?: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<{ content: string; usage: TokenUsage; model: string; provider: string }> {
  // Primärmodell + bis zu 6 Fallbacks, der Reihe nach.
  const modelConfigs: ModelConfig[] = [
    settings.primaryModel,
    settings.fallback1,
    settings.fallback2,
    settings.fallback3,
    settings.fallback4,
    settings.fallback5,
    settings.fallback6,
  ].filter((m): m is ModelConfig => !!m);

  let lastError: Error | null = null;
  // Refusal tracking: if EVERY model in the chain refused the request (content
  // policy) instead of failing technically, the caller should be able to tell
  // "all models declined" apart from "all models errored" — and must NOT treat
  // a refusal as a reason to re-run work that was already completed.
  let sawRefusal = false;

  for (let attemptIdx = 0; attemptIdx < modelConfigs.length; attemptIdx++) {
    const config = modelConfigs[attemptIdx];
    const apiKey = getApiKey(settings, config.provider);
    if (!apiKey) {
      lastError = new Error(`API key not configured for ${config.provider}`);
      continue;
    }

    // Tell the caller which model is taking over BEFORE any tokens are
    // streamed. On fallback this lets the UI reset its per-attempt buffer and
    // attribute the answer to the right model instead of the one that refused.
    callbacks?.onModelSwitch?.(config.modelId, config.provider, attemptIdx + 1);

    let reservationId: string | null = null;
    try {
      // Reserve tokens in TPM budget. `reserve` returns a reservation id so we
      // can release/confirm exactly THIS reservation later — previously the id
      // was discarded and error paths released an arbitrary (oldest) provider
      // reservation, which could free a concurrent request's pending budget.
      const estimatedTokens = estimateTokens(messages);
      const maxOutput = settings.maxTokensPerRequest;
      const totalEstimated = estimatedTokens + maxOutput;

      reservationId = await tpmManager.reserveAndWait(config.provider, totalEstimated, settings, {
        signal: abortSignal,
        onWait: (waitMs, waitedMs) => callbacks?.onBudgetWait?.(waitMs, waitedMs),
      });
      if (!reservationId) {
        // Budget stays configurable via Settings; this only happens when the
        // wait window elapsed, the request can never fit the limits, or the
        // user aborted while waiting.
        lastError = new Error(`Token budget (${settings.globalTpmLimit.toLocaleString()} TPM) still exhausted after waiting — try again later or raise the limit in Settings.`);
        continue;
      }

      const result = await executeProviderCall(
        config, apiKey, messages, tools, callbacks, abortSignal, settings
      );

      // Refusal check: the call technically succeeded (HTTP 200) but the model
      // declined to answer. Treat it like a failed attempt so the NEXT model
      // in the fallback chain answers the SAME request with the SAME message
      // history — already completed work (tool results, earlier steps) stays
      // part of the conversation and is NOT re-run from scratch.
      if (detectRefusal(result.content)) {
        // The refusing model consumed budget; account for its real usage
        // before handing over to the fallback.
        tpmManager.recordUsage(config.provider, result.usage.totalTokens, reservationId);
        reservationId = null;
        await recordTokenUsage({ ...result.usage, provider: config.provider, model: config.modelId });
        sawRefusal = true;
        throw new ModelRefusalError(config.modelId, config.provider, result.content);
      }

      // Update TPM with actual usage AND release this request's reservation in
      // one step. Previously the reservation was never released on success, so
      // its tokens were double-counted (reserved + used) until the 30s expiry.
      tpmManager.recordUsage(config.provider, result.usage.totalTokens, reservationId);
      reservationId = null;
      await recordTokenUsage({ ...result.usage, provider: config.provider, model: config.modelId });

      return { ...result, model: config.modelId, provider: config.provider };
    } catch (err: any) {
      // Release our own reservation on any failure path (no-op if already done)
      if (reservationId) {
        tpmManager.releaseReservation(config.provider, reservationId);
        reservationId = null;
      }
      if (err.name === 'AbortError') throw err;

      lastError = err;

      // Refusal by this model -> hand the SAME request (identical message
      // history, incl. tool results from earlier steps) to the next model in
      // the chain instead of restarting the task from scratch.
      if (err.refusal === true || err instanceof ModelRefusalError) {
        continue;
      }

      // Check if error is retryable
      if (err.status === 401 || err.status === 403) {
        throw new Error(`Authentication failed for ${config.provider}. Check your API key.`);
      }
      
      if (err.status === 429) {
        // Rate limited, try fallback
        continue;
      }
      
      if (err.status >= 500) {
        // Server error, try fallback
        continue;
      }
      
      // For other errors, also try fallback
      continue;
    }
  }

  // If at least one model refused and none answered, mark the final error as a
  // refusal so callers can distinguish "every model declined" (don't blindly
  // retry / redo work) from "infrastructure failure" (safe to resume/retry).
  if (sawRefusal && !(lastError as any)?.refusal) {
    const refusalErr: any = new Error(
      'All configured models declined this request (content policy). The task was not restarted — progress is preserved.'
    );
    refusalErr.refusal = true;
    refusalErr.name = 'ModelRefusalError';
    throw refusalErr;
  }

  throw lastError || new Error('All models failed');
}

async function executeProviderCall(
  config: ModelConfig,
  apiKey: string,
  messages: ProviderMessage[],
  tools: any[] | undefined,
  callbacks: StreamCallbacks | undefined,
  abortSignal: AbortSignal | undefined,
  settings: AppSettings
): Promise<{ content: string; usage: TokenUsage }> {
  const url = getApiUrl(config.provider);
  
  const body: any = {
    model: config.modelId,
    messages,
    stream: !!callbacks,
    max_tokens: settings.maxTokensPerRequest,
    temperature: 0.7,
  };

  if (body.stream) {
    // Ask the provider to include real token usage in the final stream chunk;
    // without it we can only estimate (which distorts TPM budgeting and the
    // usage dashboard). Does not change response content/quality.
    body.stream_options = { include_usage: true };
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'AI Research Assistant';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const err = new Error(`Provider error: ${response.status} - ${errorBody}`);
    (err as any).status = response.status;
    throw err;
  }

  if (callbacks?.onToken) {
    // Streaming response. Pass the request messages so prompt tokens can be
    // estimated from the actual PROMPT when the provider doesn't report usage
    // in the stream (previously they were wrongly derived from the reply text).
    return handleStreamingResponse(response, callbacks, messages);
  } else {
    // Non-streaming response
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = {
      provider: config.provider,
      model: config.modelId,
      promptTokens: data.usage?.prompt_tokens || estimateTokens(messages),
      completionTokens: data.usage?.completion_tokens || Math.ceil(content.length / 4),
      totalTokens: data.usage?.total_tokens || estimateTokens(messages) + Math.ceil(content.length / 4),
      estimated: !data.usage,
      timestamp: Date.now(),
    };
    return { content, usage };
  }
}

async function handleStreamingResponse(
  response: Response,
  callbacks: StreamCallbacks,
  requestMessages?: ProviderMessage[]
): Promise<{ content: string; usage: TokenUsage }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  // SSE frames must be reassembled across network-chunk boundaries: a single
  // `data:` line can be split over two chunks (and one chunk can contain many
  // lines). Previously every partial line was fed to JSON.parse and silently
  // dropped, which randomly lost tokens/tool-calls whenever the TCP framing
  // didn't align with SSE line breaks.
  let buffer = '';
  let sawDone = false;

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const rest = line.slice(5);
    const data = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;

      if (delta?.content) {
        fullContent += delta.content;
        callbacks.onToken(delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          callbacks.onToolCall(tc);
        }
      }

      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens;
        completionTokens = parsed.usage.completion_tokens;
      }
    } catch {
      // Skip malformed events
    }
  };

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Keep the last (possibly incomplete) segment in the buffer until the
      // terminating newline of the next chunk arrives.
      const lines2 = buffer.split('\n');
      buffer = lines2.pop() ?? '';
      for (const line of lines2) {
        processLine(line);
        if (sawDone) break;
      }
    }

    // Flush any trailing complete event left in the buffer at stream end.
    if (!sawDone && buffer) {
      processLine(buffer);
      buffer = '';
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      callbacks.onComplete(fullContent, {
        provider: '',
        model: '',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: true,
        timestamp: Date.now(),
      });
      throw err;
    }
    callbacks.onError(err);
    throw err;
  }

  const estimated = !promptTokens;
  if (estimated) {
    // The provider didn't report usage: estimate prompt tokens from the ACTUAL
    // request messages. Deriving them from the reply text (fullContent.length/4)
    // as before systematically distorted TPM budgeting and the usage dashboard.
    promptTokens = requestMessages ? estimateTokens(requestMessages) : 0;
    completionTokens = Math.ceil(fullContent.length / 4);
  }

  const usage: TokenUsage = {
    provider: '',
    model: '',
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated,
    timestamp: Date.now(),
  };

  callbacks.onComplete(fullContent, usage);
  return { content: fullContent, usage };
}

export async function testConnection(provider: string, apiKey: string, modelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const url = getApiUrl(provider);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Hello, respond with just "OK".' }],
        max_tokens: 10,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: `${response.status}: ${body}` };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
