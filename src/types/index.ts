import { z } from 'zod';

// ============ Provider Types ============
export const ProviderSchema = z.enum(['groq', 'openrouter']);
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelConfigSchema = z.object({
  provider: ProviderSchema,
  modelId: z.string(),
  label: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const AppSettingsSchema = z.object({
  groqApiKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  primaryModel: ModelConfigSchema,
  fallback1: ModelConfigSchema.optional(),
  fallback2: ModelConfigSchema.optional(),
  globalTpmLimit: z.number().min(1000).default(100000),
  perProviderLimits: z.record(z.string(), z.number()).optional(),
  maxTokensPerRequest: z.number().default(4096),
  maxToolSteps: z.number().default(20),
  maxCallDuration: z.number().default(120000),
  // When the TPM budget is exhausted, tasks WAIT instead of failing. This
  // bounds how long a single request may wait for budget to free up
  // (default 5 minutes). Set to 0 to fail immediately instead of waiting.
  tpmWaitTimeoutMs: z.number().min(0).default(300000),
  theme: z.enum(['light', 'dark', 'system']).default('dark'),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

// ============ Chat Types ============
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  sources?: Source[];
  model?: string;
  provider?: string;
  tokensUsed?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// ============ Tool Types ============
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  version: string;
  enabled: boolean;
  permissions: string[];
  maxDuration: number;
  maxDataSize: number;
  builtin: boolean;
}

export type ToolCategory = 
  | 'data_source'
  | 'filter'
  | 'transform'
  | 'ai_extraction'
  | 'comparison'
  | 'report'
  | 'workflow';

export interface ToolCall {
  id: string;
  toolId: string;
  toolName: string;
  arguments: Record<string, any>;
  timestamp: number;
}

export interface ToolResult {
  callId: string;
  toolId: string;
  success: boolean;
  data?: any;
  error?: string;
  duration: number;
  timestamp: number;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  provider?: string;
}

// ============ Workflow Types ============
export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    toolId?: string;
    params?: Record<string, any>;
    inputSchema?: Record<string, any>;
    outputSchema?: Record<string, any>;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  permissions: string[];
  status: 'draft' | 'testing' | 'approved' | 'disabled';
  createdAt: number;
  updatedAt: number;
  createdBy: 'user' | 'ai';
  testResults?: WorkflowTestResult[];
}

export interface WorkflowTestResult {
  id: string;
  workflowId: string;
  input: any;
  output?: any;
  error?: string;
  duration: number;
  timestamp: number;
  passed: boolean;
}

// ============ TPM Types ============
export interface TokenBudget {
  globalLimit: number;
  usedInWindow: number;
  windowStart: number;
  windowDuration: number;
  reserved: number;
  perProvider: Record<string, { used: number; limit: number }>;
}

export interface TokenUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  timestamp: number;
}

// ============ News & Market Types ============
export interface NewsItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt: string;
  companies: string[];
  tickers: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
}

export interface CompanyInfo {
  name: string;
  ticker: string;
  exchange: string;
  sector?: string;
  marketCap?: number;
}

export interface PriceData {
  ticker: string;
  current: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume: number;
  timestamp: string;
  historical?: { date: string; close: number }[];
}

// ============ Log Types ============
export interface AppLog {
  id: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: Record<string, any>;
  timestamp: number;
}
