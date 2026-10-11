import { useState } from 'react';
import { toolRegistry } from '../services/tools';
import { Newspaper, TrendingUp, Building2, Search, Loader2, ExternalLink, AlertCircle } from 'lucide-react';

interface ResearchResult {
  type: 'news' | 'company' | 'stock' | 'search';
  data: any;
  timestamp: number;
}

export function ResearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ResearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'news' | 'companies' | 'stocks'>('all');
  const [error, setError] = useState('');

  const handleResearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');

    try {
      const newResults: ResearchResult[] = [];

      // Search for news
      const newsResult = await toolRegistry.execute({
        id: `research_news_${Date.now()}`,
        toolId: 'news_search',
        toolName: 'News Search',
        arguments: { query, maxResults: 10, hoursBack: 48 },
        timestamp: Date.now(),
      });

      if (newsResult.success && newsResult.data?.articles?.length > 0) {
        newResults.push({ type: 'news', data: newsResult.data, timestamp: Date.now() });
      }

      // Search for web results
      const searchResult = await toolRegistry.execute({
        id: `research_search_${Date.now()}`,
        toolId: 'web_search',
        toolName: 'Web Search',
        arguments: { query, maxResults: 8 },
        timestamp: Date.now(),
      });

      if (searchResult.success && searchResult.data?.results?.length > 0) {
        newResults.push({ type: 'search', data: searchResult.data, timestamp: Date.now() });
      }

      // Try company lookup
      const companyResult = await toolRegistry.execute({
        id: `research_company_${Date.now()}`,
        toolId: 'company_lookup',
        toolName: 'Company Lookup',
        arguments: { companyName: query },
        timestamp: Date.now(),
      });

      if (companyResult.success && companyResult.data?.found) {
        newResults.push({ type: 'company', data: companyResult.data, timestamp: Date.now() });

        // If company found, also get stock data
        const stockResult = await toolRegistry.execute({
          id: `research_stock_${Date.now()}`,
          toolId: 'stock_price',
          toolName: 'Stock Price',
          arguments: { ticker: companyResult.data.ticker, days: 7 },
          timestamp: Date.now(),
        });

        if (stockResult.success && stockResult.data?.found) {
          newResults.push({ type: 'stock', data: stockResult.data, timestamp: Date.now() });
        }
      }

      setResults(prev => [...newResults, ...prev]);
    } catch (err: any) {
      setError(err.message);
    }

    setLoading(false);
  };

  const filteredResults = activeTab === 'all'
    ? results
    : results.filter(r => {
        if (activeTab === 'news') return r.type === 'news';
        if (activeTab === 'companies') return r.type === 'company';
        if (activeTab === 'stocks') return r.type === 'stock';
        return true;
      });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-gray-800 p-4">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-xl font-bold text-white mb-3">Research & Analysis</h2>
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleResearch()}
                placeholder="Enter a topic, company, or ticker to research..."
                aria-label="Research-Thema"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleResearch}
              disabled={loading || !query.trim()}
              title="Research starten (Enter)"
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Researching...</> : 'Research'}
            </button>
          </div>

          {/* Quick suggestions */}
          {!query && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {['NVIDIA', 'Tesla', 'AI industry', 'renewable energy', 'AAPL'].map(s => (
                <button
                  key={s}
                  onClick={() => setQuery(s)}
                  className="px-2.5 py-1 text-xs text-gray-400 bg-gray-800/60 hover:bg-gray-800 hover:text-gray-200 rounded-full border border-gray-700/50 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 mt-3">
            {[
              { id: 'all', label: 'All Results' },
              { id: 'news', label: 'News' },
              { id: 'companies', label: 'Companies' },
              { id: 'stocks', label: 'Stocks' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-sm text-red-300">{error}</span>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-3 p-4 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Researching... gathering information from multiple sources</span>
            </div>
          )}

          {filteredResults.map((result, idx) => (
            <div key={idx}>
              {result.type === 'news' && <NewsResults data={result.data} />}
              {result.type === 'company' && <CompanyResult data={result.data} />}
              {result.type === 'stock' && <StockResult data={result.data} />}
              {result.type === 'search' && <SearchResults data={result.data} />}
            </div>
          ))}

          {!loading && results.length === 0 && !error && (
            <div className="text-center py-16">
              <Newspaper className="w-12 h-12 mx-auto mb-3 text-gray-700" />
              <p className="text-gray-500 text-sm">Enter a topic to start researching</p>
              <p className="text-gray-600 text-xs mt-1">Try: NVIDIA, Tesla, AI industry, renewable energy</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NewsResults({ data }: { data: any }) {
  const articles = data.articles || [];
  if (articles.length === 0) return null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Newspaper className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-semibold text-white">News Results</h3>
        <span className="text-xs text-gray-500">({articles.length} articles)</span>
      </div>
      <div className="space-y-3">
        {articles.map((article: any, i: number) => (
          <div key={i} className="flex gap-3 p-2 rounded-lg hover:bg-gray-800/50 transition-colors">
            <div className="flex-1 min-w-0">
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-300 hover:text-blue-200 font-medium line-clamp-2"
              >
                {article.title}
              </a>
              {article.snippet && (
                <p className="text-xs text-gray-500 mt-1 line-clamp-2">{article.snippet}</p>
              )}
              {article.publishedAt && (
                <span className="text-xs text-gray-600 mt-1">
                  {new Date(article.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <ExternalLink className="w-3 h-3 text-gray-600 flex-shrink-0 mt-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanyResult({ data }: { data: any }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Building2 className="w-4 h-4 text-green-400" />
        <h3 className="text-sm font-semibold text-white">Company Info</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Name</div>
          <div className="text-sm text-gray-200 font-medium">{data.name}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Ticker</div>
          <div className="text-sm text-gray-200 font-medium">{data.ticker}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Exchange</div>
          <div className="text-sm text-gray-200">{data.exchange}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Sector</div>
          <div className="text-sm text-gray-200">{data.sector || 'N/A'}</div>
        </div>
      </div>
    </div>
  );
}

function StockResult({ data }: { data: any }) {
  const isPositive = data.changePercent >= 0;
  
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-yellow-400" />
        <h3 className="text-sm font-semibold text-white">Stock Data: {data.ticker}</h3>
        <span className="text-xs text-gray-600 ml-auto">{data.dataNote}</span>
      </div>
      
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Price</div>
          <div className="text-lg text-gray-100 font-bold">
            ${data.price?.toFixed(2) || 'N/A'}
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Change</div>
          <div className={`text-sm font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {data.change >= 0 ? '+' : ''}{data.change?.toFixed(2) || 'N/A'}
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Change %</div>
          <div className={`text-sm font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {data.changePercent >= 0 ? '+' : ''}{data.changePercent?.toFixed(2) || 'N/A'}%
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500">Currency</div>
          <div className="text-sm text-gray-200">{data.currency || 'USD'}</div>
        </div>
      </div>

      {/* Simple chart */}
      {data.historical && data.historical.length > 1 && (
        <div className="bg-gray-800/30 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-2">7-Day History</div>
          <div className="flex items-end gap-1 h-16">
            {data.historical.map((point: any, i: number) => {
              const prices = data.historical.map((p: any) => p.close).filter(Boolean);
              const min = Math.min(...prices);
              const max = Math.max(...prices);
              const range = max - min || 1;
              const height = ((point.close - min) / range) * 100;
              return (
                <div
                  key={i}
                  className="flex-1 bg-blue-500/40 rounded-t hover:bg-blue-500/60 transition-colors"
                  style={{ height: `${Math.max(5, height)}%` }}
                  title={`${point.date}: $${point.close}`}
                />
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-gray-600">{data.historical[0]?.date}</span>
            <span className="text-xs text-gray-600">{data.historical[data.historical.length - 1]?.date}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SearchResults({ data }: { data: any }) {
  const results = data.results || [];
  if (results.length === 0) return null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Search className="w-4 h-4 text-purple-400" />
        <h3 className="text-sm font-semibold text-white">Web Results</h3>
        <span className="text-xs text-gray-500">({results.length} results)</span>
      </div>
      <div className="space-y-2">
        {results.map((result: any, i: number) => (
          <a
            key={i}
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block p-2 rounded-lg hover:bg-gray-800/50 transition-colors"
          >
            <div className="text-sm text-blue-300 hover:text-blue-200 font-medium">{result.title}</div>
            {result.snippet && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{result.snippet}</p>
            )}
            <div className="text-xs text-gray-600 mt-0.5">{result.url}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
