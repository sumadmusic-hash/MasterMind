import type { ModelConfig, ChatMessage, TokenUsage, AppSettings } from '../types';
import { recordTokenUsage, addLog, getSettings } from './database';
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
  // Lokale KI über LM Studio (https://lmstudio.ai): der "Developer Server"
  // (Server-Tab → Start Server) stellt eine OpenAI-kompatible API auf
  // http://localhost:1234/v1 bereit. Die tatsächlich geladenen Modelle hängen
  // von der lokalen Installation ab — fetchLmStudioModels() liest sie live vom
  // Server aus; die Liste hier ist nur ein Offline-Fallback mit gängigen ids.
  lmstudio: [
    { id: 'local-model', name: 'Lokales Modell (Standard-Placeholder)', contextWindow: 8192, supportsTools: true },
    { id: 'meta-llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct (lokal)', contextWindow: 131072, supportsTools: true },
    { id: 'qwen2.5-coder-14b-instruct', name: 'Qwen 2.5 Coder 14B (lokal)', contextWindow: 32768, supportsTools: true },
    { id: 'google-gemma-2-9b-it', name: 'Gemma 2 9B IT (lokal)', contextWindow: 8192, supportsTools: false },
  ],
  // Google Gemini API (AI Studio) — kostenlos nutzbar mit kostenlosem API-Key
  // von https://aistudio.google.com/apikey (Tier "Free", ohne Kreditkarte).
  // Achtung: Google nimmt laufend alte Modellvarianten für NEUE Nutzer aus dem
  // Programm (gemini-2.5-flash/-lite und gemini-2.0-flash liefern inzwischen
  // HTTP 404 "no longer available to new users"). Deshalb stehen hier nur noch
  // aktuelle GA-/Preview-Modelle; RETIRED_GEMINI_MODELS mappt abgekündigte ids
  // auf ihren Nachfolger, damit bereits gespeicherte Einstellungen automatisch
  // weiterfunktion (siehe resolveGeminiModel()).
  gemini: [
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash (kostenlos)', contextWindow: 1048576, supportsTools: true },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview (kostenlos)', contextWindow: 1048576, supportsTools: true },
    { id: 'gemini-flash-latest', name: 'Gemini Flash Latest (kostenlos, immer aktuell)', contextWindow: 1048576, supportsTools: true },
    { id: 'gemini-flash-lite-latest', name: 'Gemini Flash Lite Latest (kostenlos, immer aktuell)', contextWindow: 1048576, supportsTools: true },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', contextWindow: 1048576, supportsTools: true },
  ],
};

/**
 * Abgekündigte Gemini-Modell-ids → aktueller Nachfolger. Wird angewendet,
 * bevor eine Anfrage an die API geht (resolveGeminiModel), damit Nutzer mit
 * älteren gespeicherten Einstellungen nicht mehr gegen die 404-Wand laufen.
 */
const RETIRED_GEMINI_MODELS: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3-flash',
  'gemini-2.5-flash-lite': 'gemini-flash-lite-latest',
  'gemini-2.0-flash': 'gemini-flash-latest',
  'gemini-2.0-flash-lite': 'gemini-flash-lite-latest',
  'gemini-2.5-pro': 'gemini-3-pro-preview',
  'gemini-2.0-pro-exp-02-05': 'gemini-3-pro-preview',
};

/**
 * Resolve a Gemini model id for the Generative Language API:
 * - strip provider prefixes ("google/gemini-2.5-flash" -> "gemini-2.5-flash")
 * - replace retired models with their current successor (Google returns
 *   HTTP 404 "This model models/gemini-2.5-flash is no longer available to
 *   new users" for deprecated variants on free-tier keys)
 */
export function resolveGeminiModel(modelId: string): string {
  const id = (modelId || '').trim();
  const slash = id.lastIndexOf('/');
  const bare = slash >= 0 ? id.slice(slash + 1) : id;
  return RETIRED_GEMINI_MODELS[bare] || bare;
}

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

/**
 * A model that streams back NEITHER text nor tool calls produced no usable
 * answer. This happens with weaker/free models when a prompt carries tool
 * results they cannot handle — the request succeeds (HTTP 200, tokens billed)
 * but the reply is empty. Previously such "silent refusals" ended the agent
 * loop as a normal completion: the user saw NO answer at all while every
 * earlier step's tokens were already spent. Treating them like a content
 * refusal lets the fallback chain take over and keeps the turn resumable.
 */
export function isEmptyResponse(content: string, toolCallCount: number): boolean {
  return !(content || '').trim() && toolCallCount === 0;
}

/** Error thrown when a model answers with an empty, useless response. */
export class EmptyResponseError extends Error {
  readonly refusal = true as const;
  readonly emptyModel: string;
  readonly emptyProvider: string;

  constructor(model: string, provider: string) {
    super(`Model "${model}" lieferte eine leere Antwort ohne Tool-Aufrufe; Fallback übernimmt…`);
    this.name = 'EmptyResponseError';
    this.emptyModel = model;
    this.emptyProvider = provider;
  }
}

/**
 * Error thrown when a provider rejects the request's credentials (HTTP 401/403).
 *
 * This is NOT a transient infrastructure failure: every model that references
 * the same provider will fail with the identical error, and resuming the turn
 * ("Fortsetzen") without fixing the API key just re-sends the whole prompt
 * (system prompt + history + tool catalogue) for nothing — observed as ~9-13k
 * tokens burned per attempt with no answer ever arriving. Callers must treat
 * this as fatal-and-non-resumable (`auth = true`, `refusal` deliberately NOT
 * set so the turn is not offered for resume) until the key is corrected.
 */
export class AuthProviderError extends Error {
  readonly auth = true as const;
  readonly failedProvider: string;

  constructor(provider: string) {
    super(`Authentication failed for ${provider}. Check your API key.`);
    this.name = 'AuthProviderError';
    this.failedProvider = provider;
  }
}

/** True when an error stems from invalid/missing provider credentials (401/403). */
export function isAuthError(err: any): boolean {
  return err instanceof AuthProviderError ||
    err?.auth === true ||
    err?.name === 'AuthProviderError' ||
    err?.status === 401 ||
    err?.status === 403;
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
    gemini: MODEL_CATALOGS.gemini,
    lmstudio: MODEL_CATALOGS.lmstudio,
  };
}

/** Standard-Basis-URL des LM-Studio-Developers-Servers (OpenAI-kompatibel). */
export const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

/**
 * Timeout-Budget für den ERSTEN Aufruf eines lokalen Modells pro Request.
 * LM Studio lädt das GGUF-Modell beim ersten Request in RAM/VRAM ("kalter
 * Start") — bei großen Modellen dauern allein die Vorlaufminuten länger als
 * das globale maxCallDuration (Standard 120s). Einmalig erlaubt, danach ist
 * das Modell warm und der normale Rahmen gilt wieder.
 */
const LOCAL_COLD_START_MAX_DURATION = 600000; // 10 Minuten

/**
 * Basis-URL des lokalen Servers aus den Einstellungen ableiten (Leer =
 * Standard). Toleriert Varianten wie "http://localhost:1234" (ohne /v1),
 * "https://192.168.x.x:1234/v1/" (Remote-LAN) oder einen beliebigen anderen
 * OpenAI-kompatiblen lokalen Server (Ollama mit LM-Studio-Bridge, llama.cpp,
 * vLLM …).
 */
export function getLmStudioBaseUrl(settings?: Pick<AppSettings, 'lmstudioBaseUrl'> | null): string {
  const raw = String(settings?.lmstudioBaseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return LMSTUDIO_DEFAULT_BASE_URL;
  // Endpunkt-Pfade nie mitschleifen — wir bauen /chat/completions selbst an.
  const withoutEndpoint = raw.replace(/\/(chat\/completions|completions|models)$/i, '');
  // "/v1" ergänzen, wenn der Nutzer nur Host:Port angegeben hat (LM Studio &
  // Co. erwarten den Pfad; reine Host-Angaben sind ein häufiger Tippfehler).
  if (!/\/v\d+$/.test(withoutEndpoint)) return `${withoutEndpoint}/v1`;
  return withoutEndpoint;
}

function getApiUrl(provider: string, settings?: AppSettings): string {
  switch (provider) {
    case 'groq': return 'https://api.groq.com/openai/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    // Gemini nutzt eine eigene URL, die das Modell enthält (:streamGenerateContent
    // bzw. :generateContent) — buildGeminiRequestUrl setzt sie zusammen. Der
    // Basis-Eintrag hier dient nur der "Provider bekannt"-Prüfung im Fallback-Loop.
    case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta';
    // Lokale KI (LM Studio): OpenAI-kompatibler chat/completions-Endpunkt auf
    // dem konfigurierten lokalen Server (Standard http://localhost:1234/v1).
    case 'lmstudio': return `${getLmStudioBaseUrl(settings)}/chat/completions`;
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function getApiKey(settings: AppSettings, provider: string): string | undefined {
  switch (provider) {
    case 'groq': return settings.groqApiKey;
    case 'openrouter': return settings.openRouterApiKey;
    case 'gemini': return settings.geminiApiKey;
    // LM Studio verlangt standardmäßig KEINEN Key — lokale Modelle laufen ohne
    // Registrierung. Ein optionaler settings.lmstudioApiKey erlaubt Server, die
    // doch einen erwarten. Ist beides leer, senden wir einen Füllwert ("local"),
    // damit der Provider im Fallback-Loop trotzdem als "konfiguriert" gilt und
    // nicht wegen eines fehlenden Keys übersprungen wird.
    case 'lmstudio': return settings.lmstudioApiKey?.trim() || 'local';
    default: return undefined;
  }
}

// ============ LM Studio (lokale KI) ============
//
// LM Studio (https://lmstudio.ai) stellt über seinen "Developer Server" eine
// OpenAI-kompatible REST-API bereit (Standard: http://localhost:1234/v1).
// Requests laufen komplett lokal — es werden keine Daten an Cloud-Anbieter
// gesendet und es fallen keine API-Kosten an. Das Format ist identisch zu
// Groq/OpenRouter (chat/completions + SSE-Streaming + tool_calls), daher reuse
// executeProviderCall; nur die URL- und Key-Auflösung unterscheidet sich.

/**
 * Live-Liste der beim lokalen Server verfügbaren Modelle (GET /v1/models).
 * Schlägt der Server nicht erreichbar fehl, kommt eine leere Liste zurück —
 * Aufrufer können dann auf MODEL_CATALOGS.lmstudio zurückgreifen.
 */
export async function fetchLmStudioModels(baseUrl?: string): Promise<string[]> {
  try {
    const response = await fetch(`${getLmStudioBaseUrl({ lmstudioBaseUrl: baseUrl })}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    const models = Array.isArray(data?.data) ? data.data : [];
    return models.map((m: any) => String(m?.id || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Erreichbarkeit + Modell-Liste des lokalen Servers prüfen (für Settings-UI).
 * Unterscheidet sauber zwischen "Server läuft nicht" (CORS-/Netzwerkfehler →
 * typischerweise TypeError "Failed to fetch") und HTTP-Fehlern.
 */
export async function checkLmStudioServer(baseUrl?: string): Promise<{ success: boolean; models: string[]; error?: string }> {
  const url = `${getLmStudioBaseUrl({ lmstudioBaseUrl: baseUrl })}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      return { success: false, models: [], error: `HTTP ${response.status} von ${url}` };
    }
    const data = await response.json().catch(() => null);
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m: any) => String(m?.id || ''))
      .filter(Boolean);
    if (models.length === 0) {
      return { success: true, models: [], error: 'Server erreichbar, aber kein Modell geladen — bitte in LM Studio ein Modell laden.' };
    }
    return { success: true, models };
  } catch (err: any) {
    return {
      success: false,
      models: [],
      error: `LM Studio nicht erreichbar (${url}). Developer-Server öffnen: LM Studio → Tab „Developer“ → „Start Server“ (CORS aktiviert lassen).`,
    };
  }
}

// ============ Google Gemini (Generative Language API) ============
//
// Gemini spricht NICHT das OpenAI-Format, sondern ein eigenes REST-API:
//   POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
//   POST .../models/<model>:streamGenerateContent?alt=sse   (SSE wie OpenAI)
// Authentifizierung: Header `x-goog-api-key`. Ein kostenloser API-Key ist ohne
// Kreditkarte unter https://aistudio.google.com/apikey erhältlich (Free-Tier).
//
// Formatunterschiede, die die folgenden Helfer abdecken:
// - System-Prompt: separates Feld `systemInstruction` statt system-Nachricht
// - Rollen: user/model statt user/assistant; Tool-Ergebnisse als
//   `{role:'user', parts:[{functionResponse:{name,response}}]}`
// - assistant tool_calls -> `parts:[{functionCall:{name,args}}]`
// - Tools: `{functionDeclarations:[{name,description,parameters}]}` (OpenAPI-Schema)
// - usageMetadata: promptTokenCount/candidatesTokenCount/totalTokenCount

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Some model ids arrive fully qualified (e.g. "google/gemini-2.5-flash" from
 *  copy-paste); the Generative Language API expects the bare model name.
 *  Retired ids are transparently mapped to their current successor (see
 *  resolveGeminiModel) so stored settings keep working after Google
 *  deprecates a model for new users (HTTP 404). */
function normalizeGeminiModelId(modelId: string): string {
  return resolveGeminiModel(modelId);
}

function buildGeminiRequestUrl(modelId: string, streaming: boolean): string {
  const model = normalizeGeminiModelId(modelId);
  const suffix = streaming ? ':streamGenerateContent?alt=sse' : ':generateContent';
  return `${GEMINI_BASE_URL}/models/${model}${suffix}`;
}

/**
 * Convert OpenAI-style provider messages into Gemini's request body fields.
 * Returns `contents` + `systemInstruction`. Consecutive same-role messages are
 * merged into one content entry because Gemini requires strictly alternating
 * user/model turns and rejects adjacent duplicates of the same role.
 */
export function toGeminiContents(messages: ProviderMessage[]): {
  contents: any[];
  systemInstruction?: { role: string; parts: { text: string }[] };
} {
  const contents: any[] = [];
  let systemText = '';

  const push = (role: string, parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.content || '');
      continue;
    }
    if (m.role === 'tool') {
      // Tool result -> functionResponse part. The originating assistant message
      // (with its functionCall parts) is already in `contents`, so no thought
      // signature is needed here (that is only required for thinking models'
      // own functionCall round-trips with valid signatures).
      push('user', [{
        functionResponse: {
          name: m.name || 'tool',
          response: parseToolResult(m.content),
        },
      }]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts: any[] = [];
      if ((m.content || '').trim()) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) {
        parts.push({
          functionCall: {
            name: tc.function?.name || tc.name || '',
            args: safeParseJson(tc.function?.arguments ?? tc.arguments ?? '{}', {}),
          },
        });
      }
      push('model', parts);
      continue;
    }
    // user (and anything unknown)
    push('user', [{ text: m.content || '' }]);
  }

  return {
    contents,
    systemInstruction: systemText
      ? { role: 'system', parts: [{ text: systemText }] }
      : undefined,
  };
}

function safeParseJson(str: string, fallback: any): any {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** Tool results travel as JSON strings on the OpenAI wire; Gemini wants an
 *  object in functionResponse.response. Non-JSON payloads are wrapped. */
function parseToolResult(content: string): any {
  const parsed = safeParseJson(content || '', null);
  if (parsed !== null && typeof parsed === 'object') return parsed;
  return { result: content ?? '' };
}

/** Strip keys that are invalid in the Gemini function-declaration schema. */
function toGeminiParameters(schema: any): any {
  const clean = normalizeJsonSchema(schema);
  if (clean && typeof clean === 'object') {
    // Gemini rejects `additionalProperties` in function parameter schemas.
    delete clean.additionalProperties;
    // propertyOrdering is a Gemini-specific hint; harmless but not needed.
    delete clean.propertyOrdering;
  }
  return clean;
}

function toGeminiTools(tools?: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const declarations = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiParameters(t.inputSchema),
  }));
  return [{ functionDeclarations: declarations }];
}

/** Map a finishReason to our refusal semantics so the fallback chain behaves
 *  exactly like it does for Groq/OpenRouter safety blocks. */
function geminiFinishReasonRefusal(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  return /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY/i.test(finishReason);
}

interface GeminiCallResult {
  content: string;
  usage: TokenUsage;
  toolCallCount: number;
  /** Raw OpenAI-shaped tool calls, forwarded via callbacks.onToolCall */
  toolCalls: any[];
  finishReason?: string;
}

function estimateTokensFromMessages(messages: ProviderMessage[]): number {
  return estimateTokens(messages);
}

/** Execute one Gemini request (streaming or non-streaming). */
async function executeGeminiCall(
  config: ModelConfig,
  apiKey: string,
  messages: ProviderMessage[],
  tools: any[] | undefined,
  callbacks: StreamCallbacks | undefined,
  combinedSignal: AbortSignal,
  settings: AppSettings,
): Promise<GeminiCallResult> {
  const streaming = !!callbacks?.onToken;
  const { contents, systemInstruction } = toGeminiContents(messages);

  const body: any = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;
  body.generationConfig = {
    maxOutputTokens: settings.maxTokensPerRequest,
    temperature: 0.7,
  };

  const url = buildGeminiRequestUrl(config.modelId, streaming);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Gemini authenticates via this header (NOT Authorization: Bearer).
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const err: any = new Error(`Provider error: ${response.status} - ${errorBody}`);
    err.status = response.status;
    throw err;
  }

  if (streaming) {
    return handleGeminiStreamingResponse(response, callbacks!, messages);
  }

  const data = await response.json();
  return extractGeminiResult(data, messages);
}

function extractGeminiResult(data: any, requestMessages?: ProviderMessage[]): GeminiCallResult {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  let content = '';
  const toolCalls: any[] = [];
  for (const p of parts) {
    if (p.text) content += p.text;
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `gemini_${toolCalls.length}`,
        type: 'function',
        function: {
          name: p.functionCall.name,
          // Gemini sends args as an object; chat.ts expects a JSON string.
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }

  const um = data?.usageMetadata || {};
  const promptTokens = um.promptTokenCount ||
    (requestMessages ? estimateTokensFromMessages(requestMessages) : 0);
  const completionTokens =
    (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0) ||
    Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4);
  const totalTokens = um.totalTokenCount || promptTokens + completionTokens;

  const usage: TokenUsage = {
    provider: 'gemini',
    model: '',
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: !um.promptTokenCount,
    timestamp: Date.now(),
  };

  return { content, usage, toolCallCount: toolCalls.length, toolCalls, finishReason: candidate?.finishReason };
}

/** Parse a Gemini SSE stream (`alt=sse` emits OpenAI-compatible `data:` frames). */
export async function handleGeminiStreamingResponse(
  response: Response,
  callbacks: StreamCallbacks,
  requestMessages?: ProviderMessage[],
): Promise<GeminiCallResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: any[] = [];

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const rest = line.slice(5);
    const data = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') chunks.push(parsed);
    } catch {
      // Skip malformed events (same policy as the OpenAI-style parser)
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  if (buffer) processLine(buffer);

  // Merge streamed candidates: text concatenates, functionCalls accumulate.
  let content = '';
  const toolCalls: any[] = [];
  let usageMetadata: any = null;
  let finishReason: string | undefined;
  for (const c of chunks) {
    const cand = c?.candidates?.[0];
    for (const p of cand?.content?.parts || []) {
      if (p.text) {
        content += p.text;
        callbacks.onToken(p.text);
      }
      if (p.functionCall?.name) {
        toolCalls.push({
          id: `gemini_${toolCalls.length}`,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        });
      }
    }
    if (cand?.finishReason) finishReason = cand.finishReason;
    if (c.usageMetadata) usageMetadata = c.usageMetadata;
  }

  for (const tc of toolCalls) callbacks.onToolCall(tc);

  const promptTokens = usageMetadata?.promptTokenCount ||
    (requestMessages ? estimateTokensFromMessages(requestMessages) : 0);
  const completionTokens = usageMetadata
    ? (usageMetadata.candidatesTokenCount ?? 0) + (usageMetadata.thoughtsTokenCount ?? 0)
    : Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4);
  const totalTokens = usageMetadata?.totalTokenCount || promptTokens + completionTokens;

  const usage: TokenUsage = {
    provider: 'gemini',
    model: '',
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: !usageMetadata,
    timestamp: Date.now(),
  };

  callbacks.onComplete(content, usage);
  return { content, usage, toolCallCount: toolCalls.length, toolCalls, finishReason };
}

/**
 * Normalise a tool input schema into minimal standard JSON Schema for the API
 * wire format. Tool schemas are plain objects today, but custom/workflow tools
 * can carry Zod-like instances with internal keys (`_def`, `typeName`, …) that
 * JSON.stringify happily serialises into the request body — every one of those
 * bytes is billed as PROMPT tokens on EVERY agent step (the tool list is
 * re-sent with each request). Recursively strip non-standard keys and drop
 * empty descriptions so only what the model actually needs goes over the wire.
 */
export function normalizeJsonSchema(schema: any): any {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizeJsonSchema);

  // Zod-style instance: take its embedded JSON definition when present.
  const def = schema._def?.schema ?? schema._def ?? schema;

  const STANDARD_KEYS = [
    'type', 'properties', 'items', 'required', 'enum', 'description',
    'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'format',
    'minimum', 'maximum', 'default',
  ];
  const out: Record<string, any> = {};
  for (const key of Object.keys(def)) {
    if (!STANDARD_KEYS.includes(key)) continue;
    const value = def[key];
    if (key === 'description' && (typeof value !== 'string' || !value.trim())) continue;
    out[key] = normalizeJsonSchema(value);
  }
  return out;
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
  // Lokale Modelle (LM Studio) laden beim ersten Request oft sekundenlang die
  // Gewichte in den RAM/VRAM — dieser "kalte Start" schlägt regelmäßig gegen
  // das globale maxCallDuration-Timeout (Standard 120s), obwohl der Server
  // perfectly gesund ist. Wir erlauben einmalig ein deutlich längeres Budget
  // für das erste lmstudio-Slot, das den Timeout tatsächlich auslöst. Danach
  // bleibt das Modell im Speicher und antwortet schnell.
  let localColdStartAllowed = false;
  // Refusal tracking: if EVERY model in the chain refused the request (content
  // policy) instead of failing technically, the caller should be able to tell
  // "all models declined" apart from "all models errored" — and must NOT treat
  // a refusal as a reason to re-run work that was already completed.
  let sawRefusal = false;
  // Track whether any slot actually reached the network this request. If not,
  // an eventual AuthProviderError would be misleading (no key was ever tested).
  let attemptedAnyCall = false;
  // Auth failure tracking: a 401/403 means the stored API key for THIS provider
  // is invalid. Models of OTHER providers in the chain can still answer, so we
  // skip every slot of the broken provider (see `authFailedProviders` below)
  // instead of letting each one fail with the same error. If NO model could
  // answer at all, the final error is an AuthProviderError — fatal and NOT
  // resumable, because "Fortsetzen" would re-send the entire prompt (system
  // prompt + history + tools, observed ~9-13k tokens per click) and hit the
  // identical 401 again without ever producing an answer.
  const authFailedProviders = new Set<string>();
  let sawAuthFailure = false;
  // Config errors (e.g. "Unknown provider") are thrown synchronously by
  // getApiUrl for EVERY slot that references the same broken provider string.
  // Retrying them against all 7 fallbacks just repeats the identical failure
  // and hides the real cause behind a generic final error — fail fast instead.
  const seenConfigErrors = new Set<string>();

  for (let attemptIdx = 0; attemptIdx < modelConfigs.length; attemptIdx++) {
    const config = modelConfigs[attemptIdx];
    // Provider's key already proven invalid this request: don't even reserve
    // TPM budget or send the prompt again — skip straight to the next slot.
    if (authFailedProviders.has(config.provider)) {
      continue;
    }
    let apiUrl: string;
    try {
      apiUrl = getApiUrl(config.provider, settings);
    } catch (err: any) {
      lastError = err;
      if (!seenConfigErrors.has(err.message)) {
        seenConfigErrors.add(err.message);
        await addLog({ level: 'warn', message: `Provider-Konfiguration: ${err.message}`, timestamp: Date.now() });
      }
      continue;
    }
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
      // AUSNAHME lmstudio (lokale KI): Lokale Modelle verursachen KEINE API-
      // Kosten und werden nicht von Anbieter-Rate-Limits gedrosselt — ihr
      // Durchsatz ergibt sich aus der Hardware. Sie würden durch das globale
      // TPM-Budget unnötig blockiert (Reservierung schlägt bei großen Prompts
      // z. B. permanent fehl). Token-Verbrauch wird trotzdem weiter protokolliert.
      const isLocalProvider = config.provider === 'lmstudio';
      const estimatedTokens = estimateTokens(messages);
      const maxOutput = settings.maxTokensPerRequest;
      const totalEstimated = estimatedTokens + maxOutput;

      if (!isLocalProvider) {
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
      }

      // Gemini speaks its own REST dialect (contents/parts/functionCall), not
      // the OpenAI chat-completions format. executeGeminiCall performs the
      // translation and returns the same shape as executeProviderCall, so all
      // downstream logic (refusal detection, empty-response handling, TPM) is
      // provider-independent.
      // Gemini spricht NICHT das OpenAI-Format, sondern ein eigenes REST-API —
      // executeGeminiCall übersetzt. Lokale LM-Studio-Server sprechen dagegen
      // exakt das OpenAI-Format (chat/completions inkl. SSE + tool_calls) und
      // laufen deshalb über den normalen executeProviderCall-Pfad; einzige
      // Besonderheit: kalter Modell-Start bekommt einmalig mehr Zeitfenster.
      const localExtendedTimeout =
        config.provider === 'lmstudio' && !localColdStartAllowed;
      if (localExtendedTimeout) localColdStartAllowed = true;

      const geminiResult = config.provider === 'gemini'
        ? await executeGeminiCall(config, apiKey, messages, tools, callbacks, buildAbortSignal(settings, abortSignal), settings)
        : await executeProviderCall(
            config, apiKey, apiUrl, messages, tools, callbacks, abortSignal, settings,
            localExtendedTimeout
          );
      const result = {
        content: geminiResult.content,
        usage: geminiResult.usage,
        toolCallCount: geminiResult.toolCallCount,
      };

      // Refusal check: the call technically succeeded (HTTP 200) but the model
      // declined to answer. Treat it like a failed attempt so the NEXT model
      // in the fallback chain answers the SAME request with the SAME message
      // history — already completed work (tool results, earlier steps) stays
      // part of the conversation and is NOT re-run from scratch.
      // For Gemini a safety block shows up as finishReason=SAFETY/... (the text
      // may be empty or truncated), which text-based detectRefusal cannot see.
      const geminiBlocked = config.provider === 'gemini' &&
        geminiFinishReasonRefusal((geminiResult as GeminiCallResult).finishReason);
      if (geminiBlocked || detectRefusal(result.content)) {
        // The refusing model consumed budget; account for its real usage
        // before handing over to the fallback.
        tpmManager.recordUsage(config.provider, result.usage.totalTokens, reservationId ?? undefined);
        reservationId = null;
        await recordTokenUsage({ ...result.usage, provider: config.provider, model: config.modelId });
        sawRefusal = true;
        throw new ModelRefusalError(config.modelId, config.provider, result.content);
      }

      // Silent refusal: no text AND no tool calls — the model answered with an
      // empty, useless reply (common with weak/free models once the prompt
      // carries tool results). Without this check the agent loop would end the
      // turn "successfully" with an empty message: the user sees NO answer
      // although every previous step already burned tokens. Hand the identical
      // request to the next model in the chain instead.
      if (isEmptyResponse(result.content, result.toolCallCount)) {
        tpmManager.recordUsage(config.provider, result.usage.totalTokens, reservationId ?? undefined);
        reservationId = null;
        await recordTokenUsage({ ...result.usage, provider: config.provider, model: config.modelId });
        sawRefusal = true;
        throw new EmptyResponseError(config.modelId, config.provider);
      }

      // Update TPM with actual usage AND release this request's reservation in
      // one step. Previously the reservation was never released on success, so
      // its tokens were double-counted (reserved + used) until the 30s expiry.
      tpmManager.recordUsage(config.provider, result.usage.totalTokens, reservationId ?? undefined);
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

      // Auth failure (401/403): the key for THIS provider is invalid. Do NOT
      // abort the whole chain here — other providers' models can still answer.
      // Remember the broken provider so every remaining slot referencing it is
      // skipped without re-sending the (expensive) prompt, then fall through to
      // the next model. If nothing in the chain answers, the final error below
      // becomes an AuthProviderError (fatal, non-resumable).
      if (err.status === 401 || err.status === 403) {
        sawAuthFailure = true;
        authFailedProviders.add(config.provider);
        await addLog({
          level: 'warn',
          message: `Authentifizierung fehlgeschlagen für ${config.provider} (${config.modelId}) – API-Key prüfen; Modell wird übersprungen.`,
          timestamp: Date.now(),
        });
        continue;
      }

      // Rate limited, try fallback
      if (err.status === 429) {
        continue;
      }

      // Deprecated model (Google: HTTP 404 "This model models/<id> is no
      // longer available to new users"). The message contains the model name,
      // so log which id should be swapped for its successor — otherwise the
      // user only sees a bare "404" in the logs. (The request URL itself is
      // already built via resolveGeminiModel, which transparently maps known
      // retired ids to their current successor.)
      if (err.status === 404 && config.provider === 'gemini') {
        await addLog({
          level: 'warn',
          message: `Modell "${config.modelId}" ist bei Google nicht mehr verfügbar (404) – bitte in den Einstellungen durch ein aktuelles Gemini-Modell ersetzen. Fallback übernimmt.`,
          timestamp: Date.now(),
        });
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

  // No model answered and at least one provider rejected the credentials:
  // surface the AUTH problem as the final error (not a generic last-error like
  // a downstream budget/timeout message). AuthProviderError is fatal and NOT
  // marked as refusal — chat.ts must not offer "Fortsetzen" for it, because a
  // resume without a corrected API key re-sends the whole prompt (~9-13k
  // tokens) only to hit the identical 401 again.
  if (sawAuthFailure) {
    throw new AuthProviderError([...authFailedProviders].join(', '));
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

  // Every model in the chain answered with an empty, useless reply (no text,
  // no tool calls). Surface that precisely instead of the generic last-error
  // text — the user otherwise sees an unexplained failure after a high token
  // spend. `refusal = true` keeps the turn resumable via "Fortsetzen".
  if (lastError instanceof EmptyResponseError) {
    const emptyErr: any = new Error(
      'Alle Modelle lieferten eine leere Antwort ohne Tool-Aufrufe. Fortschreiten Sie mit „Fortsetzen“ oder versuchen Sie es erneut.'
    );
    emptyErr.refusal = true;
    emptyErr.name = 'EmptyResponseError';
    throw emptyErr;
  }

  throw lastError || new Error('All models failed');
}

/**
 * Build the abort signal enforcing settings.maxCallDuration, combined with the
 * caller's own abort signal (Esc / "Abbrechen"). Shared by executeProviderCall
 * and the Gemini path so both respect the same timeout semantics.
 */
function buildAbortSignal(settings: AppSettings, userSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1000, settings.maxCallDuration || 120000)
  );
  return userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
}

async function executeProviderCall(
  config: ModelConfig,
  apiKey: string,
  url: string,
  messages: ProviderMessage[],
  tools: any[] | undefined,
  callbacks: StreamCallbacks | undefined,
  abortSignal: AbortSignal | undefined,
  settings: AppSettings,
  /** LM Studio (lokaler Server): längeres Timeout für den kalten Start des
   *  ersten lokalen Aufrufs (Modell wird in RAM/VRAM geladen). */
  extendedTimeout = false
): Promise<{ content: string; usage: TokenUsage; toolCallCount: number }> {
  // NOTE: the request URL is resolved by the caller (callProvider) BEFORE the
  // TPM reservation — an unknown provider must fail fast without ever
  // reserving/consuming budget. Previously getApiUrl ran here, after the
  // reservation was already made.
  
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
    // NOTE: the `tools` array is billed as PROMPT tokens on EVERY request —
    // including every follow-up step of an agent loop, where the whole tool
    // catalogue is re-sent alongside the growing message history. Keep the
    // wire format minimal here: OpenRouter/Groq accept a JSON Schema object
    // directly in `parameters`, so Zod-style schemas (which carry internal
    // keys like `_def`/`typeName` that add nothing for the model but cost
    // thousands of prompt tokens) are normalised down to standard JSON Schema
    // before being sent.
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeJsonSchema(t.inputSchema),
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

  // LM Studio & die meisten lokalen Server ignorieren den Authorization-Header;
  // weglassen schadet nie und vermeidet Verwirrung, falls der Nutzer keinen
  // Key gesetzt hat (der Füllwert "local" würde sonst als echter Key aussehen).
  if (config.provider === 'lmstudio' && !String(settings.lmstudioApiKey || '').trim()) {
    delete headers['Authorization'];
  }

  // Enforce settings.maxCallDuration: previously this value was persisted and
  // shown in Settings but never applied — a hung provider request (or a stream
  // that stalls mid-response) would block the agent loop indefinitely. Combine
  // the caller's abort signal with a per-call timeout signal so BOTH user aborts
  // (Esc / "Abbrechen") and the timeout cancel the fetch. AbortError keeps its
  // name, so callProvider's `err.name === 'AbortError'` rethrow still works.
  // Lokale Server (LM Studio) bekommen beim kalten Start ein deutlich längeres
  // Budget: das Entladen des Modells in RAM/VRAM kann mehrere Minuten dauern,
  // obwohl der Server gesund ist (extendedTimeout, einmalig pro Request).
  const effectiveMaxCallDuration = extendedTimeout
    ? Math.max(settings.maxCallDuration || 120000, LOCAL_COLD_START_MAX_DURATION)
    : settings.maxCallDuration;
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1000, effectiveMaxCallDuration || 120000)
  );
  const combinedSignal = abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err: any) {
    if (timeoutSignal.aborted && !abortSignal?.aborted) {
      const tErr = new Error(
        `Modell-Aufruf nach ${effectiveMaxCallDuration}ms abgebrochen (maxCallDuration überschritten).`
      );
      tErr.name = 'TimeoutError';
      throw tErr;
    }
    // LM Studio läuft nicht / Server gestoppt → fetch schlägt mit einem
    // Netzwerkfehler (meist TypeError "Failed to fetch") fehl — aber nur, wenn
    // der Nutzer den Aufruf nicht selbst abgebrochen hat (echter AbortError).
    if (config.provider === 'lmstudio' && err?.name !== 'AbortError') {
      const hint: any = new Error(
        `LM Studio ist nicht erreichbar (${url}). Developer-Server starten: LM Studio → Tab „Developer“ → „Start Server“. ` +
        `Falls ein anderer Port/IP genutzt wird, in den Einstellungen unter „Lokale KI (LM Studio)“ anpassen. Ursprünglicher Fehler: ${err.message || err.name}`
      );
      hint.name = 'LocalServerUnavailable';
      hint.status = 503;
      throw hint;
    }
    throw err;
  }

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
    return {
      content,
      usage,
      toolCallCount: data.choices?.[0]?.message?.tool_calls?.length || 0,
    };
  }
}

/**
 * Exported for tests: parses an OpenAI-style SSE stream, reassembles streamed
 * tool-call deltas (see the accumulator in the body) and emits exactly one
 * complete call per tool call via `callbacks.onToolCall`.
 */
export async function handleStreamingResponse(
  response: Response,
  callbacks: StreamCallbacks,
  requestMessages?: ProviderMessage[]
): Promise<{ content: string; usage: TokenUsage; toolCallCount: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  /**
   * Streaming tool calls arrive as DELTAS, not as complete objects: the first
   * chunk carries `{index, id, type, function:{name}}` and every following
   * chunk carries only a fragment of `function.arguments` (with an empty/
   * missing name and often no id at all). Forwarding each raw delta to
   * `onToolCall` used to register one "tool call" per fragment — producing
   * calls with an empty tool name ("Tool not found: ") or with only the first
   * letters of the arguments (`{"q` → parsed to `{}`, so web_search reported
   * 'Pflicht-Parameter "query" fehlt'). Reassemble deltas by `index` here and
   * emit exactly ONE complete call per tool call when the stream ends.
   */
  interface ToolCallAccumulator { id?: string; name: string; arguments: string }
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();
  let anonymousCallSeq = 0;
  // Total number of complete tool calls emitted via callbacks.onToolCall.
  // Needed by the caller to recognise "silent refusals": a reply with neither
  // text NOR tool calls is not a valid answer (see isEmptyResponse).
  let emittedToolCalls = 0;
  const flushToolCalls = () => {
    for (const [, acc] of toolCallAccumulators) {
      if (!acc.name && !acc.arguments) continue; // nothing meaningful streamed
      callbacks.onToolCall({
        id: acc.id || `call_stream_${anonymousCallSeq++}`,
        type: 'function',
        function: { name: acc.name, arguments: acc.arguments || '{}' },
      });
      emittedToolCalls++;
    }
    toolCallAccumulators.clear();
  };
  // SSE frames must be reassembled across network-chunk boundaries: a single
  // `data:` line can be split over two chunks (and one chunk can contain many
  // lines). Previously every partial line was fed to JSON.parse and silently
  // dropped, which randomly lost tokens/tool-calls whenever the TCP framing
  // didn't align with SSE line breaks.
  let buffer = '';
  let sawDone = false;
  // Tracks the most recent tool-call delta index, so continuation chunks that
  // omit `index` still merge into the right accumulator (see above).
  let lastToolCallIndex: number | undefined;

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const rest = line.slice(5);
    const data = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (data === '[DONE]') {
      sawDone = true;
      flushToolCalls();
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
          // Some providers omit `index` on continuation chunks; fall back to
          // the most recently seen index so fragments still merge correctly.
          const idx = typeof tc.index === 'number' ? tc.index : (lastToolCallIndex ?? 0);
          lastToolCallIndex = idx;
          let acc = toolCallAccumulators.get(idx);
          if (!acc) {
            acc = { id: tc.id, name: '', arguments: '' };
            toolCallAccumulators.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments;
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

    // Providers may close the stream without a `[DONE]` sentinel: make sure
    // accumulated tool-call fragments are still emitted exactly once.
    flushToolCalls();
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
  // toolCallCount lets the caller distinguish "empty but for tools" (a valid
  // intermediate step) from a truly empty, useless reply ("silent refusal").
  return { content: fullContent, usage, toolCallCount: emittedToolCalls };
}

export async function testConnection(provider: string, apiKey: string, modelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // LM Studio (lokale KI): kein API-Key nötig — geprüft wird die Erreichbar-
    // keit des lokalen Servers. Das `apiKey`-Argument wird hier als optionale
    // Basis-URL interpretiert (Leer = Standard http://localhost:1234/v1), damit
    // das Settings-UI denselben Test-Knopf wie bei den Cloud-Providern nutzen kann.
    if (provider === 'lmstudio') {
      const check = await checkLmStudioServer(String(apiKey || '').trim());
      if (!check.success) return { success: false, error: check.error };
      if (check.models.length === 0) return { success: false, error: check.error };
      if (modelId && !check.models.includes(modelId)) {
        return {
          success: false,
          error: `Server erreichbar, aber Modell "${modelId}" ist nicht geladen. Verfügbar: ${check.models.slice(0, 6).join(', ')}${check.models.length > 6 ? ' …' : ''}`,
        };
      }
      return { success: true };
    }

    // Gemini uses its own REST dialect + x-goog-api-key header — a minimal
    // generateContent call verifies key and model in one request.
    if (provider === 'gemini') {
      const response = await fetch(buildGeminiRequestUrl(modelId, false), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hello, respond with just "OK".' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        // Google meldet abgekündigte Modelle mit HTTP 404 und dem Hinweis
        // "no longer available to new users" — als Klartext zurückgeben,
        // statt den rohen JSON-Fehlerblock anzuzeigen. (Bekannte retired ids
        // werden von resolveGeminiModel bereits automatisch auf ihren
        // Nachfolger abgebildet; ein 404 bedeutet hier, dass das Modell
        // weder bekannt noch verfügbar ist.)
        if (response.status === 404 && /no longer available|NOT_FOUND/i.test(body)) {
          return { success: false, error: `Modell "${modelId}" ist bei Google nicht mehr verfügbar (404). Bitte ein aktuelles Gemini-Modell auswählen, z. B. „Gemini 3 Flash“ oder „Gemini Flash Latest“.` };
        }
        return { success: false, error: `${response.status}: ${body}` };
      }

      return { success: true };
    }

    // lmstudio wurde oben bereits über checkLmStudioServer behandelt — hier
    // erreichen wir den Cloud-Pfad nur noch für groq/openrouter.
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
