import { describe, it, expect } from 'vitest';
import { getModelCatalog, getAllModels, detectRefusal } from '../services/provider';

describe('Provider Service', () => {
  it('should return Groq model catalog', () => {
    const models = getModelCatalog('groq');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('id');
    expect(models[0]).toHaveProperty('name');
    expect(models[0]).toHaveProperty('contextWindow');
    expect(models[0]).toHaveProperty('supportsTools');
  });

  it('should return OpenRouter model catalog', () => {
    const models = getModelCatalog('openrouter');
    expect(models.length).toBeGreaterThan(0);
  });

  it('should return empty for unknown provider', () => {
    const models = getModelCatalog('unknown');
    expect(models).toEqual([]);
  });

  it('should return all models grouped by provider', () => {
    const all = getAllModels();
    expect(all).toHaveProperty('groq');
    expect(all).toHaveProperty('openrouter');
    expect(all.groq.length).toBeGreaterThan(0);
    expect(all.openrouter.length).toBeGreaterThan(0);
  });

  it('should have Llama 3.3 70B in Groq models', () => {
    const models = getModelCatalog('groq');
    const llama = models.find(m => m.id === 'llama-3.3-70b-versatile');
    expect(llama).toBeDefined();
    expect(llama?.supportsTools).toBe(true);
  });

  it('should have GPT-4o in OpenRouter models', () => {
    const models = getModelCatalog('openrouter');
    const gpt4o = models.find(m => m.id === 'openai/gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.supportsTools).toBe(true);
  });
});

describe('detectRefusal', () => {
  describe('positive cases (English)', () => {
    const refusals = [
      "I'm sorry, but I can't help with that request.",
      'I am sorry, but I cannot assist with that.',
      "I can't help with that.",
      'I cannot provide information on that topic.',
      'I won\'t answer questions about that.',
      'I must decline this request.',
      'As an AI, I cannot help with that.',
      'content_policy_violation',
      'This response was flagged due to new_sensitive_unavailable_content.',
    ];
    for (const text of refusals) {
      it(`should detect refusal: "${text.slice(0, 50)}"`, () => {
        expect(detectRefusal(text)).toBe(true);
      });
    }
  });

  describe('positive cases (German)', () => {
    const refusals = [
      'Leider kann ich Ihnen bei dieser Anfrage nicht helfen.',
      'Leider darf ich diese Information nicht weitergeben.',
      'Als KI kann ich nicht auf diese Anfrage antworten.',
      'Als Sprachmodell kann ich leider nicht handeln.',
    ];
    for (const text of refusals) {
      it(`should detect German refusal: "${text.slice(0, 50)}"`, () => {
        expect(detectRefusal(text)).toBe(true);
      });
    }
  });

  describe('negative cases (must NOT fire)', () => {
    const nonRefusals = [
      '',
      '   ',
      'Here is a detailed explanation of how photosynthesis works in plants.',
      'The water boils at 100 degrees Celsius at sea level.',
      // Mentions a policy mid-text — the start anchor must prevent a false positive
      'This policy prohibits X, but here is a summary of the regulation itself.',
      'Safety policies are important. This article explains them in depth.',
      'The word "sorry" appears frequently in apology letters.',
      'I am sorry to hear about your loss. Here is some comfort literature.',
      'Many models say "I cannot" when refusing, which is interesting metadata.',
    ];
    for (const text of nonRefusals) {
      it(`should not flag: "${text.slice(0, 50) || '(whitespace)'}"`, () => {
        expect(detectRefusal(text)).toBe(false);
      });
    }
  });

  it('should handle null/undefined-ish input without throwing', () => {
    expect(detectRefusal(undefined as unknown as string)).toBe(false);
    expect(detectRefusal(null as unknown as string)).toBe(false);
  });
});
