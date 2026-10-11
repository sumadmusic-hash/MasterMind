import { useState, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  MiniMap,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type AppNode = Node<any, string>;
type AppEdge = Edge;
import { useApp } from '../store/AppContext';
import { workflowEngine } from '../services/workflow';
import { toolRegistry } from '../services/tools';
import { saveWorkflow, deleteWorkflow, getWorkflows } from '../services/database';
import type { WorkflowDefinition } from '../types';
import {
  Plus, Save, Play, Trash2, CheckCircle, XCircle,
  GitBranch, Sparkles, FolderOpen, ChevronDown, ChevronUp,
  ArrowRight
} from 'lucide-react';

const nodeTypes = {
  input: InputNode,
  output: OutputNode,
  tool: ToolNode,
};

function InputNode({ data }: { data: any }) {
  return (
    <div className="bg-green-900/30 border border-green-600/40 rounded-lg px-4 py-2 text-sm text-green-300 min-w-[120px]">
      <div className="font-medium">{data.label || 'Input'}</div>
    </div>
  );
}

function OutputNode({ data }: { data: any }) {
  return (
    <div className="bg-purple-900/30 border border-purple-600/40 rounded-lg px-4 py-2 text-sm text-purple-300 min-w-[120px]">
      <div className="font-medium">{data.label || 'Output'}</div>
    </div>
  );
}

function ToolNode({ data }: { data: any }) {
  return (
    <div className="bg-blue-900/30 border border-blue-600/40 rounded-lg px-4 py-2 text-sm text-blue-300 min-w-[140px]">
      <div className="font-medium">{data.label || 'Tool'}</div>
      {data.toolId && <div className="text-xs text-blue-400/60 mt-0.5">{data.toolId}</div>}
    </div>
  );
}

export function WorkflowPage() {
  const { state, dispatch } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AppEdge>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDefinition | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [testInput, setTestInput] = useState('{"query": "test"}');
  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors: string[] } | null>(null);
  const [aiDescription, setAiDescription] = useState('');
  const [showPanel, setShowPanel] = useState(true);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const createNewWorkflow = () => {
    setNodes([
      { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Input' } },
      { id: 'output_1', type: 'output', position: { x: 500, y: 200 }, data: { label: 'Output' } },
    ]);
    setEdges([]);
    setWorkflowName('New Workflow');
    setWorkflowDesc('');
    setSelectedWorkflow(null);
    setTestResult(null);
    setValidationResult(null);
  };

  const addToolNode = (toolId: string) => {
    const tool = toolRegistry.getTool(toolId);
    if (!tool) return;

    const id = `tool_${Date.now()}`;
    const newNode: AppNode = {
      id,
      type: 'tool',
      position: { x: 250 + Math.random() * 100, y: 150 + Math.random() * 100 },
      data: { label: tool.name, toolId: tool.id, params: {} },
    };
    setNodes((nds: AppNode[]) => [...nds, newNode]);
  };

  const handleSave = async () => {
    const workflow: WorkflowDefinition = {
      id: selectedWorkflow?.id || crypto.randomUUID(),
      name: workflowName || 'Untitled Workflow',
      description: workflowDesc,
      version: selectedWorkflow?.version || '1.0.0',
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type || 'tool',
        position: n.position as { x: number; y: number },
        data: n.data as any,
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || undefined,
        targetHandle: e.targetHandle || undefined,
      })),
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object' },
      permissions: [],
      status: 'draft',
      createdAt: selectedWorkflow?.createdAt || Date.now(),
      updatedAt: Date.now(),
      createdBy: 'user',
    };

    await saveWorkflow(workflow);
    setSelectedWorkflow(workflow);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
    showToast('Workflow gespeichert');

    // Refresh workflows list
    const workflows = await getWorkflows();
    dispatch({ type: 'SET_WORKFLOWS', payload: workflows });
  };

  const handleValidate = () => {
    const workflow: WorkflowDefinition = {
      id: 'temp',
      name: workflowName,
      description: workflowDesc,
      version: '0.0.0',
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type || 'tool',
        position: n.position as { x: number; y: number },
        data: n.data as any,
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
      inputSchema: {},
      outputSchema: {},
      permissions: [],
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'user',
    };

    const result = workflowEngine.validateWorkflow(workflow);
    setValidationResult(result);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    const workflow: WorkflowDefinition = {
      id: 'test',
      name: workflowName,
      description: workflowDesc,
      version: '0.0.0',
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type || 'tool',
        position: n.position as { x: number; y: number },
        data: n.data as any,
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
      inputSchema: {},
      outputSchema: {},
      permissions: [],
      status: 'testing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'user',
    };

    try {
      const input = JSON.parse(testInput);
      const result = await workflowEngine.testWorkflow(workflow, input);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ passed: false, error: err.message, duration: 0 });
    }
    setTesting(false);
  };

  const handleApprove = async () => {
    if (!selectedWorkflow) return;
    const updated = { ...selectedWorkflow, status: 'approved' as const };
    await saveWorkflow(updated);
    setSelectedWorkflow(updated);
    const workflows = await getWorkflows();
    dispatch({ type: 'SET_WORKFLOWS', payload: workflows });
  };

  const handleLoadWorkflow = (wf: WorkflowDefinition) => {
    setSelectedWorkflow(wf);
    setWorkflowName(wf.name);
    setWorkflowDesc(wf.description);
    setNodes(wf.nodes.map(n => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    })));
    setEdges(wf.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
    })));
  };

  // Unsaved-changes guard for delete + a lightweight toast
  const [toast, setToast] = useState('');
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const isDirty = !!selectedWorkflow && (
    workflowName !== selectedWorkflow.name ||
    workflowDesc !== selectedWorkflow.description
  );

  const handleDelete = async (id: string) => {
    if (!window.confirm('Diesen Workflow wirklich löschen?')) return;
    await deleteWorkflow(id);
    const workflows = await getWorkflows();
    dispatch({ type: 'SET_WORKFLOWS', payload: workflows });
    if (selectedWorkflow?.id === id) {
      setSelectedWorkflow(null);
      createNewWorkflow();
    }
    showToast('Workflow gelöscht');
  };

  const handleGenerateFromAI = () => {
    if (!aiDescription.trim()) return;
    const workflow = workflowEngine.generateWorkflowFromDescription(aiDescription);
    handleLoadWorkflow(workflow);
    setAiDescription('');
  };

  const availableTools = toolRegistry.getEnabledTools();

  return (
    <div className="h-full flex">
      {/* Workflow List & Tools Panel */}
      <div className={`${showPanel ? 'w-72' : 'w-0'} transition-all duration-300 border-r border-gray-800 flex flex-col overflow-hidden bg-gray-900/30`}>
        <div className="p-3 border-b border-gray-800 space-y-2">
          <button
            onClick={createNewWorkflow}
            className="w-full flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Workflow
          </button>
          
          {/* AI Generator */}
          <div className="bg-gray-800/50 rounded-lg p-2">
            <div className="flex items-center gap-1 mb-1">
              <Sparkles className="w-3 h-3 text-purple-400" />
              <span className="text-xs text-purple-400">AI Generate</span>
            </div>
            <textarea
              value={aiDescription}
              onChange={e => setAiDescription(e.target.value)}
              placeholder="Describe what this workflow should do..."
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-purple-500"
              rows={2}
            />
            <button
              onClick={handleGenerateFromAI}
              className="w-full mt-1 px-2 py-1 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 rounded text-xs transition-colors"
            >
              Generate
            </button>
          </div>
        </div>

        {/* Saved Workflows */}
        <div className="p-3 border-b border-gray-800">
          <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">Saved Workflows</div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {state.workflows.map(wf => (
              <div key={wf.id} className="flex items-center gap-1">
                <button
                  onClick={() => handleLoadWorkflow(wf)}
                  className={`flex-1 text-left px-2 py-1.5 rounded text-xs transition-colors ${
                    selectedWorkflow?.id === wf.id ? 'bg-blue-600/20 text-blue-300' : 'text-gray-400 hover:bg-gray-800'
                  }`}
                >
                  <div className="truncate">{wf.name}</div>
                  <div className="text-gray-600">{wf.status} • v{wf.version}</div>
                </button>
                <button
                  onClick={() => handleDelete(wf.id)}
                  className="p-1 text-gray-600 hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            {state.workflows.length === 0 && (
              <p className="text-xs text-gray-600">No saved workflows</p>
            )}
          </div>
        </div>

        {/* Available Tools */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">Add Tool Node</div>
          <div className="space-y-1">
            {availableTools.map(tool => (
              <button
                key={tool.id}
                onClick={() => addToolNode(tool.id)}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                <div className="font-medium">{tool.name}</div>
                <div className="text-gray-600 truncate">{tool.description.substring(0, 50)}...</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Flow Editor */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          className="bg-gray-950"
        >
          <Controls className="!bg-gray-800 !border-gray-700 !rounded-lg" />
          <Background color="#333" gap={20} />
          <MiniMap
            className="!bg-gray-900 !border-gray-700"
            nodeColor={(n) => {
              if (n.type === 'input') return '#22c55e';
              if (n.type === 'output') return '#a855f7';
              return '#3b82f6';
            }}
          />
          <Panel position="top-right" className="flex gap-2">
            <button
              onClick={() => setShowPanel(!showPanel)}
              className="p-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-400"
            >
              {showPanel ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            <button
              onClick={handleValidate}
              className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              Validate
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Save className="w-4 h-4 inline mr-1" />
              Save
            </button>
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Play className="w-4 h-4 inline mr-1" />
              Test
            </button>
            {selectedWorkflow && selectedWorkflow.status !== 'approved' && (
              <button
                onClick={handleApprove}
                className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <CheckCircle className="w-4 h-4 inline mr-1" />
                Approve
              </button>
            )}
          </Panel>
        </ReactFlow>

        {/* Workflow Info Bar */}
        <div className="absolute bottom-0 left-0 right-0 bg-gray-900/90 border-t border-gray-800 p-3">
          <div className="flex items-center gap-3">
            <input
              value={workflowName}
              onChange={e => setWorkflowName(e.target.value)}
              placeholder="Workflow name..."
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500 w-48"
            />
            <input
              value={workflowDesc}
              onChange={e => setWorkflowDesc(e.target.value)}
              placeholder="Description..."
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            />
            {showSaved && (
              <span className="text-xs text-green-400">✓ Saved</span>
            )}
          </div>

          {/* Validation Results */}
          {validationResult && (
            <div className={`mt-2 text-xs ${validationResult.valid ? 'text-green-400' : 'text-red-400'}`}>
              {validationResult.valid ? '✓ Valid workflow' : `✗ ${validationResult.errors.join('; ')}`}
            </div>
          )}

          {/* Test Results */}
          {testResult && (
            <div className={`mt-2 p-2 rounded text-xs ${
              testResult.passed ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'
            }`}>
              <span>{testResult.passed ? '✓ Test passed' : `✗ Test failed: ${testResult.error}`}</span>
              <span className="ml-2 text-gray-500">{testResult.duration}ms</span>
              {testResult.output && (
                <pre className="mt-1 text-gray-400 overflow-x-auto max-h-20">
                  {JSON.stringify(testResult.output, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* Test Input */}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-gray-500">Test input:</span>
            <input
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
