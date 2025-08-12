// src/backend/src/services/supabase.ts
import dotenv from 'dotenv';
dotenv.config();
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY);

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Database types based on our jobs table schema
export interface Job {
  id: string;
  user_id: string;
  original_command: string;
  parsed_intent: any; // JSONB
  job_type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output: string[];
  error_message?: string;
  logs: any; // JSONB
  external_job_id?: string;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface CreateJobData {
  user_id: string;
  original_command: string;
  parsed_intent: any;
  job_type: string;
  max_retries?: number;
}

class SupabaseService {
  private supabase: SupabaseClient;
  
  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables. Check your .env file.');
    }
    
    this.supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  
  async testConnection(): Promise<boolean> {
    try {
      const { error } = await this.supabase
        .from('jobs')
        .select('count')
        .limit(1);
      if (error) {
        console.error('Supabase connection test failed:', error);
        return false;
      }
      console.log('✅ Supabase connection successful');
      return true;
    } catch (err) {
      console.error('Supabase connection error:', err);
      return false;
    }
  }
  
  async createJob(jobData: CreateJobData): Promise<Job | null> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .insert({
          user_id: jobData.user_id,
          original_command: jobData.original_command,
          parsed_intent: jobData.parsed_intent,
          job_type: jobData.job_type,
          status: 'queued',
          output: [],
          logs: {},
          retry_count: 0,
          max_retries: jobData.max_retries || 3
        })
        .select()
        .single();
      if (error) {
        console.error('Error creating job:', error);
        return null;
      }
      console.log(`✅ Job created: ${data.id}`);
      return data as Job;
    } catch (err) {
      console.error('Unexpected error creating job:', err);
      return null;
    }
  }
  
  async getJob(jobId: string): Promise<Job | null> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .single();
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
  
  async updateJobStatus(jobId: string, status: Job['status'], additionalData: Partial<Job> = {}): Promise<boolean> {
    try {
      const updateData: any = {
        status,
        updated_at: new Date().toISOString(),
        ...additionalData
      };
      if (status === 'running') {
        updateData.started_at = new Date().toISOString();
      } else if (['completed', 'failed', 'cancelled'].includes(status)) {
        updateData.completed_at = new Date().toISOString();
      }
      const { error } = await this.supabase
        .from('jobs')
        .update(updateData)
        .eq('id', jobId);
      if (error) {
        console.error('Error updating job status:', error);
        return false;
      }
      console.log(`✅ Job ${jobId} status updated to: ${status}`);
      return true;
    } catch (err) {
      console.error('Unexpected error updating job status:', err);
      return false;
    }
  }
  
  async appendJobOutput(jobId: string, outputLine: string): Promise<boolean> {
    try {
      const job = await this.getJob(jobId);
      if (!job) {
        return false;
      }
      const newOutput = [...job.output, outputLine];
      const { error } = await this.supabase
        .from('jobs')
        .update({
          output: newOutput,
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
      if (error) {
        console.error('Error appending job output:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Unexpected error appending job output:', err);
      return false;
    }
  }
  
  async getUserJobs(userId: string, limit: number = 50): Promise<Job[]> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .select('*')
        .eq('user_id', userId)
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
  
  getClient(): SupabaseClient {
    return this.supabase;
  }
}

// ✅ Export **only** named export
export const supabaseService = new SupabaseService();
