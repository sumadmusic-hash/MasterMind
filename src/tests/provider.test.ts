import { describe, it, expect } from 'vitest';
import { getModelCatalog, getAllModels } from '../services/provider';

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
