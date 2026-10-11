import type { ToolDefinition, ToolCall, ToolResult, Source } from '../types';

// Built-in tool implementations
class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private implementations: Map<string, (args: any) => Promise<any>> = new Map();

  register(tool: ToolDefinition, implementation: (args: any) => Promise<any>): void {
    this.tools.set(tool.id, tool);
    this.implementations.set(tool.id, implementation);
  }

  getTool(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitionsForLLM(): any[] {
    return this.getEnabledTools().map(t => ({
      name: t.id,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();
    const tool = this.tools.get(call.toolId);
    
    if (!tool) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Tool not found: ${call.toolId}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    if (!tool.enabled) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `Tool is disabled: ${tool.name}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    const impl = this.implementations.get(call.toolId);
    if (!impl) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: `No implementation for tool: ${call.toolId}`,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }

    try {
      // Timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool timeout after ${tool.maxDuration}ms`)), tool.maxDuration);
      });

      const result = await Promise.race([impl(call.arguments), timeoutPromise]);
      
      return {
        callId: call.id,
        toolId: call.toolId,
        success: true,
        data: result,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      return {
        callId: call.id,
        toolId: call.toolId,
        success: false,
        error: err.message || 'Unknown error',
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      };
    }
  }

  toggleTool(id: string, enabled: boolean): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.enabled = enabled;
    }
  }
}

export const toolRegistry = new ToolRegistry();

// ============ Built-in Tool Implementations ============

// Web Search Tool
toolRegistry.register({
  id: 'web_search',
  name: 'Web Search',
  description: 'Search the web for current information. Returns titles, URLs, and snippets.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum results (default 10)' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } } }
      }
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  // Using a free search approach - in production, this would use a proper search API
  const query = encodeURIComponent(args.query);
  const maxResults = args.maxResults || 10;
  
  try {
    // Use DuckDuckGo instant answer API as a free fallback
    const response = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`);
    const data = await response.json();
    
    const results: Source[] = [];
    
    if (data.Abstract) {
      results.push({
        title: data.Heading || args.query,
        url: data.AbstractURL || '',
        snippet: data.Abstract,
        provider: 'duckduckgo',
      });
    }
    
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, maxResults)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || topic.Text.substring(0, 80),
            url: topic.FirstURL,
            snippet: topic.Text,
            provider: 'duckduckgo',
          });
        }
      }
    }

    return { results: results.slice(0, maxResults), query: args.query };
  } catch (err: any) {
    return { results: [], query: args.query, error: err.message };
  }
});

// News Search Tool
toolRegistry.register({
  id: 'news_search',
  name: 'News Search',
  description: 'Search for recent news articles. Returns titles, URLs, sources, and timestamps.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'News search query' },
      hoursBack: { type: 'number', description: 'How many hours back to search (default 48)' },
      maxResults: { type: 'number', description: 'Maximum results (default 10)' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      articles: { type: 'array' }
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 15000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  // Using DuckDuckGo news as a free news source
  const query = encodeURIComponent(args.query + ' news');
  
  try {
    const response = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`);
    const data = await response.json();
    
    const articles = [];
    if (data.News) {
      for (const item of data.News.slice(0, args.maxResults || 10)) {
        articles.push({
          title: item.title,
          url: item.url,
          snippet: item.excerpt || '',
          source: item.date ? new Date(item.date * 1000).toISOString() : new Date().toISOString(),
          publishedAt: item.date ? new Date(item.date * 1000).toISOString() : undefined,
        });
      }
    }

    return { articles, query: args.query, hoursBack: args.hoursBack || 48 };
  } catch (err: any) {
    return { articles: [], query: args.query, error: err.message };
  }
});

// Company Lookup Tool
toolRegistry.register({
  id: 'company_lookup',
  name: 'Company Lookup',
  description: 'Look up company information and stock ticker symbols.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      companyName: { type: 'string', description: 'Company name to look up' },
    },
    required: ['companyName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      ticker: { type: 'string' },
      exchange: { type: 'string' },
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 10000,
  builtin: true,
}, async (args) => {
  // Known companies database for offline capability
  const knownCompanies: Record<string, { ticker: string; exchange: string; sector: string }> = {
    'apple': { ticker: 'AAPL', exchange: 'NASDAQ', sector: 'Technology' },
    'microsoft': { ticker: 'MSFT', exchange: 'NASDAQ', sector: 'Technology' },
    'google': { ticker: 'GOOGL', exchange: 'NASDAQ', sector: 'Technology' },
    'alphabet': { ticker: 'GOOGL', exchange: 'NASDAQ', sector: 'Technology' },
    'amazon': { ticker: 'AMZN', exchange: 'NASDAQ', sector: 'Consumer' },
    'nvidia': { ticker: 'NVDA', exchange: 'NASDAQ', sector: 'Technology' },
    'amd': { ticker: 'AMD', exchange: 'NASDAQ', sector: 'Technology' },
    'tesla': { ticker: 'TSLA', exchange: 'NASDAQ', sector: 'Automotive' },
    'meta': { ticker: 'META', exchange: 'NASDAQ', sector: 'Technology' },
    'facebook': { ticker: 'META', exchange: 'NASDAQ', sector: 'Technology' },
    'netflix': { ticker: 'NFLX', exchange: 'NASDAQ', sector: 'Entertainment' },
    'intel': { ticker: 'INTC', exchange: 'NASDAQ', sector: 'Technology' },
    'samsung': { ticker: '005930.KS', exchange: 'KRX', sector: 'Technology' },
    'tsmc': { ticker: 'TSM', exchange: 'NYSE', sector: 'Technology' },
    'toyota': { ticker: 'TM', exchange: 'NYSE', sector: 'Automotive' },
    'bmw': { ticker: 'BMWYY', exchange: 'OTC', sector: 'Automotive' },
    'sap': { ticker: 'SAP', exchange: 'NYSE', sector: 'Technology' },
    'siemens': { ticker: 'SIEGY', exchange: 'OTC', sector: 'Industrial' },
    'volkswagen': { ticker: 'VWAGY', exchange: 'OTC', sector: 'Automotive' },
    'bayer': { ticker: 'BAYRY', exchange: 'OTC', sector: 'Healthcare' },
    'allianz': { ticker: 'ALIZY', exchange: 'OTC', sector: 'Finance' },
    'deutsche telekom': { ticker: 'DTEGY', exchange: 'OTC', sector: 'Telecom' },
  };

  const query = args.companyName.toLowerCase().trim();
  const company = knownCompanies[query];
  
  if (company) {
    return {
      name: args.companyName,
      ticker: company.ticker,
      exchange: company.exchange,
      sector: company.sector,
      found: true,
    };
  }

  // Try partial match
  for (const [name, info] of Object.entries(knownCompanies)) {
    if (query.includes(name) || name.includes(query)) {
      return {
        name: args.companyName,
        ticker: info.ticker,
        exchange: info.exchange,
        sector: info.sector,
        found: true,
        note: 'Partial match',
      };
    }
  }

  return { name: args.companyName, found: false, note: 'Company not found in local database. Try a web search.' };
});

// Stock Price Tool
toolRegistry.register({
  id: 'stock_price',
  name: 'Stock Price',
  description: 'Get current and historical stock price data for a ticker symbol.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL, NVDA)' },
      days: { type: 'number', description: 'Days of historical data (default 7)' },
    },
    required: ['ticker'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      price: { type: 'number' },
      change: { type: 'number' },
      historical: { type: 'array' },
    }
  },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 20000,
  builtin: true,
}, async (args) => {
  // Use a free financial data source
  const ticker = args.ticker.toUpperCase();
  const days = args.days || 7;
  
  try {
    // Using Yahoo Finance query API (free, no key required for basic data)
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${days}d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    
    if (!response.ok) {
      return { ticker, error: `Could not fetch data for ${ticker}. Status: ${response.status}`, found: false };
    }
    
    const data = await response.json();
    const result = data.chart?.result?.[0];
    
    if (!result) {
      return { ticker, error: `No data available for ${ticker}`, found: false };
    }
    
    const quotes = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const closes = quotes.close || [];
    
    const historical = timestamps.map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      close: closes[i] ? Math.round(closes[i] * 100) / 100 : null,
    })).filter((h: any) => h.close !== null);
    
    const currentPrice = historical.length > 0 ? historical[historical.length - 1].close : null;
    const previousPrice = historical.length > 1 ? historical[historical.length - 2].close : null;
    
    return {
      ticker,
      price: currentPrice,
      previousClose: previousPrice,
      change: currentPrice && previousPrice ? Math.round((currentPrice - previousPrice) * 100) / 100 : null,
      changePercent: currentPrice && previousPrice ? Math.round(((currentPrice - previousPrice) / previousPrice) * 10000) / 100 : null,
      historical,
      currency: result.meta?.currency || 'USD',
      exchange: result.meta?.exchangeName || '',
      found: true,
      dataNote: 'Data may be delayed 15-20 minutes. Not for trading decisions.',
    };
  } catch (err: any) {
    return { ticker, error: err.message, found: false };
  }
});

// Data Filter Tool
toolRegistry.register({
  id: 'data_filter',
  name: 'Data Filter',
  description: 'Filter, sort, and deduplicate data arrays. Useful for processing search results.',
  category: 'filter',
  inputSchema: {
    type: 'object',
    properties: {
      data: { type: 'array', description: 'Array of objects to filter' },
      filterField: { type: 'string', description: 'Field to filter on' },
      filterValue: { type: 'string', description: 'Value to match (substring match)' },
      sortBy: { type: 'string', description: 'Field to sort by' },
      sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
      deduplicateBy: { type: 'string', description: 'Field to deduplicate on' },
      limit: { type: 'number', description: 'Maximum results' },
    },
    required: ['data'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 100000,
  builtin: true,
}, async (args) => {
  let data = [...(args.data || [])];
  
  // Filter
  if (args.filterField && args.filterValue) {
    data = data.filter(item => {
      const val = String(item[args.filterField] || '').toLowerCase();
      return val.includes(args.filterValue.toLowerCase());
    });
  }
  
  // Deduplicate
  if (args.deduplicateBy) {
    const seen = new Set();
    data = data.filter(item => {
      const key = item[args.deduplicateBy];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  // Sort
  if (args.sortBy) {
    data.sort((a, b) => {
      const aVal = a[args.sortBy] || '';
      const bVal = b[args.sortBy] || '';
      const cmp = String(aVal).localeCompare(String(bVal));
      return args.sortOrder === 'desc' ? -cmp : cmp;
    });
  }
  
  // Limit
  if (args.limit) {
    data = data.slice(0, args.limit);
  }
  
  return { data, count: data.length };
});

// Text Summarizer Tool (uses AI internally)
toolRegistry.register({
  id: 'text_summarize',
  name: 'Text Summarizer',
  description: 'Summarize text content. Extracts key points and creates concise summaries.',
  category: 'ai_extraction',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to summarize' },
      maxLength: { type: 'number', description: 'Maximum summary length in words (default 100)' },
    },
    required: ['text'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  const text = args.text || '';
  const maxWords = args.maxLength || 100;
  
  // Simple extractive summarization
  const sentences = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 20);
  
  if (sentences.length <= 3) {
    return { summary: text.trim(), wordCount: text.split(/\s+/).length };
  }
  
  // Score sentences by position and length
  const scored = sentences.map((s: string, i: number) => ({
    text: s.trim(),
    score: (1 / (i + 1)) * (s.length > 50 ? 1.5 : 1) + (i < 3 ? 2 : 0),
  }));
  
  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  
  const selected = scored.slice(0, Math.min(5, Math.ceil(maxWords / 20)));
  selected.sort((a: { text: string }, b: { text: string }) => sentences.indexOf(a.text) - sentences.indexOf(b.text));
  
  const summary = selected.map((s: { text: string }) => s.text).join('. ') + '.';
  
  return {
    summary,
    wordCount: summary.split(/\s+/).length,
    originalWordCount: text.split(/\s+/).length,
  };
});

// Report Generator Tool
toolRegistry.register({
  id: 'generate_report',
  name: 'Report Generator',
  description: 'Generate a structured report from collected data and analysis results.',
  category: 'report',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Report title' },
      sections: {
        type: 'array',
        description: 'Report sections with heading and content',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            content: { type: 'string' },
          }
        }
      },
      sources: { type: 'array', description: 'Source references' },
    },
    required: ['title', 'sections'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: [],
  maxDuration: 5000,
  maxDataSize: 100000,
  builtin: true,
}, async (args) => {
  const report = {
    title: args.title,
    generatedAt: new Date().toISOString(),
    sections: args.sections || [],
    sources: args.sources || [],
    summary: `${args.sections?.length || 0} sections, ${args.sources?.length || 0} sources`,
  };
  
  return report;
});

// URL Fetch Tool
toolRegistry.register({
  id: 'url_fetch',
  name: 'URL Fetch',
  description: 'Fetch content from a URL. Returns text content with basic HTML stripping.',
  category: 'data_source',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxLength: { type: 'number', description: 'Maximum content length (default 5000)' },
    },
    required: ['url'],
  },
  outputSchema: { type: 'object' },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  const url = args.url;
  const maxLength = args.maxLength || 5000;
  
  // Security: validate URL
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Only HTTP/HTTPS URLs are allowed', url };
    }
    // Block internal/private IPs
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname.startsWith('192.168.') || 
        hostname.startsWith('10.') || hostname.startsWith('172.')) {
      return { error: 'Access to internal network addresses is blocked', url };
    }
  } catch {
    return { error: 'Invalid URL', url };
  }
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'AI-Research-Assistant/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, url };
    }
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json')) {
      return { error: 'Unsupported content type', url, contentType };
    }
    
    let text = await response.text();
    
    // Basic HTML stripping
    if (contentType.includes('html')) {
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/\s+/g, ' ').trim();
    }
    
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '... [truncated]';
    }
    
    return { content: text, url, length: text.length };
  } catch (err: any) {
    return { error: err.message, url };
  }
});
