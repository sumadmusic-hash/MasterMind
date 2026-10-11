import Dexie, { type Table } from 'dexie';
import type { ChatSession, AppSettings, WorkflowDefinition, AppLog, TokenUsage } from '../types';

class AppDatabase extends Dexie {
  chatSessions!: Table<ChatSession, string>;
  settings!: Table<AppSettings & { id: string }, string>;
  workflows!: Table<WorkflowDefinition, string>;
  logs!: Table<AppLog, string>;
  tokenUsage!: Table<TokenUsage & { id: string }, string>;

  constructor() {
    super('ai-research-db');
    this.version(1).stores({
      chatSessions: 'id, updatedAt, createdAt',
      settings: 'id',
      workflows: 'id, status, updatedAt, createdBy',
      logs: 'id, level, timestamp',
      tokenUsage: 'id, provider, timestamp',
    });
  }
}

export const db = new AppDatabase();

// Settings management
export async function getSettings(): Promise<AppSettings | null> {
  const s = await db.settings.get('main');
  return s ? { ...s, id: undefined } as any : null;
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const existing = await db.settings.get('main');
  const merged = { ...existing, ...settings, id: 'main' };
  await db.settings.put(merged as any);
}

// Chat sessions
export async function getChatSessions(): Promise<ChatSession[]> {
  return db.chatSessions.orderBy('updatedAt').reverse().toArray();
}

export async function getChatSession(id: string): Promise<ChatSession | undefined> {
  return db.chatSessions.get(id);
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  await db.chatSessions.put({ ...session, updatedAt: Date.now() });
}

export async function deleteChatSession(id: string): Promise<void> {
  await db.chatSessions.delete(id);
}

// Workflows
export async function getWorkflows(): Promise<WorkflowDefinition[]> {
  return db.workflows.orderBy('updatedAt').reverse().toArray();
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | undefined> {
  return db.workflows.get(id);
}

export async function saveWorkflow(workflow: WorkflowDefinition): Promise<void> {
  await db.workflows.put(workflow);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await db.workflows.delete(id);
}

// Logs
export async function addLog(log: Omit<AppLog, 'id'>): Promise<void> {
  await db.logs.add({ ...log, id: crypto.randomUUID() });
  // Keep only last 1000 logs
  const count = await db.logs.count();
  if (count > 1000) {
    const oldest = await db.logs.orderBy('timestamp').limit(count - 1000).toArray();
    await db.logs.bulkDelete(oldest.map(l => l.id));
  }
}

export async function getLogs(limit = 100): Promise<AppLog[]> {
  return db.logs.orderBy('timestamp').reverse().limit(limit).toArray();
}

// Token usage
export async function recordTokenUsage(usage: TokenUsage): Promise<void> {
  await db.tokenUsage.add({ ...usage, id: crypto.randomUUID() });
}

export async function getTokenUsageSince(since: number): Promise<TokenUsage[]> {
  return db.tokenUsage.where('timestamp').aboveOrEqual(since).toArray();
}

export async function clearAllData(): Promise<void> {
  await db.chatSessions.clear();
  await db.workflows.clear();
  await db.logs.clear();
  await db.tokenUsage.clear();
}
