CREATE EXTENSION IF NOT EXISITS "uuid-ossp";
CREATE TABLE IF NOT EXISTS jobs (
   id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
   user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,


   original_command TEXT NOT NULL,
   parsed_intent JSONB,


   status TEXT CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'queued',
   priority INTEGER DEFAULT 0,


   output TEXT[] DEFAULT '{}',
   error_message TEXT,
   logs JSONB DEFAULT '[]',


   job_type TEXT,
   external_job_id TEXT,
   retry_count INTEGER DEFAULT 0,
   max_retries INTEGER DEFAULT 3,


   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
   started_at TIMESTAMP WITH TIME ZONE,
   completed_at TIMESTAMP WITH TIME ZONE,


   config JSONB DEFAULT '{}',
);


CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at_ ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_job_id);


ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Users can view own jobs" ON jobs
   FOR SELECT USING (auth.uid() = user_id);


CREATE POLICY "Users can insert own jobs" ON jobs
   FOR INSERT WITH CHECK (auth.uid() = user_id);


CERATE POLICY "Users can update own jobs" ON jobs
   FOR UPDATE USING (auth.uid() = user_id);


CREATE POLICY "Users can delete own jobs" ON jobs
   FOR DELETE USING (auth.uid() = user_id);


CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE 'plpsql';


CREATE TRIGGER update_jobs_updated_at
   BEFORE UPDATE ON jobs
   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


CREATE OR REPLACE FUNCTION get_next_job()
RETURN SETOF jobs as $$
BEGIN
   RETURN QUERY
   UPDATE jobs
   SET status = 'running',
       started_at = NOW(),
       updated_at = NOW()
   WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
END;
$$ LANGUAGE plpgsql;