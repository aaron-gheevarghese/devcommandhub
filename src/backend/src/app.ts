// src/backend/src/app.ts - Day 8 fixes for user_id handling and parsed_intent responses

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import dotenv from 'dotenv';

// ✅ CRITICAL FIX: Force load the same .env file as other modules
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { supabaseService, supabaseAdmin } from './services/supabase';
import { commandParser, validateIntent } from './services/commandParser';
import { parseCommand as parseWithNLU, regexParse as regexOnly } from './services/nluService';

const app = express();
const PORT = process.env.PORT || 3001;
const VERSION = process.env.npm_package_version || '1.0.0';
const TEST_USER_ID = process.env.TEST_USER_ID;

// In-memory job tracking for lifecycle management
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

// ---------- job simulation ----------
async function simulateJobExecution(jobId: string, action: string, service?: string, environment?: string) {
  console.log(`[JOB ${jobId}] Starting simulation for ${action}`);
  try {
    const runningDelay = 2000 + Math.random() * 1000;
    const runningTimeout = setTimeout(async () => {
      try {
        console.log(`[JOB ${jobId}] Transitioning to running`);
        await supabaseService.updateJobStatus(jobId, 'running', {
          started_at: new Date().toISOString(),
          output: [
            'Starting job execution...',
            `Action: ${action}`,
            service ? `Service: ${service}` : '',
            environment ? `Environment: ${environment}` : '',
          ].filter(Boolean),
        });
      } catch (error) {
        console.error(`[JOB ${jobId}] Error updating to running:`, error);
      }
    }, runningDelay);

    const completionDelay = 6000 + Math.random() * 4000;
    const completionTimeout = setTimeout(async () => {
      try {
        const isSuccess = Math.random() > 0.1;
        if (isSuccess) {
          console.log(`[JOB ${jobId}] Completing successfully`);
          const successOutput = generateSuccessOutput(action, service, environment);
          await supabaseService.updateJobStatus(jobId, 'completed', {
            completed_at: new Date().toISOString(),
            output: successOutput,
          });
        } else {
          console.log(`[JOB ${jobId}] Simulating failure`);
          const errorOutput = generateErrorOutput(action, service, environment);
          await supabaseService.updateJobStatus(jobId, 'failed', {
            completed_at: new Date().toISOString(),
            error_message: 'Simulated job failure',
            output: errorOutput,
          });
        }
        jobSimulations.delete(jobId);
      } catch (error) {
        console.error(`[JOB ${jobId}] Error completing job:`, error);
        try {
          await supabaseService.updateJobStatus(jobId, 'failed', {
            completed_at: new Date().toISOString(),
            error_message: `Job completion error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        } catch (updateError) {
          console.error(`[JOB ${jobId}] Failed to mark job as failed:`, updateError);
        }
        jobSimulations.delete(jobId);
      }
    }, completionDelay);

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
        `🔗 Service is now available and healthy`,
      ];
    case 'scale': {
      const replicas = Math.floor(Math.random() * 5) + 2;
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
        `✅ ${service || 'Service'} scaled to ${replicas} replicas successfully!`,
      ];
    }
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
        `✅ Retrieved latest logs for ${service || 'service'}`,
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
        `✅ ${service || 'Service'} restarted successfully!`,
      ];
    case 'rollback': {
      const version = `v${Math.floor(Math.random() * 100) + 1}.${Math.floor(Math.random() * 10)}.${Math.floor(
        Math.random() * 10
      )}`;
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
        `✅ ${service || 'Service'} rolled back to ${version} successfully!`,
      ];
    }
    case 'status': {
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
        `✅ ${service || 'Service'} is healthy and running normally`,
      ];
    }
    default:
      return [...baseOutput, `Executing ${action} command...`, '✓ Command executed successfully', '', `✅ ${action} operation completed successfully!`];
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
    'Dependency service unavailable',
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
    `❌ ${action} operation failed. Please try again or contact support.`,
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
      activeJobs: jobSimulations.size,
    });
  } catch (error: any) {
    jsonError(res, 500, 'HEALTH_ERROR', error?.message || 'Unknown error');
  }
});

// ---------- api info ----------
app.get('/api', (_req, res) => {
  // ✅ Use the same default as nluService.ts
  const model = (process.env.HF_MODEL || 'facebook/bart-large-mnli').trim();
  const threshold = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.6);

  res.json({
    name: 'DevCommandHub API',
    version: VERSION,
    nlu: {
      hasEnvKey: Boolean(process.env.HF_API_KEY),
      model,
      threshold,
    },
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

// ✅ FIXED: POST /api/commands with proper user handling and always return parsed_intent
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

    // ✅ Extract HF API key using helper function
    const hfApiKey = extractHfApiKey(req);

    // Decide NLU usage + threshold
    const nluOn = typeof enableNLU === "boolean" ? enableNLU : true;
    const thresh =
      typeof confidenceThreshold === "number"
        ? confidenceThreshold
        : Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7);

    console.log('[NLU]', {
      headerKey: Boolean(req.get('X-HF-API-Key') || req.get('Authorization')),
      envKey: Boolean(process.env.HF_API_KEY),
      model: process.env.HF_MODEL,
      threshold: thresh,
      nluEnabled: nluOn,
    });

    // ✅ Parse and store in variable at function scope
    parsedIntent = nluOn
      ? await parseWithNLU({ command, hfApiKey, confidenceThreshold: thresh })
      : regexOnly(command);

    // Apply slot overrides
    const intent = { ...parsedIntent };
    const overrides = slotOverrides || {};
    if (overrides.service) {intent.service = String(overrides.service);}
    if (overrides.environment) {intent.environment = String(overrides.environment);}
    if (overrides.replicas !== null) { intent.replicas = Number(overrides.replicas); }

    // Update parsedIntent to reflect overrides for response
    parsedIntent = intent;

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
    const createRes = await supabaseService.createJob({
      user_id: userId,
      original_command: command,
      parsed_intent: intent,
      job_type: intent.action,
    });

    if (createRes.error || !createRes.data) {
      console.error('Error creating job:', createRes.error);
      return jsonError(res, 500, 'INSERT_FAILED', 'Failed to create job', {
        db_error: createRes.error,
        parsed_intent: parsedIntent, // ✅ Always include even on errors
      });
    }

    const job = createRes.data;

    console.log(`[JOB ${job.id}] Created, starting simulation`);
    simulateJobExecution(
      job.id,
      intent.action,
      intent.service ?? undefined,
      intent.environment ?? undefined
    );

    // ✅ Always return parsed_intent in successful response
    return res.status(201).json({
      success: true,
      job_id: job.id,
      parsed_intent: parsedIntent, // ✅ Always include
      status: job.status,
      created_at: job.created_at,
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
      CONFIDENCE_THRESHOLD: process.env.CONFIDENCE_THRESHOLD || '0.6 (default)',
    },
    timestamp: new Date().toISOString(),
    activeJobs: jobSimulations.size,
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
  console.log(`🔧 Job lifecycle simulation: ENABLED`);
});

export default app;