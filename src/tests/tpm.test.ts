import { describe, it, expect, beforeEach } from 'vitest';
import { tpmManager } from '../services/tpm';
import type { AppSettings } from '../types';

const mockSettings: AppSettings = {
  groqApiKey: 'test-key',
  primaryModel: { provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
  globalTpmLimit: 100000,
  maxTokensPerRequest: 4096,
  maxToolSteps: 20,
  maxCallDuration: 120000,
  tpmWaitTimeoutMs: 300000,
  theme: 'dark',
};

describe('TokenPerMinuteManager', () => {
  beforeEach(() => {
    tpmManager.configure(mockSettings);
  });

  it('should initialize with correct budget', () => {
    const budget = tpmManager.getBudget();
    expect(budget.globalLimit).toBe(100000);
    expect(budget.usedInWindow).toBe(0);
  });

  it('should allow reservation within budget', async () => {
    const result = await tpmManager.reserve('groq', 1000, mockSettings);
    // reserve() returns a truthy reservation id on success
    expect(result).toBeTruthy();
  });

  it('should reject reservation exceeding budget', async () => {
    const result = await tpmManager.reserve('groq', 200000, mockSettings);
    // reserve() returns null when the budget would be exceeded
    expect(result).toBeNull();
  });

  it('should track remaining budget', async () => {
    await tpmManager.reserve('groq', 5000, mockSettings);
    const remaining = tpmManager.getRemaining();
    expect(remaining).toBeLessThan(100000);
    expect(remaining).toBeGreaterThan(0);
  });

  it('should calculate remaining percentage', () => {
    const percent = tpmManager.getRemainingPercent();
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it('should record usage', () => {
    tpmManager.recordUsage('groq', 500);
    const history = tpmManager.getUsageHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].tokens).toBe(500);
  });

  it('should handle per-provider limits', async () => {
    const settingsWithProviderLimit: AppSettings = {
      ...mockSettings,
      perProviderLimits: { groq: 5000 },
    };
    tpmManager.configure(settingsWithProviderLimit);

    // Should succeed within provider limit
    const result1 = await tpmManager.reserve('groq', 3000, settingsWithProviderLimit);
    expect(result1).toBeTruthy();

    // Should fail exceeding provider limit
    const result2 = await tpmManager.reserve('groq', 3000, settingsWithProviderLimit);
    expect(result2).toBeNull();
  });

  it('should release reservations', async () => {
    await tpmManager.reserve('groq', 5000, mockSettings);
    const before = tpmManager.getRemaining();
    tpmManager.releaseReservation('groq');
    const after = tpmManager.getRemaining();
    expect(after).toBeGreaterThan(before);
  });

  describe('reserveAndWait (TPM limit exceeded -> wait, not fail)', () => {
    it('reserves immediately when budget is free', async () => {
      const id = await tpmManager.reserveAndWait('groq', 1000, mockSettings);
      expect(id).toBeTruthy();
    });

    it('waits until the budget frees up instead of failing', async () => {
      // Fill the window completely so a new request cannot reserve right now
      tpmManager.recordUsage('groq', 99000);

      let waitNotified = false;
      const pending = tpmManager.reserveAndWait(
        'groq',
        2000,
        { ...mockSettings, tpmWaitTimeoutMs: 3000 },
        { onWait: () => { waitNotified = true; } }
      );

      // While waiting, the task must NOT be rejected — it stays pending.
      let resolved = false;
      pending.then(() => { resolved = true; });
      await new Promise(r => setTimeout(r, 50));
      expect(resolved).toBe(false);
      expect(waitNotified).toBe(true);

      // Simulate "wieder geht es": the used tokens age out of the window
      // (equivalent to the sliding window freeing up after 60s). Also drop
      // the reservation that the blocked first attempt left behind, so the
      // waiter succeeds on its next retry instead of only at timeout.
      tpmManager.clearWindow();
      tpmManager.releaseReservation('groq');
      // The waiter retries at its scheduled time and should succeed within
      // the 3s wait window.
      const id = await pending;
      expect(id).toBeTruthy();
    });

    it('gives up after the wait timeout elapses', async () => {
      // Window permanently full and can't be freed within the tiny timeout
      tpmManager.recordUsage('groq', 99000);
      const start = Date.now();
      const id = await tpmManager.reserveAndWait(
        'groq',
        2000,
        { ...mockSettings, tpmWaitTimeoutMs: 700 }
      );
      expect(id).toBeNull();
      expect(Date.now() - start).toBeGreaterThanOrEqual(600);
    });

    it('returns null without waiting when the request can never fit the limit', async () => {
      const start = Date.now();
      const id = await tpmManager.reserveAndWait(
        'groq',
        200000, // larger than globalTpmLimit
        { ...mockSettings, tpmWaitTimeoutMs: 60000 }
      );
      expect(id).toBeNull();
      // "Impossible" requests must fail fast, not stall the task
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('stops waiting when the abort signal fires', async () => {
      tpmManager.recordUsage('groq', 99000);
      const controller = new AbortController();
      const pending = tpmManager.reserveAndWait(
        'groq',
        2000,
        { ...mockSettings, tpmWaitTimeoutMs: 60000 },
        { signal: controller.signal }
      );
      setTimeout(() => controller.abort(), 100);
      const id = await pending;
      expect(id).toBeNull();
    });
  });
});
