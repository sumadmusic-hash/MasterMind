import { getSettings } from '../database';
import { stripHtml, cleanUrl } from './_text';

// ============ Webz.io News API (https://app.webz.io/) ============
//
// Professionelle News-/Social-Crawling-API mit strukturiertem JSON:
//   GET https://api.webz.io/api/news?token=<TOKEN>&q=<query>&format=json&size=N
//   GET https://api.webz.io/topHeadlines?token=<TOKEN>&category=business&format=json&size=N
// Antwort: { posts: [{ url, title, text, published, thread: { site, site_title, main_image } }], total_results }
// Fehler:  { error: "..." } bzw. HTTP 4xx/5xx (z. B. ungültiges Token).
// - api.webz.io sendet keine CORS-Headers; Browser-Fetches laufen daher über
//   den Vite-Dev-Proxy /webz-api (siehe vite.config.js) oder eine in den
//   Settings konfigurierbare Proxy-Basis (webzApiBaseUrl); danach versuchen
//   öffentliche JSON-CORS-Proxies als Fallback.
// - Ohne Token ist die API nicht nutzbar → klares Hinweis-Fehlerbild, damit das
//   Modell auf gnews_search / news_search umschwenkt statt zu raten.

/** Basis-URL für Webz-Aufrufe: Dev-Proxy, konfigurierbare Proxy-Basis oder direkt. */
async function getWebzBaseUrl(): Promise<string> {
  try {
    const settings = await getSettings();
    const custom = String(settings?.webzApiBaseUrl || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
  } catch { /* IndexedDB nicht verfügbar (Tests) → Default-Proxy */ }
  // /webz-api ist im Vite-Dev-Server als Rewrite-Proxy auf https://api.webz.io definiert.
  return '/webz-api';
}

/** Holt eine Webz.io-API-Antwort über alle verfügbaren CORS-Pfade (Proxy-Kaskade). */
async function fetchWebzJson(endpoint: string, params: Record<string, any>): Promise<any> {
  const settings = await getSettings().catch(() => null);
  const token = String(settings?.webzApiToken || '').trim();
  if (!token) {
    throw new Error(
      'Webz.io-API-Token fehlt. Bitte unter Einstellungen → API Keys einen kostenlosen ' +
      'Token von https://app.webz.io/ hinterlegen — oder stattdessen gnews_search / news_search nutzen.'
    );
  }
  const qs = new URLSearchParams({ ...params, token, format: 'json' });
  const base = await getWebzBaseUrl();
  const target = `${base}/${endpoint}?${qs}`;

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
      // text() bevorzugen (fängt Proxy-Seiten ab, die kein JSON sind); json()
      // nur als Fallback, wenn das Response-Objekt kein text kennt.
      const readBody = async (): Promise<any> => {
        if (typeof (resp as any).text === 'function') return JSON.parse(await (resp as any).text());
        return (resp as any).json();
      };
      let data: any;
      try { data = await readBody(); }
      catch { errors.push('Antwort ist kein JSON (Proxy blockiert?)'); continue; }
      // Webz meldet Fehler als { error: "..." } — als Fehler behandeln, damit
      // der nächste Kandidat bzw. der Hinweis an das Modell durchgreift.
      if (typeof data?.error === 'string' && data.error.trim()) {
        throw new Error(`Webz.io: ${data.error}`);
      }
      if (!Array.isArray(data?.posts)) {
        errors.push('Unerwartetes Antwortformat (kein posts-Feld)');
        continue;
      }
      return data;
    } catch (err: any) {
      // HTTP-/Formatfehler der Proxies → weiter zur nächsten Option; echte
      // API-Fehler (error-Feld oben) werden sofort geworfen.
      if (String(err?.message || '').startsWith('Webz.io:')) throw err;
      errors.push(`${err.message}`);
    }
  }
  throw new Error(`Webz.io: Alle Zugriffswege fehlgeschlagen (${errors.join('; ')})`);
}

/** Mappt einen Webz.io-Post auf das gemeinsame Source-Schema der App. */
function mapWebzHit(p: any): any {
  const publishedAt = p.published ? new Date(p.published).toISOString() : undefined;
  return {
    title: stripHtml(String(p.title || '')).trim(),
    url: cleanUrl(String(p.url || '')),
    snippet: stripHtml(String(p.text || '')).slice(0, 300),
    source: String(p.thread?.site || '').trim() || (() => { try { return new URL(p.url).hostname.replace(/^www\./, ''); } catch { return 'webz.io'; } })(),
    sourceName: p.thread?.site_title ? stripHtml(String(p.thread.site_title)) : undefined,
    image: p.thread?.main_image || undefined,
    publishedAt,
    provider: `webz:${p.thread?.site || 'unknown'}`,
  };
}
