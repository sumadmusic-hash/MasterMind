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
  }

  private cleanWindow(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Clean old usage entries
    this.usageLog = this.usageLog.filter(u => u.timestamp >= windowStart);
    
    // Recalculate
    this.budget.usedInWindow = this.usageLog.reduce((sum, u) => sum + u.tokens, 0);
    this.budget.windowStart = windowStart;
    
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
  }

  releaseReservation(_provider: string, reservationId?: string): void {
    // Prefer the exact reservation id when available.
    if (reservationId) {
      const res = this.reservations.get(reservationId);
      if (res) {
        this.reservations.delete(reservationId);
        this.budget.reserved = Math.max(0, this.budget.reserved - res.tokens);
      }
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
  }

  getBudget(): TokenBudget {
    this.cleanWindow();
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
}

export const tpmManager = new TokenPerMinuteManager();
