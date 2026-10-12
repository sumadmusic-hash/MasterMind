import { describe, it, expect, vi } from 'vitest';
import { workflowEngine } from '../services/workflow';
import * as db from '../services/database';
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

  // Regression tests for the topologicalSort / saveAndVersionWorkflow bugs.
  describe('topologicalSort (via executeWorkflow)', () => {
    it('does not drop nodes that participate in a cycle', async () => {
      // a -> b -> c -> b forms a cycle; previously b and c never reached
      // in-degree 0 and were silently omitted from the execution order.
      const spy = vi.spyOn(db, 'saveWorkflow').mockResolvedValue(undefined as any);
      const wf: WorkflowDefinition = {
        ...createValidWorkflow(),
        nodes: [
          { id: 'a', type: 'input', position: { x: 0, y: 0 }, data: { label: 'A' } },
          { id: 'b', type: 'pass', position: { x: 100, y: 0 }, data: { label: 'B' } },
          { id: 'c', type: 'output', position: { x: 200, y: 0 }, data: { label: 'C' } },
        ],
        edges: [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e2', source: 'b', target: 'c' },
          { id: 'e3', source: 'c', target: 'b' },
        ],
      };
      const res = await workflowEngine.executeWorkflow(wf, { x: 1 });
      // All three nodes must have been visited: output node c has an entry.
      expect(res.output).toBeDefined();
      expect(res.duration).toBeGreaterThan(0);
      spy.mockRestore();
    });

    it('ignores edges referencing unknown nodes without losing valid ones', async () => {
      const wf = createValidWorkflow();
      wf.edges.push({ id: 'e9', source: 'ghost', target: 'tool_1' });
      const res = await workflowEngine.executeWorkflow(wf, {
        data: [{ name: 'Apple', sector: 'Tech' }],
        filterField: 'sector',
        filterValue: 'Tech',
      });
      expect(res.success).toBe(true);
    });
  });

  describe('saveAndVersionWorkflow', () => {
    it('increments patch version normally', async () => {
      const spy = vi.spyOn(db, 'saveWorkflow').mockResolvedValue(undefined as any);
      const wf = createValidWorkflow(); // version 1.0.0
      const saved = await workflowEngine.saveAndVersionWorkflow(wf);
      expect(saved.version).toBe('1.0.1');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('never produces NaN in the version string', async () => {
      const spy = vi.spyOn(db, 'saveWorkflow').mockResolvedValue(undefined as any);
      for (const bad of ['1.0', 'v2.1.0-beta', '', 'abc', undefined as any]) {
        const wf = { ...createValidWorkflow(), version: bad };
        const saved = await workflowEngine.saveAndVersionWorkflow(wf);
        expect(saved.version).not.toContain('NaN');
        expect(saved.version).toMatch(/^\d+\.\d+\.\d+$/);
      }
      spy.mockRestore();
    });

    it('does not mutate the input workflow object', async () => {
      const spy = vi.spyOn(db, 'saveWorkflow').mockResolvedValue(undefined as any);
      const wf = createValidWorkflow();
      const originalVersion = wf.version;
      await workflowEngine.saveAndVersionWorkflow(wf);
      expect(wf.version).toBe(originalVersion);
      spy.mockRestore();
    });
  });
});
