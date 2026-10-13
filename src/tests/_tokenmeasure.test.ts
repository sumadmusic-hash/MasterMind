import { describe, it } from 'vitest';

describe('wire format measurement', () => {
  it('measures groq wire tokens for selected catalogue', async () => {
    const { toolRegistry } = await import('../services/tools');
    const { normalizeJsonSchema } = await import('../services/provider');
    const sel = toolRegistry.getToolDefinitionsForLLM('wetter dresden');
    const wire = sel.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: normalizeJsonSchema(t.inputSchema) } }));
    const json = JSON.stringify(wire);
    console.log('WIRE chars', json.length, '~tokens', Math.ceil(json.length/4));
    console.log(json.slice(0, 800));
  });
});
