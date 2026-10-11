import { describe, it, expect } from 'vitest';
import { workflowEngine } from '../services/workflow';
import type { WorkflowDefinition } from '../types';

const createValidWorkflow = (): WorkflowDefinition => ({
  id: 'test-workflow',
  name: 'Test Workflow',
  description: 'A test workflow',
  version: '1.0.0',
  nodes: [
    { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: { label: 'Input' } },
    { id: 'tool_1', type: 'tool', position: { x: 200, y: 0 }, data: { label: 'Filter', toolId: 'data_filter' } },
    { id: 'output_1', type: 'output', position: { x: 400, y: 0 }, data: { label: 'Output' } },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'tool_1' },
    { id: 'e2', source: 'tool_1', target: 'output_1' },
  ],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: [],
  status: 'draft',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'user',
});

describe('WorkflowEngine', () => {
  it('should validate a correct workflow', () => {
    const workflow = createValidWorkflow();
    const result = workflowEngine.validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect empty workflow', () => {
    const workflow: WorkflowDefinition = {
      ...createValidWorkflow(),
      nodes: [],
      edges: [],
    };
    const result = workflowEngine.validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should detect circular dependencies', () => {
    const workflow: WorkflowDefinition = {
      ...createValidWorkflow(),
      nodes: [
        { id: 'a', type: 'tool', position: { x: 0, y: 0 }, data: { label: 'A', toolId: 'data_filter' } },
        { id: 'b', type: 'tool', position: { x: 200, y: 0 }, data: { label: 'B', toolId: 'data_filter' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    };
    const result = workflowEngine.validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('circular'))).toBe(true);
  });

  it('should detect invalid tool references', () => {
    const workflow: WorkflowDefinition = {
      ...createValidWorkflow(),
      nodes: [
        { id: 'input_1', type: 'input', position: { x: 0, y: 0 }, data: { label: 'Input' } },
        { id: 'tool_1', type: 'tool', position: { x: 200, y: 0 }, data: { label: 'Bad Tool', toolId: 'nonexistent_tool' } },
      ],
      edges: [{ id: 'e1', source: 'input_1', target: 'tool_1' }],
    };
    const result = workflowEngine.validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('unknown tool'))).toBe(true);
  });

  it('should execute a simple workflow', async () => {
    const workflow = createValidWorkflow();
    const result = await workflowEngine.executeWorkflow(workflow, {
      data: [
        { name: 'Apple', sector: 'Tech' },
        { name: 'Tesla', sector: 'Auto' },
      ],
      filterField: 'sector',
      filterValue: 'Tech',
    });
    expect(result.success).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should generate workflow from description', () => {
    const workflow = workflowEngine.generateWorkflowFromDescription('Search for news about AI');
    expect(workflow.id).toBeDefined();
    expect(workflow.nodes.length).toBeGreaterThan(0);
    expect(workflow.edges.length).toBeGreaterThan(0);
    expect(workflow.createdBy).toBe('ai');
    expect(workflow.status).toBe('draft');
  });

  it('should test a workflow', async () => {
    const workflow = createValidWorkflow();
    const result = await workflowEngine.testWorkflow(workflow, {
      data: [{ name: 'test' }],
    });
    expect(result.id).toBeDefined();
    expect(result.workflowId).toBe(workflow.id);
    expect(result.timestamp).toBeGreaterThan(0);
  });
});
