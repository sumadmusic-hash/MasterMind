import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useApp } from '../store/AppContext';
import { chatOrchestrator } from '../services/chat';
import { saveChatSession, deleteChatSession } from '../services/database';
import type { ChatSession, ChatMessage, ToolCall, ToolResult } from '../types';
import {
  Send, Square, Plus, Trash2, Copy, Check, ExternalLink,
  AlertCircle, Loader2, Bot, User, Wrench, ChevronDown, ChevronUp
} from 'lucide-react';

export function ChatPage() {
  const { state, dispatch } = useApp();
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const session = state.activeSession;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, streamContent]);

  // Auto-resizing textarea for comfortable multi-line input
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [input, autoResize]);

  // Focus input when chat page opens / session changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [session?.id]);

  // Escape aborts streaming, Ctrl+K focuses the input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && streaming) {
        e.preventDefault();
        handleAbort();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const createNewSession = useCallback(() => {
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    dispatch({ type: 'SET_ACTIVE_SESSION', payload: newSession });
    dispatch({
      type: 'SET_CHAT_SESSIONS',
      payload: [newSession, ...state.chatSessions],
    });
    setError('');
    setStreamContent('');
    setToolCalls([]);
    setToolResults([]);
  }, [dispatch, state.chatSessions]);

  const selectSession = useCallback((s: ChatSession) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', payload: s });
    setError('');
    setStreamContent('');
    setToolCalls([]);
    setToolResults([]);
  }, [dispatch]);

  const handleDeleteSession = async (id: string) => {
    await deleteChatSession(id);
    dispatch({
      type: 'SET_CHAT_SESSIONS',
      payload: state.chatSessions.filter(s => s.id !== id),
    });
    if (session?.id === id) {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: null });
    }
    setConfirmDeleteId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Stabilized so memoized MessageBubble only re-renders when `copiedId` changes.
  const copyToClipboard = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    if (!state.settings) {
      setError('Please configure settings first');
      return;
    }

    // Work on a local session object and mirror every mutation into the store
    // via UPDATE_SESSION. Previously `currentSession` was captured once from
    // state; because the orchestrator mutated the same object, onComplete
    // spread `[...currentSession.messages, message]` — which already contained
    // the just-pushed final message — so the assistant reply (and with a stale
    // closure even the whole history) was rendered/stored twice.
    let currentSession: ChatSession = session
      ? { ...session, messages: [...session.messages] }
      : {
          id: crypto.randomUUID(),
          title: input.substring(0, 50),
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
    if (!session) {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: currentSession });
      dispatch({
        type: 'SET_CHAT_SESSIONS',
        payload: [currentSession, ...state.chatSessions],
      });
    }

    const syncSession = (s: ChatSession) => {
      currentSession = s;
      dispatch({ type: 'UPDATE_SESSION', payload: s });
    };

    setStreaming(true);
    setStreamContent('');
    setError('');
    setToolCalls([]);
    setToolResults([]);
    setStatus('Starting...');

    const userInput = input;
    setInput('');

    try {
      await chatOrchestrator.sendMessage(
        state.settings,
        currentSession,
        userInput,
        {
          onToken: (token) => {
            setStreamContent(prev => prev + token);
          },
          onToolCall: (call) => {
            setToolCalls(prev => [...prev, call]);
          },
          onToolResult: (result) => {
            setToolResults(prev => [...prev, result]);
          },
          onComplete: (message) => {
            // The orchestrator already appended `message` to the session
            // object it works on; only the user message might have been added
            // there after our last snapshot, so sync from the live object and
            // never append the final message manually again.
            const updated: ChatSession = {
              ...currentSession,
              messages: [...currentSession.messages],
              updatedAt: Date.now(),
              title: message.role === 'assistant' &&
                currentSession.messages.filter(m => m.role === 'user').length <= 1 &&
                currentSession.title === 'New Chat'
                ? userInput.substring(0, 50)
                : currentSession.title,
            };
            syncSession(updated);
            setStreaming(false);
            setStreamContent('');
            setStatus('');
          },
          onError: (err) => {
            setError(err);
            // Persist the partial turn (user message etc.) so it survives reload
            syncSession({ ...currentSession, messages: [...currentSession.messages] });
            setStreaming(false);
            setStreamContent('');
            setStatus('');
          },
          onStatus: (s) => {
            setStatus(s);
          },
        }
      );
      // Safety net: ensure the final session state (incl. any content saved by
      // the orchestrator on abort) is reflected in the UI even if onComplete
      // never fired.
      syncSession({ ...currentSession, messages: [...currentSession.messages] });
      setStreaming(false);
    } catch (err: any) {
      setError(err.message);
      setStreaming(false);
      setStatus('');
    }
  };

  const handleAbort = () => {
    chatOrchestrator.abort();
    // Don't clear streamContent here: the orchestrator persists the partial
    // answer asynchronously; clearing immediately would race with onComplete /
    // the final sync and could briefly drop visible content.
    setStatus('Aborting...');
  };

  return (
    <div className="h-full flex">
      {/* Session List */}
      <div className="w-64 border-r border-gray-800 flex flex-col bg-gray-900/30">
        <div className="p-3 border-b border-gray-800">
          <button
            onClick={createNewSession}
            className="w-full flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {state.chatSessions.map(s => (
            <div
              key={s.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                session?.id === s.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
              onClick={() => selectSession(s)}
            >
              <span className="flex-1 truncate">{s.title || 'Untitled'}</span>
              {confirmDeleteId === s.id ? (
                <span className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => handleDeleteSession(s.id)}
                    className="px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors"
                    title="Wirklich löschen?"
                  >
                    Löschen?
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                    title="Abbrechen"
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
                  title="Chat löschen"
                  aria-label="Chat löschen"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {state.chatSessions.length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">No conversations yet</p>
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!session && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Bot className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-xl font-semibold text-white mb-2">AI Research Assistant</h2>
                <p className="text-gray-400 text-sm mb-4">
                  Ask me to research topics, analyze news, look up companies, or check stock prices.
                  I can use tools to gather real-time information.
                </p>
                <div className="grid grid-cols-2 gap-2 text-left">
                  {[
                    'What are the latest news about NVIDIA?',
                    'Compare AAPL and MSFT stock performance',
                    'Research AI industry trends',
                    'Find news about renewable energy',
                  ].map((example, i) => (
                    <button
                      key={i}
                      onClick={() => { setInput(example); inputRef.current?.focus(); }}
                      className="p-3 text-xs text-gray-400 bg-gray-800/50 hover:bg-gray-800 rounded-lg text-left transition-colors"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {session?.messages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              copiedId={copiedId}
              onCopy={copyToClipboard}
            />
          ))}

          {/* Streaming message */}
          {streaming && streamContent && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1 bg-gray-800/50 rounded-xl p-4">
                <p className="text-gray-100 whitespace-pre-wrap">{streamContent}</p>
              </div>
            </div>
          )}

          {/* Tool calls display */}
          {(toolCalls.length > 0 || toolResults.length > 0) && (
            <ToolProgress calls={toolCalls} results={toolResults} />
          )}

          {/* Status */}
          {status && streaming && (
            <div className="flex items-center gap-2 text-sm text-gray-500 pl-11">
              <Loader2 className="w-3 h-3 animate-spin" />
              {status}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-300">{error}</p>
                <p className="text-xs text-red-400/60 mt-1">
                  Check your API keys in Settings, or try a different model.
                </p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-gray-800 p-4">
          <div className="max-w-4xl mx-auto flex gap-3">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me to research something...  (Enter = senden, Shift+Enter = neue Zeile)"
                title="Enter zum Senden, Shift+Enter für neue Zeile"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 max-h-[200px] overflow-y-auto"
                rows={1}
                disabled={streaming}
              />
            </div>
            {streaming ? (
              <button
                onClick={handleAbort}
                title="Antwort abbrechen (Esc)"
                aria-label="Antwort abbrechen"
                className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors"
              >
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                title="Senden (Enter)"
                aria-label="Senden"
                className="px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="max-w-4xl mx-auto mt-1.5 flex items-center justify-between text-[11px] text-gray-600 px-1">
            <span>
              Strg+K: Fokus · Esc: Abbrechen · Alt+1–5: Seiten wechseln
            </span>
            <span>{input.length > 0 && `${input.length} Zeichen`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoized: during streaming, ChatPage re-renders on EVERY token. Without
// memo, all historical message bubbles would re-render each time (O(n) work
// per token). `onCopy` is stabilized via useCallback in the parent, so only
// the actively changing bubble(s) re-render.
const MessageBubble = memo(function MessageBubble({ message, copiedId, onCopy }: {
  message: ChatMessage;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const [showSources, setShowSources] = useState(false);
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-gray-700' : 'bg-gradient-to-br from-blue-500 to-purple-600'
      }`}>
        {isUser ? <User className="w-4 h-4 text-gray-300" /> : <Bot className="w-4 h-4 text-white" />}
      </div>
      <div className={`flex-1 max-w-3xl ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block rounded-xl p-4 ${
          isUser ? 'bg-blue-600/20 border border-blue-500/20' : 'bg-gray-800/50'
        }`}>
          <p className="text-sm text-gray-100 whitespace-pre-wrap">{message.content}</p>
        </div>
        
        {/* Meta info */}
        <div className="flex items-center gap-2 mt-1 px-1">
          {message.model && (
            <span className="text-xs text-gray-600">{message.provider}/{message.model}</span>
          )}
          {message.tokensUsed && (
            <span className="text-xs text-gray-600">{message.tokensUsed} tokens</span>
          )}
          <button
            onClick={() => onCopy(message.content, message.id)}
            className="p-1 hover:text-gray-400 text-gray-600 transition-colors"
            title={copiedId === message.id ? 'Kopiert!' : 'Text kopieren'}
            aria-label="Nachricht kopieren"
          >
            {copiedId === message.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>

        {/* Sources */}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setShowSources(!showSources)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              {showSources ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {message.sources.length} sources
            </button>
            {showSources && (
              <div className="mt-1 space-y-1">
                {message.sources.map((src, i) => (
                  <a
                    key={i}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-400 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span className="truncate">{src.title}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function ToolProgress({ calls, results }: { calls: ToolCall[]; results: ToolResult[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pl-11 space-y-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        <Wrench className="w-3 h-3" />
        {calls.length} tool call{calls.length !== 1 ? 's' : ''}
        {results.filter(r => r.success).length > 0 && (
          <span className="text-green-400">• {results.filter(r => r.success).length} succeeded</span>
        )}
        {results.filter(r => !r.success).length > 0 && (
          <span className="text-red-400">• {results.filter(r => !r.success).length} failed</span>
        )}
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="space-y-1 ml-4">
          {results.map(r => (
            <div key={r.callId} className="text-xs bg-gray-800/30 rounded px-2 py-1">
              <span className={r.success ? 'text-green-400' : 'text-red-400'}>
                {r.success ? '✓' : '✗'}
              </span>
              <span className="text-gray-400 ml-1">{r.toolId}</span>
              <span className="text-gray-600 ml-2">{r.duration}ms</span>
              {r.error && <span className="text-red-400/70 ml-2">({r.error})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
