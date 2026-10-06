// src/backend/src/app.ts - REST API. Parses commands and enqueues jobs; src/worker.ts executes them.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import dotenv from 'dotenv';

// ✅ CRITICAL FIX: Force load the same .env file as other modules
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { supabaseService, supabaseAdmin, type ExecutionMode } from './services/supabase';
import { commandParser, validateIntent } from './services/commandParser';
import { parseCommand as parseWithNLU, DEFAULT_CONFIDENCE_THRESHOLD } from './services/nluService';
import { JobWorker } from './worker';

const app = express();
const PORT = process.env.PORT || 3001;
const VERSION = process.env.npm_package_version || '1.0.0';
const TEST_USER_ID = process.env.TEST_USER_ID;

// Where jobs run: simulation | github_actions | kubernetes (USE_GITHUB_ACTIONS=true kept for compat)
const EXECUTION_MODES: ExecutionMode[] = ['simulation', 'github_actions', 'kubernetes'];
const DEFAULT_EXECUTION_MODE: ExecutionMode =
  (EXECUTION_MODES as string[]).includes(process.env.JOB_EXECUTOR ?? '')
    ? (process.env.JOB_EXECUTOR as ExecutionMode)
    : process.env.USE_GITHUB_ACTIONS === 'true' ? 'github_actions' : 'simulation';
const GITHUB_WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || 'ops.yml';

// The worker runs in-process by default; set RUN_WORKER=false and use `npm run worker` to split it out.
const worker = process.env.RUN_WORKER === 'false' ? null : new JobWorker();

// ---------- middleware ----------
app.use(helmet());
app.use(
  cors({
    origin: ['http://localhost:3000', 'https://localhost:3000', /^vscode-webview:\/\//],
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ---------- helpers ----------
function jsonError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
) {
  return res.status(status).json({ success: false, code, message, ...(extra || {}) });
}

// Infer action from raw text
function inferAction(command: string): 'deploy'|'scale'|'logs'|'restart'|'rollback'|'status'|null {
  const c = (command || '').toLowerCase();
  if (/\b(rollback|roll\s*back|revert)\b/.test(c)) {return 'rollback';}
  if (/\b(restart|reboot|bounce)\b/.test(c)) {return 'restart';}
  if (/\b(scale|autoscal(e|ing)|replicas?)\b/.test(c)) {return 'scale';}
  if (/\b(logs?|tail|stream)\b/.test(c)) {return 'logs';}
  if (/\b(status|health|uptime|state|ping|info)\b/.test(c)) {return 'status';}
  if (/\b(deploy|release|ship|push)\b/.test(c)) {return 'deploy';}
  return null;
}

function normalizeEnv(e?: string|null) {
  if (!e) {return e;}
  const m = { prod:'production', production:'production', staging:'staging', stage:'staging', dev:'development', development:'development', test:'test', qa:'qa' } as const;
  const k = e.toLowerCase();
  return (m as any)[k] || e;
}

// ✅ Enhanced user ID resolution with header support
function resolveUserId(req: express.Request, allowMissing = false): string | null {
  // Priority order: header → body → query → environment → null
  const headerUserId = req.get('X-DCH-User-Id') || req.get('x-dch-user-id');
  const bodyUserId = req.body?.user_id;
  const queryUserId = req.query?.user_id as string;
  
  const candidate = 
    (typeof headerUserId === 'string' && headerUserId.trim().length > 0 ? headerUserId.trim() : null) ||
    (typeof bodyUserId === 'string' && bodyUserId.trim().length > 0 ? bodyUserId.trim() : null) ||
    (typeof queryUserId === 'string' && queryUserId.trim().length > 0 ? queryUserId.trim() : null) ||
    (TEST_USER_ID && TEST_USER_ID.trim().length > 0 ? TEST_USER_ID.trim() : null);

  console.log('[API] User ID resolution:', {
    header: Boolean(headerUserId),
    body: Boolean(bodyUserId),
    query: Boolean(queryUserId),
    env: Boolean(TEST_USER_ID),
    resolved: candidate ? candidate.slice(0, 8) + '...' : null
  });

  if (candidate) {
    return candidate;
  }
  
  if (allowMissing) {
    return null;
  }
  
  return null;
}

// ✅ Ensure user exists in users table before creating jobs
async function ensureUser(_userId: string, _displayName?: string): Promise<{ success: boolean; error?: string }> {
  // Day 8: no user table needed; don't block job creation
  return { success: true };
}

// ✅ Helper function to extract HF API key from request
function extractHfApiKey(req: express.Request): string | null {
  // Key from header (preferred) or environment.
  // Accept both X-HF-API-Key: hf_xxx and Authorization: Bearer hf_xxx.
  let hfApiKey: string | null =
    (req.get("X-HF-API-Key") || req.get("x-hf-api-key")) || null;
  const auth = req.get("Authorization") || req.get("authorization");
  if (!hfApiKey && auth && /^Bearer\s+hf_[A-Za-z0-9]+/.test(auth)) {
    hfApiKey = auth.replace(/^Bearer\s+/i, "").trim();
  }
  if (!hfApiKey && process.env.HF_API_KEY) {
    hfApiKey = process.env.HF_API_KEY;
  }
  return hfApiKey;
}

// ✅ Server-side client hints (simple heuristics)
function parseClientHints(command: string): { environment?: string; service?: string; replicas?: number } {
  const c = (command || '').toLowerCase();

  // environment
  let environment: string | undefined;
  if (/\b(prod|production)\b/.test(c)) {environment = 'production';}
  else if (/\b(staging)\b/.test(c)) {environment = 'staging';}
  else if (/\b(dev|development)\b/.test(c)) {environment = 'development';}
  else if (/\b(test)\b/.test(c)) {environment = 'test';}
  else if (/\bqa\b/.test(c)) {environment = 'qa';}

  // replicas (prefer explicit "replicas" phrases, then scale ... to N)
  let replicas: number | undefined;
  const m1 = c.match(/\breplicas?\b[^0-9]*?(\d{1,3})/);
  const m2 = c.match(/\bscale\b\s+\S+\s+\bto\b\s+(\d{1,3})\b/);
  const m3 = c.match(/\bto\s+(\d{1,3})\b\s*(?:replicas?|pods?)?/); // fallback
  const repRaw = (m1?.[1] ?? m2?.[1] ?? m3?.[1]);
  if (repRaw) {
    const n = parseInt(repRaw, 10);
    if (!Number.isNaN(n)) {replicas = n;}
  }

  // service (very light heuristics)
  let service: string | undefined;
  const s1 = c.match(/\b(?:for|of)\s+([a-z0-9._-]+(?:-service)?)\b/);
  const s2 = c.match(/\b([a-z0-9._-]+-service)\b/);
  const s3 = c.match(/\b(frontend|backend|api|gateway|database-service|notification-service|payment-service|user-service|auth-service)\b/);
  service = (s1?.[1] ?? s2?.[1] ?? s3?.[1]) as string | undefined;

  return { environment, service, replicas };
}

// ---------- health ----------
app.get('/health', async (_req, res) => {
  try {
    const dbStatus = await supabaseService.testConnection();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus ? 'connected' : 'disconnected',
      version: VERSION,
      executionMode: DEFAULT_EXECUTION_MODE,
      worker: worker ? worker.stats() : 'external (RUN_WORKER=false)',
    });
  } catch (error: any) {
    jsonError(res, 500, 'HEALTH_ERROR', error?.message || 'Unknown error');
  }
});

// ---------- api info ----------
app.get('/api', (_req, res) => {
  // ✅ Use the same default as nluService.ts
  const model = (process.env.HF_MODEL || 'facebook/bart-large-mnli').trim();
  const threshold = DEFAULT_CONFIDENCE_THRESHOLD;

  res.json({
    name: 'DevCommandHub API',
    version: VERSION,
    nlu: {
      hasEnvKey: Boolean(process.env.HF_API_KEY),
      model,
      threshold,
    },
    executionMode: DEFAULT_EXECUTION_MODE,
    github: {
      enabled: DEFAULT_EXECUTION_MODE === 'github_actions',
      workflowFile: GITHUB_WORKFLOW_FILE,
      hasEnvToken: Boolean(process.env.GITHUB_API_KEY),
      repoOwner: process.env.GH_REPO_OWNER,
      repoName: process.env.GH_REPO_NAME,
    },
    endpoints: {
      health: 'GET /health',
      commands: 'POST /api/commands',
      getJob: 'GET /api/jobs/:id',
      listJobs: 'GET /api/jobs',
      jobEvents: 'GET /api/jobs/:id/events',
      cancelJob: 'POST /api/jobs/:id/cancel',
      supportedCommands: 'GET /api/commands/supported',
      debugRole: 'GET /debug/role',
    },
    supportedCommands: commandParser.getSupportedCommands(),
  });
});

// ---------- supported commands ----------
app.get('/api/commands/supported', (_req, res) => {
  res.json({
    commands: commandParser.getSupportedCommands(),
    examples: [
      'deploy frontend to staging',
      'show logs for user-service',
      'scale api-service to 3',
      'rollback auth-service',
      'status of database-service',
    ],
  });
});

// ✅ FIXED: POST /api/commands with GitHub Actions integration
app.post('/api/commands', async (req, res) => {
  let parsedIntent: any = null; // Declare at top level to always be available

  try {
    const { command, enableNLU, confidenceThreshold, slotOverrides } = req.body;

    if (!command || typeof command !== 'string') {
      return jsonError(res, 400, 'BAD_REQUEST', 'Command is required and must be a string');
    }

    // ✅ Enhanced user ID resolution with proper header support
    const userId = resolveUserId(req);
    if (!userId) {
      return jsonError(
        res,
        400,
        'MISSING_USER_ID',
        'Provide user ID via X-DCH-User-Id header, request body user_id, or set TEST_USER_ID in .env'
      );
    }

    console.log('[API] Using userId:', userId.slice(0, 8) + '...');

    // ✅ Ensure user exists before creating job
    const userResult = await ensureUser(userId, req.get('X-DCH-User-Name'));
    if (!userResult.success) {
      console.warn('[API] ensureUser failed (ignored for Day 8):', userResult.error);
    }

    const hfApiKey = extractHfApiKey(req);

    const requestedMode = req.body?.execution_mode;
    if (requestedMode !== undefined && !(EXECUTION_MODES as string[]).includes(requestedMode)) {
      return jsonError(res, 400, 'BAD_REQUEST', `execution_mode must be one of: ${EXECUTION_MODES.join(', ')}`);
    }
    const executionMode: ExecutionMode = requestedMode ?? DEFAULT_EXECUTION_MODE;

    // Decide NLU usage + threshold
    const nluOn = typeof enableNLU === "boolean" ? enableNLU : true;
    const thresh =
      typeof confidenceThreshold === "number"
        ? confidenceThreshold
        : DEFAULT_CONFIDENCE_THRESHOLD;

    console.log('[NLU]', {
      headerKey: Boolean(req.get('X-HF-API-Key') || req.get('Authorization')),
      envKey: Boolean(process.env.HF_API_KEY),
      model: process.env.HF_MODEL,
      threshold: thresh,
      nluEnabled: nluOn,
    });

    // 🔎 Client hints + merge precedence
    const clientHints = parseClientHints(command);
    console.log('[API] Client hints:', clientHints);

    // Parse with NLU/regex
    // NLU off = grammar/regex only (same confidence gate, no model scores)
    parsedIntent = await parseWithNLU({ command, hfApiKey: nluOn ? hfApiKey : null, confidenceThreshold: thresh });

    console.log('[API] Initial parsed intent:', parsedIntent);

    // Merge client hints with parsed intent
    const mergedIntent = {
      ...parsedIntent,
      ...(clientHints.environment && !parsedIntent.environment ? { environment: clientHints.environment } : {}),
      ...(clientHints.service && !parsedIntent.service ? { service: clientHints.service } : {}),
      ...(typeof clientHints.replicas === 'number' ? { replicas: clientHints.replicas } : {}),
    };

    // Apply explicit slot overrides (highest precedence)
    const intent: any = { ...mergedIntent };
    const overrides = slotOverrides || {};
    if (typeof overrides.action === 'string' && overrides.action) {
      // An action the user explicitly picked counts as confirmation
      intent.action = overrides.action.toLowerCase();
      intent.needs_confirmation = false;
      intent.source = `${intent.source}+user-confirmed`;
    }
    if (overrides.service) { intent.service = String(overrides.service); }
    if (overrides.environment) { intent.environment = String(overrides.environment); }
    if (typeof overrides.replicas === 'number') { intent.replicas = Number(overrides.replicas); }

    console.log('[API] Final intent after merging:', intent);

    // Update parsedIntent to reflect all merging for response
    parsedIntent = intent;

    // Never silently execute an uncertain parse: make the user pick the action
    if (intent.needs_confirmation || intent.action === 'unknown') {
      const candidates = (intent.candidates ?? []) as Array<{ action: string; score: number }>;
      return res.status(422).json({
        success: false,
        code: 'LOW_CONFIDENCE',
        message: candidates.length
          ? `Not confident enough to run this (${Math.round((intent.confidence ?? 0) * 100)}% "${candidates[0].action}"). Which action did you mean?`
          : 'I could not tell which action you want. Which one did you mean?',
        suggested_action: candidates[0]?.action ?? null,
        candidates,
        parsed_intent: parsedIntent,
      });
    }

    // Validate required slots
    const { ok, missing } = validateIntent(intent);
    if (!ok) {
      // ✅ Return parsed_intent even on 422 slot-filling responses
      return res.status(422).json({
        success: false,
        code: 'MISSING_SLOT',
        message: intent.action === 'rollback'
          ? 'Which service should I roll back?'
          : `Missing required field(s): ${missing.join(', ')}`,
        missing,
        parsed_intent: parsedIntent, // ✅ Always include
      });
    }

    // Validate business logic using the class method
    const validation = commandParser.validateIntent(intent);
    if (!validation.valid) {
      return jsonError(res, 400, 'VALIDATION_ERROR', validation.error || 'Invalid intent', {
        parsed_intent: parsedIntent, // ✅ Always include
      });
    }

    // Create job – use an explicit result object to avoid TS confusion
    let createRes = await supabaseService.createJob({
      user_id: userId,
      original_command: command,
      parsed_intent: intent,
      job_type: intent.action,
      execution_mode: executionMode,
    });

    // jobs.user_id references auth.users; the extension sends a random per-install UUID
    // that won't exist there (FK violation 23503), so fall back to TEST_USER_ID.
    if (createRes.error?.code === '23503' && TEST_USER_ID && userId !== TEST_USER_ID) {
      console.warn('[API] user_id not found in auth.users, retrying with TEST_USER_ID');
      createRes = await supabaseService.createJob({
        user_id: TEST_USER_ID,
        original_command: command,
        parsed_intent: intent,
        job_type: intent.action,
        execution_mode: executionMode,
      });
    }

    if (createRes.error || !createRes.data) {
      console.error('Error creating job:', createRes.error);
      return jsonError(res, 500, 'INSERT_FAILED', 'Failed to create job', {
        db_error: createRes.error,
        parsed_intent: parsedIntent, // ✅ Always include even on errors
      });
    }

    const job = createRes.data;
    console.log(`[JOB ${job.id}] Queued (${executionMode})`);

    // Execution is asynchronous: the worker claims the job from the queue.
    return res.status(201).json({
      success: true,
      job_id: job.id,
      parsed_intent: parsedIntent,
      status: job.status,
      created_at: job.created_at,
      execution_method: executionMode,
    });

  } catch (error: any) {
    console.error('Error processing command:', error);
    // ✅ Include parsed_intent even in error responses if available
    return jsonError(res, 500, 'INTERNAL_ERROR', error?.message || 'Internal server error', {
      ...(parsedIntent ? { parsed_intent: parsedIntent } : {}),
    });
  }
});

// ---------- GET /api/jobs/:id ----------
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {return jsonError(res, 400, 'BAD_REQUEST', 'Job ID is required');}

    const job = await supabaseService.getJob(id);
    if (!job) {return jsonError(res, 404, 'NOT_FOUND', 'Job not found');}

    return res.json({
      success: true,
      job: {
        id: job.id,
        original_command: job.original_command,
        parsed_intent: job.parsed_intent,
        job_type: job.job_type,
        status: job.status,
        output: job.output || [],
        error_message: job.error_message,
        external_job_id: job.external_job_id,
        external_url: job.external_url,
        execution_mode: job.execution_mode,
        cancel_requested: job.cancel_requested,
        retry_count: job.retry_count,
        locked_by: job.locked_by,
        created_at: job.created_at,
        updated_at: job.updated_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
      },
    });
  } catch (error: any) {
    console.error('Error fetching job:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR', error?.message || 'Internal server error');
  }
});

// ---------- GET /api/jobs/:id/events (state machine history) ----------
app.get('/api/jobs/:id/events', async (req, res) => {
  const events = await supabaseService.getJobEvents(req.params.id);
  return res.json({ success: true, count: events.length, events });
});

// ---------- POST /api/jobs/:id/cancel ----------
app.post('/api/jobs/:id/cancel', async (req, res) => {
  try {
    const result = await supabaseService.requestCancel(req.params.id);
    if (result === 'not_found') {return jsonError(res, 404, 'NOT_FOUND', 'Job not found');}
    if (result === 'not_cancellable') {return jsonError(res, 409, 'NOT_CANCELLABLE', 'Job already finished');}
    return res.status(202).json({ success: true, result });
  } catch (error: any) {
    return jsonError(res, 500, 'INTERNAL_ERROR', error?.message || 'Internal server error');
  }
});

// ✅ FIXED: GET /api/jobs with proper user resolution
app.get('/api/jobs', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const lim = limit ? Math.min(parseInt(limit as string, 10) || 50, 100) : 50;

    // ✅ Get user_id using consistent resolution logic
    const userId = resolveUserId(req);
    if (!userId) {
      return jsonError(
        res,
        400,
        'MISSING_USER_ID',
        'Provide user ID via X-DCH-User-Id header, query param user_id, or set TEST_USER_ID in .env'
      );
    }

    const filtered = await supabaseService.getUserJobs(userId, lim, typeof status === 'string' ? status : undefined);

    return res.json({
      success: true,
      count: filtered.length,
      jobs: filtered.map((j: any) => ({
        id: j.id,
        original_command: j.original_command,
        job_type: j.job_type,
        status: j.status,
        created_at: j.created_at,
        updated_at: j.updated_at,
        completed_at: j.completed_at,
        execution_mode: j.execution_mode,
        external_job_id: j.external_job_id,
        external_url: j.external_url,
      })),
    });
  } catch (error: any) {
    console.error('Error listing jobs:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR', error?.message || 'Internal server error');
  }
});

// ---------- debug: role ----------
app.get('/debug/role', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('debug_auth');
    return res.json({ success: true, debug_auth: data || null, error: error || null });
  } catch (error: any) {
    return jsonError(res, 500, 'DEBUG_ROLE_ERROR', error?.message || 'Failed to run debug_auth()');
  }
});

// ---------- env debug ----------
app.get('/debug', (_req, res) => {
  res.json({
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'NOT SET',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET',
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'NOT SET',
      TEST_USER_ID: TEST_USER_ID ? 'SET' : 'NOT SET',
      HF_API_KEY: process.env.HF_API_KEY ? 'SET' : 'NOT SET',
      HF_MODEL: process.env.HF_MODEL || 'facebook/bart-large-mnli (default)',
      CONFIDENCE_THRESHOLD: process.env.CONFIDENCE_THRESHOLD || '0.4 (default)',
      JOB_EXECUTOR: DEFAULT_EXECUTION_MODE,
      RUN_WORKER: worker ? 'in-process' : 'external',
      GITHUB_API_KEY: process.env.GITHUB_API_KEY ? 'SET' : 'NOT SET',
      GH_REPO_OWNER: process.env.GH_REPO_OWNER || 'NOT SET',
      GH_REPO_NAME: process.env.GH_REPO_NAME || 'NOT SET',
      GH_WORKFLOW_FILE: GITHUB_WORKFLOW_FILE,
      GH_DEFAULT_REF: process.env.GH_DEFAULT_REF || 'main (default)',
    },
    timestamp: new Date().toISOString(),
  });
});

// ---------- 404 ----------
app.use('*', (req, res) => {
  return jsonError(res, 404, 'NOT_FOUND', 'Endpoint not found', {
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /health',
      'GET /api',
      'POST /api/commands',
      'GET /api/jobs/:id',
      'GET /api/jobs',
      'GET /api/jobs/:id/events',
      'POST /api/jobs/:id/cancel',
      'GET /api/commands/supported',
      'GET /debug/role',
      'GET /debug',
    ],
  });
});

// ---------- global error ----------
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  return jsonError(
    res,
    500,
    'INTERNAL_ERROR',
    process.env.NODE_ENV === 'development' ? err?.message : 'Something went wrong'
  );
});

// ---------- cleanup on shutdown ----------
async function shutdown(signal: string) {
  console.log(`${signal} received, re-queueing active jobs...`);
  await worker?.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🚀 DevCommandHub API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API info: http://localhost:${PORT}/api`);
  console.log(`🔎 Debug role:  http://localhost:${PORT}/debug/role`);
  console.log(`⚡ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Job executor: ${DEFAULT_EXECUTION_MODE}; worker: ${worker ? 'in-process' : 'external'}`);
  void worker?.start();
  if (DEFAULT_EXECUTION_MODE === 'github_actions') {
    console.log(`📋 Workflow file: ${GITHUB_WORKFLOW_FILE}`);
    console.log(`📦 Repository: ${process.env.GH_REPO_OWNER}/${process.env.GH_REPO_NAME}`);
  }
});

export default app;