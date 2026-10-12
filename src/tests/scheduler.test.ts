import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledJob, WorkflowDefinition } from '../types';

// IndexedDB isn't available in jsdom — stub the database layer with an
// in-memory store so we can test the scheduler service end-to-end.
const jobStore = new Map<string, ScheduledJob>();
const runStore: Array<Omit<ScheduledRunLike, 'id'> & { id: string }> = [];
let workflowStore: Record<string, WorkflowDefinition> = {};

interface ScheduledRunLike {
  jobId: string; startedAt: number; finishedAt: number; success: boolean;
  output?: any; error?: string;
}

vi.mock('../services/database', () => ({
  db: {
    scheduledRuns: {
      where: () => ({ equals: (jobId: string) => ({ toArray: async () => runStore.filter(r => r.jobId === jobId) }) }),
      bulkDelete: async (ids: string[]) => { ids.forEach(id => { const i = runStore.findIndex(r => r.id === id); if (i >= 0) runStore.splice(i, 1); }); },
    },
  },
  getScheduledJobs: async () => [...jobStore.values()],
  getScheduledJob: async (id: string) => jobStore.get(id),
  getScheduledRuns: async (jobId: string, limit = 20) =>
    runStore.filter(r => r.jobId === jobId).sort((a, b) => a.startedAt - b.startedAt).slice(-limit),
  saveScheduledJob: async (job: ScheduledJob) => { jobStore.set(job.id, { ...job }); },
  deleteScheduledJob: async (id: string) => { jobStore.delete(id); },
  addScheduledRun: async (run: Omit<ScheduledRunLike, 'id'>) => { runStore.push({ ...run, id: crypto.randomUUID() }); },
  getWorkflow: async (id: string) => workflowStore[id],
  addLog: async () => undefined,
}));

// Stub the workflow engine — the scheduler only needs executeWorkflow's outcome.
const executeWorkflow = vi.fn();
vi.mock('../services/workflow', () => ({
  workflowEngine: { executeWorkflow: (...args: any[]) => executeWorkflow(...args) },
}));

import { schedulerService, parseSchedule, describeSchedule } from '../services/scheduler';

function seedWorkflow(id = 'wf1') {
  workflowStore[id] = { id, name: 'WF', status: 'active' } as unknown as WorkflowDefinition;
  return id;
}

beforeEach(() => {
  jobStore.clear();
  runStore.length = 0;
  workflowStore = {};
  executeWorkflow.mockReset();
});

describe('parseSchedule / describeSchedule', () => {
  it('parses named and numeric specs', () => {
    expect(parseSchedule('@hourly')).toBe(3_600_000);
    expect(parseSchedule('@daily')).toBe(86_400_000);
    expect(parseSchedule('@weekly')).toBe(7 * 86_400_000);
    expect(parseSchedule('90m')).toBe(90 * 60_000);
    expect(parseSchedule('6h')).toBe(6 * 3_600_000);
    expect(parseSchedule('2d')).toBe(2 * 86_400_000);
  });

  it('enforces the 1-minute floor and rejects invalid specs', () => {
    expect(parseSchedule('30s')).toBeNull();
    expect(parseSchedule('0h')).toBeNull();
    expect(parseSchedule('daily')).toBeNull();
    expect(describeSchedule('bogus')).toContain('ungültig');
    expect(describeSchedule('@daily')).toBe('1x täglich');
    expect(describeSchedule('90m')).toBe('alle 90 Minuten');
  });
});

describe('schedulerService.createJob', () => {
  it('validates schedule and workflow before persisting', async () => {
    await expect(schedulerService.createJob({ name: 'X', schedule: '5s' })).rejects.toThrow(/Ungültiger Zeitplan/);
    await expect(schedulerService.createJob({ name: '', schedule: '@daily' })).rejects.toThrow(/Name/);
    await expect(schedulerService.createJob({ name: 'X', schedule: '@daily', workflowId: 'missing' })).rejects.toThrow(/Workflow nicht gefunden/);
    expect(jobStore.size).toBe(0);
  });

  it('anchors nextRun one full interval ahead (no immediate firing)', async () => {
    const wf = seedWorkflow();
    const before = Date.now();
    const job = await schedulerService.createJob({ name: 'Morgenbriefing', schedule: '6h', workflowId: wf });
    expect(job.enabled).toBe(true);
    expect(job.nextRun!).toBeGreaterThanOrEqual(before + 6 * 3_600_000);
    expect(jobStore.get(job.id)).toBeDefined();
  });
});

describe('schedulerService.tick', () => {
  it('runs due jobs and records history + nextRun', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    executeWorkflow.mockResolvedValue({ success: true, output: { ok: 1 } });
    // Write a due state directly via the DB stub to control time precisely.
    jobStore.set(job.id, { ...job, nextRun: Date.now() - 1 });
    const fired = await schedulerService.tick();
    expect(fired).toBe(1);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runStore).toHaveLength(1);
    expect(runStore[0].success).toBe(true);
    const stored = jobStore.get(job.id)!;
    expect(stored.consecutiveFailures).toBe(0);
    expect(stored.nextRun!).toBeGreaterThan(Date.now());
  });

  it('skips disabled jobs and re-anchors stale (>24h overdue) runs without firing', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    jobStore.set(job.id, { ...job, enabled: false, nextRun: Date.now() - 1 });
    const stale = await schedulerService.createJob({ name: 'S', schedule: '1h', workflowId: wf });
    jobStore.set(stale.id, { ...stale, nextRun: Date.now() - 25 * 3_600_000 });
    expect(await schedulerService.tick()).toBe(0);
    expect(executeWorkflow).not.toHaveBeenCalled();
    // Stale job got re-anchored instead of firing.
    expect(jobStore.get(stale.id)!.nextRun!).toBeGreaterThan(Date.now());
  });
});

describe('schedulerService.runJob failure handling', () => {
  it('counts consecutive failures and auto-disables after 3', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    executeWorkflow.mockResolvedValue({ success: false, error: 'boom' });
    for (let i = 0; i < 3; i++) {
      const res = await schedulerService.runJob(job.id);
      expect(res.success).toBe(false);
    }
    expect(jobStore.get(job.id)!.enabled).toBe(false);
    expect(jobStore.get(job.id)!.consecutiveFailures).toBe(3);
  });

  it('manual runs are marked user-origin (write-guard stays open)', async () => {
    const { getExecutionOrigin } = await import('../services/tools');
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    executeWorkflow.mockImplementation(async () => {
      capturedOrigin = getExecutionOrigin();
      return { success: true, output: {} };
    });
    let capturedOrigin: string = 'unset';
    await schedulerService.runNow(job.id);
    expect(capturedOrigin).toBe('user');
    expect(getExecutionOrigin()).toBe('user'); // restored after run
  });

  it('fails cleanly when the job has no workflowId or the workflow is missing', async () => {
    const orphan = await schedulerService.createJob({ name: 'NoWF', schedule: '@daily' });
    const res = await schedulerService.runJob(orphan.id);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/workflowId/i);
  });
});

describe('schedulerService.updateJob / setEnabled / removeJob', () => {
  it('re-anchors nextRun on schedule change and resets failures on re-enable', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    jobStore.set(job.id, { ...job, consecutiveFailures: 2, enabled: false });
    const updated = await schedulerService.setEnabled(job.id, true);
    expect(updated.enabled).toBe(true);
    expect(updated.consecutiveFailures).toBe(0);
    expect(updated.nextRun!).toBeGreaterThan(Date.now());

    const resched = await schedulerService.updateJob(job.id, { schedule: '@weekly' });
    expect(resched.schedule).toBe('@weekly');
    expect(resched.nextRun!).toBeGreaterThanOrEqual(Date.now() + 6 * 86_400_000);

    await expect(schedulerService.updateJob(job.id, { schedule: '13x' })).rejects.toThrow(/Ungültiger Zeitplan/);
  });

  it('removeJob deletes the job together with its run history', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    executeWorkflow.mockResolvedValue({ success: true, output: {} });
    jobStore.set(job.id, { ...job, nextRun: Date.now() - 1 });
    await schedulerService.tick();
    expect(runStore.filter(r => r.jobId === job.id)).toHaveLength(1);
    expect(await schedulerService.removeJob(job.id)).toBe(true);
    expect(jobStore.has(job.id)).toBe(false);
    expect(runStore.filter(r => r.jobId === job.id)).toHaveLength(0);
    expect(await schedulerService.removeJob('ghost')).toBe(false);
  });

  it('getHistory returns chronological runs for a job', async () => {
    const wf = seedWorkflow();
    const job = await schedulerService.createJob({ name: 'J', schedule: '1h', workflowId: wf });
    executeWorkflow.mockResolvedValue({ success: true, output: { n: 1 } });
    for (let i = 1; i <= 3; i++) {
      jobStore.set(job.id, { ...jobStore.get(job.id)!, nextRun: Date.now() - 1 });
      await schedulerService.tick();
    }
    const hist = await schedulerService.getHistory(job.id);
    expect(hist).toHaveLength(3);
    expect(hist[0].startedAt).toBeLessThanOrEqual(hist[2].startedAt);
  });
});
