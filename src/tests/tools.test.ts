import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry } from '../services/tools';

describe('ToolRegistry', () => {
  it('should have built-in tools registered', () => {
    const tools = toolRegistry.getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('should have web_search tool', () => {
    const tool = toolRegistry.getTool('web_search');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('Web Search');
    expect(tool?.enabled).toBe(true);
    expect(tool?.builtin).toBe(true);
  });

  it('should have news_search tool', () => {
    const tool = toolRegistry.getTool('news_search');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('data_source');
  });

  it('should have company_lookup tool', () => {
    const tool = toolRegistry.getTool('company_lookup');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('data_source');
  });

  it('should have stock_price tool', () => {
    const tool = toolRegistry.getTool('stock_price');
    expect(tool).toBeDefined();
  });

  it('should have data_filter tool', () => {
    const tool = toolRegistry.getTool('data_filter');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('filter');
  });

  it('should return enabled tools only', () => {
    const enabled = toolRegistry.getEnabledTools();
    expect(enabled.every(t => t.enabled)).toBe(true);
  });

  it('should toggle tool enabled state', () => {
    const tool = toolRegistry.getTool('data_filter');
    expect(tool?.enabled).toBe(true);
    
    toolRegistry.toggleTool('data_filter', false);
    expect(toolRegistry.getTool('data_filter')?.enabled).toBe(false);
    
    // Re-enable for other tests
    toolRegistry.toggleTool('data_filter', true);
    expect(toolRegistry.getTool('data_filter')?.enabled).toBe(true);
  });

  it('should generate LLM tool definitions', () => {
    const defs = toolRegistry.getToolDefinitionsForLLM();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toHaveProperty('name');
    expect(defs[0]).toHaveProperty('description');
    expect(defs[0]).toHaveProperty('inputSchema');
  });

  it('should return error for unknown tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test',
      toolId: 'nonexistent_tool',
      toolName: 'Nonexistent',
      arguments: {},
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should execute data_filter tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test_filter',
      toolId: 'data_filter',
      toolName: 'Data Filter',
      arguments: {
        data: [
          { name: 'Apple', sector: 'Tech' },
          { name: 'Tesla', sector: 'Auto' },
          { name: 'Google', sector: 'Tech' },
        ],
        filterField: 'sector',
        filterValue: 'Tech',
      },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
  });

  it('should execute company_lookup for known company', async () => {
    const result = await toolRegistry.execute({
      id: 'test_company',
      toolId: 'company_lookup',
      toolName: 'Company Lookup',
      arguments: { companyName: 'NVIDIA' },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.found).toBe(true);
    expect(result.data.ticker).toBe('NVDA');
  });

  it('should execute text_summarize tool', async () => {
    const result = await toolRegistry.execute({
      id: 'test_summary',
      toolId: 'text_summarize',
      toolName: 'Text Summarizer',
      arguments: {
        text: 'The quick brown fox jumps over the lazy dog. This is a longer sentence that provides more context about the animals in this story. Another sentence here to make the text long enough for summarization. And yet another one for good measure to ensure we have enough content.',
        maxLength: 50,
      },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
    expect(result.data.summary).toBeDefined();
    expect(result.data.summary.length).toBeGreaterThan(0);
  });
});
