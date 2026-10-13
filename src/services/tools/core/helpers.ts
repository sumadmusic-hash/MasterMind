/**
 * Trim verbose JSON values before they are sent back to the model as tool
 * results (they count as prompt tokens on every subsequent agent step).
 * Strings are shortened, long arrays are capped; structure stays intact so
 * the model still sees all relevant fields.
 * Ausnahme: das Feld `content` (siehe COMPACT_CONTENT_MAX) — Artikel-/Volltext-
 * auszüge sind ein bewusst gesetztes Budget und dürfen nicht auf Snippet-Größe
 * gestutzt werden, sonst erzwingen sie die teure url_fetch-Kaskade.
 */
const COMPACT_CONTENT_MAX = 900;

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
    // Felder, die das Modell NIE braucht und die sonst als Prompt-Tokens auf
    // JEDEM Agent-Schritt mitgewandert wären. "callId" wird vom Loop nur für
    // das Caching interner Tool-Ergebnisse benutzt (turnToolResults) — es im
    // Replay an das Modell zu senden, ist reine Token-Verschwendung.
    const DROP_KEYS = new Set(['callId', 'timestamp']);
    for (const [k, v] of Object.entries(data)) {
      if (DROP_KEYS.has(k)) continue;
      // Sonderbehandlung "chart": der validierte Chart-Spec von chart_spec
      // wird von ChatPage direkt gerendert (lazy recharts). series/categories
      // sind bereits hart auf 120 Punkte begrenzt; die generische Kürzung
      // (maxArrayLen 8) würde das Diagramm zerstören — deshalb unangetastet.
      if (k === 'chart' && v && typeof v === 'object') {
        out[k] = v;
        continue;
      }
      // Sonderbehandlung "content": dieses Feld enthält die bewusst gesetzten
      // Textauszüge der Tools (url_fetch-Artikeltext).
      // Die globale Stringkürzung würde sie auf Snippet-Größe stutzen und damit
      // genau den Token-Spar-Effekt zunichtemachen (ohne Auszug → url_fetch +
      // text_summarize als teure Kaskade). Für content gilt daher das eigene,
      // bereits vom Tool gesetzte Budget — hier nur die harte Obergrenze.
      if (k === 'content' && typeof v === 'string') {
        out[k] = v.length > COMPACT_CONTENT_MAX ? v.slice(0, COMPACT_CONTENT_MAX) + '…' : v;
        continue;
      }
      out[k] = compactToolData(v, maxStringLen, maxArrayLen);
    }
    return out;
  }
  return data;
}

// ============ Pure helpers (unit-testable, no browser APIs) ============

/** Basic statistics over a numeric series (used by macro_series & portfolio). */
export function seriesStats(values: number[]): {
  count: number; last: number | null; min: number | null; max: number | null;
  mean: number | null; changePercent: number | null; firstDateDeltaDays: number | null;
} {
  const nums = values.filter(v => Number.isFinite(v));
  if (nums.length === 0) {
    return { count: 0, last: null, min: null, max: null, mean: null, changePercent: null, firstDateDeltaDays: null };
  }
  const first = nums[0];
  const last = nums[nums.length - 1];
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return {
    count: nums.length,
    last,
    min: Math.min(...nums),
    max: Math.max(...nums),
    mean,
    changePercent: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null,
    firstDateDeltaDays: null,
  };
}

/** Downsample a [{date,value}] series to at most `maxPoints` (keeps first+last). */
export function downsample<T extends { date: string; value?: number }>(points: T[], maxPoints = 60): T[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * Parse FRED's `fredgraph.csv` format: header `observation_date,DGS10` with
 * missing values encoded as ".". Returns only finite observations.
 */
export function parseFredCsv(text: string): { unit: string | undefined; points: { date: string; value: number }[] } {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { unit: undefined, points: [] };
  const header = lines[0].split(',');
  const unit = (header[1] || '').trim() || undefined;
  const points: { date: string; value: number }[] = [];
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(',');
    if (idx < 0) continue;
    const date = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(raw);
    if (raw === '.' || !Number.isFinite(value)) continue;
    points.push({ date, value });
  }
  return { unit, points };
}

/**
 * Parse a CSV file into rows of objects using the header row as keys.
 * Handles quoted fields and escaped quotes ("" inside "...").
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; skippedLines: number } {
  const src = String(text || '');
  const rowsRaw: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rowsRaw.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) endRow();

  const nonEmpty = rowsRaw.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [], skippedLines: 0 };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows: Record<string, string>[] = [];
  let skipped = 0;
  for (const r of nonEmpty.slice(1)) {
    if (r.length !== headers.length) { skipped++; continue; }
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = r[idx].trim(); });
    rows.push(obj);
  }
  return { headers, rows, skippedLines: skipped };
}

/** Serialize an array of flat objects into CSV (first object decides columns). */
export function toCsv(rows: Record<string, any>[], columns?: string[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = columns && columns.length ? columns : Object.keys(rows[0]);
  const esc = (v: any): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r?.[c])).join(','));
  return lines.join('\n');
}

/**
 * Resolve a dot/bracket path against parsed JSON, e.g. `data.series[0].values`
 * or `meta["obs time"]`. Returns undefined when any segment is missing —
 * never throws, so a wrong path costs one retry, not a crashed chain.
 */
export function jsonPath(obj: any, path: string): any {
  if (!path) return obj;
  const segments: (string | number)[] = [];
  const re = /\.([^.\[\]]+)|\[(\d+)\]|\["([^"]+)"\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  const leading = path.startsWith('$.') ? 2 : path.startsWith('$') ? 1 : 0;
  const body = path.slice(leading);
  if (body.length === 0) return obj;
  // Simple split fallback for plain dotted paths without brackets.
  if (!/[\[\]]/.test(body)) return body.split('.').reduce((acc: any, key: string) => acc?.[key], obj);
  while ((m = re.exec(body)) !== null) {
    if (m.index !== consumed) return undefined; // malformed segment
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
    else if (m[3] !== undefined) segments.push(m[3]);
    consumed = re.lastIndex;
  }
  if (consumed !== body.length) return undefined;
  return segments.reduce((acc: any, seg) => acc?.[seg], obj);
}

/**
 * Minimal linear-regression trend for two aligned series (x = dates of a,
 * y = values of b matched by date). Used by chart_generator's optional
 * `trendline` flag and by correlation questions like "Zinsen vs. Inflation".
 */
export function alignSeriesByDate(
  a: { date: string; value: number }[],
  b: { date: string; value: number }[]
): { dates: string[]; x: number[]; y: number[] } {
  const mapB = new Map(b.map(p => [p.date, p.value]));
  const dates: string[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (const p of a) {
    if (mapB.has(p.date)) {
      dates.push(p.date);
      x.push(p.value);
      y.push(mapB.get(p.date)!);
    }
  }
  return { dates, x, y };
}

export function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxx += x[i] * x[i]; syy += y[i] * y[i];
    sxy += x[i] * y[i];
  }
  const denomX = n * sxx - sx * sx;
  if (denomX === 0) return null;
  const slope = (n * sxy - sx * sy) / denomX;
  const intercept = (sy - slope * sx) / n;
  const denomY = n * syy - sy * sy;
  const r2 = denomX === 0 || denomY === 0 ? 0 : Math.pow(n * sxy - sx * sy, 2) / (denomX * denomY);
  return { slope, intercept, r2 };
}

/** Validate a schedule spec (see scheduler.ts) without importing it (no cycle). */
export function isValidScheduleSpec(spec: string): boolean {
  const s = String(spec || '').trim().toLowerCase();
  if (['@hourly', '@daily', '@weekly'].includes(s)) return true;
  const m = /^(\d+)\s*([mhd])$/.exec(s);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3600_000 : 86400_000) >= 60_000;
}

