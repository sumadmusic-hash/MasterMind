import Dexie, { type Table } from 'dexie';
import type {
  ChatSession, AppSettings, WorkflowDefinition, AppLog, TokenUsage,
  MemoryEntry, PortfolioPosition, TimeSeriesCacheEntry, ScheduledJob, ScheduledRun,
} from '../types';

class AppDatabase extends Dexie {
  chatSessions!: Table<ChatSession, string>;
  settings!: Table<AppSettings & { id: string }, string>;
  workflows!: Table<WorkflowDefinition, string>;
  logs!: Table<AppLog, string>;
  tokenUsage!: Table<TokenUsage & { id: string }, string>;
  // Phase 1/2 (docs/fehlende-tools-mehr-macht.md): persistentes Gedächtnis,
  // Depot-Positionen, Zeitreihen-Cache und Scheduler-Jobs. Version 2 ergänzt
  // die Stores; bestehende Daten bleiben unverändert erhalten.
  memories!: Table<MemoryEntry, string>;
  positions!: Table<PortfolioPosition, string>;
  timeseriesCache!: Table<TimeSeriesCacheEntry, string>;
  scheduledJobs!: Table<ScheduledJob, string>;
  scheduledRuns!: Table<ScheduledRun, string>;

  constructor() {
    super('ai-research-db');
    this.version(1).stores({
      chatSessions: 'id, updatedAt, createdAt',
      settings: 'id',
      workflows: 'id, status, updatedAt, createdBy',
      logs: 'id, level, timestamp',
      tokenUsage: 'id, provider, timestamp',
    });
    this.version(2).stores({
      memories: 'id, [category+key], category, key, updatedAt',
      positions: 'id, ticker, updatedAt',
      timeseriesCache: 'id, source, seriesId, expiresAt',
      scheduledJobs: 'id, enabled, nextRun',
      scheduledRuns: 'id, jobId, startedAt',
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

// ============ Memory (user_memory) ============
export async function saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<MemoryEntry> {
  const now = Date.now();
  // Upsert per (category, key): the model may "re-save" a fact with updated
  // content; storing a second row would make recall return contradictions.
  const existing = await db.memories
    .where('[category+key]')
    .equals([entry.category, entry.key])
    .first();
  const record: MemoryEntry = {
    ...entry,
    id: existing?.id ?? entry.id ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.memories.put(record);
  return record;
}

export async function searchMemories(query: string, category?: string, limit = 10): Promise<MemoryEntry[]> {
  let coll = db.memories.toCollection();
  if (category) coll = db.memories.where('category').equals(category as any);
  const all = await coll.toArray();
  const q = query.toLowerCase().trim();
  const scored = all.map(m => {
    let score = m.importance * 10 + (m.pinned ? 5 : 0);
    if (q) {
      const hay = `${m.key} ${m.content}`.toLowerCase();
      for (const term of q.split(/\s+/)) {
        if (!term) continue;
        if (m.key.toLowerCase().includes(term)) score += 8;
        else if (hay.includes(term)) score += 4;
      }
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);
  const hits = scored.slice(0, limit).map(s => s.m);
  // Touch lastAccessedAt so recency can be shown in the UI later.
  const now = Date.now();
  await Promise.all(hits.map(m => db.memories.update(m.id, { lastAccessedAt: now })));
  return hits;
}

export async function listMemories(category?: string): Promise<MemoryEntry[]> {
  const all = category
    ? await db.memories.where('category').equals(category as any).toArray()
    : await db.memories.toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteMemory(id: string): Promise<void> {
  await db.memories.delete(id);
}

/**
 * Compact memory block injected into the system prompt (bounded by
 * maxChars — memories are re-sent on EVERY provider call, so this is a hard
 * token-budget decision, not a nicety).
 */
export async function buildMemoryPrompt(maxChars = 1200): Promise<string> {
  const all = await db.memories.toArray();
  if (all.length === 0) return '';
  const rank = (m: MemoryEntry) => (m.pinned ? 100 : 0) + m.importance * 10 + Math.min(3, (m.updatedAt - Date.now()) / 86400000e9 + 3);
  const sorted = all
    .slice()
    .sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)
    .filter(m => m.content && m.content.trim().length > 0);
  const lines: string[] = [];
  let used = 0;
  for (const m of sorted) {
    const line = `- [${m.category}] ${m.key}: ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `## NUTZERGEDÄCHTNIS (persistiert aus früheren Gesprächen; relevant für Personalisierung)\n${lines.join('\n')}\nNeue dauerhafte Fakten/Präferenzen des Nutzers mit \`memory_save\` speichern, nicht erraten.`;
}

// ============ Portfolio (portfolio_tracking) ============
export async function upsertPosition(pos: Omit<PortfolioPosition, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<PortfolioPosition> {
  const now = Date.now();
  const ticker = pos.ticker.toUpperCase();
  const existing = pos.id
    ? await db.positions.get(pos.id)
    : await db.positions.where('ticker').equals(ticker).first();
  const record: PortfolioPosition = {
    ...pos,
    ticker,
    id: existing?.id ?? pos.id ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.positions.put(record);
  return record;
}

export async function getPositions(): Promise<PortfolioPosition[]> {
  return db.positions.orderBy('ticker').toArray();
}

export async function deletePosition(id: string): Promise<void> {
  await db.positions.delete(id);
}

// ============ Time-series cache (macro_data) ============
export async function getCachedSeries(key: string, ttlMs: number): Promise<TimeSeriesCacheEntry | undefined> {
  const hit = await db.timeseriesCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    await db.timeseriesCache.delete(key);
    return undefined;
  }
  // Serve stale-but-recent data when TTL not yet expired; caller decides.
  void ttlMs;
  return hit;
}

export async function putCachedSeries(entry: Omit<TimeSeriesCacheEntry, 'id'> & { id: string }): Promise<void> {
  await db.timeseriesCache.put(entry as TimeSeriesCacheEntry);
}

// ============ Scheduler jobs (cron/scheduler) ============
export async function getScheduledJobs(): Promise<ScheduledJob[]> {
  return db.scheduledJobs.toArray();
}

export async function getScheduledJob(id: string): Promise<ScheduledJob | undefined> {
  return db.scheduledJobs.get(id);
}

/** Chronological run history of one job (oldest first), capped by `limit`. */
export async function getScheduledRuns(jobId: string, limit = 20): Promise<ScheduledRun[]> {
  const runs = await db.scheduledRuns.where('jobId').equals(jobId).toArray();
  return runs.sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
}

export async function saveScheduledJob(job: ScheduledJob): Promise<void> {
  await db.scheduledJobs.put(job);
}

export async function deleteScheduledJob(id: string): Promise<void> {
  await db.scheduledJobs.delete(id);
}

export async function addScheduledRun(run: Omit<ScheduledRun, 'id'>): Promise<void> {
  await db.scheduledRuns.add({ ...run, id: crypto.randomUUID() });
  const count = await db.scheduledRuns.count();
  if (count > 200) {
    const oldest = await db.scheduledRuns.orderBy('startedAt').limit(count - 200).toArray();
    await db.scheduledRuns.bulkDelete(oldest.map(r => r.id));
  }
}

export async function clearAllData(): Promise<void> {
  await db.chatSessions.clear();
  await db.workflows.clear();
  await db.logs.clear();
  await db.tokenUsage.clear();
  await db.memories.clear();
  await db.positions.clear();
  await db.timeseriesCache.clear();
  await db.scheduledJobs.clear();
  await db.scheduledRuns.clear();
}
