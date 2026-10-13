/**
 * Gemeinsame Yahoo-Finance-Helfer: Fundamental-Kennzahlen, robuster
 * Chart-Fetch (HTTP 429 / HTML-Fehlerseiten), Ticker-Auflösung,
 * CoinGecko-Krypto-Fallback und Wikipedia-Kurzprofil.
 * Genutzt von stock_price, stock_analysis, company_lookup und portfolio_overview.
 */

export async function fetchYahooFundamentals(ticker: string): Promise<any | null> {
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

  // C) chart meta — reliable, no auth required (helper survives HTML/429 pages)
  if (Object.keys(out).length === 0) {
    try {
      const data = await fetchYahooChartJson(ticker, 'range=1y&interval=1mo');
      const meta = data?.chart?.result?.[0]?.meta;
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
    } catch { /* fall through to last-resort fallback */ }
  }

  // D) last resort: CoinGecko for cryptos. Yahoo is intermittently rate-limited
  // (HTTP 429 + HTML body); crypto questions should still get a real price.
  if (Object.keys(out).length === 0) {
    const cg = await fetchCryptoPriceFromCoingecko(ticker);
    if (cg) {
      out = {
        longName: ticker.toUpperCase(),
        currency: 'USD',
        fullExchangeName: 'CoinGecko',
        regularMarketPrice: cg.priceUsd,
        regularMarketChangePercent: cg.changePercent24h,
        source: 'coingecko',
      };
    }
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

import { fetchCryptoPriceFromCoingecko } from './_gnews';

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
export async function fetchWikipediaSummary(topic: string): Promise<string | undefined> {
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

export function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}

/**
 * Map user/model-friendly names to Yahoo Finance symbols. Without this, a
 * query like "DAX kurs" fails because the model passes the bare name "DAX"
 * (or a German index name), which Yahoo does not resolve — only the correct
 * exchange symbol (e.g. ^GDAXI for the DAX) returns data.
 */
const TICKER_ALIASES: Record<string, string> = {
  // German stock indices (Xetra/DAX family). Symbols verified against the
  // Yahoo chart API; e.g. bare "^DAX"/"^MDAX" return 404 — only these work.
  'DAX': '^GDAXI',
  'DAX40': '^GDAXI',
  'MDAX': '^MDAXI',
  'SDAX': '^SDAXI',
  'TECDAX': '^TECDAX',
  'DIVDAX': 'DT5K.DE',
  // International indices
  '^GSPC': '^GSPC',
  'SP500': '^GSPC',
  'S&P500': '^GSPC',
  'NASDAQ100': '^NDX',
  'NIKKEI': '^N225',
  'FTSE': '^FTSE',
  // Cryptos (frequently asked without exchange suffix)
  'BITCOIN': 'BTC-USD',
  'BTC': 'BTC-USD',
  'ETHER': 'ETH-USD',
  'ETH': 'ETH-USD',
};

export function resolveTicker(raw: unknown): string {
  let t = String(raw ?? '').trim().toUpperCase();
  if (!t) return t;
  // The model often passes the whole user query instead of a bare symbol
  // ("wie ist der DAX Kurs aktuell?", "DAX Index Stand heute"). Strip common
  // German question/noise words so the remaining text can still match an alias.
  const cleaned = t
    .replace(/[^A-Z0-9^.\- ]/g, ' ')       // drop punctuation like ?, !, %
    .split(/\s+/)
    .filter((w) => w && !/^(WIE|IST|DER|DIE|DAS|AKTUELL|AKTUELLE|KURS|KURSE|KURSES|STAND|PREIS|HEUTE|JETZT|GERADE|INDEX|INDEXSTAND|VERLAUF|ENTWICKLUNG|VON|FÜR|FUER|IN|AUC|MIR|UNSER|DE)$/.test(w))
    .join(' ');
  if (cleaned) t = cleaned.toUpperCase();
  const compact = t.replace(/[\s._-]/g, ''); // "Dax 40", "Tec-DAX" → "DAX40", "TECDAX"
  return TICKER_ALIASES[t] || TICKER_ALIASES[compact] || t;
}

/**
 * Overall time budget (ms) for the Yahoo retry cascade. MUST stay below the
 * smallest `maxDuration` of the tools that call it (stock_price: 10 s) so the
 * helper always finishes — with a clear error message — BEFORE the tool
 * wrapper's hard timeout aborts it. A budget larger than maxDuration made the
 * wrapper reject first and the caller's fallbacks (e.g. CoinGecko) never ran.
 */
const YAHOO_RETRY_BUDGET_MS = 9000;

/**
 * Fetch a Yahoo Finance v8 chart payload as JSON.
 *
 * Fixes the "stock_price … HTML‑Fehler" bug: Yahoo answers with HTTP 429 and
 * an HTML body ("Edge: Too Many Requests") — sometimes even with status 200 —
 * when the request is rate-limited or blocked. `response.json()` then threw a
 * raw SyntaxError ("Unexpected token '<', "<!DOCTYPE…" is not valid JSON),
 * which surfaced to the model as an opaque failure. This helper:
 *   1. treats any non-JSON (HTML) response as a retryable error,
 *   2. retries on other hosts / after a short backoff,
 *   3. returns a clear German error message instead of a JSON syntax error.
 */
export async function fetchYahooChartJson(ticker: string, query: string): Promise<any> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  // Yahoo's edge blocks some User-Agent strings outright (HTTP 429 on every
  // request, e.g. the classic macOS/Chrome UA), while others pass. Rotating
  // through several realistic UAs per host makes the retry loop actually
  // escape the block instead of repeating the identical rejected request.
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  ];
  let lastError = '';
  // Overall time budget — kept under every caller's maxDuration (see
  // YAHOO_RETRY_BUDGET_MS) so we never hang longer than this and always end
  // with a clear error message instead of a generic tool timeout.
  const deadline = Date.now() + YAHOO_RETRY_BUDGET_MS;
  for (let attempt = 0; attempt < hosts.length * userAgents.length && Date.now() < deadline; attempt++) {
    const host = hosts[attempt % hosts.length];
    const ua = userAgents[Math.floor(attempt / hosts.length) % userAgents.length];
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`;
    try {
      // Per-request timeout bounded by the remaining overall budget, so a
      // single slow request can never push the loop past the deadline.
      const remaining = deadline - Date.now();
      const resp = await fetch(url, {
        headers: { 'User-Agent': ua, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(Math.min(9000, Math.max(remaining, 500))),
      });
      const ct = resp.headers.get('content-type') || '';
      if (resp.status === 429) {
        lastError = `Rate-Limit (HTTP 429) von ${host}`;
      } else if (!resp.ok) {
        // 4xx on one symbol is permanent (unknown ticker) — no point retrying.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw new Error(`Keine Daten für "${ticker}" gefunden (HTTP ${resp.status} von ${host}).`);
        }
        lastError = `HTTP ${resp.status} von ${host}`;
      } else if (!ct.includes('json')) {
        // HTML error page despite ok status — the classic "Edge: Too Many Requests".
        lastError = `HTML statt JSON erhalten (${ct || 'unknown content-type'})`;
      } else {
        const data = await resp.json().catch(() => null);
        if (data && typeof data === 'object') return data;
        lastError = 'Antwort enthielt kein gültiges JSON';
      }
    } catch (err: any) {
      if (/^Keine Daten für/.test(String(err?.message || ''))) throw err;
      const msg = String(err?.message || err);
      // Translate the raw JSON syntax error into something actionable.
      lastError = /not valid JSON|Unexpected token/i.test(msg)
        ? 'HTML-Fehlerseite statt JSON erhalten (wahrscheinlich Rate-Limit von Yahoo)'
        : msg;
    }
    // brief backoff before the next host/attempt
    await new Promise((r) => setTimeout(r, 300 + attempt * 200));
  }
  throw new Error(`Yahoo Finance nicht erreichbar für ${ticker}: ${lastError}. Bitte später erneut versuchen oder web_search nutzen.`);
}
