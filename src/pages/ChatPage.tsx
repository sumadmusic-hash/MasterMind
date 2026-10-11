import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { chatOrchestrator } from '../services/chat';
import { saveChatSession, deleteChatSession } from '../services/database';
import type { ChatSession, ChatMessage, ToolCall, ToolResult } from '../types';
import {
  Send, Square, Plus, Trash2, Copy, Check, ExternalLink,
  AlertCircle, Loader2, Bot, User, Wrench, ChevronDown, ChevronUp,
  MessageSquare, Sparkles, Newspaper
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const session = state.activeSession;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, streamContent]);

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
  };

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    if (!state.settings) {
      setError('Please configure settings first');
      return;
    }

    let currentSession = session;
    if (!currentSession) {
      currentSession = {
        id: crypto.randomUUID(),
        title: input.substring(0, 50),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: currentSession });
      dispatch({
        type: 'SET_CHAT_SESSIONS',
        payload: [currentSession, ...state.chatSessions],
      });
    }

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
            const updated = {
              ...currentSession!,
              messages: [...currentSession!.messages, message],
              updatedAt: Date.now(),
              title: currentSession!.messages.length === 0 ? userInput.substring(0, 50) : currentSession!.title,
            };
            dispatch({ type: 'UPDATE_SESSION', payload: updated });
            setStreaming(false);
            setStreamContent('');
            setStatus('');
          },
          onError: (err) => {
            setError(err);
            setStreaming(false);
            setStreamContent('');
            setStatus('');
          },
          onStatus: (s) => {
            setStatus(s);
          },
        }
      );
    } catch (err: any) {
      setError(err.message);
      setStreaming(false);
      setStatus('');
    }
  };

  const handleAbort = () => {
    chatOrchestrator.abort();
    setStreaming(false);
    setStatus('Aborted');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="h-full flex">
      {/* Session List */}
      <div className="w-64 border-r border-white/[0.06] flex flex-col bg-gray-900/40 backdrop-blur-sm">
        <div className="p-3 border-b border-white/[0.06]">
          <button
            onClick={createNewSession}
            className="btn-primary w-full !px-3 !py-2"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {state.chatSessions.map(s => (
            <div
              key={s.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-all duration-200 ${
                session?.id === s.id
                  ? 'bg-gradient-to-r from-blue-600/20 to-transparent text-white shadow-inner'
                  : 'text-gray-400 hover:bg-white/[0.05] hover:text-gray-200'
              }`}
              onClick={() => selectSession(s)}
            >
              <MessageSquare className={`w-3.5 h-3.5 flex-shrink-0 ${session?.id === s.id ? 'text-blue-400' : 'text-gray-600 group-hover:text-gray-400'}`} />
              <span className="flex-1 truncate">{s.title || 'Untitled'}</span>
              <button
                aria-label="Delete conversation"
                onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/15 hover:text-red-400 text-gray-500 transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {state.chatSessions.length === 0 && (
            <div className="text-center py-8">
              <MessageSquare className="w-6 h-6 mx-auto mb-2 text-gray-700" />
              <p className="text-xs text-gray-600">No conversations yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!session && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-md animate-fade-up">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-glow">
                  <Bot className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-xl font-bold text-white mb-2 tracking-tight">AI Research Assistant</h2>
                <p className="text-gray-400 text-sm mb-5 leading-relaxed">
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
                      className="group p-3 text-xs text-gray-400 bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-blue-500/30 rounded-xl text-left transition-all duration-200 hover:-translate-y-0.5"
                    >
                      <span className="flex items-start gap-2">
                        <Sparkles className="w-3.5 h-3.5 mt-px text-gray-600 group-hover:text-blue-400 transition-colors flex-shrink-0" />
                        {example}
                      </span>
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
            <div className="flex gap-3 animate-fade-up">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0 shadow-glow">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1 max-w-3xl card !bg-gray-800/50 rounded-2xl rounded-tl-sm p-4">
                <p className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed typing-cursor">{streamContent}</p>
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
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs">
                {status}
                <span className="flex gap-0.5 ml-1" aria-hidden="true">
                  <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" />
                </span>
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 p-3.5 bg-red-500/[0.08] border border-red-500/20 rounded-xl animate-fade-up">
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
        <div className="border-t border-white/[0.06] bg-gray-900/40 backdrop-blur-sm p-4">
          <div className="max-w-4xl mx-auto flex items-end gap-3">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me to research something..."
                className="input w-full !py-3 !px-4 rounded-2xl resize-none min-h-[46px] max-h-40"
                rows={1}
                disabled={streaming}
              />
            </div>
            {streaming ? (
              <button
                onClick={handleAbort}
                aria-label="Stop generation"
                className="btn-danger !rounded-2xl !px-4 !py-3"
              >
                <Square className="w-4 h-4" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                aria-label="Send message"
                className="btn-primary !rounded-2xl !px-4 !py-3"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
          <p className="max-w-4xl mx-auto text-[11px] text-gray-600 mt-2 pl-1">
            Enter to send · Shift + Enter for a new line
          </p>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, copiedId, onCopy }: {
  message: ChatMessage;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const [showSources, setShowSources] = useState(false);
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} animate-fade-up`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 shadow-md ${
        isUser ? 'bg-gray-700 ring-1 ring-white/10' : 'bg-gradient-to-br from-blue-500 to-purple-600 shadow-glow'
      }`}>
        {isUser ? <User className="w-4 h-4 text-gray-300" /> : <Bot className="w-4 h-4 text-white" />}
      </div>
      <div className={`flex-1 max-w-3xl ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block rounded-2xl p-4 text-left ${
          isUser
            ? 'bg-gradient-to-br from-blue-600/25 to-indigo-600/15 border border-blue-500/20 rounded-tr-sm'
            : 'card !bg-gray-800/50 rounded-tl-sm'
        }`}>
          <p className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed">{message.content}</p>
        </div>
        
        {/* Meta info */}
        <div className="flex items-center gap-2 mt-1 px-1">
          {message.model && (
            <span className="badge bg-white/[0.03] text-gray-500 ring-white/[0.06] font-mono">
              {message.provider}/{message.model}
            </span>
          )}
          {message.tokensUsed && (
            <span className="text-xs text-gray-600 tabular-nums">{message.tokensUsed} tokens</span>
          )}
          <button
            onClick={() => onCopy(message.content, message.id)}
            aria-label="Copy message"
            title="Copy to clipboard"
            className="p-1 rounded-md hover:text-gray-300 hover:bg-white/[0.06] text-gray-600 transition-colors"
          >
            {copiedId === message.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>

        {/* Sources */}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setShowSources(!showSources)}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 px-2 py-1 rounded-lg hover:bg-blue-500/10 transition-colors"
            >
              {showSources ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              <Newspaper className="w-3 h-3" />
              {message.sources.length} source{message.sources.length !== 1 ? 's' : ''}
            </button>
            {showSources && (
              <div className="mt-1 space-y-1 animate-fade-up">
                {message.sources.map((src, i) => (
                  <a
                    key={i}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-400 px-2 py-1 rounded-lg hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="w-4 text-right text-gray-600 tabular-nums flex-shrink-0">{i + 1}.</span>
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
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
}

function ToolProgress({ calls, results }: { calls: ToolCall[]; results: ToolResult[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pl-11 space-y-1.5 animate-fade-up">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-2 text-xs font-medium text-gray-500 hover:text-gray-300 px-2 py-1 rounded-lg panel transition-colors"
      >
        <Wrench className="w-3 h-3 text-blue-400" />
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
        <div className="space-y-1 ml-4 animate-fade-up">
          {results.map(r => (
            <div key={r.callId} className="flex items-center gap-2 text-xs panel px-2.5 py-1.5">
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                r.success ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
              }`}>
                {r.success ? '✓' : '✗'}
              </span>
              <span className="text-gray-300 font-medium">{r.toolId}</span>
              <span className="ml-auto text-gray-600 tabular-nums">{r.duration}ms</span>
              {r.error && <span className="text-red-400/70 max-w-[200px] truncate">({r.error})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
