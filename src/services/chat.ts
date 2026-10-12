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
  /** Content streamed during the current turn (kept for abort persistence). */
  private partialContent = '';

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

    // Add user message (via immutable helper so React state updates and the
    // final persistence below always see the same, up-to-date session)
    this.appendMessage(session, {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    try {
      await this.runAgentLoop(settings, session, callbacks);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Persist what was streamed so far — previously an abort discarded the
        // entire partial answer and even the user message from the session.
        if (this.partialContent.trim().length > 0) {
          this.appendMessage(session, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: this.partialContent + '\n\n*(Antwort abgebrochen)*',
            timestamp: Date.now(),
          });
        }
        await saveChatSession(session);
        callbacks.onStatus('Aborted by user');
        return;
      }
      // Budget-wait failures must not discard progress either: persist the
      // partial turn (user message, streamed text, completed tool steps) so a
      // retry can build on it instead of starting over.
      if (this.partialContent.trim().length > 0) {
        this.appendMessage(session, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: this.partialContent + `\n\n*(Prozess angehalten: ${err.message || 'Fehler'})*`,
          timestamp: Date.now(),
        });
        await saveChatSession(session);
      }
      callbacks.onError(err.message || 'An error occurred');
      await addLog({ level: 'error', message: `Chat error: ${err.message}`, timestamp: Date.now() });
    }

    await saveChatSession(session);
  }

  /**
   * Append a message immutably: replaces `session.messages` with a new array
   * and `session.updatedAt` with a fresh timestamp. A plain `push()` mutated
   * the object that is also held in React state, so `UPDATE_SESSION` produced
   * a reference-equal messages array — the user message never re-rendered
   * until the stream finished and could even be rendered twice once the UI
   * callback spread `[...currentSession.messages, message]` from a stale
   * closure.
   */
  private appendMessage(session: ChatSession, message: ChatMessage): void {
    session.messages = [...session.messages, message];
    session.updatedAt = Date.now();
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
    // Track streamed content on the instance so an abort in sendMessage can
    // persist the partial answer instead of discarding it.
    this.partialContent = '';
    // Per-turn counter for synthesizing unique tool-call ids when the model
    // omits `tc.id`: a bare `call_${this.toolCallCount}` stayed at 0 whenever
    // ids were missing, so `processedToolCalls` swallowed every call after the
    // first one and their results never reached the model (broken protocol).
    let turnCallIndex = 0;
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
              this.partialContent += token;
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
            // TPM budget exhausted: don't fail the task — callProvider waits
            // internally until tokens free up. Surface the wait as status so
            // the user sees progress instead of a stuck UI; completed steps
            // and streamed text stay intact while waiting.
            onBudgetWait: (waitMs, waitedMs) => {
              const secs = Math.max(1, Math.round(waitMs / 1000));
              const waited = Math.round(waitedMs / 1000);
              callbacks.onStatus(
                `Token-Limit erreicht – warte auf Budget (${secs}s${waited > 0 ? `, wartet seit ${waited}s` : ''})…`
              );
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
        this.appendMessage(session, finalMessage);
        callbacks.onComplete(finalMessage);
        callbacks.onStatus('Complete');
        return;
      }

      // Process tool calls. Assign a stable unique id to every call FIRST and
      // reuse it in both the assistant message and the matching tool result —
      // previously the two could diverge (`call_${idx}` vs `call_${count}`),
      // breaking the tool-call protocol for models that omit `tc.id`.
      const resolvedToolCalls = toolCalls.map((tc, idx) => ({
        raw: tc,
        id: tc.id || `call_${step}_${turnCallIndex + idx}`,
      }));

      const assistantMsg: ProviderMessage = {
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: resolvedToolCalls.map(({ raw, id }) => ({
          id,
          type: 'function',
          function: {
            name: raw.function?.name || raw.name || '',
            arguments: raw.function?.arguments || raw.arguments || '{}',
          },
        })),
      };
      messages.push(assistantMsg);

      // Prepare all tool calls first (validation, dedup, protocol bookkeeping),
      // then execute them in PARALLEL — network-bound tools (search, news,
      // stock, URL fetch) previously ran one after another, so a step with
      // several calls took the SUM of their latencies instead of the maximum.
      const pendingCalls: ToolCall[] = [];

      for (const { raw: tc, id: preallocatedId } of resolvedToolCalls) {
        const callId = preallocatedId;
        turnCallIndex++;

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
        pendingCalls.push(toolCall);
      }

      if (pendingCalls.length > 0) {
        callbacks.onStatus(
          pendingCalls.length === 1
            ? `Running: ${pendingCalls[0].toolName}...`
            : `Running ${pendingCalls.length} tools in parallel...`
        );

        const results = await Promise.all(pendingCalls.map(c => toolRegistry.execute(c)));

        // Push results in the ORIGINAL call order so the assistant tool_calls
        // and tool messages stay aligned in the conversation protocol.
        for (let i = 0; i < pendingCalls.length; i++) {
          const toolCall = pendingCalls[i];
          const result = results[i];
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
            tool_call_id: toolCall.id,
          });

          this.toolCallCount++;
        }
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
    this.appendMessage(session, finalMessage);
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
