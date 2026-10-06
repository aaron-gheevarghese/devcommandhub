// src/backend/src/executors/simulation.ts
// Fake executor for demos without GitHub/Kubernetes access. Output is canned.
import type { Executor, ExecutionContext, ExecutionResult } from './types';

const FAILURE_RATE = Number(process.env.SIMULATION_FAILURE_RATE ?? 0.1);

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {return reject(signal.reason);}
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

export const simulationExecutor: Executor = {
  mode: 'simulation',
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { action, service, environment } = ctx.intent;
    ctx.log('⚠️ SIMULATION MODE: no real infrastructure is touched (set JOB_EXECUTOR to change)');
    await sleep(2000 + Math.random() * 1000, ctx.signal);
    ctx.log('Starting job execution...', `Action: ${action}`);
    await sleep(4000 + Math.random() * 3000, ctx.signal);

    if (Math.random() < FAILURE_RATE) {
      ctx.log(...generateErrorOutput(action, service ?? undefined, environment ?? undefined).slice(2));
      return { success: false, error: 'Simulated job failure' };
    }
    ctx.log(...generateSuccessOutput(action, service ?? undefined, environment ?? undefined).slice(2));
    return { success: true };
  },
};

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
