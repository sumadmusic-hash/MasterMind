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

function AppContent() {
  const { state, dispatch } = useApp();

  if (!state.settingsLoaded) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-gray-950">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-glow animate-pulse">
          <Zap className="w-6 h-6 text-white" />
        </div>
        <div className="text-gray-400 text-sm tracking-wide">Loading workspace…</div>
      </div>
    );
  }

  const navItems = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'research', label: 'Research', icon: Newspaper },
    { id: 'tools', label: 'Tools', icon: Wrench },
    { id: 'workflows', label: 'Workflows', icon: GitBranch },
    { id: 'settings', label: 'Settings', icon: Settings },
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
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden antialiased">
      {/* Sidebar */}
      <aside className={`${state.sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] bg-gray-900/80 backdrop-blur-md border-r border-white/[0.06] flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-white/[0.06] flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-glow">
            <Zap className="w-4.5 h-4.5 text-white" fill="currentColor" />
          </div>
          <div className="leading-tight">
            <h1 className="font-bold text-[15px] text-white tracking-tight">AI Research</h1>
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Assistant Suite</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => dispatch({ type: 'SET_PAGE', payload: item.id })}
              className={`group relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium overflow-hidden transition-all duration-200 ${
                state.currentPage === item.id
                  ? 'bg-gradient-to-r from-blue-600/25 to-purple-600/15 text-blue-400 shadow-inner'
                  : 'text-gray-400 hover:text-gray-100 hover:bg-white/[0.05]'
              }`}
            >
              {state.currentPage === item.id && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[3px] rounded-r-full bg-gradient-to-b from-blue-400 to-purple-500" />
              )}
              <item.icon className={`w-4 h-4 transition-transform duration-200 ${
                state.currentPage === item.id ? '' : 'group-hover:scale-110'
              }`} />
              {item.label}
            </button>
          ))}
        </nav>

        {/* Token Budget Indicator */}
        {state.tokenBudget && (
          <div className="p-4 border-t border-white/[0.06]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">Token Budget</span>
              <span className="text-[10px] text-gray-500 tabular-nums">TPM</span>
            </div>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-3.5 h-3.5 text-gray-500" />
              <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(5, (state.tokenBudget.usedInWindow / state.tokenBudget.globalLimit) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] text-gray-400 tabular-nums w-8 text-right">
                {Math.round((state.tokenBudget.usedInWindow / state.tokenBudget.globalLimit) * 100)}%
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="relative h-12 flex items-center px-4 gap-3 bg-gray-900/60 backdrop-blur-md border-b border-white/[0.06]">
          <button
            onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            aria-label="Toggle sidebar"
            className="p-1.5 -ml-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/[0.07]"
          >
            {state.sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <span className="text-sm font-medium text-gray-200 tracking-tight">
            {navItems.find(n => n.id === state.currentPage)?.label || 'Chat'}
          </span>
          {state.settings?.primaryModel && (
            <span className="ml-auto badge bg-white/[0.04] text-gray-400 ring-white/10 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              {state.settings.primaryModel.provider}/{state.settings.primaryModel.modelId}
            </span>
          )}
          <span className="accent-line absolute bottom-0 left-0 right-0 h-px opacity-40" aria-hidden="true" />
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
