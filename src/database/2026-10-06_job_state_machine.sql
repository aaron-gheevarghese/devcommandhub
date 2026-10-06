-- DevCommandHub: explicit job state machine, event log, worker queue + crash recovery
-- Run AFTER schema.sql. Safe to re-run.
--
--   queued ──claim──▶ running ──▶ completed
--     │                 │  ├────▶ failed
--     │                 │  └────▶ cancelled
--     │                 └─(stale heartbeat, retries left)─▶ queued
--     └──cancel──────────────────────────────────────────▶ cancelled
--
-- completed / failed / cancelled are terminal.

-- ---------- jobs: worker + execution columns ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'simulation';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_url TEXT;
-- Which GitHub repo the job acts on, and the user's GitHub token (AES-GCM encrypted by the
-- backend; cleared when the job finishes)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_repo TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_ref TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS github_token_enc TEXT;

-- The extension identifies users by a per-install UUID (there is no Supabase Auth login),
-- so user_id must not be tied to auth.users.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_user_id_fkey;
-- Legacy rows created before user ids were required get a placeholder owner
UPDATE jobs SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
ALTER TABLE jobs ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs (user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat ON jobs (heartbeat_at) WHERE status = 'running';

-- ---------- job_events: append-only transition log ----------
CREATE TABLE IF NOT EXISTS job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  worker_id TEXT,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id);
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;

-- ---------- transition guard ----------
CREATE OR REPLACE FUNCTION dch_valid_transition(from_s TEXT, to_s TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE from_s
    WHEN 'queued'  THEN to_s IN ('running', 'cancelled')
    WHEN 'running' THEN to_s IN ('completed', 'failed', 'cancelled', 'queued')
    ELSE FALSE  -- terminal states never change
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION dch_enforce_job_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT dch_valid_transition(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Invalid job transition % -> % for job %', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'running' THEN
      NEW.started_at := COALESCE(NEW.started_at, NOW());
      NEW.heartbeat_at := NOW();
    ELSIF NEW.status IN ('completed', 'failed', 'cancelled') THEN
      NEW.completed_at := NOW();
      NEW.locked_by := NULL;
    ELSIF NEW.status = 'queued' THEN
      NEW.locked_by := NULL;
      NEW.heartbeat_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_enforce_transition ON jobs;
CREATE TRIGGER jobs_enforce_transition
  BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION dch_enforce_job_transition();

CREATE OR REPLACE FUNCTION dch_log_job_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO job_events (job_id, from_status, to_status, message)
    VALUES (NEW.id, NULL, NEW.status, 'created');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO job_events (job_id, from_status, to_status, worker_id, message)
    VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW.locked_by, OLD.locked_by), NEW.error_message);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_log_event ON jobs;
CREATE TRIGGER jobs_log_event
  AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION dch_log_job_event();

-- ---------- worker queue ----------
-- Atomically claim the oldest queued job, skipping rows other workers hold and
-- users who already have p_max_per_user jobs running.
DROP FUNCTION IF EXISTS get_next_job();
CREATE OR REPLACE FUNCTION claim_next_job(p_worker_id TEXT, p_max_per_user INT DEFAULT 2)
RETURNS SETOF jobs AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs
  SET status = 'running', locked_by = p_worker_id
  WHERE id = (
    SELECT j.id FROM jobs j
    WHERE j.status = 'queued'
      AND (SELECT COUNT(*) FROM jobs r WHERE r.user_id = j.user_id AND r.status = 'running') < p_max_per_user
    ORDER BY j.priority DESC, j.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Running jobs whose worker stopped heartbeating (crash, kill -9, laptop closed) are
-- re-queued while retries remain, otherwise failed.
CREATE OR REPLACE FUNCTION recover_stale_jobs(p_stale_seconds INT DEFAULT 60)
RETURNS TABLE (job_id UUID, new_status TEXT) AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs
  SET status = CASE WHEN retry_count < max_retries AND NOT cancel_requested THEN 'queued'
                    WHEN cancel_requested THEN 'cancelled'
                    ELSE 'failed' END,
      retry_count = CASE WHEN retry_count < max_retries AND NOT cancel_requested THEN retry_count + 1 ELSE retry_count END,
      error_message = CASE WHEN retry_count < max_retries AND NOT cancel_requested
                           THEN 'Recovered after worker heartbeat lost (' || COALESCE(locked_by, 'unknown') || ')'
                           ELSE 'Worker heartbeat lost; retries exhausted' END
  WHERE status = 'running'
    AND COALESCE(heartbeat_at, started_at, updated_at) < NOW() - make_interval(secs => p_stale_seconds)
  RETURNING id, status;
END;
$$ LANGUAGE plpgsql;
