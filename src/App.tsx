import { useEffect } from 'react';
import { AppProvider, useApp } from './store/AppContext';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { ToolsPage } from './pages/ToolsPage';
import { WorkflowPage } from './pages/WorkflowPage';
import { ResearchPage } from './pages/ResearchPage';
import {
  MessageSquare, Settings, Wrench, GitBranch, Newspaper,
  Menu, X, BarChart3, Zap
} from 'lucide-react';

const PAGE_KEYS: Record<string, string> = {
  '1': 'chat',
  '2': 'research',
  '3': 'tools',
  '4': 'workflows',
  '5': 'settings',
};

function AppContent() {
  const { state, dispatch } = useApp();

  // Global keyboard shortcuts for navigation (Bedienungs-Optimierung)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;

      // Alt + number: switch page (works everywhere, even while typing)
      if (e.altKey && !e.ctrlKey && !e.metaKey && PAGE_KEYS[e.key]) {
        e.preventDefault();
        dispatch({ type: 'SET_PAGE', payload: PAGE_KEYS[e.key] });
        return;
      }

      // Ctrl/Cmd + B: toggle sidebar
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SIDEBAR' });
        return;
      }

      // Plain number keys: quick navigation when not typing
      if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey && PAGE_KEYS[e.key]) {
        dispatch({ type: 'SET_PAGE', payload: PAGE_KEYS[e.key] });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  if (!state.settingsLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950">
        <div className="animate-pulse text-gray-400 text-lg flex items-center gap-3">
          <Zap className="w-5 h-5 text-blue-400 animate-ping" />
          Loading...
        </div>
      </div>
    );
  }

  const navItems = [
    { id: 'chat', label: 'Chat', icon: MessageSquare, shortcut: '1' },
    { id: 'research', label: 'Research', icon: Newspaper, shortcut: '2' },
    { id: 'tools', label: 'Tools', icon: Wrench, shortcut: '3' },
    { id: 'workflows', label: 'Workflows', icon: GitBranch, shortcut: '4' },
    { id: 'settings', label: 'Settings', icon: Settings, shortcut: '5' },
  ];

  const renderPage = () => {
    switch (state.currentPage) {
      case 'chat': return <ChatPage />;
      case 'research': return <ResearchPage />;
      case 'tools': return <ToolsPage />;
      case 'workflows': return <WorkflowPage />;
      case 'settings': return <SettingsPage />;
      default: return <ChatPage />;
    }
  };

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden">
      {/* Sidebar */}
      <aside className={`${state.sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-gray-800 flex items-center gap-2">
          <Zap className="w-6 h-6 text-blue-400" />
          <h1 className="font-bold text-lg text-white">AI Research</h1>
        </div>
        
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => dispatch({ type: 'SET_PAGE', payload: item.id })}
              title={`${item.label} (Alt+${item.shortcut})`}
              aria-label={item.label}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                state.currentPage === item.id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <item.icon className="w-4 h-4" />
              <span className="flex-1 text-left">{item.label}</span>
              <kbd className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                state.currentPage === item.id
                  ? 'border-blue-500/30 text-blue-400/70'
                  : 'border-gray-700 text-gray-600'
              }`}>
                {item.shortcut}
              </kbd>
            </button>
          ))}
        </nav>

        {/* Token Budget Indicator */}
        {state.tokenBudget && (
          <div className="p-4 border-t border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Token Budget (TPM)</div>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-3 h-3 text-gray-500" />
              <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all"
                  style={{ width: `${Math.max(5, (state.tokenBudget.usedInWindow / state.tokenBudget.globalLimit) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-gray-500">
                {Math.round((state.tokenBudget.usedInWindow / state.tokenBudget.globalLimit) * 100)}%
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="h-12 border-b border-gray-800 flex items-center px-4 gap-3 bg-gray-900/50">
          <button
            onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            title={state.sidebarOpen ? 'Sidebar schließen (Strg+B)' : 'Sidebar öffnen (Strg+B)'}
            aria-label={state.sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 transition-colors"
          >
            {state.sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <span className="text-sm text-gray-400">
            {navItems.find(n => n.id === state.currentPage)?.label || 'Chat'}
          </span>
          {state.settings?.primaryModel && (
            <span className="ml-auto text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">
              {state.settings.primaryModel.provider}/{state.settings.primaryModel.modelId}
            </span>
          )}
        </header>

        {/* Page Content */}
        <div className="flex-1 overflow-hidden">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
