// src/backend/src/worker.ts
// Pulls queued jobs from Supabase and executes them independently of the API request
// (and of the VS Code window). State changes go through the DB-enforced state machine:
//   queued -> running -> completed | failed | cancelled   (running -> queued on crash recovery)
import os from 'os';
import { supabaseService, type ExecutionMode, type Job } from './services/supabase';
import type { Executor, JobIntent } from './executors/types';
import { simulationExecutor } from './executors/simulation';
import { githubActionsExecutor } from './executors/githubActions';
import { kubernetesExecutor } from './executors/kubernetes';

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  maxPerUser?: number;
  heartbeatMs?: number;
  staleSeconds?: number;
}

const EXECUTORS: Record<ExecutionMode, Executor> = {
  simulation: simulationExecutor,
  github_actions: githubActionsExecutor,
  kubernetes: kubernetesExecutor,
};

const OUTPUT_FLUSH_MS = 1500;
const MAX_OUTPUT_LINES = 500;

type Active = { controller: AbortController; done: Promise<void> };

export class JobWorker {
  readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPerUser: number;
  private readonly heartbeatMs: number;
  private readonly staleSeconds: number;

  private active = new Map<string, Active>();
  private pollTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking = false;
  private lastError: string | null = null;

  constructor(opts: WorkerOptions = {}) {
    this.workerId = opts.workerId ?? `${os.hostname()}:${process.pid}`;
    this.pollIntervalMs = opts.pollIntervalMs ?? Number(process.env.WORKER_POLL_INTERVAL || 2000);
    this.maxConcurrent = opts.maxConcurrent ?? Number(process.env.MAX_CONCURRENT_JOBS || 4);
    this.maxPerUser = opts.maxPerUser ?? Number(process.env.MAX_JOBS_PER_USER || 2);
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.staleSeconds = opts.staleSeconds ?? Number(process.env.JOB_STALE_SECONDS || 60);
  }

  async start() {
    console.log(`[WORKER ${this.workerId}] starting (concurrency=${this.maxConcurrent}, perUser=${this.maxPerUser})`);
    await this.recover();
    this.recoveryTimer = setInterval(() => void this.recover(), this.staleSeconds * 1000);
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
    void this.tick();
  }

  /** Stop claiming; hand running jobs back to the queue so another worker can pick them up. */
  async stop() {
    this.stopping = true;
    if (this.pollTimer) {clearInterval(this.pollTimer);}
    if (this.recoveryTimer) {clearInterval(this.recoveryTimer);}
    for (const a of this.active.values()) {a.controller.abort('shutdown');}
    await Promise.allSettled([...this.active.values()].map(a => a.done));
  }

  stats() {
    return {
      workerId: this.workerId,
      activeJobs: [...this.active.keys()],
      maxConcurrent: this.maxConcurrent,
      maxPerUser: this.maxPerUser,
      lastError: this.lastError,
    };
  }

  private async recover() {
    try {
      const recovered = await supabaseService.recoverStaleJobs(this.staleSeconds);
      for (const r of recovered) {
        console.warn(`[WORKER] recovered stale job ${r.job_id} -> ${r.new_status}`);
      }
    } catch (e: any) {
      this.lastError = e.message;
      console.error('[WORKER] recovery failed:', e.message);
    }
  }

  private async tick() {
    if (this.stopping || this.ticking) {return;}
    this.ticking = true;
    try {
      while (!this.stopping && this.active.size < this.maxConcurrent) {
        const job = await supabaseService.claimNextJob(this.workerId, this.maxPerUser);
        if (!job) {break;}
        this.launch(job);
      }
      this.lastError = null;
    } catch (e: any) {
      if (this.lastError !== e.message) {console.error('[WORKER] claim failed:', e.message);}
      this.lastError = e.message;
    } finally {
      this.ticking = false;
    }
  }

  private launch(job: Job) {
    const controller = new AbortController();
    const done = this.run(job, controller).finally(() => {
      this.active.delete(job.id);
      void this.tick(); // a slot opened up
    });
    this.active.set(job.id, { controller, done });
  }

  private async run(job: Job, controller: AbortController) {
    const tag = `[JOB ${job.id.slice(0, 8)}]`;
    const mode = (job.execution_mode ?? 'simulation') as ExecutionMode;
    const executor = EXECUTORS[mode];
    const intent = job.parsed_intent as JobIntent;
    console.log(`${tag} claimed by ${this.workerId} (${mode}, attempt ${job.retry_count + 1})`);

    const output: string[] = job.retry_count > 0 ? [`↻ Retry ${job.retry_count} after worker failure`] : [];
    let dirty = false;
    let leaseLost = false;

    const flush = async () => {
      if (!dirty) {return;}
      dirty = false;
      await supabaseService.updateRunningJob(job.id, { output: output.slice(-MAX_OUTPUT_LINES) });
    };
    const flushTimer = setInterval(() => void flush(), OUTPUT_FLUSH_MS);

    const heartbeatTimer = setInterval(async () => {
      const hb = await supabaseService.heartbeat(job.id, this.workerId);
      if (hb === null) {
        leaseLost = true; // recovered by someone else or cancelled; stop writing
        controller.abort('lease_lost');
      } else if (hb.cancelRequested && !controller.signal.aborted) {
        controller.abort('cancel');
      }
    }, this.heartbeatMs);

    let result: { success: boolean; error?: string };
    try {
      if (!executor) {throw new Error(`Unknown execution mode: ${mode}`);}
      result = await executor.execute({
        job,
        intent,
        signal: controller.signal,
        log: (...lines) => { output.push(...lines); dirty = true; },
        setExternal: async (id, url) => {
          await supabaseService.updateRunningJob(job.id, { external_job_id: id, external_url: url });
        },
      });
    } catch (e: any) {
      result = { success: false, error: controller.signal.aborted ? 'Cancelled' : (e?.message ?? String(e)) };
    } finally {
      clearInterval(flushTimer);
      clearInterval(heartbeatTimer);
    }

    if (leaseLost) {
      console.warn(`${tag} lease lost; leaving final state to the recovering worker`);
      return;
    }

    const reason = controller.signal.reason;
    const finalOutput = output.slice(-MAX_OUTPUT_LINES);
    if (reason === 'shutdown') {
      await supabaseService.transition(job.id, 'running', 'queued', {
        output: [...finalOutput, '⏸ Worker shutting down; job re-queued'],
        error_message: `Re-queued by ${this.workerId} during shutdown`,
      });
      console.log(`${tag} re-queued (shutdown)`);
    } else if (reason === 'cancel') {
      await supabaseService.transition(job.id, 'running', 'cancelled', {
        output: [...finalOutput, '⛔ Cancelled by user'],
        error_message: 'Cancelled by user',
      });
      console.log(`${tag} cancelled`);
    } else if (result.success) {
      await supabaseService.transition(job.id, 'running', 'completed', { output: finalOutput });
      console.log(`${tag} completed`);
    } else {
      await supabaseService.transition(job.id, 'running', 'failed', {
        output: finalOutput,
        error_message: result.error ?? 'Job failed',
      });
      console.log(`${tag} failed: ${result.error}`);
    }
  }
}

// `npm run worker` runs the worker as its own process (API can then set RUN_WORKER=false).
if (require.main === module) {
  const worker = new JobWorker();
  void worker.start();
  const shutdown = async (sig: string) => {
    console.log(`${sig} received, re-queueing active jobs...`);
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
