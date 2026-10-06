// src/backend/src/executors/githubActions.ts
// Dispatches .github/workflows/devcommandhub.yml in the job's target repo (the user's repo).
// That stub calls the reusable dch-ops.yml workflow, which runs scripts/k8s-ops.sh against
// the repo's cluster (or a kind sandbox). Lines the script prints with the "DCH|" prefix are
// pulled back into the job output once the run finishes.
import { GitHubActionsService, mapGaToDchStatus } from '../services/githubService';
import { decryptToken } from '../services/tokenVault';
import type { Executor, ExecutionContext, ExecutionResult } from './types';

const WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || 'devcommandhub.yml';
const POLL_MS = Number(process.env.GH_POLL_INTERVAL_MS || 5000);
const RUN_TIMEOUT_MS = Number(process.env.GH_RUN_TIMEOUT_MS || 20 * 60 * 1000);

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Keep only the script's "DCH|" lines, without GitHub's timestamp prefix. */
export function extractDchLines(rawLogs: string): string[] {
  return rawLogs
    .split(/\r?\n/)
    .map(l => l.match(/DCH\| ?(.*)$/)?.[1])
    .filter((l): l is string => l !== undefined);
}

export const githubActionsExecutor: Executor = {
  mode: 'github_actions',
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { job, intent, signal } = ctx;
    // Target repo: the user's repo sent by the extension, else the one configured in .env
    const [owner, repo] = (job.target_repo || `${process.env.GH_REPO_OWNER}/${process.env.GH_REPO_NAME}`).split('/');
    const gh = new GitHubActionsService(undefined, owner, repo);
    // The user's own GitHub token (from VS Code sign-in), else GITHUB_API_KEY from .env
    await gh.authenticate(job.github_token_enc ? decryptToken(job.github_token_enc) : undefined);
    gh.setRef(job.target_ref || await gh.getDefaultBranch());

    const inputs = {
      job_id: job.id,
      action: intent.action,
      service: intent.service || '',
      environment: intent.environment || 'development',
      replicas: intent.replicas != null ? String(intent.replicas) : '',
      tail: String(intent.parameters?.tail ?? 100),
      original_command: job.original_command.slice(0, 200),
    };

    try {
      await gh.dispatch(WORKFLOW_FILE, inputs);
    } catch (e: any) {
      if (e?.status === 404) {
        return { success: false, error: `${owner}/${repo} has no .github/workflows/${WORKFLOW_FILE} on its default branch. Run "DevCommandHub: Set Up This Repo" in VS Code, then commit and push.` };
      }
      throw e;
    }
    ctx.log(`Dispatched ${WORKFLOW_FILE} in ${owner}/${repo}`, 'Waiting for the run to start...');

    const run = await gh.findRunByName(WORKFLOW_FILE, `DCH ${job.id} `);
    const url = gh.getRunHtmlUrl(run);
    await ctx.setExternal(String(run.id), url);
    ctx.log(`Run #${run.run_number}: ${url}`);

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let lastStatus = '';
    let current: any = run;
    while (true) {
      if (signal.aborted) {
        ctx.log('Cancelling GitHub Actions run...');
        await gh.cancelRun(run.id).catch(e => ctx.log(`Cancel request failed: ${e.message}`));
        return { success: false, error: 'Cancelled' };
      }
      if (Date.now() > deadline) {
        await gh.cancelRun(run.id).catch(() => undefined);
        return { success: false, error: `Workflow run exceeded ${Math.round(RUN_TIMEOUT_MS / 60000)} min timeout` };
      }

      current = await gh.getRun(run.id);
      if (current.status !== lastStatus) {
        ctx.log(`Run status: ${current.status}`);
        lastStatus = current.status ?? '';
      }
      if (mapGaToDchStatus(current.status as any, current.conclusion as any) !== 'running') {break;}
      await sleep(POLL_MS, signal);
    }

    let failureReason: string | undefined;
    try {
      const lines = extractDchLines(await gh.getRunLogs(run.id));
      if (lines.length) {ctx.log('', '--- kubectl output ---', ...lines);}
      failureReason = [...lines].reverse().find(l => l.startsWith('❌'))?.replace(/^❌\s*/, '');
    } catch (e: any) {
      ctx.log(`(could not fetch run logs: ${e.message})`);
    }

    const final = mapGaToDchStatus(current.status as any, current.conclusion as any);
    if (final === 'completed') {return { success: true };}
    return { success: false, error: failureReason ?? `Workflow run ${current.conclusion ?? 'failed'}: ${url}` };
  },
};
