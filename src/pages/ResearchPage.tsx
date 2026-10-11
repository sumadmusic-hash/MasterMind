import { useState } from 'react';
import { toolRegistry } from '../services/tools';
import { Newspaper, TrendingUp, Building2, Search, Loader2, ExternalLink, AlertCircle, Clock, ArrowUpRight, ArrowDownRight } from 'lucide-react';

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
      <div className="border-b border-white/[0.06] bg-gray-900/40 backdrop-blur-sm p-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-glow">
              <Search className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight leading-tight">Research & Analysis</h2>
              <p className="text-xs text-gray-500">News, companies and market data in one query</p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleResearch()}
                placeholder="Enter a topic, company, or ticker to research..."
                className="input w-full !pl-10 !py-2.5"
              />
            </div>
            <button
              onClick={handleResearch}
              disabled={loading || !query.trim()}
              className="btn-primary !py-2.5 !px-5"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Research'}
            </button>
          </div>

          {/* Tabs */}
          <div className="inline-flex gap-1 mt-3 p-1 rounded-xl panel">
            {[
              { id: 'all', label: 'All Results' },
              { id: 'news', label: 'News' },
              { id: 'companies', label: 'Companies' },
              { id: 'stocks', label: 'Stocks' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                  activeTab === tab.id
                    ? 'bg-gradient-to-r from-blue-600/30 to-purple-600/20 text-blue-400 shadow-inner'
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
            <div className="flex items-center gap-2 p-3 bg-red-500/[0.08] border border-red-500/20 rounded-xl animate-fade-up">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span className="text-sm text-red-300">{error}</span>
            </div>
          )}

          {loading && (
            <div className="card p-4 space-y-3 animate-fade-up">
              <div className="flex items-center gap-3 text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                <span className="text-sm">Researching… gathering information from multiple sources</span>
              </div>
              <div className="space-y-2">
                <div className="h-3 bg-gray-800 rounded-full animate-pulse" />
                <div className="h-3 bg-gray-800 rounded-full animate-pulse w-4/5 [animation-delay:150ms]" />
                <div className="h-3 bg-gray-800 rounded-full animate-pulse w-3/5 [animation-delay:300ms]" />
              </div>
            </div>
          )}

          {filteredResults.map((result, idx) => (
            <div key={idx} className="animate-fade-up" style={{ animationDelay: `${Math.min(idx, 6) * 60}ms` }}>
              {result.type === 'news' && <NewsResults data={result.data} />}
              {result.type === 'company' && <CompanyResult data={result.data} />}
              {result.type === 'stock' && <StockResult data={result.data} />}
              {result.type === 'search' && <SearchResults data={result.data} />}
            </div>
          ))}

          {!loading && results.length === 0 && !error && (
            <div className="text-center py-16 animate-fade-up">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                <Newspaper className="w-7 h-7 text-gray-600" />
              </div>
              <p className="text-gray-400 text-sm font-medium">Enter a topic to start researching</p>
              <div className="flex flex-wrap justify-center gap-2 mt-3">
                {['NVIDIA', 'Tesla', 'AI industry', 'renewable energy'].map(s => (
                  <button
                    key={s}
                    onClick={() => setQuery(s)}
                    className="badge bg-white/[0.04] text-gray-500 ring-white/[0.08] hover:text-blue-400 hover:ring-blue-500/30 cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
              </div>
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
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Newspaper className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-semibold text-white tracking-tight">News Results</h3>
        <span className="badge bg-blue-500/10 text-blue-400 ring-blue-500/20 ml-auto">{articles.length} articles</span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {articles.map((article: any, i: number) => (
          <div key={i} className="flex gap-3 p-2 rounded-lg hover:bg-white/[0.04] transition-colors group">
            <span className="text-xs text-gray-600 tabular-nums w-5 text-right pt-0.5 flex-shrink-0">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-gray-200 group-hover:text-blue-400 font-medium line-clamp-2 leading-snug transition-colors"
              >
                {article.title}
              </a>
              {article.snippet && (
                <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">{article.snippet}</p>
              )}
              {article.publishedAt && (
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 mt-1.5">
                  <Clock className="w-3 h-3" />
                  {new Date(article.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>
            <ExternalLink className="w-3 h-3 text-gray-600 group-hover:text-blue-400 opacity-0 group-hover:opacity-100 flex-shrink-0 mt-1 transition-all" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanyResult({ data }: { data: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Building2 className="w-4 h-4 text-green-400" />
        <h3 className="text-sm font-semibold text-white tracking-tight">Company Info</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <InfoStat label="Name" value={data.name} accent />
        <InfoStat label="Ticker" value={data.ticker} mono accent />
        <InfoStat label="Exchange" value={data.exchange} />
        <InfoStat label="Sector" value={data.sector || 'N/A'} />
      </div>
    </div>
  );
}

function InfoStat({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className={`panel p-3 ${accent ? 'ring-1 ring-inset ring-white/[0.06]' : ''}`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className={`text-sm text-gray-100 font-semibold tracking-tight ${mono ? 'font-mono text-blue-400' : ''}`}>{value}</div>
    </div>
  );
}

function StockResult({ data }: { data: any }) {
  const isPositive = data.changePercent >= 0;
  
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className={`w-4 h-4 ${isPositive ? 'text-green-400' : 'text-red-400'}`} />
        <h3 className="text-sm font-semibold text-white tracking-tight">Stock Data: <span className="font-mono text-blue-400">{data.ticker}</span></h3>
        <span className="badge bg-white/[0.04] text-gray-500 ring-white/[0.08] ml-auto">{data.dataNote}</span>
      </div>
      
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="panel p-3 ring-1 ring-inset ring-white/[0.06]">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Price</div>
          <div className="text-xl text-gray-100 font-bold tracking-tight tabular-nums mt-0.5">
            ${data.price?.toFixed(2) || 'N/A'}
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Change</div>
          <div className={`text-sm font-semibold tabular-nums mt-1 ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {data.change >= 0 ? '+' : ''}{data.change?.toFixed(2) || 'N/A'}
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Change %</div>
          <div className={`inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-md text-sm font-semibold tabular-nums ${
            isPositive ? 'text-green-400 bg-green-500/10' : 'text-red-400 bg-red-500/10'
          }`}>
            {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {data.changePercent >= 0 ? '+' : ''}{data.changePercent?.toFixed(2) || 'N/A'}%
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Currency</div>
          <div className="text-sm text-gray-200 font-medium mt-1">{data.currency || 'USD'}</div>
        </div>
      </div>

      {/* Simple chart */}
      {data.historical && data.historical.length > 1 && (() => {
        const prices = data.historical.map((p: any) => p.close).filter(Boolean);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min || 1;
        return (
          <div className="panel p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">7-Day History</span>
              <span className="text-[11px] text-gray-600 tabular-nums">${min.toFixed(2)} – ${max.toFixed(2)}</span>
            </div>
            <div className="flex items-end gap-1.5 h-16">
              {data.historical.map((point: any, i: number) => {
                const height = ((point.close - min) / range) * 100;
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-t bg-gradient-to-t from-blue-600/40 to-blue-400/70 hover:from-blue-500/60 hover:to-blue-300 transition-all duration-200 cursor-default"
                    style={{ height: `${Math.max(5, height)}%` }}
                    title={`${point.date}: $${point.close}`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[11px] text-gray-600">{data.historical[0]?.date}</span>
              <span className="text-[11px] text-gray-600">{data.historical[data.historical.length - 1]?.date}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function SearchResults({ data }: { data: any }) {
  const results = data.results || [];
  if (results.length === 0) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Search className="w-4 h-4 text-purple-400" />
        <h3 className="text-sm font-semibold text-white tracking-tight">Web Results</h3>
        <span className="badge bg-purple-500/10 text-purple-400 ring-purple-500/20 ml-auto">{results.length} results</span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {results.map((result: any, i: number) => (
          <a
            key={i}
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group block p-2 rounded-lg hover:bg-white/[0.04] transition-colors"
          >
            <div className="text-sm text-gray-200 group-hover:text-blue-400 font-medium leading-snug transition-colors">{result.title}</div>
            {result.snippet && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">{result.snippet}</p>
            )}
            <div className="flex items-center gap-1 text-[11px] text-gray-600 mt-1">
              <ExternalLink className="w-2.5 h-2.5" />
              <span className="truncate">{result.url}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
