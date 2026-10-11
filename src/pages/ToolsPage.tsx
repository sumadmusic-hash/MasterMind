import { useState } from 'react';
import { toolRegistry } from '../services/tools';
import type { ToolDefinition } from '../types';
import {
  Wrench, Search, Newspaper, Building2, TrendingUp, Filter,
  FileText, Globe, ToggleLeft, ToggleRight, TestTube, ChevronDown, ChevronUp
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

  return (
    <div className="h-full flex">
      {/* Tool List */}
      <div className="w-80 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search tools..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {Object.entries(groupedTools).map(([category, categoryTools]) => {
            const Icon = CATEGORY_ICONS[category] || Wrench;
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-3.5 h-3.5 text-gray-500" />
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {CATEGORY_LABELS[category] || category}
                  </span>
                </div>
                <div className="space-y-1">
                  {categoryTools.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => setSelectedTool(tool.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                        selectedTool === tool.id
                          ? 'bg-blue-600/20 border border-blue-500/30 text-blue-300'
                          : 'text-gray-300 hover:bg-gray-800'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{tool.name}</div>
                        <div className="text-xs text-gray-500 truncate">{tool.description}</div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(tool.id, !tool.enabled); }}
                        className="flex-shrink-0"
                      >
                        {tool.enabled ? (
                          <ToggleRight className="w-5 h-5 text-green-400" />
                        ) : (
                          <ToggleLeft className="w-5 h-5 text-gray-600" />
                        )}
                      </button>
                    </button>
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
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-xl font-bold text-white">{selected.name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  selected.enabled ? 'bg-green-900/30 text-green-400' : 'bg-gray-800 text-gray-500'
                }`}>
                  {selected.enabled ? 'Active' : 'Disabled'}
                </span>
                <span className="text-xs text-gray-600">v{selected.version}</span>
              </div>
              <p className="text-sm text-gray-400">{selected.description}</p>
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
              <h3 className="text-sm font-medium text-gray-300 mb-2">Input Schema</h3>
              <pre className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400 overflow-x-auto">
                {JSON.stringify(selected.inputSchema, null, 2)}
              </pre>
            </div>

            {/* Test Area */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <div className="flex items-center gap-2 mb-3">
                <TestTube className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-medium text-white">Test Tool</h3>
              </div>
              <textarea
                value={testInput}
                onChange={e => setTestInput(e.target.value)}
                placeholder='{"query": "test"}'
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                rows={4}
              />
              <button
                onClick={() => handleTest(selected)}
                disabled={testing || !selected.enabled}
                className="mt-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {testing ? 'Running...' : 'Execute'}
              </button>

              {testResult && (
                <div className={`mt-3 p-3 rounded-lg border ${
                  testResult.success ? 'bg-green-900/10 border-green-800/30' : 'bg-red-900/10 border-red-800/30'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                      {testResult.success ? '✓ Success' : '✗ Failed'}
                    </span>
                    <span className="text-xs text-gray-500">{testResult.duration}ms</span>
                  </div>
                  <pre className="text-xs text-gray-400 overflow-x-auto max-h-48 overflow-y-auto">
                    {JSON.stringify(testResult.success ? testResult.data : { error: testResult.error }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-500">
              <Wrench className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a tool to view details and test it</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-3">
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className="text-sm text-gray-200">{value}</div>
    </div>
  );
}
