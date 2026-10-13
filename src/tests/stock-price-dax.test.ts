import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolRegistry } from '../services/tools';

const exec = (toolId: string, args: any) =>
  toolRegistry.execute({ id: 't', toolId, toolName: toolId, arguments: args, timestamp: Date.now() });

describe('stock_price: DAX-Abfrage (Bug „HTML-Fehler“)', () => {
  beforeEach(() => vi.restoreAllMocks());
  // `vi.stubGlobal` installs globals on the global object — restoreAllMocks()
  // does NOT undo them, so the HTML-error fetch mock leaked into every later
  // test in this file (the stock_analysis case ran against the stale 429 mock
  // and failed). unstubAllGlobals() returns `fetch` to its original value.
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('liefert einen Kurs, wenn Yahoo korrekt antwortet', async () => {
    const r: any = await exec('stock_price', { ticker: 'DAX' });
    expect(r.success).toBe(true);
    expect(r.data.found).toBe(true);
    expect(typeof r.data.price).toBe('number');
    expect(r.data.ticker).toBe('^GDAXI');
  }, 30000);

  it('reagiert robust auf die Yahoo-HTML-Fehlerseite (HTTP 429, "Edge: Too Many Requests")', async () => {
    // Simulate the exact production failure: every host answers with an HTML
    // error page. Previously resp.json() threw a raw SyntaxError which the
    // model saw as an opaque "HTML-Fehler".
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>Edge: Too Many Requests</body></html>', {
      status: 429, headers: { 'content-type': 'text/html' },
    })));
    const r: any = await exec('stock_price', { ticker: 'DAX' });
    expect(r.data.found).toBe(false);
    expect(r.data.error).toContain('Rate-Limit');
    expect(r.data.error).not.toMatch(/not valid JSON|Unexpected token/);
  }, 60000);

  it('lässt sich nicht von HTML mit Status 200 als JSON verkaufen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><html>blocked</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));
    const r: any = await exec('stock_price', { ticker: 'AAPL' });
    expect(r.data.found).toBe(false);
    expect(r.data.error).toContain('HTML');
  }, 60000);

  it('liefert bei HTTP 404 eine klare Meldung statt eines Retry-Hangs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })));
    const r: any = await exec('stock_price', { ticker: 'XYZNOTEXISTENT' });
    expect(r.data.found).toBe(false);
    expect(r.data.error).toMatch(/Keine Daten/);
  }, 60000);

  it('bereinigt ganze Nutzerfragen im ticker-Argument ("wie ist der DAX Kurs aktuell?")', async () => {
    let askedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      askedUrl = String(url);
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 1, currency: 'EUR' }, timestamp: [], indicators: { quote: [{}] } }] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const r: any = await exec('stock_price', { ticker: 'wie ist der DAX Kurs aktuell?' });
    expect(askedUrl).toContain('%5EGDAXI'); // resolved to ^GDAXI, not the raw sentence
    expect(r.data.ticker).toBe('^GDAXI');
  }, 30000);

  it('stock_analysis nutzt denselben robusten Pfad (DAX funktioniert)', async () => {
    const r: any = await exec('stock_analysis', { ticker: 'DAX', period: '1mo' });
    expect(r.data.found).toBe(true);
    expect(typeof r.data.metrics?.latestPrice).toBe('number');
  }, 60000);
});
