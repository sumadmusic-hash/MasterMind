import { useState } from 'react';
import { useApp } from '../store/AppContext';
import { testConnection } from '../services/provider';
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
  const [showWebzToken, setShowWebzToken] = useState(false);
  const [testingWebz, setTestingWebz] = useState(false);
  const [webzTestResult, setWebzTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; success: boolean; error?: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  if (!settings) return null;


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

  // Verbindung zur Webz.io News API testen: Token gegen den echten Endpunkt
  // validieren (über denselben Pfad wie das webz_news-Tool, inkl. Dev-Proxy).
  const handleTestWebz = async () => {
    setTestingWebz(true);
    setWebzTestResult(null);
    const token = String(settings.webzApiToken || '').trim();
    if (!token) {
      setWebzTestResult({ success: false, error: 'Kein Token eingetragen' });
      setTestingWebz(false);
      return;
    }
    try {
      const base = String(settings.webzApiBaseUrl || '').trim().replace(/\/+$/, '') || '/webz-api';
      // credentials:'omit' → kein Browser-Login-Dialog bei HTTP 401 (Webz antwortet
      // mit WWW-Authenticate: Basic, obwohl nur ein API-Token nötig ist).
      const resp = await fetch(`${base}/api/news?${new URLSearchParams({ token, format: 'json', q: '*', sort: 'crawled', size: '1' })}`, {
        signal: AbortSignal.timeout(12000),
        credentials: 'omit',
      });
      if (resp.status === 401) throw new Error('Ungültiges Token (HTTP 401 "Unknown API token") — kein Benutzername/Passwort nötig, nur das API-Token aus dem Webz-Dashboard');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json().catch(() => null);
      if (!data || typeof data !== 'object') throw new Error('Keine JSON-Antwort (Proxy fehlt?)');
      // /api/news liefert { posts: [...], total_results, ... }
      if (Array.isArray(data.posts)) {
        setWebzTestResult({ success: true });
      } else {
        setWebzTestResult({ success: false, error: String(data?.error || data?.message || 'Unerwartetes Antwortformat') });
      }
    } catch (err: any) {
      setWebzTestResult({ success: false, error: err.message || 'Verbindung fehlgeschlagen' });
    }
    setTestingWebz(false);
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
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Settings</h2>
          <p className="text-gray-400 text-sm">Configure AI providers, models, and application behavior.</p>
        </div>

        {/* API Keys */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-blue-400" />
            <h3 className="text-lg font-semibold text-white">API Keys</h3>
            <Shield className="w-4 h-4 text-green-400 ml-auto" />
            <span className="text-xs text-green-400">Stored locally, never shared</span>
          </div>

          <div className="space-y-4">
            {/* Groq */}
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Groq API Key</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showGroqKey ? 'text' : 'password'}
                    value={settings.groqApiKey || ''}
                    onChange={e => updateSettings({ groqApiKey: e.target.value })}
                    placeholder="gsk_..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => setShowGroqKey(!showGroqKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showGroqKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={() => handleTestConnection('groq')}
                  disabled={testingProvider === 'groq'}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50"
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
              <label className="text-sm text-gray-400 mb-1 block">OpenRouter API Key</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showOpenRouterKey ? 'text' : 'password'}
                    value={settings.openRouterApiKey || ''}
                    onChange={e => updateSettings({ openRouterApiKey: e.target.value })}
                    placeholder="sk-or-..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => setShowOpenRouterKey(!showOpenRouterKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showOpenRouterKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={() => handleTestConnection('openrouter')}
                  disabled={testingProvider === 'openrouter'}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50"
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

            {/* Webz.io News API */}
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Webz.io News API Token</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showWebzToken ? 'text' : 'password'}
                    value={settings.webzApiToken || ''}
                    onChange={e => updateSettings({ webzApiToken: e.target.value })}
                    placeholder="Token aus https://app.webz.io/ (Dashboard → API)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => setShowWebzToken(!showWebzToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showWebzToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={handleTestWebz}
                  disabled={testingWebz}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50"
                >
                  {testingWebz ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Für die KI-Tools „Webz.io News Search“ und „Webz.io Top News“. Requests laufen über den
                Dev-Proxy /webz-api (bzw. eigene Proxy-Basis unten), da api.webz.io kein CORS erlaubt.
              </p>
              {webzTestResult && (
                <div className={`flex items-center gap-1 mt-1 text-xs ${webzTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {webzTestResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  {webzTestResult.success ? 'Connection successful' : webzTestResult.error}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Model Configuration */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-semibold text-white">Model Configuration</h3>
          </div>

          <div className="space-y-4">
            {/* Primary Model */}
            <ModelSelector
              label="Primary Model"
              config={settings.primaryModel}
              onChange={(config) => updateSettings({ primaryModel: config })}

            />

            {/* Fallbacks 1–6 */}
            {([1, 2, 3, 4, 5, 6] as const).map((i) => (
              <ModelSelector
                key={i}
                label={`Fallback ${i}`}
                config={settings[`fallback${i}` as 'fallback1']}
                onChange={(config) => updateSettings({ [`fallback${i}`]: config })}
                optional
              />
            ))}
          </div>
        </section>

        {/* Token Budget */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-yellow-400" />
            <h3 className="text-lg font-semibold text-white">Token Budget (TPM)</h3>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Global TPM Limit</label>
              <input
                type="number"
                value={settings.globalTpmLimit}
                onChange={e => updateSettings({ globalTpmLimit: parseInt(e.target.value) || 100000 })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="text-sm text-gray-400 mb-1 block">Max Tokens per Request</label>
              <input
                type="number"
                value={settings.maxTokensPerRequest}
                onChange={e => updateSettings({ maxTokensPerRequest: parseInt(e.target.value) || 4096 })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="text-sm text-gray-400 mb-1 block">Max. Wartezeit bei Budget-Erschöpfung (ms)</label>
              <input
                type="number"
                value={settings.tpmWaitTimeoutMs ?? 300000}
                onChange={e => updateSettings({ tpmWaitTimeoutMs: Math.max(0, parseInt(e.target.value) || 300000) })}
                min={0}
                step={10000}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Aufgaben, die das TPM-Limit überschreiten, werden nicht abgebrochen, sondern pausieren und
                fortgesetzt, sobald wieder Token-Budget frei ist. Dieser Wert begrenzt, wie lange maximal
                gewartet wird (0 = sofort fehlschlagen). Bereits bearbeitete Schritte gehen dabei nie verloren.
              </p>
            </div>

            {/* Current usage */}
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-2">Current Window Usage</div>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all"
                    style={{ width: `${Math.min(100, (budget.usedInWindow / budget.globalLimit) * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400">
                  {budget.usedInWindow.toLocaleString()} / {budget.globalLimit.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Advanced Settings */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <button
            onClick={() => setAdvanced(!advanced)}
            className="flex items-center gap-2 w-full"
          >
            <AlertTriangle className="w-5 h-5 text-orange-400" />
            <h3 className="text-lg font-semibold text-white">Advanced Settings</h3>
            <span className="ml-auto text-xs text-gray-500">{advanced ? 'Hide' : 'Show'}</span>
          </button>

          {advanced && (
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-1 block">Webz.io Proxy-Basis (optional)</label>
                <input
                  type="text"
                  value={settings.webzApiBaseUrl || ''}
                  onChange={e => updateSettings({ webzApiBaseUrl: e.target.value })}
                  placeholder="leer = /webz-api (Vite-Dev-Proxy)"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  api.webz.io sendet keine CORS-Headers. Für Produktions-Builds hier die Basis eines
                  eigenen Proxys eintragen (z. B. https://proxy.example.de/webz), der Requests an
                  https://api.webz.io weiterreicht.
                </p>
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-1 block">Max Tool Steps per Request</label>
                <input
                  type="number"
                  value={settings.maxToolSteps}
                  onChange={e => updateSettings({ maxToolSteps: parseInt(e.target.value) || 20 })}
                  min={1}
                  max={50}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-1 block">Max Call Duration (ms)</label>
                <input
                  type="number"
                  value={settings.maxCallDuration}
                  onChange={e => updateSettings({ maxCallDuration: parseInt(e.target.value) || 120000 })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-1 block">Theme</label>
                <select
                  value={settings.theme}
                  onChange={e => updateSettings({ theme: e.target.value as any })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
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
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Trash2 className="w-5 h-5 text-red-400" />
            <h3 className="text-lg font-semibold text-white">Data Management</h3>
          </div>
          <p className="text-sm text-gray-400 mb-3">
            Clear all local data including chat history, workflows, and logs.
          </p>
          <button
            onClick={handleClearData}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              confirmClear
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-gray-800 hover:bg-red-900/30 text-red-400 border border-red-800/30'
            }`}
          >
            {confirmClear ? 'Click again to confirm deletion' : 'Clear All Data'}
          </button>
        </section>
      </div>
    </div>
  );
}

function ModelSelector({ label, config, onChange, optional }: {
  label: string;
  config?: { provider: string; modelId: string };
  onChange: (config: any) => void;
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
            className="text-xs text-blue-400 hover:text-blue-300"
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
            // Modell-ID nicht überschreiben – der Nutzer trägt sie selbst ein.
            onChange({ ...config, provider });
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        >
          <option value="groq">Groq</option>
          <option value="openrouter">OpenRouter</option>
        </select>
        <input
          type="text"
          value={config?.modelId || ''}
          onChange={e => onChange({ ...config, modelId: e.target.value })}
          placeholder={config?.provider === 'openrouter' ? 'z. B. openai/gpt-4o-mini' : 'z. B. llama-3.3-70b-versatile'}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        />
      </div>
    </div>
  );
}
