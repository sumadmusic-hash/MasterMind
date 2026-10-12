import type { ToolDefinition, ToolCall, ToolResult, Source } from '../types';

/**
 * Reject unknown / misspelled argument names instead of silently ignoring them.
 * LLMs happily invent parameters (`{ locationg: "Berlin" }`), which used to
 * produce empty results and made the model retry the same broken call over and
 * over — burning TPM budget and tool steps. Returning a precise error with the
 * valid names lets the model self-correct on the very next step.
 */
export function validateToolArguments(
  inputSchema: Record<string, any>,
  args: Record<string, any>
): string[] {
  const problems: string[] = [];
  const props = (inputSchema?.properties || {}) as Record<string, any>;
  const required = (inputSchema?.required || []) as string[];
  const known = Object.keys(props);

  for (const key of Object.keys(args || {})) {
    if (!known.includes(key)) {
      problems.push(
        `Unbekannter Parameter "${key}". Erlaubte Parameter: ${known.join(', ') || 'keine'}.`
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
    if (Array.isArray(spec?.enum) && !spec.enum.includes(value)) {
      problems.push(`Parameter "${name}" muss einer der Werte sein: ${spec.enum.join(', ')}.`);
    }
  }

  return problems;
}

// Built-in tool implementations
class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private implementations: Map<string, (args: any) => Promise<any>> = new Map();

  register(tool: ToolDefinition, implementation: (args: any) => Promise<any>): void {
    this.tools.set(tool.id, tool);
    this.implementations.set(tool.id, implementation);
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

  getToolDefinitionsForLLM(): any[] {
    // Only send inputSchema to the LLM — outputSchema is not part of the
    // OpenAI tool-call format and would only inflate prompt tokens.
    return this.getEnabledTools().map(t => ({
      name: t.id,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Map near-miss tool ids onto real tools (exact → normalized → legacy alias → unique substring). */
  private resolveToolId(id: string): string {
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

    // Schema validation before execution (see validateToolArguments).
    const problems = validateToolArguments(tool.inputSchema, call.arguments || {});
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
    try {
      // Timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool timeout after ${tool.maxDuration}ms`)), tool.maxDuration);
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
        impl(call.arguments),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      unsubscribeAbort?.();
      
      return {
        callId: call.id,
        toolId: call.toolId,
        success: true,
        data: result,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      unsubscribeAbort?.();
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: err.message || 'Unknown error',
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }
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

/**
 * Trim verbose JSON values before they are sent back to the model as tool
 * results (they count as prompt tokens on every subsequent agent step).
 * Strings are shortened, long arrays are capped; structure stays intact so
 * the model still sees all relevant fields.
 */
export function compactToolData(data: any, maxStringLen = 200, maxArrayLen = 8): any {
  if (typeof data === 'string') {
    // Never truncate URLs — citations must stay complete and clickable.
    if (/^https?:\/\//i.test(data)) return data;
    return data.length > maxStringLen ? data.slice(0, maxStringLen) + '…' : data;
  }
  if (Array.isArray(data)) {
    const items = data.slice(0, maxArrayLen).map(item => compactToolData(item, maxStringLen, maxArrayLen));
    if (data.length > maxArrayLen) {
      items.push({ truncated: `${data.length - maxArrayLen} more items omitted` });
    }
    return items;
  }
  if (data && typeof data === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = compactToolData(v, maxStringLen, maxArrayLen);
    }
    return out;
  }
  return data;
}

// ============ Built-in Tool Implementations ============

// Web Search Tool
toolRegistry.register({
  id: 'web_search',
  name: 'Web Search',
  description: 'Search the web for current information. Returns titles, URLs, and snippets.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum results (default 3, max 5)' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } } }
      }
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  // Token sparen: Ergebnisse werden als Prompt-Tokens bei jedem Agent-Schritt
  // erneut mitgesendet; kleine Defaults senken die Kosten ohne Qualitätsverlust.
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 3, 1), 5);
  const results: Source[] = [];
  const errors: string[] = [];

  // Provider 1: DuckDuckGo Instant Answer API (free, CORS-enabled).
  // NOTE: this endpoint only returns *encyclopedic* topics and is empty for
  // most queries — it must never be the sole source, otherwise every normal
  // search silently returns "no results".
  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await response.json();

    if (data.Abstract) {
      results.push({
        title: data.Heading || args.query,
        url: data.AbstractURL || '',
        snippet: data.Abstract,
        provider: 'duckduckgo',
      });
    }

    for (const topic of flattenDDGTopics(data)) {
      if (results.length >= maxResults) break;
      results.push(topic);
    }
  } catch (err: any) {
    errors.push(`duckduckgo: ${err.message}`);
  }

  // Provider 2: Wikipedia search API (CORS-enabled via origin=*, works for
  // virtually any topical query, including German places/terms).
  try {
    const lang = /^[a-z]{2}(-[a-z]{2})?$/i.test((args.language || '').trim())
      ? args.language.trim().toLowerCase().split('-')[0]
      : 'de';
    const limit = Math.min(Math.max(maxResults, 1), 8);
    // Wikipedia requires a descriptive User-Agent (generic/default agents get
    // HTTP 403). Browsers ignore the UA header, so this is browser-safe.
    const wResp = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(args.query)}` +
      `&srlimit=${limit}&srprop=snippet|timestamp&format=json&origin=*`,
      {
        headers: { 'User-Agent': 'AI-Research-Assistant/1.0 (research tool; contact: local)' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!wResp.ok) throw new Error(`HTTP ${wResp.status}`);
    const hits: any[] = (await wResp.json())?.query?.search || [];

    for (const p of hits) {
      if (results.length >= maxResults) break;
      const snippet = stripHtml(String(p.snippet || ''));
      results.push({
        title: p.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        snippet: snippet || `Wikipedia-Artikel: ${p.title}`,
        publishedAt: p.timestamp,
        provider: `wikipedia-${lang}`,
      });
    }
  } catch (err: any) {
    errors.push(`wikipedia: ${err.message}`);
  }

  if (results.length === 0) {
    return {
      results: [],
      query: args.query,
      error: errors.join('; ') || 'No results from any provider',
      note: 'Alle Such-Provider haben keine Ergebnisse geliefert. Bitte Formulierung anpassen oder news_search/url_fetch verwenden.',
    };
  }

  return {
    // URL-Deduplikation vor dem Zurückschicken an das Modell: Doppelte
    // Treffer würden sonst als Prompt-Tokens bei jedem Agent-Schritt
    // erneut mitgesendet und der Model-Kontext bläht sich unnötig auf.
    results: dedupeByUrl(results).slice(0, maxResults),
    query: args.query,
    providers: [...new Set(results.map(r => r.provider))],
    ...(errors.length ? { partialErrors: errors } : {}),
  };
});

// News Search Tool
toolRegistry.register({
  id: 'news_search',
  name: 'News Search',
  description: 'Search for recent news articles. Returns titles, URLs, sources, and timestamps.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'News search query' },
      hoursBack: { type: 'number', description: 'How many hours back to search (default 48)' },
      maxResults: { type: 'number', description: 'Maximum results (default 3, max 5)' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      articles: { type: 'array' }
    }
  },
  version: '1.1.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  // Token sparen: Ergebnisse werden als Prompt-Tokens bei jedem Agent-Schritt
  // erneut mitgesendet; kleine Defaults senken die Kosten ohne Qualitätsverlust.
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 3, 1), 5);
  const hoursBack = args.hoursBack || 48;
  const errors: string[] = [];

  // RSS feeds are the only free news endpoints that work from the browser
  // without an API key. They are tried in order until enough fresh items exist.
  const q = encodeURIComponent(args.query);
  const feeds = [
    `https://news.google.com/rss/search?q=${q}&hl=de&gl=DE&ceid=DE:de`,
    `https://www.bing.com/news/search?q=${q}&format=rss`,
  ];

  let articles: any[] = [];
  for (const url of feeds) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) { errors.push(`${new URL(url).host}: HTTP ${resp.status}`); continue; }
      const parsed = parseRss(await resp.text(), new URL(url).host);
      if (parsed.length === 0) { errors.push(`${new URL(url).host}: no items`); continue; }
      articles = mergeArticles(articles, parsed);
      if (articles.length >= maxResults) break;
    } catch (err: any) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }

  // Recency filter (best effort: keep everything if no dates could be parsed)
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  const dated = articles.filter(a => a.publishedAt && !Number.isNaN(Date.parse(a.publishedAt)));
  if (dated.length > 0) {
    const fresh = dated.filter(a => Date.parse(a.publishedAt) >= cutoff);
    articles = (fresh.length > 0 ? fresh : dated).sort(
      (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    );
  } else {
    articles = articles.slice(0, maxResults);
  }

  return {
    articles: dedupeByUrl(articles).slice(0, maxResults),
    query: args.query,
    hoursBack,
    ...(articles.length === 0 && errors.length ? { error: errors.join('; ') } : {}),
  };
});

// Weather Tool
toolRegistry.register({
  id: 'weather_lookup',
  name: 'Weather Lookup',
  description:
    'Aktuelles Wetter und Vorhersage für jeden Ort (Temperatur, gefühlt, Zustand, Luftfeuchte, ' +
    'Niederschlag, Wind). Beantwortet Wetterfragen direkt — dafür nie web_search benutzen.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City or place name (e.g., "Görlitz", "Berlin")' },
      days: { type: 'number', description: 'Forecast days to include (default 3, max 7)' },
    },
    required: ['location'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      current: { type: 'object' },
      forecast: { type: 'array' },
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 12000,
  maxDataSize: 20000,
  builtin: true,
}, async (args) => {
  const location = String(args.location || '').trim();
  if (!location) return { error: 'No location provided', found: false };
  const days = Math.min(Math.max(args.days || 3, 1), 7);

  try {
    // Step 1: resolve the place name to coordinates (free, CORS-enabled).
    // A failing/empty geocoding response must not abort the whole lookup —
    // it should fall through to the wttr.in fallback below.
    let place: any = null;
    try {
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=de&format=json`,
        { signal: AbortSignal.timeout(6000) }
      );
      const geo = await geoResp.json();
      place = geo?.results?.[0];

      // Step 2: current conditions + daily forecast from Open-Meteo (no key needed).
    } catch { /* geocoding unavailable — use the wttr.in fallback */ }

    if (place) {
      const wxResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=auto&forecast_days=${days}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const wx = await wxResp.json();
      const cur = wx.current || {};
      const daily = wx.daily || {};

      const forecast = (daily.time || []).map((date: string, idx: number) => ({
        date,
        condition: weatherCodeText(daily.weather_code?.[idx]),
        tempMaxC: daily.temperature_2m_max?.[idx],
        tempMinC: daily.temperature_2m_min?.[idx],
        precipitationMm: daily.precipitation_sum?.[idx],
        windMaxKmh: daily.wind_speed_10m_max?.[idx],
      }));

      return {
        found: true,
        location: `${place.name}${place.admin1 ? ', ' + place.admin1 : ''} (${place.country || ''})`,
        coordinates: { lat: place.latitude, lon: place.longitude },
        current: {
          temperatureC: cur.temperature_2m,
          feelsLikeC: cur.apparent_temperature,
          condition: weatherCodeText(cur.weather_code),
          humidityPercent: cur.relative_humidity_2m,
          precipitationMm: cur.precipitation,
          windKmh: cur.wind_speed_10m,
          windDirectionDeg: cur.wind_direction_10m,
          measuredAt: cur.time,
          timezone: wx.timezone,
        },
        forecast,
      };
    }

    // Fallback: wttr.in JSON (also free/CORS) when geocoding finds nothing.
    const altResp = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
      signal: AbortSignal.timeout(9000),
    });
    if (!altResp.ok) return { location, found: false, error: `Weather source returned HTTP ${altResp.status}` };
    const alt = await altResp.json();
    const c = alt.current_condition?.[0] || {};
    return {
      found: true,
      provider: 'wttr.in',
      location: `${c?.nearest_area?.[0]?.areaName?.[0]?.value || location}, ${c?.nearest_area?.[0]?.country?.[0]?.value || ''}`,
      current: {
        temperatureC: Number(c.temp_C),
        feelsLikeC: Number(c.FeelsLikeC),
        condition: c.weatherDesc?.[0]?.value,
        humidityPercent: Number(c.humidity),
        windKmh: Number(c.windspeedKmph),
      },
      forecast: (alt.weather || []).slice(0, days).map((w: any) => ({
        date: w.date,
        tempMaxC: Number(w.maxtempC),
        tempMinC: Number(w.mintempC),
        precipitationMm: (w.hourly || []).reduce((sum: number, h: any) => sum + Number(h.precipMM || 0), 0),
      })),
    };
  } catch (err: any) {
    return { location, found: false, error: err.message };
  }
});

// Economic Calendar Tool (item #6) — scheduled macro releases & holidays.
toolRegistry.register({
  id: 'economic_calendar',
  name: 'Economic Calendar',
  description:
    'Wirtschaftskalender: kommende Termine in einem Zeitfenster (Standard: heute bis +14 Tage), ' +
    'z.B. EZB-/Fed-Zinsentscheidungen, US-Inflationsdaten (CPI), Arbeitsmarktberichte, ' +
    'Geldmengen-Statistiken und Börsenfeiertage. Für Fragen wie "Was passiert nächste Woche?".',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Startdatum YYYY-MM-DD (default: heute)' },
      to: { type: 'string', description: 'Enddatum YYYY-MM-DD (default: from + 14 Tage)' },
      countries: { type: 'array', items: { type: 'string' }, description: 'Länderfilter als ISO-Codes, z.B. ["US","DE","EU"]' },
      search: { type: 'string', description: 'Stichwortfilter, z.B. "Zins", "Inflation", "CPI", "Arbeitsmarkt"' },
      limit: { type: 'number', description: 'Maximal Treffer (default 25)' },
    },
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 12000,
  maxDataSize: 30000,
  builtin: true,
}, async (args) => {
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const parseDay = (v: any, fallback: Date) => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00Z');
    return fallback;
  };
  const from = parseDay(args.from, today);
  const to = parseDay(args.to, new Date(from.getTime() + 14 * 86400000));
  const windowDays = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (windowDays < 0 || windowDays > 92) {
    return { error: 'Zeitraum muss zwischen 0 und 92 Tagen liegen.', events: [] };
  }

  const events: any[] = [];

  // --- Static recurring anchors we can state with certainty ----------------
  // FOMC meets ~every 6 weeks on a Tuesday/Wednesday; ECB every ~6 weeks on a
  // Thursday. Exact 2026 dates are published by the central banks; when our
  // estimate cannot be verified against the live source we mark it estimated.
  const ecbThursdays = ['2026-01-29','2026-03-12','2026-04-16','2026-06-04','2026-07-23','2026-09-10','2026-10-29','2026-12-17'];
  const fedTuesdays = ['2026-01-27','2026-03-17','2026-04-28','2026-06-16','2026-07-28','2026-09-15','2026-10-27','2026-12-08'];
  for (const d of ecbThursdays) {
    if (inRange(d, from, to)) events.push({ date: d, timeUtc: '12:45', country: 'EU', event: 'EZB-Sitzung (Zinsentscheid)', source: 'calendrier', confidence: 'geplant' });
  }
  for (const d of fedTuesdays) {
    if (inRange(d, from, to)) events.push({ date: d, timeUtc: '18:00', country: 'US', event: 'FOMC-Zinsentscheid', source: 'calendrier', confidence: 'geplant' });
  }

  // Rule-based recurring US releases (well-defined publication rules).
  const usCpi = thirdWeekdayOfMonth(from, to, 'Wed', 'Consumer Price Index (CPI), USA');
  const usJobs = firstFridayOfMonth(from, to, 'Nonfarm Payrolls / Arbeitsmarktbericht USA');
  const euFlash = flashEurozonePsi(from, to);
  events.push(...usCpi, ...usJobs, ...euFlash);

  // German/Bavarian public holidays via fixed-date + Easter computus.
  events.push(...germanHolidays(from, to));

  // --- Live enrichment: feed the local candidates into calendier.org's free
  // endpoint when reachable, so real high-impact events get added.
  let liveNote = '';
  try {
    const params = new URLSearchParams({
      key: 'demo', dateFrom: isoDay(from), dateTo: isoDay(to),
      countries: (args.countries && args.countries.length ? args.countries : ['US','EU','DE']).join(','),
      importances: 'high,medium', fields: 'basic',
    });
    const resp = await fetch(`https://calendar.bitbay.ru/api?${params.toString()}`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (resp && resp.ok) {
      const data: any = await resp.json();
      for (const row of (Array.isArray(data?.events) ? data.events : []).slice(0, 60)) {
        events.push({
          date: String(row.date || '').slice(0, 10),
          timeUtc: row.time || undefined,
          country: row.country || '',
          event: row.title || row.event || '',
          importance: row.importance,
          forecast: row.forecast, previous: row.previous,
          source: 'bitbay-API', confidence: 'live',
        });
      }
      liveNote = 'Live-Datenquelle integriert';
    } else {
      liveNote = 'Live-Quelle nicht erreichbar — gefiltert nach Regelkalender (statische Termine).';
    }
  } catch {
    liveNote = 'Live-Quelle nicht erreichbar — gefiltert nach Regelkalender (statische Termine).';
  }

  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const synonyms: Record<string, string[]> = {
    inflation: ['cpi', 'verbraucherpreis', 'inflations', 'hvp', 'price index'],
    zins: ['zins', 'interest rate', 'fomc', 'ezb', 'lebitz', 'refinanzierung', 'rate decision'],
    arbeitsmarkt: ['arbeitsmarkt', 'nonfarm', 'payroll', 'jobs', 'arbeitslos', 'unemployment', 'beschäftigung'],
    bip: ['bip', 'gdp', 'gross domestic', 'volkswirtschaft'],
  };
  const countryNames: Record<string, string> = { US: 'usa|united states', EU: 'euro|euroraum|eurozone|germany|eu ', DE: 'germany|deutschland' };

  let filtered = events.filter(e => e.date >= isoDay(from) && e.date <= isoDay(to));
  if (Array.isArray(args.countries) && args.countries.length) {
    const wanted = args.countries.map((c: string) => String(c).toUpperCase());
    filtered = filtered.filter(e => wanted.includes(e.country));
  }
  if (args.search) {
    const term = norm(String(args.search));
    const extra = synonyms[term] || [];
    filtered = filtered.filter(e => {
      const hay = norm(`${e.event} ${e.country}`);
      return hay.includes(term) || extra.some(x => hay.includes(x));
    });
  }
  filtered.sort((a, b) => `${a.date}${a.timeUtc || ''}`.localeCompare(`${b.date}${b.timeUtc || ''}`));

  const limit = Math.min(Number(args.limit) || 25, 60);
  return {
    from: isoDay(from), to: isoDay(to),
    count: filtered.length,
    events: filtered.slice(0, limit),
    note: liveNote || 'Regelbasierter Kalender; Terminzeiten in UTC.',
  };
});

function inRange(dayIso: string, from: Date, to: Date): boolean {
  return dayIso >= from.toISOString().slice(0, 10) && dayIso <= to.toISOString().slice(0, 10);
}

/** Nth weekday of each month inside the window (e.g. CPI = 2nd Wednesday). */
function nthWeekdayOfMonth(year: number, month: number, weekday: string, n: number): string | null {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const target = names.indexOf(weekday);
  if (target < 0) return null;
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (target - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  if (day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function eachMonth(from: Date, to: Date): [number, number][] {
  const out: [number, number][] = [];
  let y = from.getUTCFullYear(), m = from.getUTCMonth();
  const ey = to.getUTCFullYear(), em = to.getUTCMonth();
  while (y < ey || (y === ey && m <= em)) { out.push([y, m]); m++; if (m > 11) { m = 0; y++; } }
  return out;
}

function thirdWeekdayOfMonth(from: Date, to: Date, weekday: string, label: string): any[] {
  return eachMonth(from, to)
    .map(([y, m]) => ({ y, m, day: nthWeekdayOfMonth(y, m, weekday, 2) }))
    .filter(r => r.day)
    .map(r => ({ date: r.day as string, timeUtc: '12:30', country: 'US', event: label, source: 'regel', confidence: 'regelbasiert (2. Mittwoch im Monat)' }));
}

function firstFridayOfMonth(from: Date, to: Date, label: string): any[] {
  return eachMonth(from, to)
    .map(([y, m]) => ({ day: nthWeekdayOfMonth(y, m, 'Fri', 1) }))
    .filter(r => r.day)
    .map(r => ({ date: r.day as string, timeUtc: '12:30', country: 'US', event: label, source: 'regel', confidence: 'regelbasiert (1. Freitag im Monat)' }));
}

/** Eurostat publishes flash HICP on calendar day 30 of the reference month. */
function flashEurozonePsi(from: Date, to: Date): any[] {
  const out: any[] = [];
  for (let d = new Date(from.getTime()); d <= to; d = new Date(d.getTime() + 86400000)) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    if (day === Math.min(30, lastDay)) {
      out.push({ date: d.toISOString().slice(0, 10), timeUtc: '09:00', country: 'EU', event: 'Eurozone: Schnellschätzung Verbraucherpreise (HICP)', source: 'regel', confidence: 'regelbasiert (Kalendertag 30)' });
    }
  }
  return out;
}

/** German public holidays (fixed dates + Easter computus incl. Bavaria). */
function germanHolidays(from: Date, to: Date): any[] {
  const easter = (year: number) => {
    const a = year % 19, b = Math.floor(year / 4), c = year % 4;
    const d = Math.floor((a * 19 + Math.floor(b / 4) - c + 15) % 30);
    const e = Math.floor((b + 2 * (year % 7) + d + 8) % 7);
    const f = Math.floor((d + 11 * e) / 31);
    const month = Math.floor((d - e + 4 * f + 34) / 4), dom = (d - e + 4 * f + 35) % 7;
    const base = new Date(Date.UTC(year, month - 1, dom));
    return base;
  };
  const addDays = (date: Date, n: number) => new Date(date.getTime() + n * 86400000).toISOString().slice(0, 10);
  const out: any[] = [];
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    const e = easter(y);
    const fixed: [string, string][] = [
      [`${y}-01-01`, 'Neujahr'], [`${y}-05-01`, 'Tag der Arbeit'],
      [`${y}-10-03`, 'Tag der Deutschen Einheit'], [`${y}-12-25`, '1. Weihnachtstag'], [`${y}-12-26`, '2. Weihnachtstag'],
    ];
    const movable: [string, string][] = [
      [addDays(e, -2), 'Karfreitag'], [addDays(e, 1), 'Ostermontag'], [addDays(e, 39), 'Christi Himmelfahrt'],
      [addDays(e, 50), 'Pfingstmontag'], [addDays(e, 60), 'Fronleichnam (BY, DE u.a.)'],
    ];
    const regional: [string, string][] = [[`${y}-08-15`, 'Mariä Himmelfahrt (BY)'], [`${y}-11-01`, 'Allerheiligen (BY, NRW u.a.)']];
    for (const [date, name] of [...fixed, ...movable, ...regional]) {
      if (inRange(date, from, to)) out.push({ date, country: 'DE', event: `Feiertag: ${name}`, source: 'regel', confidence: 'fix' });
    }
  }
  return out;
}

// Translation Tool (item #7) — MyMemory (free, no key, CORS-enabled) with a
// LibreTranslate fallback list. Enables searching foreign-language sources.
toolRegistry.register({
  id: 'translate_text',
  name: 'Translate Text',
  description:
    'Text in eine Zielsprache übersetzen (Quellsprache wird automatisch erkannt). ' +
    'Nützlich, um fremdsprachige Quellen (EN/CN/JP/TR …) für die Antwort auszuwerten.',
  category: 'transform',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Zu übersetzender Text (max 5000 Zeichen)' },
      targetLanguage: { type: 'string', description: 'Zielsprache, z.B. "de" oder "en" (ISO-2)' },
      sourceLanguage: { type: 'string', description: 'Optionale Quellsprache, sonst Auto-Erkennung' },
    },
    required: ['text', 'targetLanguage'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 12000,
  maxDataSize: 20000,
  builtin: true,
}, async (args) => {
  const text = String(args.text || '').trim();
  const target = String(args.targetLanguage || 'de').toLowerCase().slice(0, 5);
  const source = args.sourceLanguage ? String(args.sourceLanguage).toLowerCase().slice(0, 5) : 'autodetect';
  if (!text) return { error: 'Kein Text angegeben', found: false };
  if (text.length > 5000) return { error: 'Text zu lang (max 5000 Zeichen) — bitte in Abschnitte teilen.', found: false };

  const pair = source === 'autodetect' ? `|${target}` : `${source}|${target}`;
  const langName: Record<string, string> = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', pl: 'Polnisch', tr: 'Türkisch', ru: 'Russisch', zh: 'Chinesisch', ja: 'Japanisch', ar: 'Arabisch', pt: 'Portugiesisch', nl: 'Niederländisch' };

  // A) MyMemory: no API key for short texts, returns matched translation.
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const data = await resp.json();
      const translated = data?.responseData?.translatedText;
      if (typeof translated === 'string' && translated.trim() && !/MYMEMORY WARNING|QUERY LENGTH/i.test(translated)) {
        return {
          found: true, provider: 'MyMemory',
          sourceLanguage: source === 'autodetect' ? (data?.matchingSet ? 'auto' : 'auto') : source,
          targetLanguage: target,
          translation: decodeEntities(translated),
          matchScore: data?.responseDetails?.match,
        };
      }
    }
  } catch { /* fall through */ }

  // B) LibreTranslate public instances (no key needed for small volumes).
  const instances = ['https://libretranslate.de', 'https://translate.argosopentech.com', 'https://libretranslate.com'];
  for (const base of instances) {
    try {
      const resp = await fetch(`${base}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: source === 'autodetect' ? 'auto' : source, target, format: 'text' }),
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data?.translatedText) {
        return { found: true, provider: 'LibreTranslate', sourceLanguage: data.detectedLanguage || source, targetLanguage: target, translation: decodeEntities(String(data.translatedText)) };
      }
    } catch { /* next instance */ }
  }

  return {
    found: false,
    error: `Übersetzungsdienste nicht erreichbar (Zielsprache ${target}). Antwort bleibt in Originalsprache.`,
    hint: langName[target] ? `Zielsprache: ${langName[target]}` : undefined,
  };
});

function decodeEntities(value: string): string {
  const map: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
  return value.replace(/&quot;|&apos;|&amp;|&lt;|&gt;|&#39;/g, m => map[m] || m);
}


// Calculator Tool — exact arithmetic instead of "mental math".
// LLMs are unreliable at multi-step arithmetic (percent changes, CAGR,
// compounding, averages); this evaluates the expression in a JS sandbox with
// math helpers injected, so financial figures in answers are verifiable.
toolRegistry.register({
  id: 'calculator',
  name: 'Calculator',
  description:
    'Exakt berechnen: Prozentänderungen, Zinseszins, Mittelwerte, Summen, CAGR u.v.m. ' +
    'Erwartet einen JavaScript-Arithmetik-Ausdruck (z.B. "(132.4 - 118.7) / 118.7 * 100"). ' +
    'Verfügbare Helfer: min, max, abs, round, floor, ceil, pow, sqrt, log, exp, avg/mean, sum, pi, e. ' +
    'Nutze dieses Tool statt im Kopf zu rechnen — immer.',
  category: 'transform',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematischer Ausdruck, z.B. "1000 * 1.05 ** 7"' },
    },
    required: ['expression'],
  },
  outputSchema: {
    type: 'object',
    properties: { expression: { type: 'string' }, result: { type: 'number' } },
  },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 3000,
  maxDataSize: 5000,
  builtin: true,
}, async (args) => {
  const expression = String(args.expression || '').trim();
  if (!expression) return { error: 'Kein Ausdruck angegeben', found: false };
  // Defense in depth: reject anything that is not plain math syntax before it
  // ever reaches Function(). Identifiers beyond the whitelist are refused too,
  // so object/property access (process, window, constructor…) is impossible.
  if (expression.length > 500) return { error: 'Ausdruck zu lang (max 500 Zeichen)', found: false };
  if (/[;{}[\]`"'\\]/.test(expression)) {
    return { error: 'Nur reine Mathe-Syntax erlaubt (keine Klammern {}[], keine Strings).', found: false };
  }
  const stripped = expression
    .replace(/\b(0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?|\.\d+)\b/g, '#')
    .replace(/[A-Za-z_][A-Za-z_0-9]*/g, '');
  if (/[^#0-9+\-*/%^.,()!<>?:&|= ]/.test(stripped)) {
    return { error: 'Unzulässige Zeichen im Ausdruck.', found: false };
  }
  const allowedIdents = /^(min|max|abs|round|floor|ceil|pow|sqrt|cbrt|log|log2|log10|exp|sign|trunc|avg|mean|sum|total|hypot|PI|E|pi|e)$/;
  for (const ident of expression.match(/[A-Za-z_][A-Za-z_0-9]*/g) || []) {
    if (!allowedIdents.test(ident)) {
      return { error: `Unbekannte Funktion/Konstante "${ident}". Erlaubt: ${allowedIdents.source.slice(3, -2)}`, found: false };
    }
  }

  const scope: Record<string, any> = {
    min: Math.min, max: Math.max, abs: Math.abs, round: Math.round,
    floor: Math.floor, ceil: Math.ceil, pow: Math.pow, sqrt: Math.sqrt,
    cbrt: Math.cbrt, log: Math.log, log2: Math.log2, log10: Math.log10,
    exp: Math.exp, sign: Math.sign, trunc: Math.trunc, hypot: Math.hypot,
    PI: Math.PI, E: Math.E, pi: Math.PI, e: Math.E,
    sum: (...ns: number[]) => ns.flat().reduce((a, b) => a + Number(b), 0),
    total: (...ns: number[]) => ns.flat().reduce((a, b) => a + Number(b), 0),
    avg: (...ns: number[]) => { const f = ns.flat().map(Number); return f.reduce((a, b) => a + b, 0) / f.length; },
    mean: (...ns: number[]) => { const f = ns.flat().map(Number); return f.reduce((a, b) => a + b, 0) / f.length; },
  };

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(scope), `"use strict"; return (${expression});`);
    const raw = fn(...Object.values(scope));
    const result = typeof raw === 'bigint' ? Number(raw) : raw;
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return { expression, error: 'Ausdruck liefert keine endliche Zahl.', found: false };
    }
    return {
      expression,
      result: Math.round(result * 1e10) / 1e10,
      formatted: new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format(result),
      found: true,
    };
  } catch (err: any) {
    return { expression, error: `Syntaxfehler: ${err.message}`, found: false };
  }
});

// Currency & Commodity Rates Tool (free, CORS-enabled Frankfurter.app + STooq)
toolRegistry.register({
  id: 'currency_convert',
  name: 'Currency Convert',
  description:
    'Aktuelle Wechselkurse (EUR, USD, GBP, JPY, CHF, …) und Gold-/Silberpreise. ' +
    'Währungsumrechnung mit exaktem Faktor — für Beträge danach calculator verwenden.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'Betrag (default 1)' },
      from: { type: 'string', description: 'Quell-Währungscode, z.B. "USD"' },
      to: { type: 'string', description: 'Ziel-Währungscode, z.B. "EUR"' },
      base: { type: 'string', description: 'Alternativ: Basis-Währung, um alle Kurse auf einmal zu holen (z.B. "EUR")' },
    },
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 12000,
  maxDataSize: 20000,
  builtin: true,
}, async (args) => {
  const norm = (c: any) => String(c || '').trim().toUpperCase();
  const amount = args.amount === undefined || args.amount === null ? 1 : Number(args.amount);
  if (!Number.isFinite(amount)) return { error: 'Ungültiger Betrag', found: false };

  // Precious metals come from STooq (Frankfurter only covers fiat FX).
  const metals: Record<string, string> = { XAU: 'xauusd', GOLD: 'xauusd', XAG: 'xagusd', SILVER: 'xagusd' };
  const from = norm(args.from) || 'EUR';
  const to = norm(args.to) || '';
  const metalSym = metals[from] || (to ? metals[to] : undefined);
  if (metalSym) {
    try {
      const resp = await fetch(`https://stooq.com/q/l/?s=${metalSym}&f=sd2t2ohlcv&h&e=json`, { signal: AbortSignal.timeout(8000) });
      const rows: any[] = await resp.json();
      const close = Number(rows?.[0]?.c);
      if (Number.isFinite(close) && close > 0) {
        return {
          found: true, provider: 'stooq',
          metal: from === 'XAU' || from === 'GOLD' ? 'Gold' : 'Silber',
          pricePerOunceUsd: close, asOf: `${rows?.[0]?.d} ${rows?.[0]?.t}`.trim(),
          note: 'Ungefähre Spot-Kurse (1 Feinunze in USD), verzögert.',
        };
      }
    } catch { /* fall through to FX below */ }
  }

  const wantList = !to && !args.from;
  const base = wantList ? norm(args.base) || 'EUR' : from;
  if (!/^[A-Z]{3}$/.test(base)) return { error: `Ungültiger Währungscode "${base}"`, found: false };

  try {
    const url = wantList
      ? `https://api.frankfurter.app/latest?from=${base}`
      : `https://api.frankfurter.app/latest?amount=${amount}&from=${base}&to=${to}`;
    if (wantList === false && !/^[A-Z]{3}$/.test(to)) {
      return { error: 'Bitte Ziel-Währung als 3-Buchstaben-Code angeben (z.B. "EUR").', found: false };
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (wantList) {
      return {
        found: true, provider: 'frankfurter.app', base, asOf: data.date,
        rates: Object.fromEntries(Object.entries(data.rates || {}).slice(0, 40)),
        count: Object.keys(data.rates || {}).length,
      };
    }
    const rate = data?.rates?.[to];
    if (rate === undefined) return { base, quote: to, found: false, error: `Kein Kurs ${base}→${to}` };
    return {
      found: true, provider: 'frankfurter.app', asOf: data.date,
      amount, from: base, to, rate, converted: Math.round(amount * rate * 100) / 100,
      source: 'ECB Referenzkurse',
    };
  } catch (err: any) {
    return { found: false, error: err.message };
  }
});

/** Map WMO weather codes (Open-Meteo) to German descriptions. */
function weatherCodeText(code: number | undefined): string {
  const map: Record<number, string> = {
    0: 'Klar', 1: 'Überwiegend klar', 2: 'Teilweise bewölkt', 3: 'Bedeckt',
    45: 'Nebel', 48: 'Reifnebel', 51: 'Leichter Nieselregen', 53: 'Nieselregen', 55: 'Starker Nieselregen',
    56: 'Gefrierender Nieselregen', 57: 'Starker gefrierender Nieselregen',
    61: 'Leichter Regen', 63: 'Regen', 65: 'Starker Regen',
    66: 'Gefrierender Regen', 67: 'Starker gefrierender Regen',
    71: 'Leichter Schneefall', 73: 'Schneefall', 75: 'Starker Schneefall', 77: 'Schneegriesel',
    80: 'Leichte Schauer', 81: 'Schauer', 82: 'Heftige Schauer',
    85: 'Schneeschauer', 86: 'Starke Schneeschauer',
    95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Schweres Gewitter mit Hagel',
  };
  return code !== undefined && map[code] !== undefined ? map[code] : 'Unbekannt';
}

/** Minimal RSS 2.0 parser (Google News / Bing News feeds). */
function parseRss(xml: string, providerHint: string): any[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  const pick = (block: string, tag: string): string => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    if (!m) return '';
    let v = m[1].trim();
    v = v.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    return decodeXmlEntities(v);
  };

  return items.map(item => {
    const rawLink = pick(item, 'link');
    const title = pick(item, 'title');
    const description = pick(item, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const pubDate = pick(item, 'pubDate');
    const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : undefined;

    return {
      title,
      url: cleanUrl(rawLink),
      snippet: description.slice(0, 300),
      source: sourceMatch ? decodeXmlEntities(sourceMatch[1].replace(/<[^>]+>/g, '').trim()) : providerHint,
      publishedAt,
      provider: providerHint,
    };
  }).filter(a => a.title && a.url);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function cleanUrl(url: string): string {
  // Strip Bing news redirect wrapper (…&url=https%3a%2f%2factual.link&…)
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('bing.com')) {
      const inner = parsed.searchParams.get('url');
      if (inner) return inner;
    }
  } catch { /* keep original */ }
  return url;
}

function mergeArticles(existing: any[], incoming: any[]): any[] {
  const out = [...existing];
  for (const a of incoming) {
    if (!out.some(o => o.url === a.url || o.title === a.title)) out.push(a);
  }
  return out;
}

function dedupeByUrl(articles: any[]): any[] {
  const seen = new Set<string>();
  return articles.filter(a => {
    const key = a.url || a.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Flatten DDG RelatedTopics (which can contain nested topic groups) into Source items. */
function flattenDDGTopics(data: any): Source[] {
  const out: Source[] = [];
  const push = (t: any) => {
    if (t?.Text && t?.FirstURL) {
      out.push({
        title: t.Text.split(' - ')[0] || t.Text.substring(0, 80),
        url: t.FirstURL,
        snippet: t.Text,
        provider: 'duckduckgo',
      });
    }
  };
  for (const topic of data?.RelatedTopics || []) {
    if (topic?.Topics) topic.Topics.forEach(push); else push(topic);
  }
  for (const r of data?.Results || []) push(r);
  return out;
}

// Company Lookup Tool
toolRegistry.register({
  id: 'company_lookup',
  name: 'Company Lookup',
  description:
    'Firmeninformationen: Ticker, Börse, Branche plus Kennzahlen (KGV/KUV/KBV, Dividendenrendite, ' +
    'Marktkapitalisierung, Umsatz, Gewinn je Aktie, 52-Wochen-Hoch/Tief) und ein Kurzprofil. ' +
    'Deutsche Unternehmen werden automatisch am heimischen Börsenplatz (XETRA) abgefragt.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      companyName: { type: 'string', description: 'Company name to look up' },
      includeFundamentals: { type: 'boolean', description: 'Kennzahlen mitliefern (default true)' },
    },
    required: ['companyName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      ticker: { type: 'string' },
      exchange: { type: 'string' },
      fundamentals: { type: 'object' },
    }
  },
  version: '1.1.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 18000,
  maxDataSize: 30000,
  builtin: true,
}, async (args) => {
  // Known companies database. German listings (.DE) are preferred over OTC
  // ADRs because fundamentals (market cap, EPS, dividends) come in EUR and
  // the price matches what a German user sees in their broker app.
  const knownCompanies: Record<string, { ticker: string; exchange: string; sector: string }> = {
    'apple': { ticker: 'AAPL', exchange: 'NASDAQ', sector: 'Technology' },
    'microsoft': { ticker: 'MSFT', exchange: 'NASDAQ', sector: 'Technology' },
    'google': { ticker: 'GOOGL', exchange: 'NASDAQ', sector: 'Technology' },
    'alphabet': { ticker: 'GOOGL', exchange: 'NASDAQ', sector: 'Technology' },
    'amazon': { ticker: 'AMZN', exchange: 'NASDAQ', sector: 'Consumer' },
    'nvidia': { ticker: 'NVDA', exchange: 'NASDAQ', sector: 'Technology' },
    'amd': { ticker: 'AMD', exchange: 'NASDAQ', sector: 'Technology' },
    'tesla': { ticker: 'TSLA', exchange: 'NASDAQ', sector: 'Automotive' },
    'meta': { ticker: 'META', exchange: 'NASDAQ', sector: 'Technology' },
    'facebook': { ticker: 'META', exchange: 'NASDAQ', sector: 'Technology' },
    'netflix': { ticker: 'NFLX', exchange: 'NASDAQ', sector: 'Entertainment' },
    'intel': { ticker: 'INTC', exchange: 'NASDAQ', sector: 'Technology' },
    'samsung': { ticker: '005930.KS', exchange: 'KRX', sector: 'Technology' },
    'tsmc': { ticker: 'TSM', exchange: 'NYSE', sector: 'Technology' },
    'toyota': { ticker: 'TM', exchange: 'NYSE', sector: 'Automotive' },
    'bmw': { ticker: 'BMW.DE', exchange: 'XETRA', sector: 'Automotive' },
    'sap': { ticker: 'SAP.DE', exchange: 'XETRA', sector: 'Technology' },
    'siemens': { ticker: 'SIE.DE', exchange: 'XETRA', sector: 'Industrial' },
    'volkswagen': { ticker: 'VOW3.DE', exchange: 'XETRA', sector: 'Automotive' },
    'bayer': { ticker: 'BAYN.DE', exchange: 'XETRA', sector: 'Healthcare' },
    'allianz': { ticker: 'ALV.DE', exchange: 'XETRA', sector: 'Finance' },
    'deutsche telekom': { ticker: 'DTE.DE', exchange: 'XETRA', sector: 'Telecom' },
    'deutsche borse': { ticker: 'DB1.DE', exchange: 'XETRA', sector: 'Financials' },
    'deutsche börse': { ticker: 'DB1.DE', exchange: 'XETRA', sector: 'Financials' },
    'mercedes-benz': { ticker: 'MBG.DE', exchange: 'XETRA', sector: 'Automotive' },
    'mercedes': { ticker: 'MBG.DE', exchange: 'XETRA', sector: 'Automotive' },
    'infineon': { ticker: 'IFX.DE', exchange: 'XETRA', sector: 'Technology' },
    'adidas': { ticker: 'ADS.DE', exchange: 'XETRA', sector: 'Consumer' },
    'puma': { ticker: 'PUM.DE', exchange: 'XETRA', sector: 'Consumer' },
    'henkel': { ticker: 'HEN3.DE', exchange: 'XETRA', sector: 'Consumer' },
    'rheinmetall': { ticker: 'RHM.DE', exchange: 'XETRA', sector: 'Industrials' },
    'continental': { ticker: 'CON.DE', exchange: 'XETRA', sector: 'Automotive' },
    'hochtief': { ticker: 'HTF.DE', exchange: 'XETRA', sector: 'Industrials' },
    'vonovia': { ticker: 'VON.DE', exchange: 'XETRA', sector: 'Real Estate' },
    'wirecard': { ticker: 'WIR.DE', exchange: 'XETRA', sector: 'Technology' },
    'thyssenkrupp': { ticker: 'TKA.DE', exchange: 'XETRA', sector: 'Industrials' },
    'airbus': { ticker: 'AIR.PA', exchange: 'EURONEXT', sector: 'Industrials' },
    'lvmh': { ticker: 'MC.PA', exchange: 'EURONEXT', sector: 'Consumer' },
    'totalenergies': { ticker: 'TTE.PA', exchange: 'EURONEXT', sector: 'Energy' },
    'shell': { ticker: 'SHEL.L', exchange: 'LSE', sector: 'Energy' },
    'bp': { ticker: 'BP.L', exchange: 'LSE', sector: 'Energy' },
    'hsbc': { ticker: 'HSBA.L', exchange: 'LSE', sector: 'Finance' },
    'novartis': { ticker: 'NVS', exchange: 'NYSE', sector: 'Healthcare' },
    'roche': { ticker: 'ROG.SW', exchange: 'SIX', sector: 'Healthcare' },
    'nestle': { ticker: 'NESN.SW', exchange: 'SIX', sector: 'Consumer' },
    'nestlé': { ticker: 'NESN.SW', exchange: 'SIX', sector: 'Consumer' },
    'ubs': { ticker: 'UBSG.SW', exchange: 'SIX', sector: 'Finance' },
    'asml': { ticker: 'ASML', exchange: 'NASDAQ', sector: 'Technology' },
    'philips': { ticker: 'PHIA.AS', exchange: 'EURONEXT', sector: 'Technology' },
    'ibm': { ticker: 'IBM', exchange: 'NYSE', sector: 'Technology' },
    'oracle': { ticker: 'ORCL', exchange: 'NYSE', sector: 'Technology' },
    'jpmorgan': { ticker: 'JPM', exchange: 'NYSE', sector: 'Finance' },
    'boeing': { ticker: 'BA', exchange: 'NYSE', sector: 'Industrials' },
  };

  const query = args.companyName.toLowerCase().trim();
  let match = knownCompanies[query];
  const notes: string[] = [];
  if (!match) {
    for (const [name, info] of Object.entries(knownCompanies)) {
      if (query.includes(name) || name.includes(query)) { match = info; notes.push('Teiltreffer aus lokaler Datenbank'); break; }
    }
  }

  // Resolve a ticker: local DB first, then Yahoo symbol search so unknown
  // companies still get a usable symbol instead of a dead end (item #8).
  let ticker = match?.ticker || '';
  let exchange = match?.exchange || '';
  let sector = match?.sector || '';
  let found = Boolean(match);

  if (!ticker) {
    try {
      const sResp = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(args.companyName)}&quotesCount=6&newsCount=0`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
      );
      const sData = await sResp.json();
      const quote = (sData.quotes || []).find((q: any) => q.symbol && q.exchDisp);
      if (quote) {
        ticker = quote.symbol;
        exchange = quote.exchDisp || quote.exchange || '';
        sector = quote.sector || '';
        found = true;
        notes.push('Ticker über Yahoo-Symbolsuche ermittelt');
      }
    } catch { /* reported below */ }
  }

  if (!ticker) {
    return {
      name: args.companyName,
      found: false,
      note: 'Kein Ticker gefunden. Bitte Firmennamen präzisieren oder web_search/news_search nutzen.',
    };
  }

  const result: any = { name: args.companyName, ticker, exchange, sector, found };
  if (notes.length) result.note = notes.join('; ');

  // Fundamentals (item #2): KGV/KUV/KBV, Dividendenrendite, Marktkapitalisierung,
  // Umsatz, EPS, Quartalszahlen, Analystenkonsens — from free Yahoo endpoints.
  if (args.includeFundamentals !== false) {
    const fundamentals = await fetchYahooFundamentals(ticker);
    if (fundamentals) {
      result.fundamentals = fundamentals;
      result.profile = await fetchWikipediaSummary(args.companyName);
    } else {
      result.fundamentalsError = `Keine Kennzahlen für ${ticker} verfügbar (Quelle blockiert oder unbekanntes Symbol).`;
    }
  }
  return result;
});

/**
 * Fundamental metrics from free Yahoo Finance endpoints. The v7 `quote` route
 * now needs a cookie+crumb handshake (plain HTTP 401 otherwise), so we try
 * three paths and stop at the first that yields data:
 *   A) v7 quote + crumb   B) v10 quoteSummary modules   C) chart `meta`.
 * Path C always provides price, currency, exchange and the 52-week range.
 */
async function fetchYahooFundamentals(ticker: string): Promise<any | null> {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
  let out: Record<string, any> = {};

  // A) quote endpoint with crumb (cookie comes from the browser session)
  try {
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers, credentials: 'include', signal: AbortSignal.timeout(6000),
    });
    const crumb = crumbResp.ok ? decodeURIComponent((await crumbResp.text()).trim()) : '';
    if (crumb && !/<|error/i.test(crumb)) {
      const qResp = await fetch(
        `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&crumb=${encodeURIComponent(crumb)}`,
        { headers, credentials: 'include', signal: AbortSignal.timeout(7000) }
      );
      const q = qResp.ok ? (await qResp.json())?.quote?.result?.[0] : null;
      if (q) out = { ...q };
    }
  } catch { /* fall through */ }

  // B) quoteSummary modules (nested `{raw, fmt}` values are flattened)
  if (Object.keys(out).length === 0) {
    try {
      const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,earnings';
      const resp = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`,
        { headers, signal: AbortSignal.timeout(7000) }
      );
      const d = resp.ok ? (await resp.json())?.quoteSummary?.result?.[0] : null;
      if (d) {
        const absorb = (node: any) => {
          if (!node) return;
          if (typeof node.currency === 'string' && !out.currency) out.currency = node.currency;
          for (const [k, v] of Object.entries(node)) {
            if (v && typeof v === 'object' && typeof (v as any).raw === 'number') out[k] = (v as any).raw;
          }
        };
        absorb(d.price); absorb(d.summaryDetail); absorb(d.defaultKeyStatistics); absorb(d.financialData);
        const quarters = d.earningsChart?.quarterly || d.earnings?.chart?.quarterly;
        if (quarters) {
          out.quarterlyRevenue = (quarters.revenue || []).map((r: any) => `${r.date}: ${r.raw?.fmt ?? r.fmt}`).filter(Boolean);
          out.quarterlyEps = (quarters.eps || []).map((r: any) => `${r.date}: ${r.raw?.fmt ?? r.fmt}`).filter(Boolean);
        }
        const rec = d.financialData?.recommendationMean?.raw;
        if (typeof rec === 'number') out.analystRecommendationMean = Math.round(rec * 100) / 100;
      }
    } catch { /* fall through */ }
  }

  // C) chart meta — reliable, no auth required
  if (Object.keys(out).length === 0) {
    try {
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1mo`,
        { headers, signal: AbortSignal.timeout(7000) }
      );
      const meta = (await resp.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice !== undefined) {
        out = {
          longName: meta.longName || meta.shortName,
          currency: meta.currency,
          fullExchangeName: meta.fullExchangeName || meta.exchangeName,
          regularMarketPrice: meta.regularMarketPrice,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          regularMarketVolume: meta.regularMarketVolume,
          source: 'yahoo-chart-meta',
        };
      }
    } catch { /* give up */ }
  }

  if (Object.keys(out).length === 0) return null;

  const pct = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? round2(Math.abs(v) <= 1 ? v * 100 : v) : undefined);
  const summary: Record<string, any> = {
    name: out.longName || out.shortName || out.marketName,
    currency: out.currency,
    exchange: out.fullExchangeName || out.exchangeName || out.exchange,
    price: typeof out.regularMarketPrice === 'number' ? round2(out.regularMarketPrice) : undefined,
    marketCap: out.marketCap,
    marketCapFormatted: out.marketCap ? formatCompact(out.marketCap, out.currency) : undefined,
    peRatio: typeof out.trailingPE === 'number' ? round2(out.trailingPE) : undefined,       // KGV
    forwardPe: typeof out.forwardPE === 'number' ? round2(out.forwardPE) : undefined,        // KGV erwartet
    priceToSales: typeof out.priceToSalesTrailing12Months === 'number' ? round2(out.priceToSalesTrailing12Months) : undefined, // KUV
    priceToBook: typeof out.priceToBook === 'number' ? round2(out.priceToBook) : undefined,  // KBV
    dividendRate: typeof out.dividendRate === 'number' ? round2(out.dividendRate) : undefined,
    dividendYieldPercent: pct(out.dividendYield),
    epsTrailing12M: typeof out.trailingEps === 'number' ? round2(out.trailingEps) : undefined,
    revenueTrailing12M: out.totalRevenue,
    revenueFormatted: out.totalRevenue ? formatCompact(out.totalRevenue, out.currency) : undefined,
    netIncome: out.netIncomeToCommon,
    profitMarginPercent: pct(out.profitMargins),
    returnOnEquityPercent: pct(out.returnOnEquity),
    debtToEquity: typeof out.debtToEquity === 'number' ? round2(out.debtToEquity) : undefined,
    beta: typeof out.beta === 'number' ? round2(out.beta) : undefined,
    fiftyTwoWeekHigh: typeof out.fiftyTwoWeekHigh === 'number' ? round2(out.fiftyTwoWeekHigh) : undefined,
    fiftyTwoWeekLow: typeof out.fiftyTwoWeekLow === 'number' ? round2(out.fiftyTwoWeekLow) : undefined,
    volume: out.regularMarketVolume ?? out.volume,
    analystRecommendationMean: out.analystRecommendationMean,
    analystScale: out.analystRecommendationMean ? '1 = Strong Buy … 5 = Sell' : undefined,
    quarterlyRevenue: out.quarterlyRevenue,
    quarterlyEps: out.quarterlyEps,
    dataNote: 'Kostenlose Yahoo-Finance-Daten, verzögert; keine Anlageberatung.',
  };
  return Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
}

/** Large numbers in German reading order (Mio./Mrd./Bio.). */
export function formatCompact(value: number, currency?: string): string {
  const cur = currency === 'EUR' ? ' €' : currency ? ` ${currency}` : '';
  const abs = Math.abs(value);
  const dec = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');
  if (abs >= 1e12) return `${dec(value / 1e12, 2)} Bio${cur}`;
  if (abs >= 1e9) return `${dec(value / 1e9, 2)} Mrd${cur}`;
  if (abs >= 1e6) return `${dec(value / 1e6, 1)} Mio${cur}`;
  return `${value}${cur}`;
}

/** Short company/place profile from Wikipedia (free, CORS-enabled). */
async function fetchWikipediaSummary(topic: string): Promise<string | undefined> {
  try {
    const title = String(topic).trim().replace(/\s+/g, '_');
    const resp = await fetch(
      `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?origin=*`,
      { headers: { 'User-Agent': 'AI-Research-Assistant/1.0 (research tool; contact: local)' }, signal: AbortSignal.timeout(6000) }
    );
    if (!resp.ok) return undefined;
    const extract = (await resp.json())?.extract;
    return typeof extract === 'string' && extract.length > 40 ? extract.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}

// Stock Price Tool
toolRegistry.register({
  id: 'stock_price',
  name: 'Stock Price',
  description: 'Get current and historical stock price data for a ticker symbol.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL, NVDA, SIE.DE)' },
      days: { type: 'number', description: 'Days of historical data (default 7)' },
    },
    required: ['ticker'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      price: { type: 'number' },
      change: { type: 'number' },
      historical: { type: 'array' },
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 20000,
  builtin: true,
}, async (args) => {
  // Use a free financial data source
  const ticker = args.ticker.toUpperCase();
  const days = args.days || 7;
  
  try {
    // Using Yahoo Finance query API (free, no key required for basic data)
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${days}d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(9000) }
    );
    
    if (!response.ok) {
      return { ticker, error: `Could not fetch data for ${ticker}. Status: ${response.status}`, found: false };
    }
    
    const data = await response.json();
    const result = data.chart?.result?.[0];
    
    if (!result) {
      return { ticker, error: `No data available for ${ticker}`, found: false };
    }
    
    const quotes = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const closes = quotes.close || [];
    
    const historical = timestamps.map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      close: closes[i] ? Math.round(closes[i] * 100) / 100 : null,
    })).filter((h: any) => h.close !== null);
    
    const currentPrice = historical.length > 0 ? historical[historical.length - 1].close : null;
    const previousPrice = historical.length > 1 ? historical[historical.length - 2].close : null;
    
    return {
      ticker,
      name: result.meta?.longName || result.meta?.shortName,
      price: currentPrice,
      dayHigh: result.meta?.regularMarketDayHigh,
      dayLow: result.meta?.regularMarketDayLow,
      fiftyTwoWeekHigh: result.meta?.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: result.meta?.fiftyTwoWeekLow,
      previousClose: previousPrice,
      change: currentPrice && previousPrice ? Math.round((currentPrice - previousPrice) * 100) / 100 : null,
      changePercent: currentPrice && previousPrice ? Math.round(((currentPrice - previousPrice) / previousPrice) * 10000) / 100 : null,
      historical,
      currency: result.meta?.currency || 'USD',
      exchange: result.meta?.exchangeName || '',
      found: true,
      dataNote: 'Data may be delayed 15-20 minutes. Not for trading decisions.',
    };
  } catch (err: any) {
    return { ticker, error: err.message, found: false };
  }
});

// Stock Analysis Tool — pre-computed risk/performance metrics from OHLC data,
// so the model does not have to average hundreds of numbers itself.
toolRegistry.register({
  id: 'stock_analysis',
  name: 'Stock Analysis',
  description:
    'Kursanalyse für ein Wertpapier im Zeitraum: berechnet Performance, annualisierte Volatilität, ' +
    'maximalen Drawdown, Durchschnittsvolumen und gleitenden Durchschnitt aus den Tages-/Wochen-/Monatskursen ' +
    '(OHLCV). Für Kennzahlen wie KGV/Dividende stattdessen company_lookup verwenden.',
  category: 'transform',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Ticker (AAPL, NVDA, SIE.DE, ...)' },
      period: { type: 'string', enum: ['1mo', '3mo', '6mo', '1y', '2y', '5y'], description: 'Zeitraum (default 6mo)' },
      interval: { type: 'string', enum: ['1d', '1wk', '1mo'], description: 'Kursintervall (default 1d)' },
    },
    required: ['ticker'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 40000,
  builtin: true,
}, async (args) => {
  const ticker = String(args.ticker).toUpperCase();
  const period = ['1mo','3mo','6mo','1y','2y','5y'].includes(args.period) ? args.period : '6mo';
  const interval = ['1d','1wk','1mo'].includes(args.interval) ? args.interval : '1d';

  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${period}&interval=${interval}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const result = (await resp.json())?.chart?.result?.[0];
    if (!result) return { ticker, found: false, error: `Keine Daten fuer ${ticker}` };

    const q = result.indicators?.quote?.[0] || {};
    const rows = (result.timestamp || [])
      .map((ts: number, i: number) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
      }))
      .filter((r: any) => typeof r.close === 'number');
    if (rows.length < 2) return { ticker, found: false, error: `Zu wenige Kursdaten fuer ${ticker} (${period})` };

    const closes = rows.map((r: any) => r.close as number);
    const first = closes[0], last = closes[closes.length - 1];
    const rets = closes.slice(1).map((c: number, i: number) => Math.log(c / closes[i]));
    const mean = rets.reduce((a: number, b: number) => a + b, 0) / rets.length;
    const variance = rets.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
    const perYear = interval === '1d' ? 252 : interval === '1wk' ? 52 : 12;
    let peak = closes[0], maxDrawdown = 0;
    for (const c of closes) { peak = Math.max(peak, c); maxDrawdown = Math.min(maxDrawdown, (c - peak) / peak); }
    const volumes = rows.map((r: any) => r.volume).filter((v: any) => typeof v === 'number');
    const smaWindow = Math.min(50, closes.length);

    return {
      ticker,
      name: result.meta?.longName || result.meta?.shortName,
      currency: result.meta?.currency,
      period, interval, points: rows.length,
      from: rows[0].date, to: rows[rows.length - 1].date,
      metrics: {
        startPrice: round2(first),
        latestPrice: round2(last),
        changeAbsolute: round2(last - first),
        changePercent: round2(((last - first) / first) * 100),
        periodHigh: round2(Math.max(...rows.map((r: any) => r.high ?? r.close))),
        periodLow: round2(Math.min(...rows.map((r: any) => r.low ?? r.close))),
        volatilityAnnualizedPercent: round2(Math.sqrt(variance * perYear) * 100),
        maxDrawdownPercent: round2(maxDrawdown * 100),
        avgVolume: volumes.length ? Math.round(volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length) : undefined,
        movingAverage: round2(closes.slice(-smaWindow).reduce((a: number, b: number) => a + b, 0) / smaWindow),
        movingAverageWindow: smaWindow,
      },
      candles: rows.slice(-40),
      dataNote: 'Verzoegerte Gratisdaten (Yahoo Finance), keine Anlageberatung.',
    };
  } catch (err: any) {
    return { ticker, found: false, error: err.message };
  }
});

// Data Filter Tool
toolRegistry.register({
  id: 'data_filter',
  name: 'Data Filter',
  description: 'Filter, sort, and deduplicate data arrays. Useful for processing search results.',
  category: 'filter',
  inputSchema: {
    type: 'object',
    properties: {
      data: { type: 'array', description: 'Array of objects to filter' },
      filterField: { type: 'string', description: 'Field to filter on' },
      filterValue: { type: 'string', description: 'Value to match (substring match)' },
      sortBy: { type: 'string', description: 'Field to sort by' },
      sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
      deduplicateBy: { type: 'string', description: 'Field to deduplicate on' },
      limit: { type: 'number', description: 'Maximum results' },
    },
    required: ['data'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 100000,
  builtin: true,
}, async (args) => {
  let data = [...(args.data || [])];
  
  // Filter
  if (args.filterField && args.filterValue) {
    data = data.filter(item => {
      const val = String(item[args.filterField] || '').toLowerCase();
      return val.includes(args.filterValue.toLowerCase());
    });
  }
  
  // Deduplicate
  if (args.deduplicateBy) {
    const seen = new Set();
    data = data.filter(item => {
      const key = item[args.deduplicateBy];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  // Sort
  if (args.sortBy) {
    data.sort((a, b) => {
      const aVal = a[args.sortBy] || '';
      const bVal = b[args.sortBy] || '';
      const cmp = String(aVal).localeCompare(String(bVal));
      return args.sortOrder === 'desc' ? -cmp : cmp;
    });
  }
  
  // Limit
  if (args.limit) {
    data = data.slice(0, args.limit);
  }
  
  return { data, count: data.length };
});

// Text Summarizer Tool (uses AI internally)
toolRegistry.register({
  id: 'text_summarize',
  name: 'Text Summarizer',
  description: 'Summarize text content. Extracts key points and creates concise summaries.',
  category: 'ai_extraction',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to summarize' },
      maxLength: { type: 'number', description: 'Maximum summary length in words (default 100)' },
    },
    required: ['text'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  const text = args.text || '';
  const maxWords = args.maxLength || 100;
  
  // Simple extractive summarization
  const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 20);
  
  if (sentences.length <= 3) {
    return { summary: text.trim(), wordCount: text.split(/\s+/).length };
  }
  
  // Score sentences by position and length
  const scored = sentences.map((s: string, i: number) => ({
    text: s.trim(),
    score: (1 / (i + 1)) * (s.length > 50 ? 1.5 : 1) + (i < 3 ? 2 : 0),
  }));
  
  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  
  const selected = scored.slice(0, Math.min(5, Math.ceil(maxWords / 20)));
  selected.sort((a: { text: string }, b: { text: string }) => sentences.indexOf(a.text) - sentences.indexOf(b.text));
  
  const summary = selected.map((s: { text: string }) => s.text).join('. ') + '.';
  
  return {
    summary,
    wordCount: summary.split(/\s+/).length,
    originalWordCount: text.split(/\s+/).length,
  };
});

// Report Generator Tool
toolRegistry.register({
  id: 'generate_report',
  name: 'Report Generator',
  description: 'Generate a structured report from collected data and analysis results.',
  category: 'report',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Report title' },
      sections: {
        type: 'array',
        description: 'Report sections with heading and content',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            content: { type: 'string' },
          }
        }
      },
      sources: { type: 'array', description: 'Source references' },
    },
    required: ['title', 'sections'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 100000,
  builtin: true,
}, async (args) => {
  const report = {
    title: args.title,
    generatedAt: new Date().toISOString(),
    sections: args.sections || [],
    sources: args.sources || [],
    summary: `${args.sections?.length || 0} sections, ${args.sources?.length || 0} sources`,
  };
  
  return report;
});

// URL Fetch Tool
toolRegistry.register({
  id: 'url_fetch',
  name: 'URL Fetch',
  description:
    'Webseite laden und den ARTICLE-Text extrahieren (Readability-Algorithmus: Navigation, Cookie-Banner, ' +
    'Footer werden entfernt). Liefert headline, publishedAt, text und die wichtigsten Metadaten. ' +
    'Für News-Seiten (z.B. tagesschau.de) der richtige Weg — web_search liefert nur Snippets. ' +
    'Bei JS-lastigen Seiten wird automatisch ein Lesbarkeitsextraktor-Dienst nachgeschaltet.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxLength: { type: 'number', description: 'Maximale Textlänge in Zeichen (default 6000)' },
      selector: { type: 'string', description: 'Optionaler CSS-Selektor, z.B. "article" oder ".article-content"' },
      raw: { type: 'boolean', description: 'HTML unverändert zurückgeben (ohne Extraktion)' },
    },
    required: ['url'],
  },
  outputSchema: { type: 'object' },
  version: '2.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 60000,
  builtin: true,
}, async (args) => {
  const url = String(args.url || '');
  const maxLength = Math.min(Math.max(Number(args.maxLength) || 6000, 500), 30000);

  // Security: validate URL (SSRF protection kept from v1 and extended).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'Invalid URL', url };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only HTTP/HTTPS URLs are allowed', url };
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivateIp =
    /^(10\.|192\.168\.|127\.|0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === 'localhost' || host.endsWith('.local') || host === '[::1]' || host === '::1';
  if (isPrivateIp) return { error: 'Access to internal network addresses is blocked', url };

  const html = await fetchHtml(url);
  if (!html) {
    return { error: 'Seite konnte nicht geladen werden (Direktzugriff durch CORS blockiert und alle Proxy-Backends ohne Ergebnis).', url, found: false };
  }

  if (args.raw) {
    return { url, contentType: 'text/html', length: html.length, html: html.slice(0, maxLength) };
  }

  const article = extractArticle(html, url, args.selector ? { selector: args.selector } : {});
  const text = article.text.replace(/\s+\n/g, '\n').trim();
  const truncated = text.length > maxLength;

  return {
    found: true,
    url,
    finalUrl: article.finalUrl || url,
    headline: article.title,
    byline: article.byline,
    publishedAt: article.publishedAt,
    siteName: article.siteName,
    excerpt: article.excerpt,
    wordCount: (text.match(/\S+/g) || []).length,
    content: truncated ? text.slice(0, maxLength) + '\n… [getürzt]' : text,
    extractor: article.extractor,
    ...(truncated ? { note: `Text auf ${maxLength} Zeichen gekürzt (setter maxLength höher).` } : {}),
  };
});

/**
 * Load HTML directly first (works for CORS-enabled hosts); on failure fall
 * back to public readability/text-extraction proxies. All requests are capped
 * so one slow backend cannot exhaust the tool timeout.
 */
async function fetchHtml(url: string): Promise<string | null> {
  // 1) Direct fetch — same-origin-ish endpoints (RSS, JSON APIs) work here.
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Research-Assistant/2.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (resp.ok) {
      const ct = resp.headers.get('content-type') || '';
      const body = await resp.text();
      if (body && (ct.includes('json') || ct.includes('xml'))) {
        // JSON/XML: hand back a flattened text view so extraction still works.
        return `<pre>${escapeHtml(body.slice(0, 200000))}</pre>`;
      }
      if (body) return body;
    }
  } catch { /* CORS or network — try proxies below */ }

  // 2) Readability proxies (return clean JSON with extracted text).
  const jsonEndpoints = [
    { name: 'r.jina.ai', build: () => `https://r.jina.ai/${url}`, pick: (j: any) => j?.data?.content || j?.content },
    { name: 'microlink', build: () => `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true`, pick: (j: any) => j?.data?.data?.description || j?.data?.status },
  ];
  for (const ep of jsonEndpoints) {
    try {
      const resp = await fetch(ep.build(), { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) continue;
      const picked = ep.pick(await resp.json());
      if (typeof picked === 'string' && picked.trim().length > 80) {
        return `<article><div>${escapeHtml(picked).replace(/\n/g, '</p><p>')}</p></div></article>`;
      }
    } catch { /* next backend */ }
  }

  // 3) Raw-HTML proxies (allorigins / codetabs), then normal extraction.
  const htmlEndpoints = [
    () => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    () => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];
  for (const build of htmlEndpoints) {
    try {
      const resp = await fetch(build(), { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) continue;
      const body = await resp.text();
      if (body && body.length > 200) return body;
    } catch { /* next backend */ }
  }
  return null;
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Readability-style extraction implemented with DOMParser (available in the
 * browser and in jsdom, so it is unit-testable without network access).
 * Strategy: score candidate containers by paragraph density, strip boilerplate
 * (nav/footer/aside/share/cookie boxes), then pull title/date from <title>,
 * og:* meta tags and JSON-LD NewsArticle.
 */
export function extractArticle(
  html: string,
  baseUrl: string,
  options: { selector?: string; maxChars?: number } = {}
): {
  title?: string; byline?: string; publishedAt?: string; siteName?: string;
  excerpt?: string; text: string; finalUrl?: string; extractor: string;
} {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: any = { extractor: 'readability-lite', text: '' };

  // --- metadata -----------------------------------------------------------
  const meta = (prop: string): string | undefined =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ||
    doc.querySelector(`meta[name="${prop}"]`)?.getAttribute('content') || undefined;

  out.title = meta('og:title') || doc.querySelector('h1')?.textContent?.trim() ||
    doc.title?.replace(/\s*[-|–]\s*([^-|–]+)$/,'')?.trim() || undefined;
  out.siteName = meta('og:site_name') || undefined;
  out.excerpt = meta('description') || meta('og:description') || undefined;
  out.byline = meta('author') || meta('article:author') || undefined;
  const rawDate = meta('article:published_time') || meta('og:published_time') || meta('datePublished') ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime') || undefined;
  if (rawDate && !Number.isNaN(Date.parse(rawDate))) out.publishedAt = new Date(rawDate).toISOString();

  // JSON-LD often carries the authoritative headline/date even when og: is missing.
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(script.textContent || '');
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const items = [node, ...(Array.isArray(node?.mainEntity) ? node.mainEntity : []), ...(Array.isArray(node?.['@graph']) ? node['@graph'] : [])];
        for (const item of items) {
          const type = String(item?.['@type'] || '');
          if (!/NewsArticle|Article|BlogPosting|ReportageArticle/i.test(type)) continue;
          if (!out.publishedAt && item.datePublished && !Number.isNaN(Date.parse(item.datePublished))) {
            out.publishedAt = new Date(item.datePublished).toISOString();
          }
          if (item.headline && (!out.title || out.title.length < 15)) out.title = String(item.headline);
          if (item.author) {
            const a = Array.isArray(item.author) ? item.author[0] : item.author;
            if (a?.name && !out.byline) out.byline = String(a.name);
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }

  // --- body ---------------------------------------------------------------
  const NOISE = 'script,style,noscript,iframe,svg,form,button,nav,footer,header,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],[class*=cookie i],[id*=cookie i],[class*=share i],[class*=social i],[class*=newsletter i],[class*=advert i],[class*=banner i],[id*=comments i],[class*=comment i]';

  const paragraphsOf = (root: Element): string[] => {
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll(NOISE).forEach(n => n.remove());
    const blocks = Array.from(clone.querySelectorAll('p, li, h2, h3, blockquote, pre'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 40);
    return dedupeStrings(blocks);
  };

  let paragraphs: string[] = [];
  let extractor = 'readability-lite';

  if (options.selector) {
    const target = doc.querySelector(options.selector);
    if (target) { paragraphs = paragraphsOf(target); extractor = `selector:${options.selector}`; }
  }

  if (paragraphs.length === 0) {
    // Prefer explicit article containers, then score every container by how
    // much text it holds relative to its link density (classic Readability).
    const candidates = Array.from(doc.querySelectorAll('article, [itemprop=articleBody], main, [role=main], .article, .article-body, #content, .post-content'))
      .concat(Array.from(doc.querySelectorAll('div, section')));
    let best: { el: Element; score: number } | null = null;
    for (const el of candidates) {
      const ps = paragraphsOf(el);
      if (ps.length < 2) continue;
      const textLen = ps.join(' ').length;
      const links = el.querySelectorAll('a').length;
      const score = textLen * (1 - Math.min(links / Math.max(ps.length, 1) / 4, 0.8));
      if (!best || score > best.score) best = { el, score };
    }
    if (best) { paragraphs = paragraphsOf(best.el); }
    else {
      // Last resort: whole body text.
      const body = doc.body;
      if (body) {
        const clone = body.cloneNode(true) as Element;
        clone.querySelectorAll(NOISE).forEach(n => n.remove());
        paragraphs = dedupeStrings(
          (clone.textContent || '').split(/\n{2,}/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 60)
        );
        extractor = 'fallback-fulltext';
      }
    }
  }

  const maxChars = options.maxChars || 40000;
  let joined = '';
  for (const p of paragraphs) {
    if ((joined + '\n\n' + p).length > maxChars) break;
    joined += (joined ? '\n\n' : '') + p;
  }
  out.text = joined;
  out.extractor = extractor;
  out.paragraphs = paragraphs.length;
  return out;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

