// src/backend/src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { supabaseService } from './services/supabase';
import { commandParser, ParsedIntent } from './services/commandParser';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://localhost:3000',
    /^vscode-webview:\/\//
  ],
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbStatus = await supabaseService.testConnection();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus ? 'connected' : 'disconnected',
      version: process.env.npm_package_version || '1.0.0'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'DevCommandHub API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      commands: 'POST /api/commands',
      getJob: 'GET /api/jobs/:id',
      listJobs: 'GET /api/jobs',
      supportedCommands: 'GET /api/commands/supported'
    },
    supportedCommands: commandParser.getSupportedCommands()
  });
});

// Get supported commands
app.get('/api/commands/supported', (req, res) => {
  res.json({
    commands: commandParser.getSupportedCommands(),
    examples: [
      'deploy frontend to staging',
      'show logs for user-service',
      'scale api-service to 3',
      'rollback auth-service',
      'status of database-service'
    ]
  });
});

// Process natural language commands
app.post('/api/commands', async (req, res) => {
  try {
    const { command, user_id } = req.body;

    // Validation
    if (!command || typeof command !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Command is required and must be a string'
      });
    }

    // For now, use a default user_id if not provided (later we'll get from auth)
    const userId = user_id || '00000000-0000-0000-0000-000000000000';

    // Parse the command
    const parseResult = commandParser.parseCommand(command);
    
    if (!parseResult.success || !parseResult.intent) {
      return res.status(400).json({
        success: false,
        error: parseResult.error || 'Failed to parse command',
        suggestions: commandParser.getSupportedCommands()
      });
    }

    // Validate the parsed intent
    const validation = commandParser.validateIntent(parseResult.intent);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
        parsed_intent: parseResult.intent
      });
    }

    // Create job in database - matching your existing supabaseService interface
    const job = await supabaseService.createJob({
      user_id: userId,
      original_command: command,
      parsed_intent: parseResult.intent,
      job_type: parseResult.intent.action
      // Note: removed 'status' as it's not in your CreateJobData interface
    });

    if (!job) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create job'
      });
    }

    res.status(201).json({
      success: true,
      job_id: job.id,
      command: command,
      parsed_intent: parseResult.intent,
      status: job.status,
      created_at: job.created_at
    });

  } catch (error) {
    console.error('Error processing command:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get specific job by ID
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Job ID is required'
      });
    }

    // Use your existing getJob method (single parameter)
    const job = await supabaseService.getJob(id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
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
        completed_at: job.completed_at
      }
    });

  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List jobs for user
app.get('/api/jobs', async (req, res) => {
  try {
    const { user_id, limit, status } = req.query;

    // For now, use default user_id if not provided
    const userId = (user_id as string) || '00000000-0000-0000-0000-000000000000';

    const jobs = await supabaseService.getUserJobs(
      userId, 
      limit ? parseInt(limit as string, 10) : 50
    );

    // Filter by status if provided
    const filteredJobs = status 
      ? jobs.filter(job => job.status === status)
      : jobs;

    res.json({
      success: true,
      jobs: filteredJobs.map(job => ({
        id: job.id,
        original_command: job.original_command,
        job_type: job.job_type,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at
      })),
      count: filteredJobs.length
    });

  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Debug endpoint (temporary - remove in production)
app.get('/debug', (req, res) => {
  res.json({
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'NOT SET',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET',
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'NOT SET'
    },
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /health',
      'GET /api',
      'POST /api/commands',
      'GET /api/jobs/:id',
      'GET /api/jobs',
      'GET /api/commands/supported'
    ]
  });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 DevCommandHub API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API info: http://localhost:${PORT}/api`);
  console.log(`⚡ Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;