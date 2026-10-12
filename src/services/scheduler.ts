import type { ScheduledJob } from '../types';
import {
  getScheduledJobs, saveScheduledJob, addScheduledRun, getWorkflow, addLog,
} from './database';
import { workflowEngine } from './workflow';
import { setExecutionOrigin } from './tools';

/**
 * Clientseitiger Scheduler (docs/fehlende-tools-mehr-macht.md, Phase 2).
 *
 * Bewusste Einschränkungen (gegenüber Server-Cron):
 * - Der Browser muss offen sein; verpasste Läufe werden beim nächsten Tick
 *   „catch-up“ EINMAL nachgeholt (kein Backfill mehrerer Tage).
 * - Schedule-Syntax ist bewusst KEIN volles Cron: `@hourly`, `@daily` oder
 *   `<n><m|h|d>` (z. B. `30m`, `6h`, `2d`). Vollcron wäre im Browser ohne
 *   Timezone-Bibliothek eine Fehlerquelle und hier nicht nötig.
 * - Nach 3 Fehlschlägen in Folge wird der Job deaktiviert (kein Endlos-Retry,
 *   das TPM-Budget verbrennt).
 */

export const MIN_INTERVAL_MS = 60_000; // 1 Minute — schützt TPM-Budget & API-Rate-Limits
const TICK_MS = 30_000;                // Prüfintervall
const MAX_CATCHUP_AGE_MS = 24 * 3600_000; // länger zurückliegende Runs werden verworfen
const MAX_CONSECUTIVE_FAILURES = 3;

/** Parse a schedule spec into milliseconds; returns null for invalid specs. */
export function parseSchedule(spec: string): number | null {
  const s = String(spec || '').trim().toLowerCase();
  if (s === '@hourly') return 3600_000;
  if (s === '@daily') return 86400_000;
  if (s === '@weekly') return 7 * 86400_000;
  const m = /^(\d+)\s*([mhd])$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { m: 60_000, h: 3600_000, d: 86400_000 }[m[2] as 'm' | 'h' | 'd']!;
  return Math.max(n * unit, MIN_INTERVAL_MS);
}

/** Human-readable interval, e.g. "1x täglich", "alle 90 Minuten". */
export function describeSchedule(spec: string): string {
  const ms = parseSchedule(spec);
  if (ms == null) return `ungültig (${spec})`;
  if (ms % 86400_000 === 0) return ms === 86400_000 ? '1x täglich' : `alle ${ms / 86400_000} Tage`;
  if (ms % 3600_000 === 0) return `alle ${ms / 3600_000} Stunden`;
  return `alle ${Math.round(ms / 60_000)} Minuten`;
}

class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  /** Injected by AppContext so manual runs can be marked “user-initiated”. */
  private markManual: <T>(fn: () => T | Promise<T>) => T | Promise<T> = fn => fn();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // First tick shortly after boot: catches jobs missed while the tab was closed.
    setTimeout(() => { void this.tick(); }, 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Execute one job NOW (used by the tick loop and by the UI's „Jetzt testen“-
   * button). The returned promise resolves with the run outcome; failures are
   * recorded on the job (consecutiveFailures, auto-disable) exactly like
   * scheduled runs.
   */
  async runJob(jobId: string, opts: { manual?: boolean } = {}): Promise<{ success: boolean; error?: string; output?: any }> {
    const job = await getScheduledJobs().then(jobs => jobs.find(j => j.id === jobId));
    if (!job) return { success: false, error: `Job nicht gefunden: ${jobId}` };
    if (this.running.has(jobId)) return { success: false, error: 'Job läuft bereits.' };
    this.running.add(jobId);
    const startedAt = Date.now();
    try {
      const outcome = await this.markManual(async () => {
        // Origin marker for the write-guard in tools.ts (assertInteractive):
        // scheduled runs must not silently rewrite memory/positions/jobs.
        // Manual UI runs („Jetzt testen") stay 'user'. try/finally restores
        // 'user' even on throw, so a failed run can't poison later turns.
        setExecutionOrigin(opts.manual ? 'user' : 'scheduled');
        try {
          if (!job.workflowId) {
            throw new Error('Job hat kein Workflow hinterlegt (workflowId fehlt) — im Bereich Workflows erstellen/zweisen.');
          }
          const wf = await getWorkflow(job.workflowId);
          if (!wf) throw new Error(`Workflow nicht gefunden: ${job.workflowId}`);
          if (wf.status === 'disabled') throw new Error(`Workflow ist deaktiviert: ${wf.name}`);
          return workflowEngine.executeWorkflow(wf, job.inputs || {});
        } finally {
          setExecutionOrigin('user');
        }
      });
      const finishedAt = Date.now();
      const success = !!outcome.success;
      await addScheduledRun({
        jobId, startedAt, finishedAt, success,
        output: success ? outcome.output : undefined,
        error: success ? undefined : outcome.error,
      });
      const updated: ScheduledJob = {
        ...job,
        lastRun: finishedAt,
        nextRun: finishedAt + (parseSchedule(job.schedule) ?? 86400_000),
        consecutiveFailures: success ? 0 : job.consecutiveFailures + 1,
      };
      if (!success && updated.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        updated.enabled = false;
        await addLog({
          level: 'warn',
          message: `Scheduler-Job automatisch deaktiviert nach ${updated.consecutiveFailures} Fehlschlägen: ${job.name}`,
          timestamp: Date.now(),
        });
      }
      await saveScheduledJob(updated);
      if (!success) {
        await addLog({ level: 'error', message: `Scheduler-Job fehlgeschlagen: ${job.name}: ${outcome.error || 'unbekannter Fehler'}`, timestamp: Date.now() });
      }
      return { success, error: outcome.error, output: outcome.output };
    } catch (err: any) {
      const finishedAt = Date.now();
      await addScheduledRun({ jobId, startedAt, finishedAt, success: false, error: err?.message });
      await saveScheduledJob({
        ...job,
        lastRun: finishedAt,
        nextRun: finishedAt + (parseSchedule(job.schedule) ?? 86400_000),
        consecutiveFailures: job.consecutiveFailures + 1,
      });
      return { success: false, error: err?.message || 'Unbekannter Fehler' };
    } finally {
      this.running.delete(jobId);
    }
  }

  /** One scheduler pass: find due, enabled jobs and run them sequentially. */
  async tick(now = Date.now()): Promise<number> {
    const jobs = await getScheduledJobs();
    const due = jobs.filter(j => {
      if (!j.enabled || this.running.has(j.id)) return false;
      const interval = parseSchedule(j.schedule);
      if (interval == null) return false;
      // Jobs without a persisted nextRun get one scheduled relative to their
      // last run (or now, for brand-new jobs) instead of firing immediately.
      if (j.nextRun == null) {
        void saveScheduledJob({ ...j, nextRun: (j.lastRun ?? now) + interval });
        return false;
      }
      // Catch-up guard: a run more than a day overdue is stale (the machine
      // was asleep / the tab closed) — skip it but re-anchor nextRun.
      if (now - j.nextRun > MAX_CATCHUP_AGE_MS) {
        void saveScheduledJob({ ...j, nextRun: now + interval });
        return false;
      }
      return j.nextRun <= now;
    });
    for (const job of due) {
      await this.runJob(job.id);
    }
    return due.length;
  }
}

export const schedulerService = new SchedulerService();

/** Test hook: let suites drive the scheduler deterministically. */
export function __setManualMarkerForTests(marker: <T>(fn: () => T | Promise<T>) => T | Promise<T>): void {
  schedulerService['markManual'] = marker;
}
