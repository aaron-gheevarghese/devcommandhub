// src/backend/src/executors/types.ts
import type { ExecutionMode, Job } from '../services/supabase';

export interface JobIntent {
  action: 'deploy' | 'rollback' | 'scale' | 'restart' | 'logs' | 'status';
  service?: string | null;
  environment?: string | null;
  replicas?: number | null;
  parameters?: Record<string, any>;
}

export interface ExecutionContext {
  job: Job;
  intent: JobIntent;
  /** Aborted when the user cancels the job or the worker shuts down. */
  signal: AbortSignal;
  /** Append output lines; the worker batches them into jobs.output. */
  log: (...lines: string[]) => void;
  /** Record the external run (e.g. GitHub Actions run id + URL) on the job. */
  setExternal: (id: string, url?: string) => Promise<void>;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
}

export interface Executor {
  mode: ExecutionMode;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
}
