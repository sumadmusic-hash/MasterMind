import { createContext, useContext, useReducer, useEffect, useMemo, type ReactNode } from 'react';
import type { AppSettings, ChatSession, WorkflowDefinition, TokenBudget } from '../types';
import { getSettings, saveSettings, getChatSessions, getWorkflows } from '../services/database';
import { tpmManager } from '../services/tpm';

interface AppState {
  settings: AppSettings | null;
  settingsLoaded: boolean;
  chatSessions: ChatSession[];
  activeSession: ChatSession | null;
  workflows: WorkflowDefinition[];
  // Token-Budget wird NUR noch bei echten Änderungen gesetzt (vergleiche
  // tpmManager.subscribe unten). Vorher wurde alle 2s ein neuer Budget-Wert
  // dispatched – dadurch haben alle Context-Konsumenten (App + alle Seiten)
  // dauerhaft mitgerendert, auch ohne jede Änderung.
  tokenBudget: TokenBudget | null;
  sidebarOpen: boolean;
  currentPage: string;
}

type Action =
  | { type: 'SET_SETTINGS'; payload: AppSettings }
  | { type: 'SET_SETTINGS_LOADED' }
  | { type: 'SET_CHAT_SESSIONS'; payload: ChatSession[] }
  | { type: 'SET_ACTIVE_SESSION'; payload: ChatSession | null }
  | { type: 'UPDATE_SESSION'; payload: ChatSession }
  | { type: 'SET_WORKFLOWS'; payload: WorkflowDefinition[] }
  | { type: 'SET_TOKEN_BUDGET'; payload: TokenBudget }
  | { type: 'SET_PAGE'; payload: string }
  | { type: 'TOGGLE_SIDEBAR' };

const initialState: AppState = {
  settings: null,
  settingsLoaded: false,
  chatSessions: [],
  activeSession: null,
  workflows: [],
  tokenBudget: null,
  sidebarOpen: true,
  currentPage: 'chat',
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };
    case 'SET_SETTINGS_LOADED':
      return { ...state, settingsLoaded: true };
    case 'SET_CHAT_SESSIONS':
      return { ...state, chatSessions: action.payload };
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSession: action.payload };
    case 'UPDATE_SESSION':
      return {
        ...state,
        activeSession: action.payload,
        chatSessions: state.chatSessions.map(s => s.id === action.payload.id ? action.payload : s),
      };
    case 'SET_WORKFLOWS':
      return { ...state, workflows: action.payload };
    case 'SET_TOKEN_BUDGET':
      return { ...state, tokenBudget: action.payload };
    case 'SET_PAGE':
      return { ...state, currentPage: action.payload };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    default:
      return state;
  }
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Load initial data
  useEffect(() => {
    async function load() {
      const settings = await getSettings();
      if (settings) {
        dispatch({ type: 'SET_SETTINGS', payload: settings });
        tpmManager.configure(settings);
      } else {
        // Default settings
        const defaults: AppSettings = {
          primaryModel: { provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
          globalTpmLimit: 100000,
          maxTokensPerRequest: 4096,
          maxToolSteps: 20,
          maxCallDuration: 120000,
          theme: 'dark',
        };
        dispatch({ type: 'SET_SETTINGS', payload: defaults });
        await saveSettings(defaults);
      }
      dispatch({ type: 'SET_SETTINGS_LOADED' });

      const sessions = await getChatSessions();
      dispatch({ type: 'SET_CHAT_SESSIONS', payload: sessions });

      const workflows = await getWorkflows();
      dispatch({ type: 'SET_WORKFLOWS', payload: workflows });
    }
    load();
  }, []);

  // Token-Budget: Update NUR bei echten Änderungen (subscribe) plus ein
  // leichter 5s-Ticker, der ablaufende Fenster erkennt – statt previously
  // alle 2s einen neuen State zu setzen und alles neu zu rendern.
  useEffect(() => {
    dispatch({ type: 'SET_TOKEN_BUDGET', payload: tpmManager.getBudget() });
    const unsubscribe = tpmManager.subscribe(budget => {
      dispatch({ type: 'SET_TOKEN_BUDGET', payload: budget });
    });
    const interval = setInterval(() => {
      // getBudget() löst bei geänderten Werten den Listener oben aus;
      // ohne Änderung passiert kein Dispatch und kein Render.
      tpmManager.getBudget();
    }, 5000);
    return () => { unsubscribe(); clearInterval(interval); };
  }, []);

  const updateSettings = async (updates: Partial<AppSettings>) => {
    const newSettings = { ...state.settings, ...updates } as AppSettings;
    dispatch({ type: 'SET_SETTINGS', payload: newSettings });
    await saveSettings(updates);
    tpmManager.configure(newSettings);
  };

  // Provider-Value stabil halten: sonst bekommen ALLE Konsumenten bei jedem
  // Parent-Render ein neues Objekt und renderen unnötig mit.
  const value = useMemo(
    () => ({ state, dispatch, updateSettings }),
    [state, updateSettings]
  );

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
