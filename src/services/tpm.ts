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
    this.budget.globalLimit = settings.globalTpmLimit;
    if (settings.perProviderLimits) {
      for (const [provider, limit] of Object.entries(settings.perProviderLimits)) {
        this.budget.perProvider[provider] = { used: 0, limit };
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

  async reserve(provider: string, tokens: number, settings: AppSettings): Promise<boolean> {
    this.cleanWindow();
    
    const totalNeeded = this.budget.usedInWindow + this.budget.reserved + tokens;
    
    // Check global limit
    if (totalNeeded > this.budget.globalLimit) {
      return false;
    }
    
    // Check per-provider limit
    const providerLimit = this.budget.perProvider[provider];
    if (providerLimit) {
      const providerTotal = providerLimit.used + tokens;
      if (providerTotal > providerLimit.limit) {
        return false;
      }
    }
    
    // Check per-request limit
    if (tokens > settings.maxTokensPerRequest * 2) {
      return false;
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
    
    return true;
  }

  recordUsage(provider: string, tokens: number): void {
    this.usageLog.push({
      provider,
      tokens,
      timestamp: Date.now(),
    });
  }

  releaseReservation(provider: string): void {
    // Release oldest reservation for this provider
    for (const [id, res] of this.reservations) {
      if (res.provider === provider) {
        this.reservations.delete(id);
        this.budget.reserved -= res.tokens;
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
