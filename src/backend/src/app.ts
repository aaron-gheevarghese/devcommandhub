// src/backend/src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { supabaseService, supabaseAdmin } from './services/supabase';
import { commandParser } from './services/commandParser';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const VERSION = process.env.npm_package_version || '1.0.0';
const TEST_USER_ID = process.env.TEST_USER_ID; // string | undefined

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

function resolveUserId(
  reqBodyUserId?: unknown,
  allowMissing = false
): { ok: true; userId: string } | { ok: false; res: express.Response; status: number } {
  // prefer body user_id if it's a non-empty string; else fall back to TEST_USER_ID
  const candidate =
    (typeof reqBodyUserId === 'string' && reqBodyUserId.trim().length > 0
      ? reqBodyUserId.trim()
      : undefined) ?? TEST_USER_ID;

  if (candidate && candidate.length > 0) {
    return { ok: true, userId: candidate };
  }

  if (allowMissing) {
    return { ok: true, userId: '' };
  }

  return {
    ok: false,
    res: {} as express.Response,
    status: 400,
  };
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
    });
  } catch (error: any) {
    jsonError(res, 500, 'HEALTH_ERROR', error?.message || 'Unknown error');
  }
});

// ---------- api info ----------
app.get('/api', (_req, res) => {
  res.json({
    name: 'DevCommandHub API',
    version: VERSION,
    endpoints: {
      health: 'GET /health',
      commands: 'POST /api/commands',
      getJob: 'GET /api/jobs/:id',
      listJobs: 'GET /api/jobs',
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

// ---------- core: POST /api/commands ----------
app.post('/api/commands', async (req, res) => {
  try {
    const { command, user_id } = req.body;

    if (!command || typeof command !== 'string') {
      return jsonError(res, 400, 'BAD_REQUEST', 'Command is required and must be a string');
    }

    // Require a real user id (no nulls). Either pass in request body or set TEST_USER_ID in .env
    const uid = resolveUserId(user_id);
    if (!uid.ok) {
      return jsonError(
        res,
        400,
        'MISSING_USER_ID',
        'Provide "user_id" in the request body or set TEST_USER_ID in your .env.'
      );
    }
    const userId = uid.userId; // string

    // Parse + validate
    const parseResult = commandParser.parseCommand(command);
    if (!parseResult.success || !parseResult.intent) {
      return jsonError(res, 400, 'PARSE_ERROR', parseResult.error || 'Failed to parse command', {
        suggestions: commandParser.getSupportedCommands(),
      });
    }
    const validation = commandParser.validateIntent(parseResult.intent);
    if (!validation.valid) {
      return jsonError(res, 400, 'VALIDATION_ERROR', validation.error || 'Invalid intent', {
        parsed_intent: parseResult.intent,
      });
    }

    // 🔎 Debug: check DB auth role on this code path using the raw admin client
    try {
      const { data: dbg, error: dbgErr } = await supabaseAdmin.rpc('debug_auth');
      console.log('DEBUG_AUTH RPC:', dbg || null, dbgErr || null);
    } catch (e) {
      console.warn('DEBUG_AUTH RPC failed:', e);
    }

    // Create job via your service (types expect string)
    const job = await supabaseService.createJob({
      user_id: userId,
      original_command: command,
      parsed_intent: parseResult.intent,
      job_type: parseResult.intent.action,
    });

    if (!job) {
      return jsonError(res, 500, 'INSERT_FAILED', 'Failed to create job');
    }

    return res.status(201).json({
      success: true,
      job_id: job.id,
      parsed_intent: parseResult.intent,
      status: job.status,
      created_at: job.created_at,
    });
  } catch (error: any) {
    console.error('Error processing command:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR', error?.message || 'Internal server error');
  }
});

// ---------- GET /api/jobs/:id ----------
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return jsonError(res, 400, 'BAD_REQUEST', 'Job ID is required');
    }

    const job = await supabaseService.getJob(id);
    if (!job) {
      return jsonError(res, 404, 'NOT_FOUND', 'Job not found');
    }

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

// ---------- GET /api/jobs (with basic filtering) ----------
app.get('/api/jobs', async (req, res) => {
  try {
    const { user_id, status, limit } = req.query;
    const lim = limit ? Math.min(parseInt(limit as string, 10) || 50, 100) : 50;

    const uid = resolveUserId(user_id, /* allowMissing */ false);
    if (!uid.ok) {
      return jsonError(
        res,
        400,
        'MISSING_USER_ID',
        'Provide "user_id" as a query param or set TEST_USER_ID in your .env.'
      );
    }
    const userId = uid.userId; // string

    const jobs = await supabaseService.getUserJobs(userId, lim);
    const filtered = status ? jobs.filter((j: any) => j.status === status) : jobs;

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

// ---------- env debug (safe) ----------
app.get('/debug', (_req, res) => {
  res.json({
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'NOT SET',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET',
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'NOT SET',
      TEST_USER_ID: TEST_USER_ID ? 'SET' : 'NOT SET',
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

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🚀 DevCommandHub API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API info: http://localhost:${PORT}/api`);
  console.log(`🔎 Debug role:  http://localhost:${PORT}/debug/role`);
  console.log(`⚡ Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
