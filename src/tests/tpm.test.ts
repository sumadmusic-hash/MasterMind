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
    expect(result).toBe(true);
  });

  it('should reject reservation exceeding budget', async () => {
    const result = await tpmManager.reserve('groq', 200000, mockSettings);
    expect(result).toBe(false);
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
    expect(result1).toBe(true);

    // Should fail exceeding provider limit
    const result2 = await tpmManager.reserve('groq', 3000, settingsWithProviderLimit);
    expect(result2).toBe(false);
  });

  it('should release reservations', async () => {
    await tpmManager.reserve('groq', 5000, mockSettings);
    const before = tpmManager.getRemaining();
    tpmManager.releaseReservation('groq');
    const after = tpmManager.getRemaining();
    expect(after).toBeGreaterThan(before);
  });
});
