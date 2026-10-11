import type { ChatMessage, ChatSession, AppSettings, ToolCall, ToolResult, Source } from '../types';
import { callProvider, type ProviderMessage } from './provider';
import { toolRegistry } from './tools';
import { saveChatSession, getChatSession } from './database';
import { addLog } from './database';

const SYSTEM_PROMPT = `You are an AI research assistant. You help users research topics, analyze news, look up company information, and check stock prices.

You have access to various tools that you can use to gather information:
- web_search: Search the web for current information
- news_search: Search for recent news articles
- company_lookup: Look up company info and ticker symbols
- stock_price: Get stock price data
- data_filter: Filter and process data
- text_summarize: Summarize text content
- generate_report: Create structured reports
- url_fetch: Fetch content from URLs

When you need information, use the appropriate tools. Always cite your sources.
Distinguish between verified facts, your analysis, and uncertainties.
When comparing data (e.g., news and stock prices), note that correlation does not imply causation.
If data is unavailable, state this clearly.

Respond in the same language the user uses. Be concise but thorough.`;

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

        // Add tool result to messages
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
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
        const assistantMsg: ProviderMessage = { role: 'assistant', content: msg.content };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.toolId, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        messages.push(assistantMsg);
      } else if (msg.role === 'tool' && msg.toolResults) {
        for (const tr of msg.toolResults) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(tr.success ? tr.data : { error: tr.error }),
            tool_call_id: tr.callId,
          });
        }
      }
    }

    return messages;
  }

  abort(): void {
    this.abortController?.abort();
  }
}

export const chatOrchestrator = new ChatOrchestrator();
