import { useState } from 'react';
import { useApp } from '../store/AppContext';
import { testConnection, getAllModels } from '../services/provider';
import { clearAllData } from '../services/database';
import { tpmManager } from '../services/tpm';
import {
  Key, Shield, Zap, AlertTriangle, Check, X, Loader2,
  Eye, EyeOff, Trash2, RefreshCw
} from 'lucide-react';

export function SettingsPage() {
  const { state, updateSettings } = useApp();
  const settings = state.settings;
  
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [showOpenRouterKey, setShowOpenRouterKey] = useState(false);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; success: boolean; error?: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  if (!settings) return null;

  const allModels = getAllModels();

  const handleTestConnection = async (provider: string) => {
    setTestingProvider(provider);
    setTestResult(null);
    
    const apiKey = provider === 'groq' ? settings.groqApiKey : settings.openRouterApiKey;
    const modelId = provider === 'groq' 
      ? (settings.primaryModel.provider === 'groq' ? settings.primaryModel.modelId : 'llama-3.3-70b-versatile')
      : (settings.primaryModel.provider === 'openrouter' ? settings.primaryModel.modelId : 'openai/gpt-4o-mini');

    if (!apiKey) {
      setTestResult({ provider, success: false, error: 'No API key configured' });
      setTestingProvider(null);
      return;
    }

    const result = await testConnection(provider, apiKey, modelId);
    setTestResult({ provider, ...result });
    setTestingProvider(null);
  };

  const handleClearData = async () => {
    if (confirmClear) {
      await clearAllData();
      setConfirmClear(false);
      window.location.reload();
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 5000);
    }
  };

  const budget = tpmManager.getBudget();

  return (
    <div className="h-full overflow-y-auto p-6 bg-gray-950/30">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">Settings</h2>
          <p className="text-gray-400 text-sm">Configure AI providers, models, and application behavior.</p>
        </div>

        {/* API Keys */}
        <section className="card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-8 h-8 rounded-lg bg-blue-500/10 ring-1 ring-inset ring-blue-500/20 flex items-center justify-center">
              <Key className="w-4 h-4 text-blue-400" />
            </span>
            <h3 className="section-title !text-base">API Keys</h3>
            <Shield className="w-4 h-4 text-green-400 ml-auto" />
            <span className="badge bg-green-500/10 text-green-400 ring-green-500/20">Stored locally, never shared</span>
          </div>

          <div className="space-y-4">
            {/* Groq */}
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Groq API Key</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showGroqKey ? 'text' : 'password'}
                    value={settings.groqApiKey || ''}
                    onChange={e => updateSettings({ groqApiKey: e.target.value })}
                    placeholder="gsk_..."
                    className="input w-full"
                  />
                  <button
                    onClick={() => setShowGroqKey(!showGroqKey)}
                    aria-label="Toggle key visibility"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]"
                  >
                    {showGroqKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={() => handleTestConnection('groq')}
                  disabled={testingProvider === 'groq'}
                  className="btn-secondary !px-4"
                >
                  {testingProvider === 'groq' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
                </button>
              </div>
              {testResult?.provider === 'groq' && (
                <div className={`flex items-center gap-1 mt-1 text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  {testResult.success ? 'Connection successful' : testResult.error}
                </div>
              )}
            </div>

            {/* OpenRouter */}
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">OpenRouter API Key</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showOpenRouterKey ? 'text' : 'password'}
                    value={settings.openRouterApiKey || ''}
                    onChange={e => updateSettings({ openRouterApiKey: e.target.value })}
                    placeholder="sk-or-..."
                    className="input w-full"
                  />
                  <button
                    onClick={() => setShowOpenRouterKey(!showOpenRouterKey)}
                    aria-label="Toggle key visibility"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]"
                  >
                    {showOpenRouterKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={() => handleTestConnection('openrouter')}
                  disabled={testingProvider === 'openrouter'}
                  className="btn-secondary !px-4"
                >
                  {testingProvider === 'openrouter' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
                </button>
              </div>
              {testResult?.provider === 'openrouter' && (
                <div className={`flex items-center gap-1 mt-1 text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  {testResult.success ? 'Connection successful' : testResult.error}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Model Configuration */}
        <section className="card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-8 h-8 rounded-lg bg-purple-500/10 ring-1 ring-inset ring-purple-500/20 flex items-center justify-center">
              <Zap className="w-4 h-4 text-purple-400" />
            </span>
            <h3 className="section-title !text-base">Model Configuration</h3>
          </div>

          <div className="space-y-4">
            {/* Primary Model */}
            <ModelSelector
              label="Primary Model"
              config={settings.primaryModel}
              onChange={(config) => updateSettings({ primaryModel: config })}
              models={allModels}
            />

            {/* Fallback 1 */}
            <ModelSelector
              label="Fallback 1"
              config={settings.fallback1}
              onChange={(config) => updateSettings({ fallback1: config })}
              models={allModels}
              optional
            />

            {/* Fallback 2 */}
            <ModelSelector
              label="Fallback 2"
              config={settings.fallback2}
              onChange={(config) => updateSettings({ fallback2: config })}
              models={allModels}
              optional
            />
          </div>
        </section>

        {/* Token Budget */}
        <section className="card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-8 h-8 rounded-lg bg-yellow-500/10 ring-1 ring-inset ring-yellow-500/20 flex items-center justify-center">
              <Zap className="w-4 h-4 text-yellow-400" />
            </span>
            <h3 className="section-title !text-base">Token Budget (TPM)</h3>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Global TPM Limit</label>
              <input
                type="number"
                value={settings.globalTpmLimit}
                onChange={e => updateSettings({ globalTpmLimit: parseInt(e.target.value) || 100000 })}
                className="input w-full tabular-nums"
              />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Max Tokens per Request</label>
              <input
                type="number"
                value={settings.maxTokensPerRequest}
                onChange={e => updateSettings({ maxTokensPerRequest: parseInt(e.target.value) || 4096 })}
                className="input w-full tabular-nums"
              />
            </div>

            {/* Current usage */}
            <div className="panel p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wider text-gray-500">Current Window Usage</span>
                <span className="text-xs text-gray-400 tabular-nums">
                  {budget.usedInWindow.toLocaleString()} / {budget.globalLimit.toLocaleString()}
                </span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, (budget.usedInWindow / budget.globalLimit) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Advanced Settings */}
        <section className="card p-6">
          <button
            onClick={() => setAdvanced(!advanced)}
            className="flex items-center gap-2 w-full"
          >
            <span className="w-8 h-8 rounded-lg bg-orange-500/10 ring-1 ring-inset ring-orange-500/20 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
            </span>
            <h3 className="section-title !text-base">Advanced Settings</h3>
            <span className="ml-auto badge bg-white/[0.04] text-gray-500 ring-white/10">{advanced ? 'Hide' : 'Show'}</span>
          </button>

          {advanced && (
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Max Tool Steps per Request</label>
                <input
                  type="number"
                  value={settings.maxToolSteps}
                  onChange={e => updateSettings({ maxToolSteps: parseInt(e.target.value) || 20 })}
                  min={1}
                  max={50}
                  className="input w-full tabular-nums"
                />
              </div>

              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Max Call Duration (ms)</label>
                <input
                  type="number"
                  value={settings.maxCallDuration}
                  onChange={e => updateSettings({ maxCallDuration: parseInt(e.target.value) || 120000 })}
                  className="input w-full tabular-nums"
                />
              </div>

              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">Theme</label>
                <select
                  value={settings.theme}
                  onChange={e => updateSettings({ theme: e.target.value as any })}
                  className="input w-full tabular-nums"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </div>
            </div>
          )}
        </section>

        {/* Data Management */}
        <section className="card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="w-8 h-8 rounded-lg bg-red-500/10 ring-1 ring-inset ring-red-500/20 flex items-center justify-center">
              <Trash2 className="w-4 h-4 text-red-400" />
            </span>
            <h3 className="section-title !text-base">Data Management</h3>
          </div>
          <p className="text-sm text-gray-400 mb-3">
            Clear all local data including chat history, workflows, and logs.
          </p>
          <button
            onClick={handleClearData}
            className={confirmClear ? 'btn-danger' : 'btn-secondary !border-red-500/30 !text-red-400 hover:!bg-red-500/10 hover:!border-red-500/50 hover:!text-red-300'}
          >
            <Trash2 className="w-4 h-4" />
            {confirmClear ? 'Click again to confirm deletion' : 'Clear All Data'}
          </button>
        </section>
      </div>
    </div>
  );
}

function ModelSelector({ label, config, onChange, models, optional }: {
  label: string;
  config?: { provider: string; modelId: string };
  onChange: (config: any) => void;
  models: Record<string, { id: string; name: string }[]>;
  optional?: boolean;
}) {
  const [enabled, setEnabled] = useState(!!config);

  if (optional && !enabled) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-1">
          <label className="text-sm text-gray-400">{label}</label>
          <button
            onClick={() => { setEnabled(true); onChange({ provider: 'groq', modelId: 'llama-3.3-70b-versatile' }); }}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded-md hover:bg-blue-500/10"
          >
            + Add
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="text-sm text-gray-400">{label}</label>
        {optional && (
          <button
            onClick={() => { setEnabled(false); onChange(undefined); }}
            className="text-xs text-gray-500 hover:text-red-400"
          >
            Remove
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <select
          value={config?.provider || 'groq'}
          onChange={e => {
            const provider = e.target.value;
            const defaultModel = models[provider]?.[0]?.id || '';
            onChange({ provider, modelId: defaultModel });
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="groq">Groq</option>
          <option value="openrouter">OpenRouter</option>
        </select>
        <select
          value={config?.modelId || ''}
          onChange={e => onChange({ ...config, modelId: e.target.value })}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          {(models[config?.provider || 'groq'] || []).map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
