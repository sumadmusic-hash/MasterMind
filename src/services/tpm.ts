import type { AppSettings, TokenBudget } from '../types';

interface Reservation {
  id: string;
  provider: string;
  tokens: number;
  timestamp: number;
}

class TokenPerMinuteManager {
  private budget: TokenBudget;
  private reservations: Map<string, Reservation> = new Map();
  private usageLog: { provider: string; tokens: number; timestamp: number }[] = [];
  private windowMs = 60000; // 60 seconds
  // Lightweight change notification so the UI can re-render ONLY when the
  // displayed budget numbers actually changed (instead of a fixed 2s poll
  // that forced every context consumer to re-render around the clock).
  private listeners = new Set<(budget: TokenBudget) => void>();
  private lastSignature = '';

  private signature(): string {
    return `${this.budget.globalLimit}|${this.budget.usedInWindow}|${this.budget.reserved}`;
  }

  private notifyIfChanged(): void {
    const sig = this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    const snapshot = this.getBudget();
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: (budget: TokenBudget) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Estimate how long until `tokens` more tokens become available in the
   * rolling window — used to compute a smart sleep interval while waiting,
   * instead of busy-polling. If nothing is currently in flight, the full
   * 60s window must elapse before usage drops off; otherwise we wait for
   * the oldest in-flight entries to age out and re-check.
   */
  private estimateWaitMs(tokens: number): number {
    // usageLog is a plain array — iterate it directly (Map-style `.values()`
    // on an array yields the *index keys* "0","1",… as strings, so every
    // `entry.tokens` below was undefined and the estimate silently degraded
    // to a fixed full-window wait).
    const inflight = [...this.usageLog].sort((a, b) => a.timestamp - b.timestamp);
    if (inflight.length === 0) return this.windowMs;
    // Walk oldest-first until enough tokens would be freed by aging out
    let freed = 0;
    for (const entry of inflight) {
      freed += entry.tokens;
      if (freed >= tokens) {
        const remaining = Math.max(1000, entry.timestamp + this.windowMs - Date.now());
        return Math.min(remaining, this.windowMs);
      }
    }
    return this.windowMs;
  }

  /**
   * Reserve tokens, WAITING until the budget frees up instead of failing.
   * This is what lets a task that exceeds the tokens-per-minute limit still
   * get processed: the request simply pauses until the sliding window has
   * enough room. Already-completed work (prior agent steps, streamed text)
   * lives in the caller's state and is never discarded while waiting.
   *
   * Resolves with the reservation id as soon as the tokens can be reserved,
   * or `null` when:
   *  - `waitTimeoutMs` elapses without the budget freeing up, or
   *  - the request is fundamentally too large for the configured limits
   *    (waiting would never help), or
   *  - the abort signal fires while waiting.
   *
   * `onWait` is invoked before each pause with the estimated retry delay so
   * the UI can show "Waiting for token budget..." instead of appearing stuck.
   */
  async reserveAndWait(
    provider: string,
    tokens: number,
    settings: AppSettings,
    opts: { waitTimeoutMs?: number; onWait?: (waitMs: number, waitedMs: number) => void; signal?: AbortSignal } = {}
  ): Promise<string | null> {
    const waitTimeoutMs = opts.waitTimeoutMs ?? settings.tpmWaitTimeoutMs ?? 300000;

    // Fast path: budget is free right now.
    const immediate = await this.reserve(provider, tokens, settings);
    if (immediate) return immediate;

    // NOTE: Do NOT release any reservation here. A failed `reserve()` never
    // creates a reservation of its own, so there is nothing of ours to clean
    // up. Releasing the oldest reservation of this provider would steal the
    // pending budget of a *different*, in-flight request and corrupt the
    // reserved-tokens counter (allowing more traffic than the limit permits).

    // Distinguish "temporarily full" from "never fits": if even an empty
    // window couldn't accommodate this request, waiting is pointless.
    const perProviderLimit = this.budget.perProvider[provider]?.limit;
    const impossible =
      tokens > this.budget.globalLimit ||
      (perProviderLimit !== undefined && tokens > perProviderLimit) ||
      tokens > settings.maxTokensPerRequest * 2;
    if (impossible) return null;

    if (waitTimeoutMs <= 0) return null;

    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return null;

      const waitMs = Math.min(this.estimateWaitMs(tokens), deadline - Date.now());
      opts.onWait?.(Math.max(0, waitMs), Date.now() - (deadline - waitTimeoutMs));

      await new Promise<void>(resolve => {
        const timer = setTimeout(finish, Math.max(250, waitMs));
        function finish() {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', finish);
          resolve();
        }
        opts.signal?.addEventListener('abort', finish, { once: true });
      });

      if (opts.signal?.aborted) return null;

      const attempt = await this.reserve(provider, tokens, settings);
      if (attempt) return attempt;
    }
    return null;
  }

  constructor() {
    this.budget = {
      globalLimit: 100000,
      usedInWindow: 0,
      windowStart: Date.now(),
      windowDuration: this.windowMs,
      reserved: 0,
      perProvider: {},
    };
  }

  configure(settings: AppSettings): void {
    let budgetChanged = this.budget.globalLimit !== settings.globalTpmLimit;
    this.budget.globalLimit = settings.globalTpmLimit;

    // Determine which providers should have limits per current settings
    const nextLimits = settings.perProviderLimits ?? {};
    const nextProviders = new Set(Object.keys(nextLimits));

    // Remove stale entries (providers no longer configured); keep usage for the rest
    for (const provider of Object.keys(this.budget.perProvider)) {
      if (!nextProviders.has(provider)) {
        delete this.budget.perProvider[provider];
        budgetChanged ||= true;
      }
    }

    // Add or update per-provider limits without wiping tracked usage
    for (const [provider, limit] of Object.entries(nextLimits)) {
      const existing = this.budget.perProvider[provider];
      if (existing) {
        if (existing.limit !== limit) {
          existing.limit = limit;
          budgetChanged ||= true;
        }
      } else {
        this.budget.perProvider[provider] = { used: 0, limit };
        budgetChanged ||= true;
      }
    }

    // If any limit changed, drop accumulated reservations/usage so the new
    // budget applies cleanly instead of being blocked by stale state.
    if (budgetChanged) {
      this.reservations.clear();
      this.budget.reserved = 0;
      this.usageLog = [];
      this.budget.usedInWindow = 0;
      this.budget.windowStart = Date.now();
      for (const provider of Object.keys(this.budget.perProvider)) {
        this.budget.perProvider[provider].used = 0;
      }
    }
    this.notifyIfChanged();
  }

  private cleanWindow(): void {
    const now = Date.now();
    // Sliding-window cutoff: keep every usage entry younger than 60s. NOTE:
    // the cutoff must NOT be written into budget.windowStart — that field is
    // display metadata for a fixed window and would otherwise jump forward on
    // every call (windowStart > timestamps of retained entries).
    const cutoff = now - this.windowMs;

    // Clean old usage entries
    this.usageLog = this.usageLog.filter(u => u.timestamp >= cutoff);

    // Recalculate
    this.budget.usedInWindow = this.usageLog.reduce((sum, u) => sum + u.tokens, 0);
    
    // Clean expired reservations (older than 30 seconds)
    for (const [id, res] of this.reservations) {
      if (now - res.timestamp > 30000) {
        this.reservations.delete(id);
        this.budget.reserved -= res.tokens;
      }
    }
    
    // Recalculate per-provider usage
    for (const provider of Object.keys(this.budget.perProvider)) {
      this.budget.perProvider[provider].used = this.usageLog
        .filter(u => u.provider === provider)
        .reduce((sum, u) => sum + u.tokens, 0);
    }
  }

  /**
   * Reserve tokens for an upcoming request. Returns the reservation id on
   * success, or `null` when the budget (global / per-provider / per-request)
   * would be exceeded. The caller MUST eventually either confirm the actual
   * usage via `recordUsage(..., reservationId)` or free the reservation via
   * `releaseReservation(provider, reservationId)` — otherwise the reserved
   * tokens would be double-counted until they expire.
   */
  async reserve(provider: string, tokens: number, settings: AppSettings): Promise<string | null> {
    // Keep limits in sync with the latest settings (also prunes stale provider entries)
    this.configure(settings);
    this.cleanWindow();

    const totalNeeded = this.budget.usedInWindow + this.budget.reserved + tokens;

    // Check global limit
    if (totalNeeded > this.budget.globalLimit) {
      return null;
    }

    // Check per-provider limit (include pending reservations for this provider)
    const providerLimit = this.budget.perProvider[provider];
    if (providerLimit) {
      let reservedForProvider = 0;
      for (const res of this.reservations.values()) {
        if (res.provider === provider) reservedForProvider += res.tokens;
      }
      const providerTotal = providerLimit.used + reservedForProvider + tokens;
      if (providerTotal > providerLimit.limit) {
        return null;
      }
    }

    // Check per-request limit
    if (tokens > settings.maxTokensPerRequest * 2) {
      return null;
    }

    // Reserve
    const id = crypto.randomUUID();
    this.reservations.set(id, {
      id,
      provider,
      tokens,
      timestamp: Date.now(),
    });
    this.budget.reserved += tokens;
    this.notifyIfChanged();

    return id;
  }

  /**
   * Record actual usage AND release the matching reservation in one step.
   * Previously the reservation was never released on success, so its tokens
   * were counted twice (once as `reserved`, once via the usage log) until the
   * 30s expiry cleanup kicked in — throttling the budget far too aggressively.
   */
  recordUsage(provider: string, tokens: number, reservationId?: string): void {
    this.usageLog.push({
      provider,
      tokens,
      timestamp: Date.now(),
    });

    if (reservationId) {
      const res = this.reservations.get(reservationId);
      if (res) {
        this.reservations.delete(reservationId);
        this.budget.reserved = Math.max(0, this.budget.reserved - res.tokens);
      }
    } else {
      // Fallback for callers without a reservation id: release the oldest one
      // for this provider so reserved tokens never leak permanently.
      this.releaseReservation(provider);
    }
    // usedInWindow steigt erst, wenn cleanWindow() den Log neu summiert –
    // hier bereits benachrichtigen, damit das UI die Reservierung sieht.
    this.cleanWindow();
    this.notifyIfChanged();
  }

  releaseReservation(_provider: string, reservationId?: string): void {
    // Prefer the exact reservation id when available.
    if (reservationId) {
      const res = this.reservations.get(reservationId);
      if (res) {
        this.reservations.delete(reservationId);
        this.budget.reserved = Math.max(0, this.budget.reserved - res.tokens);
      }
      this.notifyIfChanged();
      return;
    }
    // Release oldest reservation for this provider
    for (const [id, res] of this.reservations) {
      if (res.provider === _provider) {
        this.reservations.delete(id);
        this.budget.reserved = Math.max(0, this.budget.reserved - res.tokens);
        break;
      }
    }
    this.notifyIfChanged();
  }

  getBudget(): TokenBudget {
    this.cleanWindow();
    // Benachrichtige Listener, falls sich die Anzeige-Werte durch das
    // Zeitfenster-Rolling geändert haben (z. B. abgelaufene Nutzung).
    this.notifyIfChanged();
    return { ...this.budget };
  }

  getRemaining(): number {
    this.cleanWindow();
    return Math.max(0, this.budget.globalLimit - this.budget.usedInWindow - this.budget.reserved);
  }

  getRemainingPercent(): number {
    if (this.budget.globalLimit === 0) return 0;
    return Math.round((this.getRemaining() / this.budget.globalLimit) * 100);
  }

  getUsageHistory(): { provider: string; tokens: number; timestamp: number }[] {
    return [...this.usageLog];
  }

  /**
   * Test/utility hook: drop all recorded usage as if the sliding window had
   * fully elapsed ("wieder geht es" ohne 60s Realtime-Warten). Reservations
   * are kept so in-flight requests stay accounted for.
   */
  clearWindow(): void {
    this.usageLog = [];
    this.budget.usedInWindow = 0;
    this.budget.windowStart = Date.now();
    for (const provider of Object.keys(this.budget.perProvider)) {
      this.budget.perProvider[provider].used = 0;
    }
    this.notifyIfChanged();
  }
}

export const tpmManager = new TokenPerMinuteManager();
