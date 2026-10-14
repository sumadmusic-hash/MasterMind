import type { ChatMessage, ChatSession, AppSettings, ToolCall, ToolResult, Source } from '../types';
import { callProvider, type ProviderMessage } from './provider';
import { toolRegistry, compactToolData } from './tools';
import { saveChatSession } from './database';
import { addLog } from './database';
import { buildMemoryPrompt } from './database';

/**
 * Limits for tool results sent back to the model. Every retained result is
 * re-billed as prompt tokens on EACH remaining agent step, so snippets and
 * long strings are trimmed aggressively here — the model still sees title,
 * URL and a usable excerpt per source, which is all citations and synthesis
 * need (full text remains available via url_fetch when genuinely required).
 */
export const COMPACT_RESULT_MAX_STRING = 150;
export const COMPACT_RESULT_MAX_ARRAY = 5;

/**
 * Note appended to the cached payload when an identical tool call is answered
 * from the dedup cache instead of being re-executed. Exported so tests (and
 * any consumer that must distinguish a real result from a replay) can assert
 * against the exact protocol string.
 */
export const DEDUP_CACHED_NOTE = 'identical call skipped – cached result from earlier in this turn';

/**
 * Runtime tool budget for SIMPLE factual questions (observed failure: "wer ist
 * bundeskanzler?" burned 12k+ tokens on 4 tool calls — three searches plus a
 * url_fetch — and the model still answered from stale training data because
 * every extra step re-bills system prompt + tool catalogue + all prior tool
 * results). Prompts are advice only, so the cap is enforced in code: when the
 * user query is a short single-fact question without an explicit research
 * order, at most ONE search call may execute per turn. Complex/analytical
 * requests keep the regular budget (`maxToolCallsPerTurn`).
 */
const SIMPLE_QUERY_TOOL_BUDGET = 1;

/**
 * Classifies a user query as a simple factual question worth the cheap path.
 * Conservative by design: any research/report/imperative signal disqualifies
 * the query, so genuine multi-step tasks never lose tool budget.
 */
export function isSimpleFactQuery(text: string): boolean {
  const q = (text || '').trim().toLowerCase();
  if (!q) return false;
  // The cheap path only makes sense for INTERROGATIVE one-fact questions —
  // imperative task descriptions ("rechne 1+0, 2+0 … aus", "nenne mir …") may
  // contain question marks in quotes but demand multiple computations.
  if (/^(?:rechne|berechne|nenne|gib|liste|mach|mache|zeig|calc|addier)/.test(q)) return false;
  // Long inputs are compound tasks / pasted content, not a quick fact lookup.
  if (q.length > 80) return false;
  // Imperatives & research vocabulary → full task, keep normal budget.
  if (/(?:^|\s)(?:recherchiere|research|analysier|untersuch|vergleiche|erstelle|berichte|zusammenfassen|fasse .{0,20} zusammen|erkl[aä]re .{0,30}(gründlich|detailliert|ausführlich)|step[- ]?by[- ]?step|pro |studie|report)/.test(q)) return false;
  // Question words typical for one-fact lookups…
  const asksFact = /(^(?:wer|was|welche[rms]?|wann|wie viele|wieviel|wie viel|wie spät|woher|wozu|wie hoch|wie tief|ist\b|sind\b|hat\b|hatte\b|wird\b)\b|[?！])/.test(q);
  if (!asksFact) return false;
  // Multi-part questions ("wer ist X und was macht Y?") need more than one call.
  const questionMarks = (q.match(/[?]/g) || []).length;
  if (questionMarks > 1) return false;
  if (/\b(?:und|oder)\b.*[?]/.test(q) === false) return true;
  // "und/oder" inside the question: still simple if it's one subject ("wer ist X oder Y")
  return !/\bwelche\b.*\bund\b.*\bwelche\b|\b(?:wer|was|wann)\b.*\b(?:und|oder)\b.*\b(?:wer|was|wann)\b/i.test(q);
}

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

## 1.5 EINFACHE FAKTENFRAGEN (token-sparender Pfad)
- **Erkennung:** kurze Frage nach EINEM Fakt ("wer ist…", "wie viele…", "wann…", "was ist…") ohne Research-Auftrag → MAXIMAL 1 Tool-Aufruf (\`ddg_web_search\`, \`maxResults: 3\`), dann sofort die Antwort in 1–3 Sätzen + Quellenzeile. Kein url_fetch, kein Report-Format, keine Abschnitte für Unsicherheit/Gaps.
- **Aktualität:** Bei Personen-/Amts-/Kurs-/Ereignisfragen ("wer ist X?", aktuelles Ergebnis) gilt das Modell-Wissen als VERALTET — erst Tool-Ergebnis abwarten und danach antworten. Niemals Wissensstand als "Stand …" verkaufen; wenn das Suchtool Fehler liefert, in EINEM Satz auf den Fehler verweisen statt ungeprüftes Trainingswissen auszugeben.

## 2. TOOL-REGELN (kostenlos: Schemas/Beschreibungen sind bereits im API-tools-Parameter)
- \`ddg_web_search\`/\`web_search\`/\`news_search\`: \`maxResults: 3\` (bei News zusätzlich \`hoursBack: 24\`); \`ddg_web_search\` ist die DuckDuckGo-Websuche mit echten Suchergebnissen (Option \`timeRange: day/week/month/year\` für aktuelle Ereignisse)
- \`url_fetch\`: \`maxLength: 2000\` + \`selector: "article, main, .content, #article-body"\`; nur wenn Snippet unzureichend
- \`text_summarize\` (\`maxLength: 80\`) nur bei Fetch-Text > 1500 Zeichen; \`data_filter\` nur bei Rohdaten aus anderen Tools
- \`stock_analysis\` (\`period: "6mo"\`, \`interval: "1d"\`) statt \`stock_price\`; \`company_lookup\` mit \`includeFundamentals: true\`
- **Aktuelle Kurse/Indizes** (z. B. „DAX kurs?“): \`stock_price\` mit \`ticker: "DAX"\` (auch MDAX, SDAX, TecDAX, DivDAX, ^GSPC, Bitcoin — Namen werden automatisch aufgelöst); \`web_search\` nur als Fallback, wenn das Tool keine Kursdaten liefert
- \`calculator\`/\`currency_convert\` für jede Berechnung — kein Kopfrechnen
- \`generate_report\`: max 4 Sektionen à 60 Wörter
- **Verboten:** \`stock_price\` für Research-Berichte (nur Tagesdaten; für Einzelabfragen aktueller Kurse/Indizes ist \`stock_price\` dagegen das richtige Tool), \`web_search\` mit \`maxResults > 5\`, \`url_fetch\` ohne \`maxLength\`/\`selector\`

## 3. WORKFLOW (für Research-Aufgaben; Schritte 2 und 4 nur wenn nötig)
1. **SEARCH** → \`ddg_web_search\`/\`web_search\`/\`news_search\` (max 3 Ergebnisse; bereits dedupliziert nach URL und auf 5 begrenzt — \`data_filter\` danach ist überflüssig)
2. **FETCH** → \`url_fetch\` (nur 1–2 beste URLs, max 2000 Zeichen, article-selector)
3. **SUMMARIZE** → \`text_summarize\` (max 80 Wörter) NUR bei Fetch-Text > 1500 Zeichen
4. **SYNTHESIZE** → direkter Antworttext ODER \`generate_report\` (max 4 Sektionen à 60 Wörter)
5. **CITE** → Quellen-Array: \`[{"title": "", "url": "", "source": "", "date": ""}]\`

## 4. RESPONSE FORMAT
**Kern-Ergebnis** (3–5 Bulletpoints: Fakt/Zahl/Schlussfolgerung) → optional **Datentabelle** (Metrik | Wert | Quelle) → **Unsicherheiten/Gaps** (fehlende Daten, Annahmen) → **Quellen** als \`[S1] Titel – URL – Quelle – Datum\`. Fakten von Analyse trennen; Spekulation nur mit \`💡 Annahme:\`.

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
  private maxToolCallsPerTurn = 4;
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
    currentUserMessage?: string,
    callbacks: ChatOrchestratorCallbacks = NOOP_CALLBACKS
  ): Promise<void> {
    this.abortController = new AbortController();
    this.toolCallCount = 0;
    this.processedToolCalls = new Set();
    // maxToolSteps comes from the UI/settings as a NUMBER, but sessions or
    // settings persisted by older builds (or hand-edited configs) can carry it
    // as a string. `for (step < "10")` with a numeric step silently never
    // iterates — every message would then skip the agent loop entirely.
    // Coerce defensively so the loop always sees a real number.
    this.maxToolSteps = Number(settings.maxToolSteps) || 20;

    // Add user message (via immutable helper so React state updates and the
    // final persistence below always see the same, up-to-date session).
    // `currentUserMessage` is optional: resumeTurn() reuses the existing session as-is.
    if (currentUserMessage !== undefined) {
      this.appendMessage(session, {
        id: crypto.randomUUID(),
        role: 'user',
        content: currentUserMessage,
        timestamp: Date.now(),
      });
    }

    try {
      const loop = await this.runAgentLoop(settings, session, callbacks, currentUserMessage);
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
    // Same defensive numeric coercion as sendMessage() — a string maxToolSteps
    // would make the agent loop never iterate.
    this.maxToolSteps = Number(settings.maxToolSteps) || 20;

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
    callbacks: ChatOrchestratorCallbacks,
    currentUserMessage?: string
  ): Promise<{ interruption?: { err: any; ctx: Parameters<ChatOrchestrator['persistInterruptedTurn']>[2] } } | void> {
    // user_memory (docs/fehlende-tools-mehr-macht.md Phase 1): the persisted
    // memory block is appended to the system prompt once per turn — every
    // step of the agent loop reuses this message array, so memories ride
    // along on all provider calls without extra DB hits. buildMemoryPrompt
    // caps the block size itself (token budget), failures must never break
    // a chat turn, hence the try/catch.
    let systemContent = SYSTEM_PROMPT;
    try {
      const memBlock = await buildMemoryPrompt();
      if (memBlock) systemContent = `${SYSTEM_PROMPT}\n\n${memBlock}`;
    } catch { /* memory is best-effort */ }
    const messages = this.buildProviderMessages(session.messages, systemContent);
    // Token saving: the tool catalogue (~31 tools ≈ 7k prompt tokens) is
    // billed on EVERY provider call. Select only tools relevant to the
    // current question plus a small core set (web search + url fetch), so a
    // simple fact question doesn't pay for the entire registry. When the
    // model asks for an unselected tool later in the turn, the catalogue is
    // widened once (see the tool-call branch below).
    // The CURRENT user message must win: on resumeTurn() no new user message
    // is appended, and a plain "last user message" lookup would then pick up
    // an older query from the history — selecting the wrong tools and even
    // applying that stale turn's simple-fact budget to the resumed task.
    // Fallback for resumeTurn(): the ORIGINAL request is still identifiable
    // because the replayed interrupted assistant message carries its tool
    // calls — derive the query from those call arguments instead of guessing
    // from arbitrary earlier user messages.
    const lastUserQuery = (() => {
      if (typeof currentUserMessage === 'string' && currentUserMessage.trim()) return currentUserMessage;
      const resumedToolCalls = [...session.messages].reverse()
        .find(m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)?.toolCalls;
      if (resumedToolCalls) {
        const q = resumedToolCalls.map(c => c.arguments?.query).find(v => typeof v === 'string' && v);
        if (q) return q as string;
      }
      return [...session.messages].reverse().find(m => m.role === 'user')?.content ?? '';
    })();
    // Simple fact question → cheap runtime path (see SIMPLE_QUERY_TOOL_BUDGET):
    // one search at most, and after it the model MUST answer from the result —
    // never from its stale training data. Complex queries keep the full budget.
    const simpleFactTurn = isSimpleFactQuery(lastUserQuery);
    const effectiveToolBudget = simpleFactTurn ? SIMPLE_QUERY_TOOL_BUDGET : this.maxToolCallsPerTurn;
    let tools = toolRegistry.getToolDefinitionsForLLM(lastUserQuery);
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
    // Number of provider calls made inside the agent loop (0-based index of
    // the NEXT call). Needed to recognise the dedicated synthesis round-trip:
    // it is always the FIRST call made after a step that exhausted the budget.
    let providerCallIndex = 0;
    // Deduplicate tool calls by (name + arguments): models often repeat the
    // exact same call across steps, which wastes both execution time and
    // prompt tokens for the duplicated results.
    // NOTE: this is a Map signature -> real call id, NOT a plain Set: when an
    // identical call was already executed, the skip message must still be
    // keyed to the CURRENT call's protocol id (see the dedup branch below).
    const seenToolSignatures = new Map<string, string>();
    // Signature cache for CROSS-STEP duplicates: signature -> the compacted
    // JSON payload of the producing call's result (WITHOUT the note field).
    // The per-turn `seenToolSignatures` map only knows WHICH call produced a
    // result; this cache stores the ready-to-send body so a duplicate can be
    // answered immediately — in the very step it appears in — without paying
    // for a re-execution or an extra round-trip. Filled right after each
    // executed result is compacted (see the execution loop), which also
    // removes the double stringify/re-compact the old replay path performed.
    const dedupPayloadCache = new Map<string, string>();
    // Protocol ids whose EXECUTED result must additionally be announced to the
    // model as a cached replay ("identical call skipped – cached result").
    // Two producers land here:
    //  - intra-step siblings: several identical calls in ONE batch share a
    //    single execution; every non-producer gets this id via the dedup
    //    branch below and must see the real value keyed to its own call id;
    //  - cross-step duplicates: filled when a duplicate from an EARLIER step
    //    is finally promoted into the conversation (see the promotion pass
    //    after the budget trim) — the replay then keys to the duplicate's id.
    const replaySourceIds = new Set<string>();
    // Cross-step duplicate replies detected during the prepare loop, buffered
    // per STEP until it is clear the duplicate's tool_call stays in the
    // conversation (the budget trim may drop the announcement — Groq rejects a
    // tool response without a preceding tool_call with a 400). Turn-level, not
    // step-level: a duplicate detected in step N must be promoted at the end
    // of step N, even when that step executes NO tools itself (otherwise its
    // assistant message would carry an unmatched tool_call into the next
    // prompt — broken protocol).
    const pendingDedupByStep = new Map<number, { callId: string; signature: string }[]>();
    // One retry is allowed when a model returns a completely empty reply
    // (no text, no tools) before anything was accomplished this turn.
    let emptyRetryUsed = false;
    // Pre-allocated messages for the mandatory synthesis round-trip that runs
    // once the per-turn tool budget is exhausted. The loop sets these when the
    // budget trips and BREAKS immediately: the synthesis call below consumes
    // them as the final prompt. Without this, the next loop iteration would
    // run a full extra tool-enabled round-trip whose tool calls all get
    // budget-skipped — a wasted step that re-bills the entire history and
    // (as regression-tested) also answered duplicate calls with a bare hint
    // instead of the cached result.
    let synthMessages: ProviderMessage[] | null = null;

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

      providerCallIndex++;
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
      // Protocol ids of the calls that pass validation and are queued for
      // execution in THIS step — BEFORE the budget trim shrinks the queue.
      // The deferred-dedup charge below must only count duplicates whose
      // producing call ran in an EARLIER step; a duplicate whose producer is
      // queued here shares one execution with it and the whole group is
      // charged once via `usedBudget` at the end of the step. Using
      // `pendingCalls` for that check instead of this set is wrong whenever
      // the trim drops the producer from the queue (budget-skipped producers
      // were never executed, so their duplicates must be charged).
      const queuedCallIds = new Set<string>();
      // Cross-step duplicates detected in THIS step (step-scoped view of the
      // turn-level `pendingDedupByStep` buffer): their tool messages are
      // pushed after the parallel execution so they can replay the cached
      // result. Intra-step siblings never land here — their producer executes
      // in this very step and is answered right after the execution loop.
      const deferredDedupReplies: { callId: string; signature: string }[] = [];
      pendingDedupByStep.set(step, deferredDedupReplies);
      // Protocol ids of invalid/garbage calls. They were already charged to
      // `toolCallCount` individually when detected (so the budget trim right
      // after the prepare loop sees them); the step-end accounting must not
      // count them a second time.
      const invalidCallIds = new Set<string>();

      for (const { raw: tc, id: preallocatedId } of resolvedToolCalls) {
        const callId = preallocatedId;
        turnCallIndex++;

        // Prevent duplicate execution. The id was just minted for THIS step's
        // assistant message, so a repeat id means the provider emitted a
        // broken/duplicated delta — answering it with a tool message would put
        // TWO tool responses under one tool_call into the prompt and Groq
        // rejects that with a 400 ("tool message without preceding tool
        // call"). Such calls are dropped from the assistant message as well
        // (see the retainedReplyIds filter below); the original call of that
        // id was already charged when it was prepared, so this stray repeat
        // consumes no additional budget.
        if (this.processedToolCalls.has(callId)) {
          continue;
        }
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
          // Garbage calls still consumed a round-trip → charge the budget so a
          // model that keeps emitting broken payloads cannot loop past the
          // per-turn cap until maxToolSteps. The id was already added to
          // `processedToolCalls` above, so the step-end accounting must NOT
          // count this call again — it is tracked in `invalidCallIds` and
          // subtracted there.
          invalidCallIds.add(callId);
          this.toolCallCount++;
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              error: !toolName
                ? 'Ungültiger Tool-Aufruf: Der Tool-Name fehlt. Verfügbare Tools: ' + toolRegistry.getEnabledToolIds().join(', ')
                : malformedArgs && toolName
                  ? `Ungültige bzw. unvollständige Argumente für "${toolName}" (JSON konnte nicht geparst werden). Rufe das Tool erneut mit vollständigem JSON-Arguments-Objekt auf.`
                  : 'Ungültiger (leerer) Tool-Aufruf ohne Name und Argumente – ignoriert.',
            }),
            tool_call_id: callId,
          });
          continue;
        }

        // Catalogue widening: the per-turn tool selection is keyword-based and
        // can miss a tool the model legitimately needs (it only saw a subset
        // of the registry in this request). If the requested tool EXISTS but
        // was not offered, execute it anyway — refusing would waste a step and
        // force a re-search — and widen the catalogue for the remaining calls
        // of this turn so no further round-trip is needed.
        if (tools.length > 0 && !tools.some(t => t.name === toolName)) {
          if (toolRegistry.getTool(toolName)) {
            tools = toolRegistry.getToolDefinitionsForLLM();
          }
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
        // The signature maps to the id of the call that PRODUCED the result,
        // so a duplicate gets the original answer back instead of just a
        // "was returned earlier" hint the model cannot act on — that hint
        // made many models re-issue the same call anyway (the dedup only
        // saved execution time, not prompt tokens). Replaying the compacted
        // result costs nothing extra and lets the model proceed immediately.
        // Cross-step duplicates are NOT re-executed and must not linger in the
        // message list as tool replies for calls the model may never see
        // again: when the budget trips in this very step, the duplicate's
        // announcement is trimmed below (Groq rejects a tool response without
        // a preceding tool_call with a 400). Buffer the replay here and push
        // it into `messages` only once it is clear the duplicate's tool_call
        // stays in the conversation (see budgetExhausted branch at the end of
        // this step).
        const signature = `${toolName}:${JSON.stringify(toolArgs)}`;
        const priorCallId = seenToolSignatures.get(signature);
        if (priorCallId !== undefined) {
          // Intra-step sibling: the producer is queued for execution in THIS
          // very step. Its real result will be replayed right after the
          // parallel execution below — no turn-level buffering needed, and no
          // extra budget charge (the whole group counts once via `usedBudget`).
          if (queuedCallIds.has(priorCallId)) {
            replaySourceIds.add(callId);
          } else {
            // Cross-step duplicate: the producer ran in an EARLIER step, so
            // the compacted payload is already in `dedupPayloadCache`. Buffer
            // the reply at TURN level keyed by step: it gets promoted into
            // `messages` at the end of this step once it is clear the
            // duplicate's tool_call survives the budget trim (a tool response
            // without a preceding tool_call is rejected by Groq with a 400).
            deferredDedupReplies.push({ callId, signature });
            // Charge the duplicate against the per-turn budget ONLY when the
            // producer was actually EXECUTED (its compacted payload is cached)
            // or when its announcement will be dropped by the budget trim
            // anyway (budget already spent before this step). A duplicate of
            // a call that is still PENDING in this step's queue shares that
            // single execution — charging it here would trip the budget after
            // half as many real executions as configured. The pending case is
            // settled after the trim below (see the dedupCharge loop).
            const producerPending = pendingCalls.some(c => c.id === priorCallId);
            if (!producerPending || this.toolCallCount >= effectiveToolBudget) {
              this.toolCallCount++;
            }
          }
          continue;
        }
        seenToolSignatures.set(signature, callId);

        queuedCallIds.add(callId);
        pendingCalls.push(toolCall);
      }

      // Hard runtime cap on executed tool calls per turn (the prompt only
      // advises ≤3 — every extra call re-bills the whole history as prompt
      // tokens). Simple fact questions get a reduced budget of 1. Once the
      // budget is spent, remaining calls are answered via the protocol with a
      // short note and the loop forces a final answer.
      // NOTE: the trimming must happen BEFORE any call is announced via
      // onToolCall: the callback signals actual EXECUTION, so budget-skipped
      // calls must never be reported as started (previously the UI/telemetry
      // showed every queued call as running even though most were skipped).
      // `stepToolMessages` collects every tool reply generated for THIS step
      // (executed results + dedup replays) and is appended to `messages` only
      // after the parallel execution, in original call order (Groq rejects
      // out-of-order tool responses with a 400). `stepToolMessagesByCall`
      // keeps each reply addressable by its protocol id so the budget-trim
      // below can remove exactly the messages of dropped calls while
      // preserving the original ordering. The map is created BEFORE the trim
      // because budget-skip notes are registered there as well.
      const stepToolMessages: ProviderMessage[] = [];
      const stepToolMessagesByCall = new Map<string, ProviderMessage>();

      const callBudgetLeft = Math.max(0, effectiveToolBudget - this.toolCallCount);
      // Protocol ids of calls trimmed by the per-turn budget. Their "skipped"
      // tool replies stay in the conversation (the announcement stays too —
      // the protocol needs one reply per announced call), and the step-end
      // accounting must count them exactly once via this set: they were never
      // charged individually above, and `usedBudget` deliberately excludes
      // every non-executed call to avoid the double-counting bug.
      const budgetSkippedIds = new Set<string>();
      if (pendingCalls.length > callBudgetLeft) {
        for (const dropped of pendingCalls.slice(callBudgetLeft)) {
          budgetSkippedIds.add(dropped.id);
          const skipNote: ProviderMessage = {
            role: 'tool',
            content: JSON.stringify({ skipped: 'Tool-Budget für diesen Turn erschöpft. Antworte jetzt mit dem gesammelten Material.' }),
            tool_call_id: dropped.id,
          };
          messages.push(skipNote);
          // Register it like every other reply of this step so the protocol
          // cleanup at the end of the step knows this message belongs to the
          // current assistant announcement (ordering/trim invariant).
          stepToolMessagesByCall.set(dropped.id, skipNote);
          callbacks.onToolResult({ callId: dropped.id, toolId: dropped.toolId, success: false, error: 'Tool-Budget für diesen Turn erschöpft', duration: 0, timestamp: Date.now() });
        }
        pendingCalls.length = callBudgetLeft;
      }

      // Deferred budget charge for cross-step duplicates whose producer was
      // still PENDING in this step's queue when the prepare loop saw them:
      //  - producer executed → the duplicate shares nothing but a cache hit;
      //    it consumed real prompt/budget slots → charge one unit now;
      //  - producer trimmed (budget-skipped) → the duplicate's announcement
      //    and reply are dropped from the final prompt entirely, so charging
      //    would only trip the synthesis earlier than configured → skip.
      for (const dup of deferredDedupReplies) {
        const priorCallId = seenToolSignatures.get(dup.signature);
        if (priorCallId && !budgetSkippedIds.has(priorCallId)) {
          this.toolCallCount++;
        }
      }

      // Announce the surviving calls now that the budget trim is settled.
      for (const c of pendingCalls) callbacks.onToolCall(c);

      if (pendingCalls.length > 0) {
        callbacks.onStatus(
          pendingCalls.length === 1
            ? `Running: ${pendingCalls[0].toolName}...`
            : `Running ${pendingCalls.length} tools in parallel...`
        );

        // Pass the turn's abort signal so a user cancel interrupts running
        // tools immediately instead of letting them burn until maxDuration.
        const results = await Promise.all(
          pendingCalls.map(c => toolRegistry.execute(c, this.abortController?.signal))
        );

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
          // be re-sent as prompt tokens on every remaining agent step).
          // The compacted payload is stringified EXACTLY ONCE here and cached
          // per signature — cross-step duplicates replay that ready-to-send
          // body without a second compact+stringify pass over the same data.
          const compactedPayload = JSON.stringify(
            result.success ? compactToolData(result.data, COMPACT_RESULT_MAX_STRING, COMPACT_RESULT_MAX_ARRAY) : { error: result.error }
          );
          dedupPayloadCache.set(`${toolCall.toolId}:${JSON.stringify(toolCall.arguments)}`, compactedPayload);
          stepToolMessages.push({
            role: 'tool',
            content: compactedPayload,
            tool_call_id: toolCall.id,
          });

          // NOTE: no per-call `this.toolCallCount++` here. The budget is
          // charged once for the whole step below via
          // `this.toolCallCount += usedBudget` (usedBudget = ALL calls that
          // consumed budget this turn: executed, dedup-skipped and
          // budget-skipped). Incrementing per executed call IN ADDITION made
          // every executed call count TWICE, so the budget tripped after half
          // as many calls as configured — the loop ended prematurely and the
          // synthesis nudge fired too early.
        }
      }

      // Intra-step duplicate siblings: the producing call ran in parallel
      // within THIS step, so its compacted result is now in
      // `dedupPayloadCache` — replay it keyed to the sibling's own protocol
      // id (the tool-call protocol needs one reply per announced call). The
      // payload was already stringified once at execution time; only the
      // cache note is appended here (no second compact+stringify pass).
      // Fallback note keeps the protocol valid even if the producing call
      // itself failed before storing a result.
      const stepReplayIds = [...replaySourceIds];
      replaySourceIds.clear();
      for (const dupCallId of stepReplayIds) {
        const producer = resolvedToolCalls.find(({ raw, id }) => id === dupCallId);
        let dupName = (producer?.raw.function?.name || producer?.raw.name || '').trim();
        let dupArgs: Record<string, any> = {};
        try {
          const argsStr = producer?.raw.function?.arguments || producer?.raw.arguments || '{}';
          dupArgs = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
        } catch { /* signature miss → fallback note below */ }
        const signature = `${dupName}:${JSON.stringify(dupArgs)}`;
        const cached = dedupPayloadCache.get(signature);
        const reply: ProviderMessage = {
          role: 'tool',
          content: cached !== undefined
            ? `${cached.slice(0, -1)},"note":"identical call skipped – cached result from earlier in this turn"}`
            : JSON.stringify({ skipped: 'duplicate call', note: 'Identical result was returned earlier in this conversation turn.' }),
          tool_call_id: dupCallId,
        };
        stepToolMessages.push(reply);
        stepToolMessagesByCall.set(dupCallId, reply);
      }

      // PROMOTION PASS: cross-step duplicates detected during THIS step's
      // prepare loop were only BUFFERED (see the dedup branch) — push their
      // replays now, after the executed results of this step have been added
      // to `dedupPayloadCache` above. The order matters for the budget math:
      //  - budget still available → every duplicate's tool_call stays in the
      //    conversation, so its replay must be promoted into `messages` right
      //    away; the NEXT provider call then sees the cached value keyed to
      //    the duplicate's own id instead of a bare "returned earlier" hint;
      //  - budget exhausted → the final prompt is assembled as a filtered
      //    COPY (synthMessages below) that drops both the announcement and
      //    the reply of every non-executed call (Groq rejects a tool response
      //    without a preceding tool_call with a 400). Promoting first is
      //    harmless: the copy filter simply leaves those ids out.
      pendingDedupByStep.delete(step);
      for (const dup of deferredDedupReplies) {
        const cached = dedupPayloadCache.get(dup.signature);
        messages.push({
          role: 'tool',
          content: cached !== undefined
            ? `${cached.slice(0, -1)},"note":"identical call skipped – cached result from earlier in this turn"}`
            : JSON.stringify({ skipped: 'duplicate call', note: 'Identical result was returned earlier in this conversation turn.' }),
          tool_call_id: dup.callId,
        });
      }

      // Budget exhausted: force synthesis in the NEXT provider call. Without
      // this nudge the model tends to emit yet another tool-call step that
      // gets fully skipped — a wasted round-trip billing the whole history.
      // Charge EXACTLY ONE budget unit per distinct signature that consumed
      // budget this step. Categories:
      //  - queued groups (executed OR budget-skipped after the trim): each
      //    unique signature counts ONCE — several identical calls answered
      //    from one execution must not multiply the charge, and a group whose
      //    producer was trimmed still consumed a budget slot;
      //  - cross-step dedup hits: charged individually in the prepare loop
      //    (their producer's signature is no longer in this step's queue);
      //  - invalid/garbage calls: charged individually (`invalidCallIds`);
      //  - provider-duplicate ids: never charged (the original call of that
      //    id was billed when it was prepared).
      // Counting `resolvedToolCalls.length` instead (the old formula) charged
      // invalid and duplicate-id calls TWICE and treated every deferred dedup
      // as free even when its producing call ran in an earlier step — so the
      // budget tripped at the wrong moment and valid protocol replies were
      // trimmed away.
      let usedBudget = budgetSkippedIds.size;
      for (const c of pendingCalls) {
        if (seenToolSignatures.get(`${c.toolId}:${JSON.stringify(c.arguments)}`) === c.id) usedBudget++;
      }
      this.toolCallCount += usedBudget;
      const budgetExhausted = this.toolCallCount >= effectiveToolBudget;
      if (budgetExhausted) {
        // Protocol invariant for the FINAL/synthesis prompt: every tool_call
        // announced in the assistant message needs exactly one matching tool
        // message — and no tool message may exist for a call that was never
        // announced. Calls that got NO reply at all (dedup replays buffered
        // for deletion, provider-duplicate ids, garbage calls whose error
        // reply is removed below) must also lose their announcement; calls
        // that keep their reply (executed results, budget-skipped notes) keep
        // the announcement too. Everything else disappears from the final
        // prompt — the model answers from the executed results plus the
        // nudge below (a stray or unmatched tool message is rejected by Groq
        // with a 400).
        //
        // IMPORTANT: the cleanup must NOT splice into `messages` itself. The
        // buffered cross-step dedup replays were deliberately never pushed on
        // this path, so every announcement that lost its reply is exactly one
        // of those duplicates — instead of deleting messages in place (which
        // also forced this whole scan), the final/synthesis prompt is built as
        // a filtered COPY: all history up to (and including) the assistant
        // announcement WITHOUT the dropped tool_calls, followed by every tool
        // reply of this step that survived (executed results + budget-skip
        // notes), followed by the nudge. Older history already satisfies the
        // invariant and is copied verbatim — no O(n) rescanning, no mutation.
        const retainedReplyIds = new Set<string>([
          ...pendingCalls.map(c => c.id),   // executed → real result pushed
          ...budgetSkippedIds,              // trimmed → "skipped" note pushed
        ]);
        assistantMsg.tool_calls = (assistantMsg.tool_calls || []).filter(
          (c: any) => retainedReplyIds.has(c.id) || invalidCallIds.has(c.id)
        );
        // Replies of THIS step that belong in the final prompt: only executed
        // results and budget-skip notes. Buffered dedup replays (in
        // `stepToolMessagesByCall` but not retained) stay out; garbage-call
        // error notes keep their (now empty-announcement) slot ONLY if the id
        // is still announced — invalid calls were filtered above via
        // `invalidCallIds`, so their replies must ride along too.
        const finalStepReplies = stepToolMessages.filter(m =>
          m.tool_call_id !== undefined &&
          (retainedReplyIds.has(m.tool_call_id) || invalidCallIds.has(m.tool_call_id))
        );
        synthMessages = [
          // Everything before this step's assistant announcement, untouched.
          ...messages.slice(0, messages.indexOf(assistantMsg)),
          // The (possibly trimmed) announcement itself.
          assistantMsg,
          // Every surviving tool reply of this step, in original call order.
          ...finalStepReplies,
          // Budget-skip notes live directly in `messages` (pushed at trim
          // time), not in stepToolMessages — include the ones that survived.
          ...messages
            .slice(messages.indexOf(assistantMsg) + 1)
            .filter(m => m.role === 'tool' && m.tool_call_id && budgetSkippedIds.has(m.tool_call_id)),
        ];
        synthMessages.push({
          role: 'user',
          content: simpleFactTurn
            ? 'Keine weiteren Tools erlaubt. Antworte JETZT kurz (1–3 Sätze) direkt auf die Nutzerfrage — ausschließlich anhand des Suchergebnisses oben, NICHT anhand deines Trainingswissens. Zitiere die Quelle als URL. Falls das Suchergebnis einen Fehler enthält, sage das in einem Satz und gib keine unbestätigte Antwort.'
            : 'Tool-Budget erschöpft. Erstelle JETZT die finale Antwort aus dem gesammelten Material (inkl. Quellen-Array); keine weiteren Tool-Aufrufe.',
        });
      }

      // NOTE: `fullContent` must NOT be reset here. It accumulates every
      // completed step of the turn (streamed planning text + final answer) so
      // that the max-steps fallback message below contains all prior output,
      // and an interrupted turn persists its progress instead of losing it.

      if (lastStepContent.trim().length > 0) {
        this.partialContent = lastStepContent;
      }

      // If the budget nudge above was injected, give the model exactly ONE
      // more call to synthesize its final answer. Previously the loop kept
      // iterating until `maxToolSteps` even though no further tool could
      // execute — every remaining step re-billed the entire history as prompt
      // tokens for answers that would then be discarded by the max-steps
      // fallback. With the typical settings (maxToolSteps 20, budget 4) a
      // single question could burn ~16 pointless round-trips.
      if (budgetExhausted) {
        callbacks.onStatus('Synthesizing final answer...');
        let finalContent = '';
        try {
          const result = await callProvider(
            settings,
            // The pre-allocated synthesis prompt (see the budgetExhausted
            // branch above): a filtered COPY of the conversation in which
            // every tool_call announcement matches exactly one tool reply.
            // `messages` itself stays untouched — no splicing, and the loop
            // BREAKS right after this call so the stale list is never reused.
            synthMessages ?? [...messages],
            undefined, // no tools offered — the model MUST answer from collected material
            {
              onToolCall: () => {}, // tools are not offered in the synthesis call
              onToken: (token: string) => {
                finalContent += token;
                this.partialContent += token;
                callbacks.onToken(token);
              },
              onComplete: (_content: string, usage: any) => {
                totalTokens += usage.totalTokens;
              },
              onError: (err: Error) => {
                callbacks.onError(err.message);
              },
              onBudgetWait: (waitMs, waitedMs) => {
                const secs = Math.max(1, Math.round(waitMs / 1000));
                const waited = Math.round(waitedMs / 1000);
                callbacks.onStatus(
                  `Token-Limit erreicht – warte auf Budget (${secs}s${waited > 0 ? `, wartet seit ${waited}s` : ''})…`
                );
              },
              onModelSwitch: (modelId, provider, attempt) => {
                if (attempt > 1) {
                  finalContent = '';
                  this.partialContent = '';
                }
                currentModel = modelId;
                currentProvider = provider;
              },
            },
            this.abortController?.signal
          );
          currentModel = result.model;
          currentProvider = result.provider;
          // The streamed text already accumulated in `finalContent`; prefer it
          // over `result.content` only if streaming delivered something (both
          // should match — this guards against providers that report content
          // without forwarding tokens).
          const answerText = finalContent || result.content;
          if (answerText.trim().length > 0) {
            fullContent += (fullContent ? '\n\n' : '') + answerText;
          }
        } catch (err: any) {
          if (err.name === 'AbortError') throw err;
          // Synthesis failed after the budget was spent: persist everything
          // accomplished so far as a resumable interrupted turn instead of
          // letting the outer catch discard the progress silently.
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
        // Final answer produced — end the turn immediately.
        const finalMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: fullContent,
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
        callbacks.onStatus('Complete');
        return;
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
        content: JSON.stringify(r.success ? compactToolData(r.data, COMPACT_RESULT_MAX_STRING, COMPACT_RESULT_MAX_ARRAY) : { error: r.error }),
        tool_call_id: c.id,
      });
    }
  }

  private buildProviderMessages(chatMessages: ChatMessage[], systemContent: string = SYSTEM_PROMPT): ProviderMessage[] {
    const messages: ProviderMessage[] = [
      { role: 'system', content: systemContent },
    ];

    // History tool calls/results are NOT replayed into follow-up prompts: the
    // assistant's final answer already summarises them, and every retained
    // tool result is re-sent as prompt tokens on EVERY provider call —
    // including all follow-up steps of the agent loop. Dropping them keeps a
    // new question cheap even after a tool-heavy previous turn (the model can
    // simply re-run a tool if it truly needs fresh data).
    for (const msg of chatMessages) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
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
    const MAX_HISTORY_TOKENS = 8000; // ~ chars/4 estimate — comfortably below even small free-model windows (32k) once the tool catalogue (~2k tokens) is added on top
    let total = 0;
    const sizes = messages.map(m => {
      // Tool-call payloads count toward the prompt too — previously only
      // `content` was measured, so truncation could still ship an oversized
      // prompt when history carried tool calls.
      let chars = m.content?.length || 0;
      if (m.tool_calls) {
        try { chars += JSON.stringify(m.tool_calls).length; } catch { /* ignore */ }
      }
      total += chars;
      return chars;
    });
    let start = 0;
    // Always keep the system message (index 0) and at least the last message.
    while (total > MAX_HISTORY_TOKENS && start < messages.length - 2) {
      total -= sizes[start + 1];
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
