// src/backend/src/executors/kubernetes.ts
// Runs scripts/k8s-ops.sh locally against the current kubectl context
// (e.g. a kind/minikube cluster). Same script the GitHub Actions workflow runs.
import { spawn } from 'child_process';
import path from 'path';
import type { Executor, ExecutionContext, ExecutionResult } from './types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const OPS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'k8s-ops.sh');

export const kubernetesExecutor: Executor = {
  mode: 'kubernetes',
  execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { intent, signal } = ctx;
    const args = [
      OPS_SCRIPT,
      intent.action,
      intent.service || '',
      intent.environment || 'development',
      intent.replicas != null ? String(intent.replicas) : '',
      String(intent.parameters?.tail ?? 100),
    ];
    ctx.log(`$ scripts/k8s-ops.sh ${args.slice(1).filter(Boolean).join(' ')}`);

    return new Promise((resolve) => {
      const child = spawn('bash', args, { cwd: REPO_ROOT, env: { ...process.env, DCH_JOB_ID: ctx.job.id } });

      let partial = '';
      const onData = (buf: Buffer) => {
        const text = partial + buf.toString();
        const lines = text.split('\n');
        partial = lines.pop() ?? '';
        if (lines.length) {ctx.log(...lines);}
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const onAbort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ success: false, error: `Failed to start k8s-ops.sh: ${err.message}` });
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (partial) {ctx.log(partial);}
        if (signal.aborted) {return resolve({ success: false, error: 'Cancelled' });}
        resolve(code === 0 ? { success: true } : { success: false, error: `k8s-ops.sh exited with code ${code}` });
      });
    });
  },
};
