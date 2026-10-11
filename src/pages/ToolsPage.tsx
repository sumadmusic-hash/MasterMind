import { useState } from 'react';
import { toolRegistry } from '../services/tools';
import type { ToolDefinition } from '../types';
import {
  Wrench, Search, Newspaper, Building2, TrendingUp, Filter,
  FileText, Globe, ToggleLeft, ToggleRight, TestTube, ChevronDown, ChevronUp, Loader2
} from 'lucide-react';

const CATEGORY_ICONS: Record<string, any> = {
  data_source: Globe,
  filter: Filter,
  transform: TrendingUp,
  ai_extraction: FileText,
  comparison: Search,
  report: FileText,
  workflow: Wrench,
};

const CATEGORY_LABELS: Record<string, string> = {
  data_source: 'Data Sources',
  filter: 'Filters',
  transform: 'Transformations',
  ai_extraction: 'AI Extraction',
  comparison: 'Comparison',
  report: 'Reports',
  workflow: 'Workflows',
};

export function ToolsPage() {
  const [tools, setTools] = useState<ToolDefinition[]>(toolRegistry.getAllTools());
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('{}');
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = tools.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedTools = filteredTools.reduce((groups, tool) => {
    const cat = tool.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(tool);
    return groups;
  }, {} as Record<string, ToolDefinition[]>);

  const handleToggle = (toolId: string, enabled: boolean) => {
    toolRegistry.toggleTool(toolId, enabled);
    setTools(toolRegistry.getAllTools());
  };

  const handleTest = async (tool: ToolDefinition) => {
    setTesting(true);
    setTestResult(null);
    
    try {
      let args: Record<string, any>;
      try {
        args = JSON.parse(testInput);
      } catch {
        setTestResult({ success: false, error: 'Invalid JSON input' });
        setTesting(false);
        return;
      }

      const result = await toolRegistry.execute({
        id: `test_${Date.now()}`,
        toolId: tool.id,
        toolName: tool.name,
        arguments: args,
        timestamp: Date.now(),
      });

      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    }
    setTesting(false);
  };

  const selected = tools.find(t => t.id === selectedTool);
  const SelectedIcon = selected ? (CATEGORY_ICONS[selected.category] || Wrench) : null;

  return (
    <div className="h-full flex">
      {/* Tool List */}
      <div className="w-80 border-r border-white/[0.06] flex flex-col bg-gray-900/40 backdrop-blur-sm">
        <div className="p-3 border-b border-white/[0.06]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search tools..."
              className="input w-full !pl-9"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {Object.entries(groupedTools).map(([category, categoryTools]) => {
            const Icon = CATEGORY_ICONS[category] || Wrench;
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-2 px-1">
                  <Icon className="w-3.5 h-3.5 text-gray-500" />
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
                    {CATEGORY_LABELS[category] || category}
                  </span>
                  <span className="text-[10px] text-gray-700 tabular-nums">{categoryTools.length}</span>
                </div>
                <div className="space-y-1">
                  {categoryTools.map(tool => (
                    <div
                      key={tool.id}
                      onClick={() => setSelectedTool(tool.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 ${
                        selectedTool === tool.id
                          ? 'bg-gradient-to-r from-blue-600/20 to-transparent ring-1 ring-inset ring-blue-500/25 text-blue-300'
                          : 'text-gray-300 hover:bg-white/[0.05]'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{tool.name}</div>
                        <div className="text-xs text-gray-500 truncate">{tool.description}</div>
                      </div>
                      <button
                        aria-label={`Toggle ${tool.name}`}
                        onClick={(e) => { e.stopPropagation(); handleToggle(tool.id, !tool.enabled); }}
                        className="flex-shrink-0 rounded-lg hover:bg-white/[0.06] p-0.5 transition-colors"
                      >
                        {tool.enabled ? (
                          <ToggleRight className="w-5 h-5 text-green-400" />
                        ) : (
                          <ToggleLeft className="w-5 h-5 text-gray-600" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tool Detail */}
      <div className="flex-1 overflow-y-auto p-6">
        {selected ? (
          <div className="max-w-2xl space-y-6 animate-fade-up">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-glow">
                  <SelectedIcon className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-xl font-bold text-white tracking-tight">{selected.name}</h2>
                <span className={`badge ${
                  selected.enabled
                    ? 'bg-green-500/10 text-green-400 ring-green-500/25'
                    : 'bg-white/[0.04] text-gray-500 ring-white/10'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${selected.enabled ? 'bg-green-400' : 'bg-gray-600'}`} />
                  {selected.enabled ? 'Active' : 'Disabled'}
                </span>
                <span className="text-xs text-gray-600 font-mono">v{selected.version}</span>
              </div>
              <p className="text-sm text-gray-400 leading-relaxed">{selected.description}</p>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-2 gap-3">
              <InfoCard label="Category" value={CATEGORY_LABELS[selected.category] || selected.category} />
              <InfoCard label="Max Duration" value={`${selected.maxDuration}ms`} />
              <InfoCard label="Max Data Size" value={`${(selected.maxDataSize / 1000).toFixed(0)}KB`} />
              <InfoCard label="Permissions" value={selected.permissions.join(', ') || 'None'} />
              <InfoCard label="Built-in" value={selected.builtin ? 'Yes' : 'Custom'} />
            </div>

            {/* Input Schema */}
            <div>
              <h3 className="section-title mb-2">Input Schema</h3>
              <pre className="panel p-3 text-xs text-gray-400 font-mono overflow-x-auto leading-relaxed">
                {JSON.stringify(selected.inputSchema, null, 2)}
              </pre>
            </div>

            {/* Test Area */}
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <TestTube className="w-4 h-4 text-purple-400" />
                <h3 className="section-title">Test Tool</h3>
              </div>
              <textarea
                value={testInput}
                onChange={e => setTestInput(e.target.value)}
                placeholder='{"query": "test"}'
                className="input w-full font-mono text-xs resize-none"
                rows={4}
              />
              <button
                onClick={() => handleTest(selected)}
                disabled={testing || !selected.enabled}
                className="mt-2 btn-primary"
                style={{ backgroundImage: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' }}
              >
                {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                {testing ? 'Running…' : 'Execute'}
              </button>

              {testResult && (
                <div className={`mt-3 p-3 rounded-xl border animate-fade-up ${
                  testResult.success ? 'bg-green-500/[0.06] border-green-500/20' : 'bg-red-500/[0.06] border-red-500/20'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`badge ${testResult.success ? 'bg-green-500/10 text-green-400 ring-green-500/20' : 'bg-red-500/10 text-red-400 ring-red-500/20'}`}>
                      {testResult.success ? '✓ Success' : '✗ Failed'}
                    </span>
                    <span className="text-xs text-gray-500 tabular-nums">{testResult.duration}ms</span>
                  </div>
                  <pre className="text-xs text-gray-400 font-mono overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                    {JSON.stringify(testResult.success ? testResult.data : { error: testResult.error }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                <Wrench className="w-7 h-7 text-gray-600" />
              </div>
              <p className="text-gray-400 text-sm font-medium">Select a tool to view details</p>
              <p className="text-gray-600 text-xs mt-1">Inspect its schema and run live tests here</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="text-sm text-gray-100 font-medium tracking-tight">{value}</div>
    </div>
  );
}
