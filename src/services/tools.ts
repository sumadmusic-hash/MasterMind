import type { ToolDefinition, ToolCall, ToolResult, Source } from '../types';

// Built-in tool implementations
class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private implementations: Map<string, (args: any) => Promise<any>> = new Map();

  register(tool: ToolDefinition, implementation: (args: any) => Promise<any>): void {
    this.tools.set(tool.id, tool);
    this.implementations.set(tool.id, implementation);
  }

  getTool(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
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

  async execute(call: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();
    const tool = this.tools.get(call.toolId);
    
    if (!tool) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Tool not found: ${call.toolId}`,
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

    try {
      // Timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool timeout after ${tool.maxDuration}ms`)), tool.maxDuration);
      });

      const result = await Promise.race([impl(call.arguments), timeoutPromise]);
      
      return {
        callId: call.id,
        toolId: call.toolId,
        success: true,
        data: result,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (err: any) {
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
    const tool = this.tools.get(id);
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
      maxResults: { type: 'number', description: 'Maximum results (default 10)' },
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
  const maxResults = args.maxResults || 10;
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
    results: results.slice(0, maxResults),
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
      maxResults: { type: 'number', description: 'Maximum results (default 10)' },
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
  const maxResults = args.maxResults || 10;
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
  id: 'weather',
  name: 'Weather',
  description: 'Get current weather and a short forecast for a city. Answers weather questions directly — do not use web_search for this.',
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
    const geoResp = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=de&format=json`,
      { signal: AbortSignal.timeout(6000) }
    );
    const geo = await geoResp.json();
    const place = geo?.results?.[0];

    // Step 2: current conditions + daily forecast from Open-Meteo (no key needed).
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
        location: `${place.name}${place.admin1 ? ', ' + place.admin1 : ''} (${place.country || geo?.results?.[0]?.country || ''})`,
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
  description: 'Look up company information and stock ticker symbols.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      companyName: { type: 'string', description: 'Company name to look up' },
    },
    required: ['companyName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      ticker: { type: 'string' },
      exchange: { type: 'string' },
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 10000,
  builtin: true,
}, async (args) => {
  // Known companies database for offline capability
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
    'bmw': { ticker: 'BMWYY', exchange: 'OTC', sector: 'Automotive' },
    'sap': { ticker: 'SAP', exchange: 'NYSE', sector: 'Technology' },
    'siemens': { ticker: 'SIEGY', exchange: 'OTC', sector: 'Industrial' },
    'volkswagen': { ticker: 'VWAGY', exchange: 'OTC', sector: 'Automotive' },
    'bayer': { ticker: 'BAYRY', exchange: 'OTC', sector: 'Healthcare' },
    'allianz': { ticker: 'ALIZY', exchange: 'OTC', sector: 'Finance' },
    'deutsche telekom': { ticker: 'DTEGY', exchange: 'OTC', sector: 'Telecom' },
  };

  const query = args.companyName.toLowerCase().trim();
  const company = knownCompanies[query];
  
  if (company) {
    return {
      name: args.companyName,
      ticker: company.ticker,
      exchange: company.exchange,
      sector: company.sector,
      found: true,
    };
  }

  // Try partial match
  for (const [name, info] of Object.entries(knownCompanies)) {
    if (query.includes(name) || name.includes(query)) {
      return {
        name: args.companyName,
        ticker: info.ticker,
        exchange: info.exchange,
        sector: info.sector,
        found: true,
        note: 'Partial match',
      };
    }
  }

  return { name: args.companyName, found: false, note: 'Company not found in local database. Try a web search.' };
});

// Stock Price Tool
toolRegistry.register({
  id: 'stock_price',
  name: 'Stock Price',
  description: 'Get current and historical stock price data for a ticker symbol.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL, NVDA)' },
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
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${days}d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
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
      price: currentPrice,
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
  description: 'Fetch content from a URL. Returns text content with basic HTML stripping.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxLength: { type: 'number', description: 'Maximum content length (default 5000)' },
    },
    required: ['url'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  const url = args.url;
  const maxLength = args.maxLength || 5000;
  
  // Security: validate URL
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Only HTTP/HTTPS URLs are allowed', url };
    }
    // Block internal/private IPs
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname.startsWith('192.168.') || 
        hostname.startsWith('10.') || hostname.startsWith('172.')) {
      return { error: 'Access to internal network addresses is blocked', url };
    }
  } catch {
    return { error: 'Invalid URL', url };
  }
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'AI-Research-Assistant/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, url };
    }
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json')) {
      return { error: 'Unsupported content type', url, contentType };
    }
    
    let text = await response.text();
    
    // Basic HTML stripping
    if (contentType.includes('html')) {
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/\s+/g, ' ').trim();
    }
    
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '... [truncated]';
    }
    
    return { content: text, url, length: text.length };
  } catch (err: any) {
    return { error: err.message, url };
  }
});
