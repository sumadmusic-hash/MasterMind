import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toolRegistry } from '../services/tools';

describe('ToolRegistry', () => {
  it('should have built-in tools registered', () => {
    const tools = toolRegistry.getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('should have web_search tool', () => {
    const tool = toolRegistry.getTool('web_search');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('Web Search');
    expect(tool?.enabled).toBe(true);
    expect(tool?.builtin).toBe(true);
  });

  it('should have ddg_web_search (DuckDuckGo) tool', () => {
    const tool = toolRegistry.getTool('ddg_web_search');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('DuckDuckGo Search');
    expect(tool?.category).toBe('data_source');
    expect(tool?.enabled).toBe(true);
    expect(tool?.builtin).toBe(true);
    expect(tool?.inputSchema.properties.query).toBeDefined();
    expect(tool?.inputSchema.properties.timeRange.enum).toEqual(['day', 'week', 'month', 'year']);
  });

  it('should have news_search tool', () => {
    const tool = toolRegistry.getTool('news_search');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('data_source');
  });

  it('should have company_lookup tool', () => {
    const tool = toolRegistry.getTool('company_lookup');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('data_source');
  });

  it('should have stock_price tool', () => {
    const tool = toolRegistry.getTool('stock_price');
    expect(tool).toBeDefined();
  });

  it('should have data_filter tool', () => {
    const tool = toolRegistry.getTool('data_filter');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('filter');
  });

  it('should return enabled tools only', () => {
    const enabled = toolRegistry.getEnabledTools();
    expect(enabled.every(t => t.enabled)).toBe(true);
  });

  it('should toggle tool enabled state', () => {
    const tool = toolRegistry.getTool('data_filter');
    expect(tool?.enabled).toBe(true);
    
    toolRegistry.toggleTool('data_filter', false);
    expect(toolRegistry.getTool('data_filter')?.enabled).toBe(false);
    
    // Re-enable for other tests
    toolRegistry.toggleTool('data_filter', true);
    expect(toolRegistry.getTool('data_filter')?.enabled).toBe(true);
  });

  it('should generate LLM tool definitions', () => {
    const defs = toolRegistry.getToolDefinitionsForLLM();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toHaveProperty('name');
    expect(defs[0]).toHaveProperty('description');
    expect(defs[0]).toHaveProperty('inputSchema');
  });

  it('should return error for unknown tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test',
      toolId: 'nonexistent_tool',
      toolName: 'Nonexistent',
      arguments: {},
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should execute data_filter tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test_filter',
      toolId: 'data_filter',
      toolName: 'Data Filter',
      arguments: {
        data: [
          { name: 'Apple', sector: 'Tech' },
          { name: 'Tesla', sector: 'Auto' },
          { name: 'Google', sector: 'Tech' },
        ],
        filterField: 'sector',
        filterValue: 'Tech',
      },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
  });

  it('should execute company_lookup for known company', async () => {
    const result = await toolRegistry.execute({
      id: 'test_company',
      toolId: 'company_lookup',
      toolName: 'Company Lookup',
      arguments: { companyName: 'NVIDIA' },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.found).toBe(true);
    expect(result.data.ticker).toBe('NVDA');
  });

  it('should execute text_summarize tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test_summary',
      toolId: 'text_summarize',
      toolName: 'Text Summarizer',
      arguments: {
        text: 'The quick brown fox jumps over the lazy dog. This is a longer sentence that provides more context about the animals in this story. Another sentence here to make the text long enough for summarization. And yet another one for good measure to ensure we have enough content.',
        maxLength: 50,
      },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.summary).toBeDefined();
    expect(result.data.summary.length).toBeGreaterThan(0);
  });
  it('should have weather tool registered', () => {
    const tool = toolRegistry.getTool('weather');
    expect(tool).toBeDefined();
    expect(tool?.enabled).toBe(true);
    expect(tool?.inputSchema.required).toContain('location');
  });

  // Webz.io News API (https://app.webz.io/) — als KI-Tools exponiert.
  it('should have webz_news and webz_top_news tools registered', () => {
    const search = toolRegistry.getTool('webz_news');
    expect(search).toBeDefined();
    expect(search?.category).toBe('data_source');
    expect(search?.enabled).toBe(true);
    expect(search?.inputSchema.required).toContain('query');

    const top = toolRegistry.getTool('webz_top_news');
    expect(top).toBeDefined();
    expect(top?.inputSchema.properties.category.enum).toContain('business');

    // Beide Tools müssen im LLM-Definitionen-Set auftauchen, damit das Modell
    // sie überhaupt aufrufen kann.
    const defs = toolRegistry.getToolDefinitionsForLLM();
    expect(defs.some(d => d.name === 'webz_news')).toBe(true);
    expect(defs.some(d => d.name === 'webz_top_news')).toBe(true);
  });

  // GNews.io News API (https://gnews.io/) — kostenlose, demo-key-fähige JSON-Suche.
  it('should have gnews_search and gnews_top_headlines tools registered', () => {
    const search = toolRegistry.getTool('gnews_search');
    expect(search).toBeDefined();
    expect(search?.category).toBe('data_source');
    expect(search?.enabled).toBe(true);
    expect(search?.inputSchema.required).toContain('query');

    const top = toolRegistry.getTool('gnews_top_headlines');
    expect(top).toBeDefined();
    expect(top?.inputSchema.properties.category.enum).toContain('business');

    const defs = toolRegistry.getToolDefinitionsForLLM();
    expect(defs.some(d => d.name === 'gnews_search')).toBe(true);
    expect(defs.some(d => d.name === 'gnews_top_headlines')).toBe(true);
  });

  it('gnews_search calls /api/v4/search with demo key fallback and maps articles', async () => {
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init?: any) => {
      fetchCalls.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({ totalArticles: 1 }),
        text: async () => JSON.stringify({
          totalArticles: 1,
          articles: [{
            title: 'Testmeldung',
            description: '<p>Kurzbeschreibung</p>',
            url: 'https://example.com/a1',
            pubDate: '2026-10-12T10:00:00Z',
          }],
        }),
      };
    };
    try {
      let result: any;
      try {
        result = await toolRegistry.execute({
          id: 't', toolId: 'gnews_search', toolName: 'gnews_search',
          arguments: { query: 'Bayer' }, timestamp: Date.now(),
        });
      } finally {
        vi.restoreAllMocks();
      }

      expect(result.success).toBe(true);
      // Dev-Proxy-Pfad + v4-Endpunkt + Demo-Key als Standard-API-Key
      expect(fetchCalls[0]).toContain('/gnews-api/api/v4/search?');
      expect(fetchCalls[0]).toContain('q=Bayer');
      expect(fetchCalls[0]).toContain('lang=de');
      expect(fetchCalls[0]).toContain('apikey=demo');
      const articles: any[] = (result.data as any).articles;
      expect(articles[0].title).toBe('Testmeldung');
      expect(articles[0].snippet).toBe('Kurzbeschreibung');
      expect(articles[0].url).toBe('https://example.com/a1');
      expect(articles[0].source).toBe('example.com');
      expect(articles[0].provider).toBe('gnews.io');
      expect((result.data as any).totalHits).toBe(1);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  it('gnews_search uses a user-configured API key when present', async () => {
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      fetchCalls.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => JSON.stringify({ totalArticles: 0, articles: [] }),
      };
    };
    try {
      const db = await import('../services/database');
      vi.spyOn(db, 'getSettings').mockResolvedValue({ gnewsApiKey: 'user-key-123' } as any);

      const result = await toolRegistry.execute({
        id: 't', toolId: 'gnews_search', toolName: 'gnews_search',
        arguments: { query: 'Test', language: 'en' }, timestamp: Date.now(),
      });
      expect(result.success).toBe(true);
      expect(fetchCalls[0]).toContain('apikey=user-key-123');
      expect(fetchCalls[0]).toContain('lang=en');
    } finally {
      vi.restoreAllMocks();
      (globalThis as any).fetch = origFetch;
    }
  });

  it('webz_news fails with helpful error when no token is configured', async () => {
    const result = await toolRegistry.execute({
      id: 't', toolId: 'webz_news', toolName: 'webz_news',
      arguments: { query: 'Test' }, timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Webz\.io-API-Token/i);
  });

  // Regressionschutz für das offizielle Webz-"Integrate"-Snippet:
  // GET https://api.webz.io/api/news?token=...&q=...&format=json (NICHT /search).
  it('webz_news calls the /api/news endpoint with q param and maps posts correctly', async () => {
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init?: any) => {
      fetchCalls.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({
          posts: [{
            url: 'https://example.com/a1',
            title: 'Testmeldung',
            text: 'Langertext des Artikels …',
            published: '2026-10-09T16:40:00.000+03:00',
            thread: { site: 'example.com', site_title: 'Example News', main_image: 'https://example.com/img.jpg' },
          }],
          total_results: 1,
        }),
      };
    };
    try {
      // Token-Quelle mocken: getSettings ist ein ESM-Live-Binding — vitest kann es
      // nicht zuweisen, aber mit spyOnProperty (Accessor) überschreiben.
      const db = await import('../services/database');
      // Vitest-eigener Mock-Setter (funktioniert bei ESM-Exporten), danach restore.
      vi.spyOn(db, 'getSettings').mockResolvedValue({ webzApiToken: 'test-token' } as any);

      let result: any;
      try {
        result = await toolRegistry.execute({
          id: 't', toolId: 'webz_news', toolName: 'webz_news',
          arguments: { query: 'Bayer' }, timestamp: Date.now(),
        });
      } finally {
        vi.restoreAllMocks();
      }

      expect(result.success).toBe(true);
      expect(fetchCalls[0]).toContain('/api/news?');
      expect(fetchCalls[0]).toContain('q=Bayer');
      expect(fetchCalls[0]).toContain('token=test-token');
      const articles: any[] = (result.data as any).articles;
      expect(articles[0].title).toBe('Testmeldung');
      expect(articles[0].url).toBe('https://example.com/a1');
      expect(articles[0].provider).toBe('webz:example.com');
      expect(articles[0].sourceName).toBe('Example News');
      expect((result.data as any).totalHits).toBe(1);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  describe('search tools regression (empty-result bug)', () => {
    const exec = (toolId: string, args: any) =>
      toolRegistry.execute({ id: 't', toolId, toolName: toolId, arguments: args, timestamp: Date.now() });

    it('web_search returns results for a normal query (not only DDG instant answers)', async () => {
      const result = await exec('web_search', { query: 'Sächsische Schweiz' });
      expect(result.success).toBe(true);
      expect(result.data.results.length).toBeGreaterThan(0);
      expect(result.data.results[0]).toHaveProperty('url');
    }, 20000);

    it('news_search returns recent articles via RSS providers', async () => {
      const result = await exec('news_search', { query: 'Deutschland', hoursBack: 168 });
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data.articles)).toBe(true);
      expect(result.data.articles.length).toBeGreaterThan(0);
      expect(result.data.articles[0].title).toBeTruthy();
    }, 20000);

    it('weather returns current conditions for a city', async () => {
      const result = await exec('weather', { location: 'Berlin' });
      expect(result.success).toBe(true);
      expect(result.data.found).toBe(true);
      expect(typeof result.data.current.temperatureC).toBe('number');
      expect(result.data.forecast.length).toBeGreaterThan(0);
    }, 20000);
  });

  describe('ddg_web_search (DuckDuckGo Websuche)', () => {
    const execDDG = (args: any) =>
      toolRegistry.execute({ id: 't', toolId: 'ddg_web_search', toolName: 'DuckDuckGo Search', arguments: args, timestamp: Date.now() });

    const SAMPLE_HTML = `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="https://html.duckduckgo.com/html//?uddg=https%3A%2F%2Fwww.beispiel.de%2Fseite&kd=-1">Ergebnis &amp; Titel</a>
        <a class="result__snippet" href="#"><b>Snippet</b>-Text mit &quot;HTML&quot;</a>
      </div>
      <div class="result results_links results_links_deep result--ad">
        <a class="result__a" href="https://ads.example.com/x">Werbung</a>
        <a class="result__snippet" href="#">ad</a>
      </div>
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzwei.de%2F&tj=desktop">Zweiter Treffer</a>
        <td class="result-snippet">Kurzer Snippet</td>
      </div>`;

    const origFetch = globalThis.fetch;

    afterEach(() => { (globalThis as any).fetch = origFetch; });

    it('parst echte HTML-Treffer: uddg-Links entpackt, Snippets bereinigt, Ads gefiltert', async () => {
      const urls: string[] = [];
      let postedBody = '';
      (globalThis as any).fetch = async (url: any, init?: any) => {
        urls.push(String(url));
        if (String(url).includes('html.duckduckgo.com')) {
          postedBody = String(init?.body || '');
          return new Response(SAMPLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const result = await execDDG({ query: 'beispiel suche', language: 'de' });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.provider).toBe('duckduckgo');
      expect(data.results.length).toBe(2); // Ad-Block wurde uebersprungen
      expect(data.results[0].title).toBe('Ergebnis & Titel');
      expect(data.results[0].url).toBe('https://www.beispiel.de/seite'); // uddg gewrappt + Tracking befreit
      expect(data.results[0].snippet).toBe('Snippet-Text mit "HTML"');
      expect(data.results[0].provider).toBe('duckduckgo-web');
      expect(data.results[1].url).toBe('https://zwei.de/'); // protocol-relative uddg
      // POST an html.duckduckgo.com mit Region aus language="de"
      expect(urls.some(u => u.includes('html.duckduckgo.com/html/'))).toBe(true);
      expect(postedBody).toContain('q=beispiel+suche');
      expect(postedBody).toContain('kl=de-de');
    });

    it('timeRange/Enum-Validierung: unbekannter Wert wird abgelehnt, gueltiger akzeptiert', async () => {
      const bad = await execDDG({ query: 'x', timeRange: 'jahrzehnt' });
      expect(bad.success).toBe(false);
      expect(bad.error).toContain('timeRange');
    });

    it('CAPTCHA-Hinweis ("anomaly") fuehrt zu Fehlermeldung statt leerem Ergebnis', async () => {
      (globalThis as any).fetch = async (url: any) => {
        if (String(url).includes('html.duckduckgo.com')) {
          return new Response('<html><head><title>anomaly.js</title></head><body>What anomaly?</body></html>', { status: 200 });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const result = await execDDG({ query: 'irgendwas' });
      expect(result.success).toBe(true); // Tool selbst schlaegt nicht fehl
      const data = result.data as any;
      expect(data.results).toEqual([]);
      expect(data.error).toContain('duckduckgo-web');
    });

    it('Instant-Answer-Fallback liefert Results, wenn das Web-Ranking leer bleibt', async () => {
      (globalThis as any).fetch = async (url: any) => {
        if (String(url).includes('html.duckduckgo.com')) {
          return new Response('<html><body>no results here</body></html>', { status: 200 });
        }
        return new Response(JSON.stringify({
          Heading: 'Berlin',
          Abstract: 'Hauptstadt von Deutschland',
          AbstractURL: 'https://de.wikipedia.org/wiki/Berlin',
          RelatedTopics: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const result = await execDDG({ query: 'Berlin' });
      const data = result.data as any;
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].provider).toBe('duckduckgo');
      expect(data.results[0].snippet).toContain('Hauptstadt');
    });
  });

});
