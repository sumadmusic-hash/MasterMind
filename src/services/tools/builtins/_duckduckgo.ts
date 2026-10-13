import type { Source } from '../../types';
import { getSettings } from '../database';
import { decodeXmlEntities, stripHtml, cleanUrl, describeFetchError } from './_text';

// ---- DuckDuckGo Helpers -----------------------------------------------------
// DuckDuckGo bietet zwei nutzbare, kostenlose Endpunkte ohne API-Key:
//  1. api.duckduckgo.com  (Instant Answer JSON-API, CORS-faehig) - liefert nur
//     enzyklopaedische Antworten; fuer die meisten Alltagsanfragen leer.
//  2. html.duckduckgo.com (Crawler-/Textversion der normalen Suche) - echte
//     WEB-Treffer inkl. Snippets. Als POST-Formular (application/x-www-form-
//     urlencoded) funktioniert der Endpunkt auch aus dem Browser heraus;
//     einfache GET-Requests beantwortet DDG gern mit HTTP 200 + CAPTCHA-
//     Hinweis ("anomaly"), was wie "0 Treffer" aussaehe - daher POST.
// `ddg_web_search` ist das eigentliche DuckDuckGo-Suchwerkzeug fuer die KI;
// es kombiniert echtes Web-Ranking mit der Instant-Answer-API.

/** Map language / locale-ish inputs onto DuckDuckGo's `kl` region codes.
 * Ohne Angabe wird die Browser-Sprache verwendet (navigator.language), damit
 * eine deutsche Frage ("wer ist Bundeskanzler?") deutsche Treffer bekommt,
 * auch wenn das Modell den `language`-Parameter weglässt. */
function ddgRegionCode(language?: string): string {
  const raw = String(language || '').trim().toLowerCase();
  if (!raw) {
    let nav = '';
    try { nav = String(globalThis.navigator?.language || ''); } catch { /* kein Browser (Tests/Node) */ }
    if (nav) return ddgRegionCode(nav);
  }
  if (/^[a-z]{2}-[a-z]{2}$/.test(raw)) return raw; // already a kl code, e.g. "de-de"
  const base = raw.split('-')[0];
  const map: Record<string, string> = {
    de: 'de-de', at: 'at-de', ch: 'ch-de', fr: 'fr-fr', it: 'it-it', es: 'es-es',
    nl: 'nl-nl', pl: 'pl-pl', ru: 'ru-ru', tr: 'tr-tr', uk: 'ua-en', us: 'us-en',
  };
  if (map[base]) return map[base];
  return /^[a-z]{2}$/.test(base) ? `${base}-en` : 'wt-wt'; // unknown -> worldwide
}

/** Unwrap DuckDuckGo's `uddg=` redirect links and drop tracking parameters. */
function unwrapDDGUrl(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const inner = u.searchParams.get('uddg');
    let out = inner || href;
    if (/^\/\//.test(out)) out = 'https:' + out;
    const parsed = new URL(out);
    for (const p of ['kd', 'kaj', 'kjp', 'kce', 'df', 'dp', 'tj', 'kt']) parsed.searchParams.delete(p);
    return parsed.toString();
  } catch {
    return href;
  }
}

/** Parse organic result blocks from html.duckduckgo.com markup (ads are skipped). */
function parseDDGHtmlResults(htmlDoc: string, max: number): Source[] {
  // Split so that each chunk STARTS with its own container opening tag - this
  // lets us check the block's OWN classes for ad markers (checking the whole
  // chunk would also see the NEXT block's classes and vice versa).
  const parts = htmlDoc.split(/(?=<div[^>]+class="[^"]*\bresult results_links[^"]*")/);
  const out: Source[] = [];
  for (const block of parts) {
    if (out.length >= max) break;
    const header = block.slice(0, 300); // Klassen des Container-Tags dieser Zeile
    if (/result--ad|badge--ad|results_links_deep_homepage/.test(header)) continue; // Sponsored Ergebnisse ueberspringen
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const title = decodeXmlEntities(stripHtml(link[2])).trim();
    const url = unwrapDDGUrl(decodeXmlEntities(link[1]));
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[\s\S]*?>([\s\S]*?)<\/a>/)
      || block.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const snippet = snippetMatch ? decodeXmlEntities(stripHtml(snippetMatch[1])).trim() : '';
    out.push({ title, url, snippet: snippet || undefined, provider: 'duckduckgo-web' });
  }
  return out;
}

/** Basis-URL für html.duckduckgo.com: konfigurierbare Proxy-Basis (Settings),
 * sonst der Vite-Dev-Proxy /ddg-api (siehe vite.config.js). html.duckduckgo.com
 * sendet keine CORS-Headers – ein direkter Browser-Fetch würde immer mit
 * "TypeError: Failed to fetch" enden, daher führt jeder Versuch über einen
 * gleichartigen Prefix-/Proxy-Pfad. */
async function getDDGHtmlBase(): Promise<string> {
  try {
    const settings = await getSettings();
    const custom = String(settings?.ddgApiBaseUrl || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
  } catch { /* IndexedDB nicht verfügbar (Tests) → Default-Proxy */ }
  // /ddg-api ist im Vite-Dev-Server als Rewrite-Proxy auf https://html.duckduckgo.com definiert.
  return '/ddg-api';
}



/**
 * Holt Suchtreffer von html.duckduckgo.com über mehrere Kandidaten (GET via
 * Dev-Proxy / konfigurierbare Proxy-Basis, dann POST direkt).
 *
 * Hintergrund: Der Browser kann html.duckduckgo.com NICHT direkt laden – die
 * Antwort enthält keine `Access-Control-Allow-Origin`-Header, der Fetch bricht
 * mit "TypeError: Failed to fetch" ab (das war der Bug: die Suche meldete
 * "keine Treffer", obwohl DDG längst geantwortet hatte). Auch ein POST wäre
 * aus dem Browser zudem eine CORS-Preflight-Anfrage, die DDG nicht beantwortet.
 * Deshalb: erst der gleiche Pfad wie bei webz/gnews (Proxy), dann Direkt-POST
 * als Fallback für Server-Umgebungen (Tests, Node) und den Fall, dass DDG
 * someday CORS nachrüstet.
 */
async function fetchDDGWebResults(query: string, region: string, max: number): Promise<Source[]> {
  const base = await getDDGHtmlBase();
  const qs = new URLSearchParams({ q: query, kl: region });
  const candidates: Array<{ url: string; init: RequestInit }> = [
    // 1) Proxy-Pfad als GET: kein Preflight, funktioniert aus dem Browser.
    { url: `${base}/?${qs.toString()}`, init: { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(9000) } },
    // 2) Direkter POST (funktioniert nur ohne CORS-Restriktion, z. B. serverseitig).
    {
      url: 'https://html.duckduckgo.com/html/',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; AI-Research-Assistant/2.0)',
        },
        body: qs as unknown as BodyInit,
        signal: AbortSignal.timeout(9000),
      },
    },
  ];

  const errors: string[] = [];
  for (const cand of candidates) {
    let resp: Response;
    try {
      resp = await fetch(cand.url, cand.init);
    } catch (err: any) {
      errors.push(describeFetchError(err));
      continue;
    }
    if (!resp.ok) { errors.push(`HTTP ${resp.status}`); continue; }
    const htmlDoc = await resp.text();
    if (/anomaly/i.test(htmlDoc.slice(0, 4000))) {
      throw new Error('DuckDuckGo blockiert automatisierte Anfragen (CAPTCHA-Seite) - kurz warten und erneut versuchen.');
    }
    const parsed = parseDDGHtmlResults(htmlDoc, max);
    if (parsed.length > 0) return parsed;
    errors.push('Antwort enthielt keine organischen Treffer');
  }
  // Keine Fehler werfen, wenn DDG sauber geantwortet hat, aber 0 Treffer lieferte:
  // Das ist ein echtes "keine Ergebnisse", kein technischer Defekt.
  if (errors.every(e => e === 'Antwort enthielt keine organischen Treffer')) return [];
  throw new Error(errors.join('; '));
}
