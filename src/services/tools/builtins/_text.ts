/**
 * Gemeinsame Text-/URL-Helfer für mehrere Built-in-Tools.
 * Reine Funktionen ohne Tool-Registry-Abhängigkeit.
 */

export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function cleanUrl(url: string): string {
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

export function dedupeByUrl(articles: any[]): any[] {
  const seen = new Set<string>();
  return articles.filter(a => {
    const key = a.url || a.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeArticles(existing: any[], incoming: any[]): any[] {
  const out = [...existing];
  for (const a of incoming) {
    if (!out.some(o => o.url === a.url || o.title === a.title)) out.push(a);
  }
  return out;
}

export function describeFetchError(err: any): string {
  const msg = String(err?.message || err || 'unbekannter Fehler');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return `${msg} (CORS oder Netzwerk blockiert die Anfrage direkt vom Browser)`;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Zeitüberschreitung bei der Anfrage';
  return msg;
}
