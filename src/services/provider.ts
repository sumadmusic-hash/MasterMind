import type { ModelConfig, ChatMessage, TokenUsage, AppSettings } from '../types';
import { recordTokenUsage } from './database';
import { tpmManager } from './tpm';

export interface ProviderMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: any) => void;
  onComplete: (fullContent: string, usage: TokenUsage) => void;
  onError: (error: Error) => void;
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
  // Rough estimation: ~4 chars per token
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  return Math.ceil(totalChars / 4);
}

export async function callProvider(
  settings: AppSettings,
  messages: ProviderMessage[],
  tools?: any[],
  callbacks?: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<{ content: string; usage: TokenUsage; model: string; provider: string }> {
  const modelConfigs: ModelConfig[] = [
    settings.primaryModel,
    settings.fallback1,
    settings.fallback2,
  ].filter((m): m is ModelConfig => !!m);

  let lastError: Error | null = null;

  for (const config of modelConfigs) {
    const apiKey = getApiKey(settings, config.provider);
    if (!apiKey) {
      lastError = new Error(`API key not configured for ${config.provider}`);
      continue;
    }

    try {
      // Reserve tokens in TPM budget
      const estimatedTokens = estimateTokens(messages);
      const maxOutput = settings.maxTokensPerRequest;
      const totalEstimated = estimatedTokens + maxOutput;
      
      const reserved = await tpmManager.reserve(config.provider, totalEstimated, settings);
      if (!reserved) {
        lastError = new Error('Token budget exhausted. Please wait or increase limits.');
        continue;
      }

      const result = await executeProviderCall(
        config, apiKey, messages, tools, callbacks, abortSignal, settings
      );

      // Update TPM with actual usage
      tpmManager.recordUsage(config.provider, result.usage.totalTokens);
      await recordTokenUsage(result.usage);

      return { ...result, model: config.modelId, provider: config.provider };
    } catch (err: any) {
      tpmManager.releaseReservation(config.provider);
      
      if (err.name === 'AbortError') throw err;
      
      lastError = err;
      
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
    // Streaming response
    return handleStreamingResponse(response, callbacks);
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
  callbacks: StreamCallbacks
): Promise<{ content: string; usage: TokenUsage }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') break;

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
          // Skip malformed chunks
        }
      }
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
    promptTokens = Math.ceil(fullContent.length / 4);
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
