// src/backend/src/services/supabase.ts
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';

// ---------- Types (jobs table) ----------
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionMode = 'simulation' | 'github_actions' | 'kubernetes';
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled'];

export interface Job {
  id: string;
  user_id: string;
  original_command: string;
  parsed_intent: any; // JSONB
  job_type: string;
  status: JobStatus;
  output: string[];
  error_message?: string;
  logs: any; // JSONB
  external_job_id?: string;
  external_url?: string;
  execution_mode?: ExecutionMode;
  locked_by?: string | null;
  heartbeat_at?: string | null;
  cancel_requested?: boolean;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface JobEvent {
  id: number;
  job_id: string;
  from_status: JobStatus | null;
  to_status: JobStatus;
  worker_id: string | null;
  message: string | null;
  created_at: string;
}

export interface CreateJobData {
  user_id: string;
  original_command: string;
  parsed_intent: any;
  job_type: string;
  execution_mode: ExecutionMode;
  max_retries?: number;
}

export type CreateJobResult = { data: Job | null; error: PostgrestError | null };

// ---------- Env + raw admin client ----------
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!;
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase environment variables. Check SUPABASE_URL and SUPABASE_SERVICE_KEY.');
}

export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { 'X-Client-Info': 'devcommandhub-backend/0.1.0' } },
});

// Export the class so its typed surface is visible to importers
export class SupabaseService {
  constructor(private supabase: SupabaseClient) {}

  getClient(): SupabaseClient {
    return this.supabase;
  }

  async rpc(fn: string, args?: Record<string, unknown>) {
    return this.supabase.rpc(fn, args ?? {});
  }

  async testConnection(): Promise<boolean> {
    try {
      // light probe
      const { error } = await this.supabase.from('jobs').select('*').limit(1);
      if (error) {
        console.error('Supabase connection test failed:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Supabase connection error:', err);
      return false;
    }
  }

  async createJob(jobData: CreateJobData): Promise<CreateJobResult> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .insert([{
          user_id: jobData.user_id,
          original_command: jobData.original_command,
          parsed_intent: jobData.parsed_intent,
          job_type: jobData.job_type,
          execution_mode: jobData.execution_mode,
          status: 'queued',
          output: [],
          logs: [],                // JSONB array matches your schema default
          retry_count: 0,
          max_retries: jobData.max_retries ?? 3,
        }])
        .select('*')
        .single();

      if (error) {
        console.error('Error creating job:', error);
        return { data: null, error };
      }
      return { data: data as Job, error: null };
    } catch (err: any) {
      console.error('Unexpected error creating job:', err);
      // Wrap thrown errors to PostgrestError-compatible shape
      const wrapped: PostgrestError = {
        message: String(err?.message ?? err),
        details: '',
        hint: '',
        code: 'UNKNOWN',
        name: ''
      };
      return { data: null, error: wrapped };
    }
  }

  async getJob(jobId: string): Promise<Job | null> {
    try {
      const { data, error } = await this.supabase.from('jobs').select('*').eq('id', jobId).single();
      if (error) {
        console.error('Error fetching job:', error);
        return null;
      }
      return data as Job;
    } catch (err) {
      console.error('Unexpected error fetching job:', err);
      return null;
    }
  }

  /**
   * Move a job between states. The DB trigger rejects illegal transitions; `from`
   * makes the update conditional so two writers can't both win the same transition.
   */
  async transition(
    jobId: string,
    from: JobStatus,
    to: JobStatus,
    fields: Partial<Pick<Job, 'output' | 'error_message' | 'external_job_id' | 'external_url'>> = {}
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('jobs')
      .update({ status: to, ...fields })
      .eq('id', jobId)
      .eq('status', from)
      .select('id');
    if (error) {
      console.error(`Error transitioning job ${jobId} ${from} -> ${to}:`, error.message);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  /** Update output / external refs on a running job without changing its state. */
  async updateRunningJob(
    jobId: string,
    fields: Partial<Pick<Job, 'output' | 'external_job_id' | 'external_url'>>
  ): Promise<void> {
    const { error } = await this.supabase.from('jobs').update(fields).eq('id', jobId).eq('status', 'running');
    if (error) {console.error(`Error updating job ${jobId}:`, error.message);}
  }

  /** Refresh the worker's lease; returns whether cancellation was requested (null if the lease was lost). */
  async heartbeat(jobId: string, workerId: string): Promise<{ cancelRequested: boolean } | null> {
    const { data, error } = await this.supabase
      .from('jobs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('status', 'running')
      .eq('locked_by', workerId)
      .select('cancel_requested');
    if (error) {
      console.error(`Heartbeat failed for job ${jobId}:`, error.message);
      return { cancelRequested: false }; // transient error: keep running
    }
    if (!data?.length) {return null;}
    return { cancelRequested: Boolean(data[0].cancel_requested) };
  }

  async claimNextJob(workerId: string, maxPerUser: number): Promise<Job | null> {
    const { data, error } = await this.supabase.rpc('claim_next_job', {
      p_worker_id: workerId,
      p_max_per_user: maxPerUser,
    });
    if (error) {throw new Error(`claim_next_job failed: ${error.message}`);}
    return (Array.isArray(data) && data.length ? data[0] : null) as Job | null;
  }

  async recoverStaleJobs(staleSeconds: number): Promise<Array<{ job_id: string; new_status: JobStatus }>> {
    const { data, error } = await this.supabase.rpc('recover_stale_jobs', { p_stale_seconds: staleSeconds });
    if (error) {throw new Error(`recover_stale_jobs failed: ${error.message}`);}
    return (data ?? []) as Array<{ job_id: string; new_status: JobStatus }>;
  }

  /** Queued jobs are cancelled immediately; running jobs are flagged for their worker to stop. */
  async requestCancel(jobId: string): Promise<'cancelled' | 'cancel_requested' | 'not_cancellable' | 'not_found'> {
    const job = await this.getJob(jobId);
    if (!job) {return 'not_found';}
    if (job.status === 'queued') {
      const ok = await this.transition(jobId, 'queued', 'cancelled', { error_message: 'Cancelled by user before start' });
      if (ok) {return 'cancelled';}
      return this.requestCancel(jobId); // a worker claimed it meanwhile
    }
    if (job.status === 'running') {
      const { error } = await this.supabase.from('jobs').update({ cancel_requested: true }).eq('id', jobId).eq('status', 'running');
      return error ? 'not_cancellable' : 'cancel_requested';
    }
    return 'not_cancellable';
  }

  async getJobEvents(jobId: string): Promise<JobEvent[]> {
    const { data, error } = await this.supabase
      .from('job_events')
      .select('*')
      .eq('job_id', jobId)
      .order('id', { ascending: true });
    if (error) {
      console.error('Error fetching job events:', error.message);
      return [];
    }
    return (data ?? []) as JobEvent[];
  }

  async getUserJobs(userId: string, limit = 50, status?: string): Promise<Job[]> {
    try {
      let query = this.supabase
        .from('jobs')
        .select('id, original_command, job_type, status, execution_mode, created_at, updated_at, completed_at, external_job_id, external_url')
        .eq('user_id', userId);
      if (status) {query = query.eq('status', status);}
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Error fetching user jobs:', error);
        return [];
      }
      return data as Job[];
    } catch (err) {
      console.error('Unexpected error fetching user jobs:', err);
      return [];
    }
  }
}

export const supabaseService = new SupabaseService(supabaseAdmin);
