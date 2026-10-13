import { getSettings } from '../database';

// ============ GNews.io News API (https://gnews.io/) ============
//
// Rechercheergebnis "beste kostenlose News-API" (Stand: Okt. 2026):
// - gnews.io ist die einzige strukturierte JSON-News-Suche, die man OHNE jegliche
//   Registrierung nutzen kann: der offizielle Demo-Key "demo" ist dauerhaft frei
//   und liefert echte Treffer (max. 10 Artikel/Tag, q/m/max/lang/top-headlines).
// - Mit kostenlosem Account (100 Req/Tag) wird aus dem Demo-Modus voller Zugriff.
// - Alternativen im Blick behalten:
//     * The Guardian Open Platform — wirklich open source (Apache-2.0 auf GitHub),
//       kostenlose API (5.000 Req/Tag, Key per E-Mail-Aktivierung).
//     * NewsData.io / Currents / GDELT — Free-Tier mit API-Key bzw. ganz ohne Key.
// - Endpunkte:
//     GET https://gnews.io/api/v4/search?q=<query>&lang=de&max=3&apikey=<KEY>
//     GET https://gnews.io/api/v4/top-headlines?category=business&lang=de&max=3&apikey=<KEY>
//   Antwort: { totalArticles, articles: [{ title, description, url, image, pubDate }] }
//   Fehler: HTTP 4xx/5xx + {"errors":["..."]} (z. B. invalid key, quota exceeded).
// - CORS: api.gnews.io sendet keine Access-Control-Allow-Origin-Headers; direkte
//   Browser-Fetches werden blockiert. Lösung:
//     * Dev: Vite-Proxy /gnews-api → https://gnews.io (siehe vite.config.js)
//     * Prod: eigene Proxy-Basis in den Settings (gnewsApiBaseUrl)
//     * Fallback: öffentliche JSON-CORS-Proxies (allorigins.win, corsproxy.io)

const GNEWS_DEMO_KEY = 'demo'; // offizieller, dauerhaft freier Demo-Key von gnews.io

/** Basis-URL für GNews-Aufrufe: Dev-Proxy, konfigurierbare Proxy-Basis oder direkt. */
async function getGnewsBaseUrl(): Promise<string> {
  try {
    const settings = await getSettings();
    const custom = String(settings?.gnewsApiBaseUrl || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
  } catch { /* IndexedDB nicht verfügbar (Tests) → Default-Proxy */ }
  // /gnews-api ist im Vite-Dev-Server als Rewrite-Proxy auf https://gnews.io definiert.
  return '/gnews-api';
}

/** Holt eine GNews-API-Antwort über alle verfügbaren CORS-Pfade (Proxy-Kaskade). */
async function fetchGnewsJson(endpoint: string, params: Record<string, any>): Promise<any> {
  const settings = await getSettings().catch(() => null);
  const key = String(settings?.gnewsApiKey || '').trim() || GNEWS_DEMO_KEY;
  const qs = new URLSearchParams({ ...params, apikey: key });
  const base = await getGnewsBaseUrl();
  const target = `${base}/api/v4/${endpoint}?${qs}`;

  // Reihenfolge: erst eigener Pfad (Dev-Proxy/Proxy-Basis), dann öffentliche Proxies.
  const candidates = [
    target,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
  ];

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000), credentials: 'omit' });
      if (!resp.ok) { errors.push(`${new URL(url, 'http://local').host}: HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      let data: any;
      try { data = JSON.parse(text); }
      catch { errors.push('Antwort ist kein JSON (Proxy blockiert?)'); continue; }
      // GNews meldet Fehler als { errors: [...] } — als Fehler behandeln, damit
      // der nächste Proxy-Kandidat bzw. der Hinweis an das Modell durchgreift.
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        throw new Error(`GNews: ${data.errors.join('; ')}`);
      }
      if (!Array.isArray(data?.articles)) {
        errors.push('Unerwartetes Antwortformat (kein articles-Feld)');
        continue;
      }
      return data;
    } catch (err: any) {
      // HTTP-Fehler der Proxies → weiter zur nächsten Option; echte API-Fehler
      // (errors-Feld oben) werden sofort geworfen.
      if (String(err?.message || '').startsWith('GNews:')) throw err;
      errors.push(`${err.message}`);
    }
  }
  if (key === GNEWS_DEMO_KEY) {
    // Demo-Key erschöpft/abgelehnt — Nutzer zum kostenlosen Key verleiten.
    throw new Error(
      'GNews: Demo-Key lieferte keine Daten (Limit von 10 Anfragen/Tag erreicht?). ' +
      'Bitte unter Einstellungen → API Keys einen kostenlosen GNews-API-Key hinterlegen (https://gnews.io).'
    );
  }
  throw new Error(`GNews: Alle Zugriffswege fehlgeschlagen (${errors.join('; ')})`);
}

/**
 * Last-resort fallback for crypto tickers when Yahoo is unreachable/rate-
 * limited: CoinGecko (free, CORS-enabled, no key). Shared by company_lookup
 * and stock_price so the ticker map and fetch logic exist exactly once.
 * Returns null when the ticker is not a known crypto or the lookup fails.
 */
const CRYPTO_COINGECKO_IDS: Record<string, string> = {
  'BTC-USD': 'bitcoin', 'ETH-USD': 'ethereum', 'SOL-USD': 'solana',
  'XRP-USD': 'ripple', 'DOGE-USD': 'dogecoin', 'LTC-USD': 'litecoin',
  'ADA-USD': 'cardano', 'DOT-USD': 'polkadot', 'LINK-USD': 'chainlink',
};

async function fetchCryptoPriceFromCoingecko(
  ticker: string,
): Promise<{ id: string; priceUsd: number; changePercent24h?: number } | null> {
  const cgId = CRYPTO_COINGECKO_IDS[ticker.toUpperCase()];
  if (!cgId) return null;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(7000) },
    );
    const d = resp.ok ? (await resp.json().catch(() => null))?.[cgId] : null;
    if (typeof d?.usd !== 'number') return null;
    return {
      id: cgId,
      priceUsd: d.usd,
      changePercent24h: typeof d.usd_24h_change === 'number' ? d.usd_24h_change : undefined,
    };
  } catch {
    return null; // caller reports the original error
  }
}

/**
 * Last-resort fallback for crypto tickers when Yahoo is unreachable/rate-
 * limited: CoinGecko (free, CORS-enabled, no key). Shared by company_lookup
 * and stock_price so the ticker map and fetch logic exist exactly once.
 * Returns null when the ticker is not a known crypto or the lookup fails.
 */
const CRYPTO_COINGECKO_IDS: Record<string, string> = {
  'BTC-USD': 'bitcoin', 'ETH-USD': 'ethereum', 'SOL-USD': 'solana',
  'XRP-USD': 'ripple', 'DOGE-USD': 'dogecoin', 'LTC-USD': 'litecoin',
  'ADA-USD': 'cardano', 'DOT-USD': 'polkadot', 'LINK-USD': 'chainlink',
};

export async function fetchCryptoPriceFromCoingecko(
  ticker: string,
): Promise<{ id: string; priceUsd: number; changePercent24h?: number } | null> {
  const cgId = CRYPTO_COINGECKO_IDS[ticker.toUpperCase()];
  if (!cgId) return null;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(7000) },
    );
    const d = resp.ok ? (await resp.json().catch(() => null))?.[cgId] : null;
    if (typeof d?.usd !== 'number') return null;
    return {
      id: cgId,
      priceUsd: d.usd,
      changePercent24h: typeof d.usd_24h_change === 'number' ? d.usd_24h_change : undefined,
    };
  } catch {
    return null; // caller reports the original error
  }
}
