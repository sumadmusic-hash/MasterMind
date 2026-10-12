import type { WorkflowDefinition, WorkflowNode, WorkflowEdge, WorkflowTestResult } from '../types';
import { toolRegistry } from './tools';
import { saveWorkflow } from './database';

export interface WorkflowExecutionContext {
  inputs: Record<string, any>;
  nodeOutputs: Map<string, any>;
  errors: Map<string, string>;
  executionOrder: string[];
}

class WorkflowEngine {
  validateWorkflow(workflow: WorkflowDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!workflow.nodes || workflow.nodes.length === 0) {
      errors.push('Workflow must have at least one node');
    }

    // Check for cycles
    if (this.hasCycle(workflow.nodes, workflow.edges)) {
      errors.push('Workflow contains circular dependencies');
    }

    // Check node connections
    for (const edge of workflow.edges) {
      const sourceNode = workflow.nodes.find(n => n.id === edge.source);
      const targetNode = workflow.nodes.find(n => n.id === edge.target);
      
      if (!sourceNode) errors.push(`Edge references missing source node: ${edge.source}`);
      if (!targetNode) errors.push(`Edge references missing target node: ${edge.target}`);
    }

    // Check that tool IDs exist
    for (const node of workflow.nodes) {
      if (node.data.toolId) {
        const tool = toolRegistry.getTool(node.data.toolId);
        if (!tool) {
          errors.push(`Node "${node.data.label}" references unknown tool: ${node.data.toolId}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
    const graph = new Map<string, string[]>();
    for (const node of nodes) {
      graph.set(node.id, []);
    }
    for (const edge of edges) {
      const neighbors = graph.get(edge.source) || [];
      neighbors.push(edge.target);
      graph.set(edge.source, neighbors);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (nodeId: string): boolean => {
      if (inStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;

      visited.add(nodeId);
      inStack.add(nodeId);

      for (const neighbor of graph.get(nodeId) || []) {
        if (dfs(neighbor)) return true;
      }

      inStack.delete(nodeId);
      return false;
    };

    for (const node of nodes) {
      if (dfs(node.id)) return true;
    }

    return false;
  }

  async executeWorkflow(
    workflow: WorkflowDefinition,
    inputs: Record<string, any>
  ): Promise<{ success: boolean; output?: any; error?: string; duration: number }> {
    // Use performance.now() for sub-millisecond accuracy; Date.now() would often yield 0
    const startTime = performance.now();
    
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; '), duration: Math.max(1, Math.round(performance.now() - startTime)) };
    }

    const context: WorkflowExecutionContext = {
      inputs,
      nodeOutputs: new Map(),
      errors: new Map(),
      executionOrder: [],
    };

    // Topological sort for execution order
    const order = this.topologicalSort(workflow.nodes, workflow.edges);
    
    for (const nodeId of order) {
      const node = workflow.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      // Gather inputs from connected nodes
      const nodeInputs: Record<string, any> = { ...inputs };
      const incomingEdges = workflow.edges.filter(e => e.target === nodeId);
      
      for (const edge of incomingEdges) {
        const sourceOutput = context.nodeOutputs.get(edge.source);
        if (sourceOutput) {
          Object.assign(nodeInputs, sourceOutput);
        }
      }

      // Merge with node-specific params
      if (node.data.params) {
        Object.assign(nodeInputs, node.data.params);
      }

      try {
        if (node.type === 'input') {
          context.nodeOutputs.set(nodeId, inputs);
        } else if (node.type === 'output') {
          context.nodeOutputs.set(nodeId, nodeInputs);
        } else if (node.data.toolId) {
          const tool = toolRegistry.getTool(node.data.toolId);
          if (!tool || !tool.enabled) {
            context.errors.set(nodeId, `Tool not available: ${node.data.toolId}`);
            continue;
          }

          const result = await toolRegistry.execute({
            id: `${nodeId}_${Date.now()}`,
            toolId: node.data.toolId,
            toolName: tool.name,
            arguments: nodeInputs,
            timestamp: Date.now(),
          });

          if (result.success) {
            context.nodeOutputs.set(nodeId, result.data);
          } else {
            context.errors.set(nodeId, result.error || 'Tool execution failed');
          }
        } else {
          // Pass-through node
          context.nodeOutputs.set(nodeId, nodeInputs);
        }

        context.executionOrder.push(nodeId);
      } catch (err: any) {
        context.errors.set(nodeId, err.message);
      }
    }

    // Find output node(s)
    const outputNodes = workflow.nodes.filter(n => n.type === 'output');
    let finalOutput: any = {};
    
    if (outputNodes.length > 0) {
      for (const outNode of outputNodes) {
        const output = context.nodeOutputs.get(outNode.id);
        if (output) {
          finalOutput = { ...finalOutput, ...output };
        }
      }
    } else {
      // Use last node's output
      const lastNodeId = order[order.length - 1];
      finalOutput = context.nodeOutputs.get(lastNodeId) || {};
    }

    const hasErrors = context.errors.size > 0;
    
    return {
      success: !hasErrors,
      output: finalOutput,
      error: hasErrors ? Array.from(context.errors.entries()).map(([k, v]) => `${k}: ${v}`).join('; ') : undefined,
      duration: Math.max(1, Math.round(performance.now() - startTime)),
    };
  }

  private topologicalSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
    const inDegree = new Map<string, number>();
    const graph = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      graph.set(node.id, []);
    }

    for (const edge of edges) {
      const neighbors = graph.get(edge.source) || [];
      neighbors.push(edge.target);
      graph.set(edge.source, neighbors);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) queue.push(nodeId);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);

      for (const neighbor of graph.get(nodeId) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    // BUGFIX: nodes that are part of a cycle (or only reachable through one)
    // never reach in-degree 0 and were silently DROPPED from the order — the
    // workflow then "succeeded" while whole branches were never executed.
    // Append every node missing from `result` (deterministic: original node
    // order) so all nodes run at least once; validateWorkflow still flags
    // cycles as errors, but execution no longer loses work invisibly.
    if (result.length !== nodes.length) {
      const seen = new Set(result);
      for (const node of nodes) {
        if (!seen.has(node.id)) result.push(node.id);
      }
    }

    return result;
  }

  async testWorkflow(workflow: WorkflowDefinition, testInput: any): Promise<WorkflowTestResult> {
    const startTime = Date.now();
    
    try {
      const result = await this.executeWorkflow(workflow, testInput);
      
      return {
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        input: testInput,
        output: result.output,
        error: result.error,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
        passed: result.success,
      };
    } catch (err: any) {
      return {
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        input: testInput,
        error: err.message,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
        passed: false,
      };
    }
  }

  async saveAndVersionWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    // BUGFIX (1): `split('.').map(Number)` produced NaN for non-numeric or
    // missing version parts ("1.0", "v1.0.0-beta", ""), which then leaked into
    // the stored version string as e.g. "1.NaN.2" or "NaN.NaN.1". Parse each
    // part defensively with a numeric fallback instead.
    // BUGFIX (2): the old code MUTATED the caller's workflow object; work on a
    // copy so callers can still compare/rollback their own state.
    const rawParts = String(workflow.version || '').trim().replace(/^v/i, '').split('.');
    const num = (v: string | undefined, fallback: number) => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const parts = [
      num(rawParts[0], 1),
      num(rawParts[1], 0),
      num(rawParts[2], 0) + 1, // increment patch version
    ];

    const updated: WorkflowDefinition = {
      ...workflow,
      version: parts.join('.'),
      updatedAt: Date.now(),
    };

    await saveWorkflow(updated);
    return updated;
  }

  generateWorkflowFromDescription(description: string): WorkflowDefinition {
    // AI-assisted workflow generation from description
    // This creates a basic workflow structure that can be refined
    const id = crypto.randomUUID();
    
    const nodes: WorkflowNode[] = [
      {
        id: 'input_1',
        type: 'input',
        position: { x: 0, y: 200 },
        data: { label: 'Input', params: {} },
      },
      {
        id: 'process_1',
        type: 'tool',
        position: { x: 250, y: 200 },
        data: {
          label: 'Process',
          toolId: 'web_search',
          params: { query: description },
        },
      },
      {
        id: 'output_1',
        type: 'output',
        position: { x: 500, y: 200 },
        data: { label: 'Output', params: {} },
      },
    ];

    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'input_1', target: 'process_1' },
      { id: 'e2', source: 'process_1', target: 'output_1' },
    ];

    return {
      id,
      name: `Workflow: ${description.substring(0, 50)}`,
      description,
      version: '1.0.0',
      nodes,
      edges,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object' },
      permissions: [],
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'ai',
    };
  }
}

export const workflowEngine = new WorkflowEngine();
