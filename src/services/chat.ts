import type { ChatMessage, ChatSession, AppSettings, ToolCall, ToolResult, Source } from '../types';
import { callProvider, type ProviderMessage } from './provider';
import { toolRegistry, compactToolData } from './tools';
import { saveChatSession } from './database';
import { addLog } from './database';

// Compact system prompt: the tool list was removed because full tool names,
// descriptions and schemas are already sent via the API "tools" parameter —
// repeating them here only wasted prompt tokens on every request. All quality
// guardrails (citations, fact/analysis separation, etc.) are preserved.
const SYSTEM_PROMPT = `# ⚙️ SYSTEM INSTRUCTIONS — TOKEN-EFFICIENT RESEARCH AGENT

## 1. HARD CONSTRAINTS
- **MAX OUTPUT PER TURN:** 300 Wörter (≈ 400 Tokens). Keine Ausnahmen.
- **MAX TOOL CALLS PER TURN:** 3. Bevorzuge Batch-Aufrufe.
- **NO FLUFF:** Keine Einleitungen, Übergänge, Höflichkeitsfloskeln, Zusammenfassungen des eigenen Vorgehens.
- **OUTPUT FORMAT:** Nur **strukturiertes Ergebnis** (Bulletpoints, Tabellen, JSON) + **Quellen-Array** am Ende.

## 2. TOOL USAGE RULES
| Tool | Parameter-Limits | Wann nutzen |
|------|------------------|-------------|
| \`web_search\` | \`maxResults: 3\` | Erstschlag, breite Abdeckung |
| \`news_search\` | \`maxResults: 3\`, \`hoursBack: 24\` | Aktuelle News |
| \`url_fetch\` | \`maxLength: 2000\`, \`selector: "article, main, .content, #article-body"\` | Nur wenn Snippet unzureichend |
| \`text_summarize\` | \`maxLength: 80\` | **Immer** nach \`url_fetch\` wenn Text > 1500 Zeichen |
| \`data_filter\` | \`limit: 5\`, \`deduplicateBy: "url"\` | Nach jeder Suche mit >3 Treffern |
| \`stock_analysis\` | \`period: "6mo"\`, \`interval: "1d"\` | Statt \`stock_price\` für Performance/Volatilität |
| \`company_lookup\` | \`includeFundamentals: true\` | Statt manueller Kennzahlen-Suche |
| \`calculator\` / \`currency_convert\` | — | Jede Berechnung, kein Kopfrechnen |
| \`generate_report\` | \`sections: max 4\`, \`maxLength per section: 60 Wörter\` | Finales Output-Format |

**Verboten:** \`stock_price\` (Tagesdaten), \`web_search\` mit \`maxResults > 5\`, \`url_fetch\` ohne \`maxLength\`/\`selector\`.

## 3. MANDATORY WORKFLOW (für jede Research-Aufgabe)
1. **SEARCH** → \`web_search\`/\`news_search\` (max 3 Ergebnisse)
2. **FILTER** → \`data_filter\` (Top 3, deduplicate by URL)
3. **FETCH** → \`url_fetch\` (nur 1–2 beste URLs, max 2000 Zeichen, article-selector)
4. **SUMMARIZE** → \`text_summarize\` (max 80 Wörter pro Quelle)
5. **SYNTHESIZE** → \`generate_report\` (max 4 Sektionen à 60 Wörter)
6. **CITE** → Quellen-Array: \`[{"title": "", "url": "", "source": "", "date": ""}]\`

## 4. RESPONSE TEMPLATE (exakt dieses Format)
\`\`\`markdown
## 🎯 Kern-Ergebnis
- Punkt 1 (Fakt, Zahl, Schlussfolgerung)
- Punkt 2
- Punkt 3

## 📊 Daten / Kennzahlen (falls relevant)
| Metrik | Wert | Quelle |
|--------|------|--------|
| KGV | 18,2 | S1 |
| 6M Performance | +14 % | S2 |

## ⚠️ Unsicherheiten / Gaps
- Fehlende Daten: X
- Annahme: Y

## 📚 Quellen
[S1] Titel – URL – Quelle – Datum
[S2] Titel – URL – Quelle – Datum
\`\`\`

## 5. BEHAVIORAL TRIGGERS
- **User fragt „Warum?" / „Erkläre"** → **Nicht** erzählen, sondern **neuen Research-Workflow** starten (max 1 Turn).
- **User will Details** → Neue Suche mit \`maxResults: 2\`, \`url_fetch\` 1 Quelle, \`text_summarize: 60\`.
- **Token-Warnung (App-seitig)** → Sofort \`generate_report\` mit bisherigem Material, Turn beenden.

## 6. NEVER DO
- ❌ Mehr als 3 Tool-Calls pro Turn
- ❌ Rohdaten (HTML, lange Listen, volle Artikel) in den Kontext lassen
- ❌ Sätze wie „Hier ist die Zusammenfassung:" oder „Ich habe folgende Quellen geprüft:"
- ❌ Spekulieren ohne Quelle (Kennzeichnung: \`💡 Annahme:\`)

---

**ENFORCEMENT:** Wenn du diese Regeln brichst, ist die Antwort ungültig. Starte den Turn neu mit korrektem Workflow.

(Grundregeln: Immer Quellen zitieren; Fakten von Analyse/Unsicherheit trennen — Korrelation ist nicht Kausalität; fehlende Daten klar benennen; in der Sprache des Nutzers antworten.)`;

/** Describes WHY a turn stopped without completing (see onInterruption). */
export interface TurnInterruption {
  /** True when every model in the fallback chain declined the request. */
  refusal: boolean;
  message: string;
}

export interface ChatOrchestratorCallbacks {
  onToken: (token: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onComplete: (message: ChatMessage) => void;
  onError: (error: string) => void;
  onStatus: (status: string) => void;
  /**
   * Optional: fired IN ADDITION to onError whenever a turn stops incomplete
   * (all models refused, budget exhausted, other failure). The interrupted turn
   * is persisted together with everything already accomplished, so the UI can
   * offer "Fortsetzen" (chatOrchestrator.resumeTurn) instead of a plain retry
   * that would restart the task from scratch. `refusal` distinguishes "every
   * model declined" from an infrastructure failure.
   */
  onInterruption?: (interruption: TurnInterruption) => void;
}

/**
 * Continuation instruction injected when the previous model refused the task
 * and a fallback model takes over. It tells the new model to RESUME the task
 * from the existing conversation state (including tool results already
 * present in the message history) instead of redoing everything from scratch.
 */
const REFUSAL_RESUME_INSTRUCTION = `⚠️ FORTESETZUNGS-HINWEIS (Fallback-Übernahme):
Das vorherige Modell hat diese Anfrage abgelehnt. Du übernimmst die Aufgabe AB DEM AKTUELLEN STAND:
- Bereits ausgeführte Tool-Aufrufe und ihre Ergebnisse stehen im Gesprächsverlauf – nutze sie, führe keine identische Suche/Abfrage erneut aus.
- Erstelle nichts neu, was bereits vorhanden ist; setze nur die noch offenen Schritte der Aufgabe fort.
- Beantworte die ursprüngliche Nutzeranfrage mit dem gesammelten Material so vollständig wie möglich.`;

/** Marker used to persist an interrupted turn so it can be resumed later. */
const INTERRUPTED_SUFFIX = 'Prozess angehalten';

/** Silent callback set used when a caller (e.g. tests) doesn't need UI events. */
const NOOP_CALLBACKS: ChatOrchestratorCallbacks = {
  onToken: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onComplete: () => {},
  onError: () => {},
  onStatus: () => {},
};

/** True when the provider chain ended in a content refusal ("all declined"). */
function isRefusalError(err: any): boolean {
  return err?.refusal === true || err?.name === 'ModelRefusalError';
}

/**
 * Report an interruption to the caller: onError for the visible message plus
 * onInterruption so the UI knows a resumable, partially completed turn was
 * persisted and can offer a "Fortsetzen" action.
 */
function emitInterruption(callbacks: ChatOrchestratorCallbacks, err: any): void {
  const message = err?.message || 'An error occurred';
  callbacks.onError(message);
  callbacks.onInterruption?.({ refusal: isRefusalError(err), message });
}

export class ChatOrchestrator {
  private abortController: AbortController | null = null;
  private toolCallCount = 0;
  private maxToolSteps = 20;
  /**
   * Hard cap on EXECUTED tool calls per turn. The system prompt asks for ≤3,
   * but prompts are only advice — without a runtime limit a model can fire off
   * dozens of searches in one turn (observed: 8 tool calls + ~43k tokens for
   * the single question "wieviel kostet eine Siemens Aktie?"). Every extra
   * step re-sends all prior tool results as prompt tokens, so this cap is the
   * main defence against runaway token spend. When reached, the loop stops
   * calling tools and forces the model to answer from what it already has.
   */
  private maxToolCallsPerTurn = 6;
  private processedToolCalls = new Set<string>();
  /** Content streamed during the current turn (kept for abort persistence). */
  private partialContent = '';
  /**
   * Set after a refusal/interruption so the NEXT provider call receives the
   * "continue, don't restart" instruction exactly once.
   */
  private pendingResumeNote = false;

  async sendMessage(
    settings: AppSettings,
    session: ChatSession,
    userMessage?: string,
    callbacks: ChatOrchestratorCallbacks = NOOP_CALLBACKS
  ): Promise<void> {
    this.abortController = new AbortController();
    this.toolCallCount = 0;
    this.processedToolCalls = new Set();
    this.maxToolSteps = settings.maxToolSteps;

    // Add user message (via immutable helper so React state updates and the
    // final persistence below always see the same, up-to-date session).
    // `userMessage` is optional: resumeTurn() reuses the existing session as-is.
    if (userMessage !== undefined) {
      this.appendMessage(session, {
        id: crypto.randomUUID(),
        role: 'user',
        content: userMessage,
        timestamp: Date.now(),
      });
    }

    try {
      const loop = await this.runAgentLoop(settings, session, callbacks);
      // If the turn stopped because every model refused (or all failed), the
      // interruption is persisted WITH the completed work attached — a later
      // resumeTurn() continues from there instead of restarting the task.
      if (loop?.interruption) {
        this.persistInterruptedTurn(session, loop.interruption.err, loop.interruption.ctx);
        await saveChatSession(session);
        emitInterruption(callbacks, loop.interruption.err);
        await addLog({ level: 'error', message: `Chat error: ${loop.interruption.err.message}`, timestamp: Date.now() });
      }
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
      // Interruptions outside the agent loop must not discard progress either:
      // persist the partial turn (with the resumable marker) so a later
      // resumeTurn() continues from here instead of restarting the task.
      if (this.partialContent.trim().length > 0) {
        this.appendMessage(session, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: this.partialContent + `\n\n*(${INTERRUPTED_SUFFIX}: ${err.message || 'Fehler'})*`,
          timestamp: Date.now(),
        });
        await saveChatSession(session);
      }
      emitInterruption(callbacks, err);
      await addLog({ level: 'error', message: `Chat error: ${err.message}`, timestamp: Date.now() });
    }

    await saveChatSession(session);
  }

  /**
   * Resume the LAST interrupted turn of a session — e.g. after a model refused
   * the request and the fallback chain took over, or after a TPM-budget wait
   * failed. Instead of re-asking the user and redoing every completed step,
   * this continues from the persisted state: finished agent steps and their
   * tool results are replayed into the provider context for free, and only the
   * remaining work is executed by the (fallback) model.
   */
  async resumeTurn(
    settings: AppSettings,
    session: ChatSession,
    callbacks: ChatOrchestratorCallbacks = NOOP_CALLBACKS
  ): Promise<void> {
    this.abortController = new AbortController();
    this.toolCallCount = 0;
    this.processedToolCalls = new Set();
    this.maxToolSteps = settings.maxToolSteps;

    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.content.includes(INTERRUPTED_SUFFIX)) {
      throw new Error('Kein angehaltener Turn gefunden – es gibt nichts fortzusetzen.');
    }

    // Strip the interruption marker from the persisted partial answer so the
    // continuation flows seamlessly onto exactly the point where the previous
    // attempt stopped.
    const stripped = last.content.replace(/\n\n*\(\*[^)]*\)\*$/, '').trim();
    last.content = stripped ? `${stripped}\n\n*(Fortsetzung nach Fallback-Übernahme)*` : '';
    session.messages = [...session.messages];
    session.updatedAt = Date.now();

    // The fallback model that takes over must CONTINUE the task instead of
    // restarting it — injected once into the very next provider call.
    this.pendingResumeNote = true;

    try {
      const loop = await this.runAgentLoop(settings, session, callbacks);
      if (loop?.interruption) {
        this.persistInterruptedTurn(session, loop.interruption.err, loop.interruption.ctx);
        emitInterruption(callbacks, loop.interruption.err);
        await addLog({ level: 'error', message: `Resume error: ${loop.interruption.err.message}`, timestamp: Date.now() });
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
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
      if (this.partialContent.trim().length > 0) {
        this.appendMessage(session, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: this.partialContent + `\n\n*(${INTERRUPTED_SUFFIX}: ${err.message || 'Fehler'})*`,
          timestamp: Date.now(),
        });
      }
      emitInterruption(callbacks, err);
      await addLog({ level: 'error', message: `Resume error: ${err.message}`, timestamp: Date.now() });
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
  ): Promise<{ interruption?: { err: any; ctx: Parameters<ChatOrchestrator['persistInterruptedTurn']>[2] } } | void> {
    const messages = this.buildProviderMessages(session.messages);
    const tools = toolRegistry.getToolDefinitionsForLLM();
    // Accumulates the FINAL answer text across steps. Previously it was reset
    // to '' at the end of every step, so when the max-steps limit was hit the
    // fallback message below always contained nothing but the boilerplate —
    // everything the model had streamed during the turn was lost.
    let fullContent = '';
    let lastStepContent = '';
    let currentModel = '';
    let currentProvider = '';
    let totalTokens = 0;
    // Text of every COMPLETED step of this turn (steps that ended with tool
    // calls). Kept separately so an interrupted turn can be persisted with all
    // progress and resumed without regenerating earlier output.
    const stepContents: string[] = [];
    // Sources are collected across ALL steps of the turn and deduplicated by
    // URL — models often run the same search in several steps, which
    // previously produced duplicated citation lists in the final message.
    const sources: Source[] = [];
    const seenSourceUrls = new Set<string>();
    const addSource = (s: Source) => {
      if (seenSourceUrls.has(s.url)) return;
      seenSourceUrls.add(s.url);
      sources.push(s);
    };
    // Tool activity of the whole turn, persisted on the final assistant
    // message so follow-up turns can see WHAT was researched earlier.
    const turnToolCalls: ToolCall[] = [];
    const turnToolResults: ToolResult[] = [];
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
    // One retry is allowed when a model returns a completely empty reply
    // (no text, no tools) before anything was accomplished this turn.
    let emptyRetryUsed = false;

    // Replay completed work from a previously interrupted turn: if the last
    // assistant message is an interruption marker that carries tool calls AND
    // their results (persisted before), feed them straight back into the
    // provider context. The fallback model then continues where the refused
    // attempt stopped — instead of re-running every search/tool from scratch.
    this.seedInterruptedProgress(messages, session.messages);

    // Agent loop: keep calling until no more tool calls or max steps reached
    for (let step = 0; step < this.maxToolSteps; step++) {
      callbacks.onStatus(step === 0 ? 'Thinking...' : `Processing step ${step + 1}...`);

      let assistantContent = '';
      let toolCalls: any[] = [];

      // Refusal/fallback takeover: tell the new model ONCE to resume the task
      // from the existing state rather than restarting it.
      if (this.pendingResumeNote) {
        messages.push({ role: 'user', content: REFUSAL_RESUME_INSTRUCTION });
        this.pendingResumeNote = false;
      }

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
            // Fallback takeover DURING this request: a previous model failed or
            // refused and the next one streams into the SAME UI buffer. Reset
            // the per-attempt buffers so the refusing model's partial text is
            // not prepended to the fallback model's answer ("weitermachen,
            // nicht doppelt"), and track which model is now answering.
            onModelSwitch: (modelId, provider, attempt) => {
              if (attempt > 1) {
                assistantContent = '';
                this.partialContent = '';
                callbacks.onStatus(
                  `Modell hat abgelehnt/fehler → Fallback übernimmt (${provider}/${modelId}), Aufgabe wird fortgesetzt…`
                );
              }
              currentModel = modelId;
              currentProvider = provider;
            },
          },
          this.abortController?.signal
        );

        currentModel = result.model;
        currentProvider = result.provider;
        lastStepContent = result.content;
        // NOTE: no accumulation here — the step's text is added to `fullContent`
        // exactly once below (in the tool-step branch) or used directly as the
        // final answer (no-tool-calls branch). Accumulating BOTH here and there
        // duplicated every planning text in the final/persisted answer.
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        // The whole fallback chain failed or refused. DON'T end the turn here
        // with a bare onError — that would discard everything completed so far.
        // Return an interruption descriptor instead so sendMessage/resumeTurn
        // can persist the finished steps, tool calls/results and sources; a
        // later resumeTurn() continues from exactly this state.
        return {
          interruption: {
            err,
            ctx: {
              partialContent: this.partialContent,
              stepContents,
              turnToolCalls,
              turnToolResults,
              sources,
              model: currentModel,
              provider: currentProvider,
              tokens: totalTokens,
            },
          },
        };
      }

      // If no tool calls, we're done — UNLESS the reply is empty AND nothing
      // was researched yet: that is a "silent refusal" (the model answered
      // with neither text nor tools), not an answer. Ending here would show
      // the user a blank message after already burning tokens on earlier
      // steps; instead feed the model one explicit nudge to answer now.
      if (toolCalls.length === 0) {
        const hasProgress = turnToolCalls.length > 0 || fullContent.trim().length > 0;
        if (!assistantContent.trim() && !hasProgress && !emptyRetryUsed) {
          emptyRetryUsed = true;
          messages.push({
            role: 'user',
            content: 'Deine vorherige Antwort war leer (kein Text, kein Tool-Aufruf). Antworte JETZT direkt und vollständig auf die ursprüngliche Nutzerfrage, ggf. mit den bereits im Verlauf vorhandenen Tool-Ergebnissen.',
          });
          continue;
        }
        const finalMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent || fullContent,
          timestamp: Date.now(),
          model: currentModel,
          provider: currentProvider,
          tokensUsed: totalTokens,
          sources: sources.length > 0 ? sources : undefined,
          // Persist what was researched during this turn so follow-up
          // questions can build on it instead of re-running every search.
          toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
          toolResults: turnToolResults.length > 0 ? turnToolResults : undefined,
        };
        this.appendMessage(session, finalMessage);
        callbacks.onComplete(finalMessage);
        callbacks.onStatus('Complete');
        return;
      }

      // The model asked for tools: its planning text is now a completed step
      // of THIS turn. Keep it as the base of the final answer — previously it
      // was discarded here, so after an interruption/fallback takeover only the
      // last step's text survived and earlier output had to be produced again.
      if (assistantContent.trim().length > 0) {
        fullContent += (fullContent ? '\n\n' : '') + assistantContent;
        // Record it as a COMPLETED step so an interrupted turn can be persisted
        // with all prior output (persistInterruptedTurn → stepContents) and a
        // resumed turn does not have to regenerate earlier steps' text.
        stepContents.push(assistantContent);
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

        const toolName = (tc.function?.name || tc.name || '').trim();
        let toolArgs: Record<string, any> = {};
        // True when the model streamed argument JSON that couldn't be parsed
        // (truncated/half-streamed payload) — such calls must not run with an
        // empty argument object, see the guard below.
        let malformedArgs = false;

        try {
          const argsStr = tc.function?.arguments || tc.arguments || '{}';
          toolArgs = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
        } catch {
          // Truncated/invalid argument JSON (e.g. a half-streamed `{"q`) must
          // NOT be executed as an empty call — that produced bogus errors like
          // 'Pflicht-Parameter "query" fehlt'. Normalize to {} and flag it so
          // the model gets a clear, self-correctable error back.
          toolArgs = {};
          malformedArgs = true;
        }
        if (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
          toolArgs = {};
          malformedArgs = true;
        }

        // Guard against garbage calls reaching the registry: models (and old
        // buggy delta-forwarding code) can emit calls with an empty name or no
        // payload at all. Answer them via the protocol with a precise error
        // instead of executing "Tool not found: ".
        const isEmptyFragment = !toolName && Object.keys(toolArgs).length === 0;
        if (!toolName || isEmptyFragment || malformedArgs) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              error: !toolName
                ? 'Ungültiger Tool-Aufruf: Der Tool-Name fehlt. Verfügbare Tools: ' + toolRegistry.getEnabledTools().map(t => t.id).join(', ')
                : malformedArgs && toolName
                  ? `Ungültige bzw. unvollständige Argumente für "${toolName}" (JSON konnte nicht geparst werden). Rufe das Tool erneut mit vollständigem JSON-Arguments-Objekt auf.`
                  : 'Ungültiger (leerer) Tool-Aufruf ohne Name und Argumente – ignoriert.',
            }),
            tool_call_id: callId,
          });
          continue;
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
          turnToolCalls.push(toolCall);
          turnToolResults.push(result);

          // Extract sources from tool results
          if (result.success && result.data) {
            if (result.data.results) {
              for (const r of result.data.results) {
                if (r.url && r.title) {
                  addSource({ title: r.title, url: r.url, snippet: r.snippet });
                }
              }
            }
            if (result.data.articles) {
              for (const a of result.data.articles) {
                if (a.url && a.title) {
                  addSource({ title: a.title, url: a.url, snippet: a.snippet, publishedAt: a.publishedAt });
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

      // NOTE: `fullContent` must NOT be reset here. It accumulates every
      // completed step of the turn (streamed planning text + final answer) so
      // that the max-steps fallback message below contains all prior output,
      // and an interrupted turn persists its progress instead of losing it.

      if (lastStepContent.trim().length > 0) {
        this.partialContent = lastStepContent;
      }
    }

    // Max steps reached — persist the tool activity too, so a later resume or
    // follow-up can build on the completed research instead of redoing it.
    const finalMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: fullContent || 'Maximum tool steps reached. Here is what I found so far.',
      timestamp: Date.now(),
      model: currentModel,
      provider: currentProvider,
      tokensUsed: totalTokens,
      sources: sources.length > 0 ? sources : undefined,
      toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
      toolResults: turnToolResults.length > 0 ? turnToolResults : undefined,
    };
    this.appendMessage(session, finalMessage);
    callbacks.onComplete(finalMessage);
    callbacks.onStatus('Max steps reached');
  }

  /**
   * Persist an interrupted turn (refusal / budget exhaustion) together with
   * the work already done in that turn, so `resumeTurn()` (or any later retry)
   * can CONTINUE from this state instead of restarting the task from scratch.
   */
  private persistInterruptedTurn(
    session: ChatSession,
    err: any,
    ctx: {
      partialContent: string;
      stepContents: string[];
      turnToolCalls: ToolCall[];
      turnToolResults: ToolResult[];
      sources: Source[];
      model: string;
      provider: string;
      tokens: number;
    }
  ): void {
    const refusal = isRefusalError(err);
    const body = [
      ...ctx.stepContents.map(c => c.trim()).filter(Boolean),
      ctx.partialContent.trim(),
    ].filter(Boolean).join('\n\n');
    const note = refusal
      ? `Alle Modelle haben die Anfrage abgelehnt bzw. kein Ergebnis geliefert: ${err.message}`
      : `Prozess angehalten: ${err?.message || 'Fehler'}`;
    this.appendMessage(session, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `${body ? body + '\n\n' : ''}*(${INTERRUPTED_SUFFIX}: ${note})*`,
      timestamp: Date.now(),
      model: ctx.model || undefined,
      provider: ctx.provider || undefined,
      tokensUsed: ctx.tokens || undefined,
      sources: ctx.sources.length > 0 ? ctx.sources : undefined,
      toolCalls: ctx.turnToolCalls.length > 0 ? ctx.turnToolCalls : undefined,
      toolResults: ctx.turnToolResults.length > 0 ? ctx.turnToolResults : undefined,
    });
  }

  /**
   * Replay completed work of an interrupted turn into the provider message
   * list. The last assistant message carrying the interruption marker keeps
   * its tool calls/results; feeding them back as assistant+tool messages means
   * the fallback model sees exactly how far the task had progressed and only
   * performs the remaining steps — nothing already researched is executed or
   * generated again.
   */
  private seedInterruptedProgress(messages: ProviderMessage[], chatMessages: ChatMessage[]): void {
    const last = chatMessages[chatMessages.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (!last.content.includes(INTERRUPTED_SUFFIX)) return;
    if (!last.toolCalls?.length || !last.toolResults?.length) return;

    // ToolResult carries the call id in `callId` (see types) — matching by a
    // non-existent `r.id` would silently drop every replayed result.
    const resultById = new Map(last.toolResults.map(r => [r.callId, r]));
    const usable = last.toolCalls.filter(c => resultById.has(c.id));
    if (usable.length === 0) return;

    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: usable.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.toolName, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    });
    for (const c of usable) {
      const r = resultById.get(c.id)!;
      messages.push({
        role: 'tool',
        content: JSON.stringify(r.success ? compactToolData(r.data) : { error: r.error }),
        tool_call_id: c.id,
      });
    }
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
