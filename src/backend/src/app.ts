// src/backend/src/app.ts - Main Express Server
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
// Load environment variables
dotenv.config();

import { supabaseService } from './services/supabase';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet()); // Security headers
app.use(cors({
  origin: ['http://localhost:3000', 'vscode-webview://*'], // VS Code extension support
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic logging middleware
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint (with database test)
app.get('/health', async (req: express.Request, res: express.Response) => {
  const dbConnected = await supabaseService.testConnection();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'DevCommandHub API',
    version: '1.0.0',
    database: dbConnected ? 'connected' : 'disconnected'
  });
});

// API routes will go here
app.get('/api', (req: express.Request, res: express.Response) => {
  res.json({
    message: 'DevCommandHub API v1.0.0',
    endpoints: {
      health: 'GET /health',
      commands: 'POST /api/commands (coming soon!)'
    }
  });
});

// Temporary debug endpoint - REMOVE THIS LATER
app.get('/debug', (req: express.Request, res: express.Response) => {
  res.json({
    env_check: {
      has_supabase_url: !!process.env.SUPABASE_URL,
      has_supabase_service_key: !!process.env.SUPABASE_SERVICE_KEY,
      supabase_url_preview: process.env.SUPABASE_URL ? 
        process.env.SUPABASE_URL.substring(0, 30) + '...' : 'missing'
    }
  });
});

// 404 handler
app.use('*', (req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 DevCommandHub API running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🛠️ Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;