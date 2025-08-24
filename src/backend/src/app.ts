// src/backend/src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { supabaseService, supabaseAdmin } from './services/supabase';
import { commandParser } from './services/commandParser';
// NEW
import { parseCommand as parseWithNLU, regexParse as regexOnly } from './services/nluService';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const VERSION = process.env.npm_package_version || '1.0.0';
const TEST_USER_ID = process.env.TEST_USER_ID; // string | undefined

// 🔧 NEW: In-memory job tracking for lifecycle management
const jobSimulations = new Map<string, NodeJS.Timeout>();

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

// 🔧 NEW: Job lifecycle simulation functions
async function simulateJobExecution(jobId: string, action: string, service?: string, environment?: string) {
  console.log(`[JOB ${jobId}] Starting simulation for ${action}`);
  
  try {
    // Phase 1: Transition to 'running' after 2-3 seconds
    const runningDelay = 2000 + Math.random() * 1000;
    const runningTimeout = setTimeout(async () => {
      try {
        console.log(`[JOB ${jobId}] Transitioning to running`);
        await supabaseService.updateJobStatus(jobId, 'running', {
          started_at: new Date().toISOString(),
          output: ['Starting job execution...', `Action: ${action}`, service ? `Service: ${service}` : '', environment ? `Environment: ${environment}` : ''].filter(Boolean)
        });
      } catch (error) {
        console.error(`[JOB ${jobId}] Error updating to running:`, error);
      }
    }, runningDelay);

    // Phase 2: Complete after 6-10 seconds total
    const completionDelay = 6000 + Math.random() * 4000;
    const completionTimeout = setTimeout(async () => {
      try {
        // 90% success rate, 10% failure for realistic simulation
        const isSuccess = Math.random() > 0.1;
        
        if (isSuccess) {
          console.log(`[JOB ${jobId}] Completing successfully`);
          const successOutput = generateSuccessOutput(action, service, environment);
          await supabaseService.updateJobStatus(jobId, 'completed', {
            completed_at: new Date().toISOString(),
            output: successOutput
          });
        } else {
          console.log(`[JOB ${jobId}] Simulating failure`);
          const errorOutput = generateErrorOutput(action, service, environment);
          await supabaseService.updateJobStatus(jobId, 'failed', {
            completed_at: new Date().toISOString(),
            error_message: 'Simulated job failure',
            output: errorOutput
          });
        }
        
        // Clean up tracking
        jobSimulations.delete(jobId);
      } catch (error) {
        console.error(`[JOB ${jobId}] Error completing job:`, error);
        // Try to mark as failed on error
        try {
          await supabaseService.updateJobStatus(jobId, 'failed', {
            completed_at: new Date().toISOString(),
            error_message: `Job completion error: ${error instanceof Error ? error.message : 'Unknown error'}`
          });
        } catch (updateError) {
          console.error(`[JOB ${jobId}] Failed to mark job as failed:`, updateError);
        }
        jobSimulations.delete(jobId);
      }
    }, completionDelay);

    // Store timeouts for cleanup if needed
    jobSimulations.set(jobId, completionTimeout);
    
  } catch (error) {
    console.error(`[JOB ${jobId}] Error in job simulation:`, error);
    jobSimulations.delete(jobId);
  }
}

function generateSuccessOutput(action: string, service?: string, environment?: string): string[] {
  const baseOutput = [
    'Starting job execution...',
    `Action: ${action}`,
    ...(service ? [`Service: ${service}`] : []),
    ...(environment ? [`Environment: ${environment}`] : []),
    '',
    'Executing command...',
  ];

  switch (action.toLowerCase()) {
    case 'deploy':
      return [
        ...baseOutput,
        'Building application...',
        '✓ Build completed successfully',
        'Uploading artifacts...',
        '✓ Upload completed',
        'Starting deployment...',
        '✓ Deployment completed successfully',
        '',
        `✅ ${service || 'Application'} deployed to ${environment || 'target environment'} successfully!`,
        `🔗 Service is now available and healthy`
      ];

    case 'scale':
      const replicas = Math.floor(Math.random() * 5) + 2; // 2-6 replicas
      return [
        ...baseOutput,
        `Scaling ${service || 'service'} to ${replicas} replicas...`,
        'Updating deployment configuration...',
        '✓ Configuration updated',
        'Starting new instances...',
        '✓ All instances started successfully',
        'Performing health checks...',
        '✓ All instances healthy',
        '',
        `✅ ${service || 'Service'} scaled to ${replicas} replicas successfully!`
      ];

    case 'logs':
      return [
        ...baseOutput,
        `Fetching logs for ${service || 'service'}...`,
        '✓ Connected to log stream',
        '',
        '--- Recent Log Entries ---',
        '[2024-01-15 10:30:15] INFO: Application started successfully',
        '[2024-01-15 10:30:20] INFO: Database connection established',
        '[2024-01-15 10:31:45] INFO: Processing user request',
        '[2024-01-15 10:32:10] INFO: Request completed successfully',
        '[2024-01-15 10:33:00] INFO: Health check passed',
        '',
        `✅ Retrieved latest logs for ${service || 'service'}`
      ];

    case 'restart':
      return [
        ...baseOutput,
        `Restarting ${service || 'service'}...`,
        'Gracefully stopping current instances...',
        '✓ All instances stopped',
        'Starting new instances...',
        '✓ New instances started',
        'Performing health checks...',
        '✓ All instances healthy',
        '',
        `✅ ${service || 'Service'} restarted successfully!`
      ];

    case 'rollback':
      const version = `v${Math.floor(Math.random() * 100) + 1}.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 10)}`;
      return [
        ...baseOutput,
        `Rolling back ${service || 'service'} to previous version...`,
        `Target version: ${version}`,
        'Stopping current deployment...',
        '✓ Current deployment stopped',
        'Deploying previous version...',
        '✓ Previous version deployed',
        'Performing health checks...',
        '✓ All instances healthy',
        '',
        `✅ ${service || 'Service'} rolled back to ${version} successfully!`
      ];

    case 'status':
      const uptime = `${Math.floor(Math.random() * 72) + 1}h ${Math.floor(Math.random() * 60)}m`;
      return [
        ...baseOutput,
        `Checking status of ${service || 'service'}...`,
        '',
        '--- Service Status ---',
        `Status: ✅ Healthy`,
        `Uptime: ${uptime}`,
        `Replicas: ${Math.floor(Math.random() * 5) + 1}/3 running`,
        `CPU Usage: ${Math.floor(Math.random() * 40) + 10}%`,
        `Memory Usage: ${Math.floor(Math.random() * 60) + 20}%`,
        `Last Deployment: ${new Date(Date.now() - Math.random() * 86400000 * 7).toLocaleString()}`,
        '',
        `✅ ${service || 'Service'} is healthy and running normally`
      ];

    default:
      return [
        ...baseOutput,
        `Executing ${action} command...`,
        '✓ Command executed successfully',
        '',
        `✅ ${action} operation completed successfully!`
      ];
  }
}

function generateErrorOutput(action: string, service?: string, environment?: string): string[] {
  const baseOutput = [
    'Starting job execution...',
    `Action: ${action}`,
    ...(service ? [`Service: ${service}`] : []),
    ...(environment ? [`Environment: ${environment}`] : []),
    '',
    'Executing command...',
  ];

  const errors = [
    'Connection timeout to target environment',
    'Insufficient permissions for operation',
    'Resource quota exceeded',
    'Service configuration validation failed',
    'Network connectivity issues',
    'Authentication token expired',
    'Target service not found',
    'Dependency service unavailable'
  ];

  const randomError = errors[Math.floor(Math.random() * errors.length)];

  return [
    ...baseOutput,
    'Attempting operation...',
    `❌ Error: ${randomError}`,
    '',
    'Troubleshooting steps:',
    '1. Check service configuration',
    '2. Verify network connectivity',
    '3. Confirm permissions and credentials',
    '4. Review service logs for details',
    '',
    `❌ ${action} operation failed. Please try again or contact support.`
  ];
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
      activeJobs: jobSimulations.size // 🔧 NEW: Show active job count
    });
  } catch (error: any) {
    jsonError(res, 500, 'HEALTH_ERROR', error?.message || 'Unknown error');
  }
});

// ---------- api info ----------
app.get('/health', async (_req, res) => {
  try {
    const dbStatus = await supabaseService.testConnection();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus ? 'connected' : 'disconnected',
      version: VERSION,
      nlu: {
        hasEnvKey: Boolean(process.env.HF_API_KEY),
        model: process.env.HF_MODEL || 'cross-encoder/nli-deberta-v3-base',
        threshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7),
      },
      activeJobs: jobSimulations.size,
    });
  } catch (error: any) {
    jsonError(res, 500, 'HEALTH_ERROR', error?.message || 'Unknown error');
  }
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

    // 🔧 NEW: Start job lifecycle simulation
    console.log(`[JOB ${job.id}] Created, starting simulation`);
    simulateJobExecution(
      job.id, 
      parseResult.intent.action,
      parseResult.intent.service,
      parseResult.intent.environment
    );

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
    activeJobs: jobSimulations.size, // 🔧 NEW: Show active job simulations
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

// 🔧 NEW: Graceful shutdown - clean up active job simulations
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up job simulations...');
  jobSimulations.forEach((timeout, jobId) => {
    clearTimeout(timeout);
    console.log(`Cancelled simulation for job ${jobId}`);
  });
  jobSimulations.clear();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up job simulations...');
  jobSimulations.forEach((timeout, jobId) => {
    clearTimeout(timeout);
    console.log(`Cancelled simulation for job ${jobId}`);
  });
  jobSimulations.clear();
  process.exit(0);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🚀 DevCommandHub API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API info: http://localhost:${PORT}/api`);
  console.log(`🔎 Debug role:  http://localhost:${PORT}/debug/role`);
  console.log(`⚡ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Job lifecycle simulation: ENABLED`);
});

export default app;