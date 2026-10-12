import { describe, it, expect, beforeEach, vi } from 'vitest';
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
});
