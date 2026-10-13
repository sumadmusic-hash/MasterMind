import type { ToolDefinition, ToolCall, ToolResult, Source } from '../types';
import { getSettings, addLog } from './database';

// scheduler.ts statically imports this module (setExecutionOrigin). Use a
// lazy dynamic import for the reverse direction so there is no ESM cycle.
async function loadScheduler() {
  return import('./scheduler');
}

/**
 * Per-turn marker for scheduler-initiated executions (set by AppContext via
 * `__setManualMarkerForTests`-style injection in scheduler.ts). Tools that
 * WRITE persistent state (memory, positions, scheduled jobs) refuse to run
 * inside an automated background run unless the job explicitly opts in with
 * `allowInScheduledRun: true` — a cron-triggered workflow must never silently
 * rewrite the user's memory or depot.
 */
let currentExecutionOrigin: 'user' | 'scheduled' = 'user';
export function setExecutionOrigin(origin: 'user' | 'scheduled'): void {
  currentExecutionOrigin = origin;
}
export function getExecutionOrigin(): 'user' | 'scheduled' {
  return currentExecutionOrigin;
}

/** Throwing guard used by all write-capable tools registered after Phase 1. */
function assertInteractive(args: any): void {
  if (currentExecutionOrigin === 'scheduled' && args?.allowInScheduledRun !== true) {
    throw new Error(
      'Blockiert: Dieser Schreibzugriff läuft in einem automatisierten Scheduler-Run. ' +
      'Für geplante Jobs bewusst nur lesende Tools verwenden oder im Job `allowInScheduledRun: true` setzen.'
    );
  }
}

/**
 * True when the CURRENT turn was started by the scheduler (not the user).
 * Used by chat.ts to disable interactive features (e.g. automatic memory
 * injection) during background runs.
 */
export function isScheduledRunActive(): boolean {
  return currentExecutionOrigin === 'scheduled';
}

/**
 * Reject unknown / misspelled argument names instead of silently ignoring them.
 * LLMs happily invent parameters (`{ locationg: "Berlin" }`), which used to
 * produce empty results and made the model retry the same broken call over and
 * over — burning TPM budget and tool steps. Returning a precise error with the
 * valid names lets the model self-correct on the very next step.
 */
/**
 * Coerce the JSON-ish values LLMs actually emit into the types declared in the
 * tool schema. Models send numbers as strings (`"4"`), booleans as `"true"` /
 * `"1"` / `"ja"`, and invent empty placeholders (`""`, `"null"`, `"none"`) for
 * optional parameters. Without coercion every such call dies in validation and
 * burns a retry step + TPM budget; with coercion the same call just works.
 * Mutates and returns `args` (callers pass a shallow copy).
 */
export function coerceToolArguments(
  inputSchema: Record<string, any>,
  args: Record<string, any>
): Record<string, any> {
  const props = (inputSchema?.properties || {}) as Record<string, any>;
  // Only touch declared properties — unknown keys must survive untouched so
  // validateToolArguments can still reject invented parameters.
  for (const name of Object.keys(args)) {
    const spec = props[name];
    if (!spec) continue;
    const value = args[name];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (spec?.type === 'number') {
      // ""/"null"/"none" are placeholder noise → treat as absent (default applies).
      if (trimmed === '' || /^(null|none|n\/a|-)$/i.test(trimmed)) { delete args[name]; continue; }
      const n = Number(trimmed.replace(/[\s_]/g, '').replace(',', '.'));
      if (Number.isFinite(n)) args[name] = n;
    } else if (spec?.type === 'boolean') {
      if (trimmed === '' || /^(null|none|n\/a|-)$/i.test(trimmed)) { delete args[name]; continue; }
      if (/^(true|1|yes|ja)$/i.test(trimmed)) args[name] = true;
      else if (/^(false|0|no|nein)$/i.test(trimmed)) args[name] = false;
    } else if (spec?.type === 'string') {
      // Empty placeholders for optional strings would trip the "missing/empty"
      // required check or leak junk into the implementation — drop them.
      if ((trimmed === '' || /^(null|none)$/i.test(trimmed)) && !(inputSchema?.required || []).includes(name)) {
        delete args[name];
      }
    }
  }
  return args;
}

export function validateToolArguments(
  inputSchema: Record<string, any>,
  args: Record<string, any>
): string[] {
  const problems: string[] = [];
  const props = (inputSchema?.properties || {}) as Record<string, any>;
  const required = (inputSchema?.required || []) as string[];
  // O(1) membership instead of Array.includes inside the per-key loop — this
  // runs on EVERY tool call in the agent loop.
  const known = new Set(Object.keys(props));

  for (const key of Object.keys(args || {})) {
    if (!known.has(key)) {
      problems.push(
        `Unbekannter Parameter "${key}". Erlaubte Parameter: ${[...known].join(', ') || 'keine'}.`
      );
    }
  }

  for (const name of required) {
    const v = args?.[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      problems.push(`Pflicht-Parameter "${name}" fehlt oder ist leer.`);
    }
  }

  for (const [name, spec] of Object.entries(props)) {
    const value = args?.[name];
    if (value === undefined || value === null || value === '') continue;
    if (spec?.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) problems.push(`Parameter "${name}" muss eine Zahl sein.`);
    }
    if (spec?.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`Parameter "${name}" muss ein Boolean sein (true/false).`);
    }
    if (Array.isArray(spec?.enum)) {
      // Accept case-insensitive enum matches ("TECH" → "tech") instead of
      // forcing a wasted retry round-trip on pure casing differences.
      if (!spec.enum.includes(value)) {
        const ci = typeof value === 'string'
          ? spec.enum.find((e: any) => typeof e === 'string' && e.toLowerCase() === value.toLowerCase())
          : undefined;
        if (ci !== undefined) args[name] = ci;
        else problems.push(`Parameter "${name}" muss einer der Werte sein: ${spec.enum.join(', ')}.`);
      }
    }
  }

  return problems;
}

/**
 * Keyword-based tool selection for the LLM tool catalogue (token saving).
 *
 * The full catalogue (~29 tools) costs roughly 7k prompt tokens and is sent
 * with EVERY provider call — including every follow-up step of an agent loop.
 * For a simple question like "wer ist friedrich merz?" that dwarfs the actual
 * answer (~300 tokens) and inflated a single turn to ~20k tokens. This helper
 * keeps only the tools plausibly relevant for the current user query plus a
 * small always-on core set, so generic research still works.
 *
 * Pure function (no registry state) so it is unit-testable in isolation.
 */
const TOOL_CORE_IDS = ['ddg_web_search', 'url_fetch'];

const TOOL_KEYWORDS: Record<string, string[]> = {
  web_search: ['websearch', 'websuche', 'suche im web', 'search the web'],
  news_search: ['news', 'nachricht', 'presse', 'headline', 'aktuelles'],
  gnews_search: ['news', 'nachricht', 'presse', 'gnews'],
  gnews_top_headlines: ['news', 'schlagzeile', 'headline', 'top story'],
  weather_lookup: ['wetter', 'weather', 'temperatur', 'regen', 'prognose', 'sonne', 'grad'],
  economic_calendar: ['wirtschaftskalender', 'economic calendar', 'cpi', 'arbeitsmarkt', 'zinssatz', 'ezb', 'fed ', 'inflation'],
  translate_text: ['übersetz', 'translate', 'dolmetsch', 'sprache übersetzen'],
  calculator: ['rechn', 'calculat', 'mathematik', 'quadratwurzel', 'prozent', 'formel'],
  currency_convert: ['währung', 'currency', 'fx', 'euro', 'dollar', 'usd', 'eur', 'franken', 'devisen', 'wechselkurs'],
  company_lookup: ['unternehmen', 'company', 'konzern', 'ticker', 'firma', 'ceo', 'vorstand'],
  stock_price: ['aktie', 'stock', 'kurs', 'preis', 'dax', 'mdax', 'sdax', 'tecdax', 'divdax', '^gspc', 's&p', 'nasdaq', 'bitcoin', 'krypto', 'crypto', 'wertpapier', 'share'],
  stock_analysis: ['aktie', 'stock', 'chart', 'analyse', 'trend', 'performance', 'volatil', 'rsi', 'macd', 'dax', 'bitcoin', 'krypto', 'crypto'],
  data_filter: ['filtern', 'sortieren', 'dedup', 'daten filtern', 'liste filtern'],
  text_summarize: ['zusammenfass', 'summary', 'summarize', 'fasse', 'kurzfass'],
  generate_report: ['bericht', 'report', 'studie', 'research', 'recherch', 'analyse erstellen'],
  memory_save: ['merk dir', 'merken', 'speicher dir', 'gedächtnis', 'memory', 'präferenz', 'prefere'],
  memory_recall: ['erinnerst', 'erinnere', 'gedächtnis', 'memory', 'weißt du noch', 'weiss du noch'],
  memory_forget: ['vergiss', 'vergesse', 'löschen aus dem gedächtnis', 'forget'],
  macro_series: ['inflation', 'bip', 'gdp', 'arbeitslosigkeit', 'unemployment', 'zins', 'macro', 'fred', 'konjunktur'],
  portfolio_update: ['depot', 'portfolio', 'position kaufen', 'position verkaufen', 'bestandsliste'],
  portfolio_overview: ['depot', 'portfolio', 'übersicht depot'],
  schedule_create: ['plan', 'kalender', 'scheduling', 'termin', 'täglich', 'taguell', 'cron', 'erinner mich', 'remind', 'um \\d+:\\d+', 'jede woche', 'jeden tag'],
  schedule_list: ['geplante', 'scheduled jobs', 'aufträge', 'zeitplan'],
  schedule_remove: ['plan löschen', 'job löschen', 'zeitplan entfernen', 'scheduled remove'],
  chart_spec: ['diagramm', 'chart', 'graph', 'visualisier', 'plot'],
  export_file: ['export', 'herunterladen', 'download', 'datei speichern', 'csv speichern', 'als datei'],
  import_file: ['import', 'datei hochladen', 'upload', 'csv-Datei', 'meine datei'],
};

/**
 * Returns the enabled tools relevant for `query`. Guarantees: at least the
 * core search/fetch tools are present, and the result never exceeds
 * MAX_SELECTED_TOOLS (extra matches are dropped in registry order). When the
 * query matches nothing specific, only the core set is returned — cheap by
 * design, because the model can always fall back to web search.
 */
export function selectRelevantTools(tools: ToolDefinition[], query: string): ToolDefinition[] {
  const MAX_SELECTED_TOOLS = 8;
  const q = (query || '').toLowerCase();
  if (!q.trim()) return tools.filter(t => TOOL_CORE_IDS.includes(t.id));

  const core = new Set(TOOL_CORE_IDS);
  const matchedIds = new Set<string>();
  for (const [toolId, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (core.has(toolId)) continue;
    if (keywords.some(k => q.includes(k))) matchedIds.add(toolId);
  }
  // Broad fallback: any question that looks open-ended ("wer/was/wo/wie…")
  // gets the report/search family via the core set already; nothing extra.
  const selected = tools.filter(t => core.has(t.id) || matchedIds.has(t.id));
  if (selected.length > MAX_SELECTED_TOOLS) {
    // Keep core tools first, then fill up with matches in registry order.
    const cores = selected.filter(t => core.has(t.id));
    const rest = selected.filter(t => !core.has(t.id));
    return [...cores, ...rest].slice(0, MAX_SELECTED_TOOLS);
  }
  return selected;
}

// Built-in tool implementations
class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private implementations: Map<string, (args: any) => Promise<any>> = new Map();

  private resolveCache = new Map<string, string>();

  register(tool: ToolDefinition, implementation: (args: any) => Promise<any>): void {
    this.tools.set(tool.id, tool);
    this.implementations.set(tool.id, implementation);
    // Near-miss resolution depends on the full tool set — drop the memo.
    this.resolveCache.clear();
  }

  getTool(id: string): ToolDefinition | undefined {
    // Resolve near-miss ids (e.g. legacy "weather" -> "weather_lookup") the same
    // way execute() does, so lookups don't fail on renamed/typo'd tool ids.
    return this.tools.get(this.resolveToolId(id));
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Tool definitions sent to the model. NOTE: this catalogue is billed as
   * PROMPT TOKENS ON EVERY REQUEST — system prompt, full message history and
   * all previous tool results are re-sent alongside it on every step of an
   * agent loop. With ~29 registered tools the full catalogue costs roughly
   * 7k tokens per call (measured), which is why a trivial question like
   * "wer ist friedrich merz?" showed ~20k tokens in the UI even though the
   * answer itself was ~300 tokens. To keep simple questions cheap we select
   * only the tools that are plausibly relevant for the current turn and
   * always include a small core set (web search + url fetch) so the model
   * can still research anything. Models inventing an unselected tool simply
   * receive the existing "not found" error and can pick another one.
   */
  getToolDefinitionsForLLM(query?: string): any[] {
    // Only send inputSchema to the LLM — outputSchema is not part of the
    // OpenAI tool-call format and would only inflate prompt tokens.
    const enabled = this.getEnabledTools();
    const selected = query ? selectRelevantTools(enabled, query) : enabled;
    return selected.map(t => ({
      name: t.id,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** All enabled tool ids — used by error messages that must stay truthful
   *  about what exists even when the current request only offered a subset. */
  getEnabledToolIds(): string[] {
    return this.getEnabledTools().map(t => t.id);
  }

  /** Map near-miss tool ids onto real tools (exact → normalized → legacy alias → unique substring). */
  private resolveToolId(id: string): string {
    if (!id) return id;
    // Memoized: execute()/getTool()/toggleTool() resolve the same handful of
    // ids over and over, and the fallback path is O(#tools) with per-id regex
    // work. Entries are invalidated whenever the registry changes (register()).
    const cached = this.resolveCache.get(id);
    if (cached !== undefined) return cached;
    const resolved = this.computeResolveToolId(id);
    this.resolveCache.set(id, resolved);
    return resolved;
  }

  private computeResolveToolId(id: string): string {
    if (this.tools.has(id)) return id;
    const direct = [id.toLowerCase(), id.replace(/[-\s]/g, '_'), id.replace(/^get_|^fetch_|^lookup_/, ''), id.replace(/_$/, '')];
    for (const cand of direct) if (this.tools.has(cand)) return cand;
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(id);
    for (const toolId of this.tools.keys()) if (norm(toolId) === target) return toolId;
    const legacy: Record<string, string> = { weather: 'weather_lookup', forex: 'currency_convert', fx: 'currency_convert', calendar: 'economic_calendar' };
    if (legacy[target] && this.tools.has(legacy[target])) return legacy[target];
    const hits = [...this.tools.keys()].filter(t => norm(t).includes(target) || target.includes(norm(t)));
    return hits.length === 1 ? hits[0] : id;
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    // If the caller (user abort / turn cancellation) was already aborted, do
    // not even start the tool — previously execute() ignored the abort signal
    // entirely and ran every queued tool to completion (or maxDuration timeout)
    // after the user pressed "Abbrechen".
    if (signal?.aborted) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: 'Abgebrochen: Tool-Ausführung wurde nicht gestartet (Abort-Signal).',
        duration: 0,
        timestamp: Date.now(),
      };
    }

    const startTime = Date.now();
    // The model sometimes emits an id it invented or renamed ("weather" after
    // the weather_lookup rename, "get_weather", …). Resolve near-misses instead
    // of aborting a whole research chain over one typo'd tool name.
    const resolvedId = this.resolveToolId(call.toolId);
    if (resolvedId !== call.toolId) call = { ...call, toolId: resolvedId };
    const tool = this.tools.get(resolvedId);

    if (!tool) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Tool not found: ${call.toolId}. Verfuegbare Tools: ${[...this.tools.keys()].join(', ')}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    if (!tool.enabled) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Tool is disabled: ${tool.name}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    const impl = this.implementations.get(call.toolId);
    if (!impl) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `No implementation for tool: ${call.toolId}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    // Normalize LLM-emitted argument types BEFORE validation (see
    // coerceToolArguments), on a copy so the caller's original call object
    // (persisted in the chat history) stays untouched.
    const args = coerceToolArguments(tool.inputSchema, { ...(call.arguments || {}) });

    // Schema validation before execution (see validateToolArguments).
    const problems = validateToolArguments(tool.inputSchema, args);
    if (problems.length > 0) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Ungültige Argumente für "${tool.name}": ${problems.join(' ')}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    // Abort handling: race the implementation against the caller's abort
    // signal too, so a user cancel during a long-running tool (search, fetch)
    // ends the call immediately instead of waiting for maxDuration.
    let unsubscribeAbort: (() => void) | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Timeout handling. The handle is cleared once the race settles — the
      // previous version left a pending timer for up to maxDuration on EVERY
      // call (needless timers when many tools run per turn / scheduler burst).
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Tool timeout after ${tool.maxDuration}ms`)), tool.maxDuration);
      });

      const abortPromise: Promise<never> | null = signal
        ? new Promise<never>((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('Tool-Ausführung abgebrochen.'), { name: 'AbortError' }));
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
            unsubscribeAbort = () => signal.removeEventListener('abort', onAbort);
            void resolve;
          })
        : null;

      const result = await Promise.race([
        impl(args),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      unsubscribeAbort?.();
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

      // Enforce the declared per-tool data limit (README: "strict timeouts and
      // data size limits"). An oversized payload would otherwise be re-sent as
      // prompt tokens on EVERY subsequent agent step of the turn.
      let data = result;
      if (tool.maxDataSize > 0) {
        try {
          const json = JSON.stringify(data ?? null);
          if (json && json.length > tool.maxDataSize) {
            data = {
              truncated: true,
              originalSize: json.length,
              limit: tool.maxDataSize,
              note: 'Tool-Ausgabe war zu groß und wurde begrenzt. Eingrenzen (weniger Treffer, kürzerer Zeitraum, weniger Felder) und erneut aufrufen.',
              preview: json.slice(0, Math.min(tool.maxDataSize, 2000)),
            };
          }
        } catch {
          // Circular/unserializable output: keep as-is — compactToolData still
          // caps strings/arrays before the result reaches the model.
        }
      }

      return {
        callId: call.id,
        toolId: call.toolId,
        success: true,
        data,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      unsubscribeAbort?.();
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: err.message || 'Unknown error',
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } finally {
      this.logSlowOrFailedCall(call.toolId, startTime);
    }
  }

  /**
   * Fire-and-forget observability (docs gap "Observability"): slow runs and
   * timeouts land in the app log (Dexie) so they are debuggable outside the
   * chat transcript. Only calls that took at least half the tool's timeout
   * are logged — normal fast calls never touch IndexedDB. addLog is guarded
   * with .catch(): logging must never break or slow down a tool call.
   */
  private logSlowOrFailedCall(toolId: string, startTime: number): void {
    const duration = Date.now() - startTime;
    const tool = this.tools.get(toolId);
    const maxDuration = tool?.maxDuration ?? 15000;
    if (duration < maxDuration / 2) return;
    addLog({
      level: duration >= maxDuration ? 'warn' : 'info',
      message: `Tool ${toolId}: langer Lauf (${duration} ms)${duration >= maxDuration ? ' — Timeout erreicht?' : ''}`,
      context: { toolId, duration },
      timestamp: Date.now(),
    }).catch(() => { /* IndexedDB nicht verfügbar (Tests) */ });
  }

  toggleTool(id: string, enabled: boolean): void {
    // Use the SAME resolution as execute()/getTool() (exact → normalized →
    // legacy alias → unique substring). A hand-rolled "direct candidates"
    // copy here previously lacked the legacy alias map, so toggling the
    // historical id "weather" silently did nothing while execution still
    // resolved it to weather_lookup — a hidden tool that could not be
    // disabled. The unique-substring rule cannot hit an ambiguous second
    // tool, so this can never toggle a different tool than requested.
    const resolved = this.resolveToolId(id);
    const tool = this.tools.get(resolved);
    if (tool) {
      tool.enabled = enabled;
    }
  }
}

export const toolRegistry = new ToolRegistry();
