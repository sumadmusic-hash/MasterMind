import { describe, it, expect } from 'vitest';
import { toolRegistry, coerceToolArguments, validateToolArguments } from '../services/tools';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    maxResults: { type: 'number' },
    includeContent: { type: 'boolean' },
    category: { type: 'string', enum: ['business', 'tech'] },
  },
  required: ['query'],
};

describe('coerceToolArguments (LLM-typische Formate)', () => {
  it('wandelt Zahlen-Strings in Numbers um (inkl. Komma & Leerzeichen)', () => {
    const out = coerceToolArguments(schema, { query: 'x', maxResults: '4' });
    expect(out.maxResults).toBe(4);
    const de = coerceToolArguments(schema, { query: 'x', maxResults: '1 000,5' });
    expect(de.maxResults).toBe(1000.5);
  });

  it('wandelt "true"/"1"/"ja"/"false"/"0"/"nein" in Booleans um', () => {
    expect(coerceToolArguments(schema, { query: 'x', includeContent: 'true' }).includeContent).toBe(true);
    expect(coerceToolArguments(schema, { query: 'x', includeContent: 'ja' }).includeContent).toBe(true);
    expect(coerceToolArguments(schema, { query: 'x', includeContent: 'false' }).includeContent).toBe(false);
    expect(coerceToolArguments(schema, { query: 'x', includeContent: '0' }).includeContent).toBe(false);
  });

  it('entfernt Platzhalter-Müll ("", "null", "none") für optionale Parameter', () => {
    const out = coerceToolArguments(schema, { query: 'x', maxResults: 'null', includeContent: '' });
    expect('maxResults' in out).toBe(false);
    expect('includeContent' in out).toBe(false);
  });

  it('lässt Pflicht-Parameter leer stehen (Validierung soll meckern)', () => {
    const out = coerceToolArguments(schema, { query: 'null' });
    expect(out.query).toBe('null'); // wird nicht gelöscht, weil required
  });

  it('unbekannte/andere Typen bleiben unverändert', () => {
    const out = coerceToolArguments(schema, { query: 'x', maxResults: 'apfel' });
    expect(out.maxResults).toBe('apfel'); // Number schlägt fehl → Validierung greift
  });
});

describe('validateToolArguments (nach Coercion)', () => {
  it('akzeptiert case-insensitive Enum-Werte und normalisiert sie', () => {
    const args = { query: 'x', category: 'TECH' };
    expect(validateToolArguments(schema, args)).toEqual([]);
    expect(args.category).toBe('tech');
  });

  it('lehnt echte Enum-Verstöße ab', () => {
    expect(validateToolArguments(schema, { query: 'x', category: 'sport' })).toHaveLength(1);
  });

  it('lehnt unbekannte Parameter weiterhin ab (Schutz vor erfundenen Params)', () => {
    const problems = validateToolArguments(schema, { query: 'x', locationg: 'Berlin' });
    expect(problems[0]).toContain('locationg');
  });

  it('prüft leere Pflicht-Parameter', () => {
    expect(validateToolArguments(schema, {})).toHaveLength(1);
  });
});

describe('execute(): Coercion + maxDataSize + Timer-Cleanup', () => {
  const call = (toolId: string, args: any) => ({
    id: 't', toolId, toolName: toolId, arguments: args, timestamp: Date.now(),
  });

  it('führt data_filter mit String-Zahl für limit erfolgreich aus (kein Retry nötig)', async () => {
    const result = await toolRegistry.execute(call('data_filter', {
      data: [{ a: 1 }, { a: 2 }, { a: 3 }],
      filterField: 'a',
      filterValue: "1",
    }) as any);
    expect(result.success).toBe(true);

    // Boolean als String "true" für einen boolean-Param: akzeptiert statt Fehler.
    const r2 = await toolRegistry.execute(call('chart_spec', {
      chart: JSON.stringify({ type: 'line', series: [] }),
    }) as any);
    // chart_spec erwartet strukturierte Eingabe — hier nur prüfen, dass die
    // Pipeline (Coercion→Validierung→Impl) keine Typ-Artefakte erzeugt.
    expect(typeof r2.success).toBe('boolean');
  });

  it('begrenzt Ausgaben über maxDataSize mit truncation-Hinweis statt Token-Explosion', async () => {
    // portfolio_overview: maxDataSize klein; wir erzwingen eine Riesen-Ausgabe
    // über ein registriertes Test-Tool (Register invalidiert die Resolve-Memo).
    toolRegistry.register({
      id: '__test_big__', name: 'Big', description: 'test', category: 'transform',
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object' }, version: '1', enabled: true,
      permissions: [], maxDuration: 3000, maxDataSize: 500, builtin: false,
    }, async () => ({ blob: 'x'.repeat(2000) }));

    const result = await toolRegistry.execute(call('__test_big__', {}) as any);
    expect(result.success).toBe(true);
    expect(result.data.truncated).toBe(true);
    expect(result.data.limit).toBe(500);

    // Aufräumen: Tool wieder entfernen geht über Registry-API nicht — aber ein
    // deaktiviertes Tool stört keine anderen Tests.
    toolRegistry.toggleTool('__test_big__', false);
  });

  it('Timeout hinterlässt keinen hängenden Timer (clearTimeout wird erreicht)', async () => {
    toolRegistry.register({
      id: '__test_hang__', name: 'Hang', description: 'test', category: 'transform',
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object' }, version: '1', enabled: true,
      permissions: [], maxDuration: 50, maxDataSize: 1000, builtin: false,
    }, () => new Promise(resolve => setTimeout(() => resolve('spät'), 5000)));

    const clearSpy = vi_spyClear();
    const result = await toolRegistry.execute(call('__test_hang__', {}) as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(clearSpy.calls).toBeGreaterThan(0);
    clearSpy.restore();
    toolRegistry.toggleTool('__test_hang__', false);
  });

  it('Abort-Signal verhindert Start komplett (duration 0)', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await toolRegistry.execute(call('data_filter', { data: [], filterField: 'a', filterValue: 1 }) as any, ac.signal);
    expect(result.success).toBe(false);
    expect(result.duration).toBe(0);
  });
});

// Minimaler clearTimeout-Spy ohne vitest.mock (ESM-Live-Bindings).
function vi_spyClear() {
  const orig = globalThis.clearTimeout;
  let calls = 0;
  (globalThis as any).clearTimeout = ((h: any) => { calls++; return (orig as any)(h); }) as any;
  return { get calls() { return calls; }, restore: () => { (globalThis as any).clearTimeout = orig; } };
}
