import type { ChatMessage, ChatSession, AppSettings, ToolCall, ToolResult, Source } from '../types';
import { callProvider, type ProviderMessage } from './provider';
import { toolRegistry, compactToolData } from './tools';
import { saveChatSession, getChatSession } from './database';
import { addLog } from './database';

// Compact system prompt: the tool list was removed because full tool names,
// descriptions and schemas are already sent via the API "tools" parameter —
// repeating them here only wasted prompt tokens on every request. All quality
// guardrails (citations, fact/analysis separation, etc.) are preserved.
const SYSTEM_PROMPT = `You are an AI research assistant helping users research topics, analyze news, look up companies, and check stock prices.

Use the provided tools to gather information when needed. Always cite sources.
Separate verified facts from analysis and uncertainty; correlation is not causation. State clearly if data is unavailable.
Respond in the user's language, concise but thorough.`;

export interface ChatOrchestratorCallbacks {
  onToken: (token: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onComplete: (message: ChatMessage) => void;
  onError: (error: string) => void;
  onStatus: (status: string) => void;
}

export class ChatOrchestrator {
  private abortController: AbortController | null = null;
  private toolCallCount = 0;
  private maxToolSteps = 20;
  private processedToolCalls = new Set<string>();

  async sendMessage(
    settings: AppSettings,
    session: ChatSession,
    userMessage: string,
    callbacks: ChatOrchestratorCallbacks
  ): Promise<void> {
    this.abortController = new AbortController();
    this.toolCallCount = 0;
    this.processedToolCalls = new Set();
    this.maxToolSteps = settings.maxToolSteps;

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);

    try {
      await this.runAgentLoop(settings, session, callbacks);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        callbacks.onStatus('Aborted by user');
        return;
      }
      callbacks.onError(err.message || 'An error occurred');
      await addLog({ level: 'error', message: `Chat error: ${err.message}`, timestamp: Date.now() });
    }

    await saveChatSession(session);
  }

  private async runAgentLoop(
    settings: AppSettings,
    session: ChatSession,
    callbacks: ChatOrchestratorCallbacks
  ): Promise<void> {
    const messages = this.buildProviderMessages(session.messages);
    const tools = toolRegistry.getToolDefinitionsForLLM();
    let fullContent = '';
    let currentModel = '';
    let currentProvider = '';
    let totalTokens = 0;
    const sources: Source[] = [];
    // Deduplicate tool calls by (name + arguments): models often repeat the
    // exact same call across steps, which wastes both execution time and
    // prompt tokens for the duplicated results.
    const seenToolSignatures = new Set<string>();

    // Agent loop: keep calling until no more tool calls or max steps reached
    for (let step = 0; step < this.maxToolSteps; step++) {
      callbacks.onStatus(step === 0 ? 'Thinking...' : `Processing step ${step + 1}...`);

      let assistantContent = '';
      let toolCalls: any[] = [];

      try {
        const result = await callProvider(
          settings,
          [...messages],
          tools.length > 0 ? tools : undefined,
          {
            onToken: (token: string) => {
              assistantContent += token;
              callbacks.onToken(token);
            },
            onToolCall: (tc: any) => {
              toolCalls.push(tc);
            },
            onComplete: (_content: string, usage: any) => {
              totalTokens += usage.totalTokens;
            },
            onError: (err: Error) => {
              callbacks.onError(err.message);
            },
          },
          this.abortController?.signal
        );

        currentModel = result.model;
        currentProvider = result.provider;
        fullContent += result.content;
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        callbacks.onError(err.message);
        return;
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        const finalMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent || fullContent,
          timestamp: Date.now(),
          model: currentModel,
          provider: currentProvider,
          tokensUsed: totalTokens,
          sources: sources.length > 0 ? sources : undefined,
        };
        session.messages.push(finalMessage);
        callbacks.onComplete(finalMessage);
        callbacks.onStatus('Complete');
        return;
      }

      // Process tool calls
      const assistantMsg: ProviderMessage = {
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: toolCalls.map((tc, idx) => ({
          id: tc.id || `call_${idx}`,
          type: 'function',
          function: {
            name: tc.function?.name || tc.name || '',
            arguments: tc.function?.arguments || tc.arguments || '{}',
          },
        })),
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of toolCalls) {
        const callId = tc.id || `call_${this.toolCallCount}`;
        
        // Prevent duplicate execution
        if (this.processedToolCalls.has(callId)) continue;
        this.processedToolCalls.add(callId);

        const toolName = tc.function?.name || tc.name || '';
        let toolArgs: Record<string, any> = {};
        
        try {
          const argsStr = tc.function?.arguments || tc.arguments || '{}';
          toolArgs = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
        } catch {
          toolArgs = {};
        }

        const toolCall: ToolCall = {
          id: callId,
          toolId: toolName,
          toolName,
          arguments: toolArgs,
          timestamp: Date.now(),
        };

        // Skip identical tool calls already executed in this turn; return the
        // cached result to the model so the tool-call protocol stays valid.
        const signature = `${toolName}:${JSON.stringify(toolArgs)}`;
        if (seenToolSignatures.has(signature)) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ skipped: 'duplicate call', note: 'Identical result was returned earlier in this conversation turn.' }),
            tool_call_id: callId,
          });
          continue;
        }
        seenToolSignatures.add(signature);

        callbacks.onToolCall(toolCall);
        callbacks.onStatus(`Running: ${toolName}...`);

        const result = await toolRegistry.execute(toolCall);
        callbacks.onToolResult(result);

        // Extract sources from tool results
        if (result.success && result.data) {
          if (result.data.results) {
            for (const r of result.data.results) {
              if (r.url && r.title) {
                sources.push({ title: r.title, url: r.url, snippet: r.snippet });
              }
            }
          }
          if (result.data.articles) {
            for (const a of result.data.articles) {
              if (a.url && a.title) {
                sources.push({ title: a.title, url: a.url, snippet: a.snippet, publishedAt: a.publishedAt });
              }
            }
          }
        }

        // Add tool result to messages (compacted: raw results would otherwise
        // be re-sent as prompt tokens on every remaining agent step)
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? compactToolData(result.data) : { error: result.error }),
          tool_call_id: callId,
        });

        this.toolCallCount++;
      }

      // Reset content for next iteration
      fullContent = '';
    }

    // Max steps reached
    const finalMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: fullContent || 'Maximum tool steps reached. Here is what I found so far.',
      timestamp: Date.now(),
      model: currentModel,
      provider: currentProvider,
      tokensUsed: totalTokens,
      sources: sources.length > 0 ? sources : undefined,
    };
    session.messages.push(finalMessage);
    callbacks.onComplete(finalMessage);
    callbacks.onStatus('Max steps reached');
  }

  private buildProviderMessages(chatMessages: ChatMessage[]): ProviderMessage[] {
    const messages: ProviderMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    for (const msg of chatMessages) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        // History tool calls/results are no longer actionable for the model
        // (they were already summarized in the assistant's reply), so we drop
        // them from prior turns. This cuts prompt tokens dramatically in long
        // sessions while keeping the full conversational text intact.
        messages.push({ role: 'assistant', content: msg.content });
      }
      // Historical 'tool' messages are intentionally skipped (see above).
    }

    return this.fitToContextWindow(messages);
  }

  /**
   * Hard cap on prompt size: keep system prompt + most recent messages that
   * fit into a fraction of the model's context window. Prevents runaway token
   * spend and provider errors on very long sessions; the current turn's tool
   * results are added separately in the agent loop, so they are never lost.
   */
  private fitToContextWindow(messages: ProviderMessage[]): ProviderMessage[] {
    const MAX_HISTORY_TOKENS = 24000; // ~ chars/4 estimate, well under 128k windows
    let total = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    let start = 0;
    // Always keep the system message (index 0) and at least the last message.
    while (total > MAX_HISTORY_TOKENS && start < messages.length - 2) {
      total -= messages[start + 1].content?.length || 0;
      start++;
    }
    if (start > 0) {
      return [messages[0], ...messages.slice(start + 1)];
    }
    return messages;
  }

  abort(): void {
    this.abortController?.abort();
  }
}

export const chatOrchestrator = new ChatOrchestrator();
