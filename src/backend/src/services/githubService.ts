// src/backend/src/services/githubActions.ts
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Octokit } from '@octokit/rest';

type GAStatus = 'queued'|'in_progress'|'completed';
type GAConclusion = 'success'|'failure'|'cancelled'|'timed_out'|'action_required'|null;

export function mapGaToDchStatus(gaStatus: GAStatus, gaConclusion: GAConclusion) {
  if (gaStatus === 'queued' || gaStatus === 'in_progress') {return 'running' as const;}
  if (gaStatus === 'completed') {
    if (gaConclusion === 'success') {return 'completed' as const;}
    if (gaConclusion === 'cancelled') {return 'cancelled' as const;}
    return 'failed' as const;
  }
  return 'queued' as const;
}

export class GitHubActionsService {
  private octokit: Octokit | null = null;
  private owner = process.env.GH_REPO_OWNER!;
  private repo  = process.env.GH_REPO_NAME!;
  private ref   = process.env.GH_DEFAULT_REF || 'main';

  async authenticate(token: string) {
    this.octokit = new Octokit({ auth: token });
    await this.octokit.rest.users.getAuthenticated();
  }

  // Dispatch a workflow by file name (e.g., "ops.yml") with inputs
  async dispatch(workflowFile: string, inputs: Record<string, any>, ref = this.ref) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner, repo: this.repo, workflow_id: workflowFile, ref, inputs
    });
  }

  async listWorkflows() {
  if (!this.octokit) {
    throw new Error('GitHub not authenticated');
  }
  const { data } = await this.octokit.rest.actions.listRepoWorkflows({
    owner: this.owner,
    repo: this.repo
  });
  return data.workflows || [];
}


  // Find the run we just started by its run-name ("DCH <jobId> — ...")
  async findRunByName(workflowFile: string, runName: string, tries = 12, delayMs = 1500) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    for (let i = 0; i < tries; i++) {
      const { data } = await this.octokit.rest.actions.listWorkflowRuns({
        owner: this.owner, repo: this.repo, workflow_id: workflowFile, event: 'workflow_dispatch', per_page: 30
      });
      const hit = data.workflow_runs?.find(r => r.name === runName);
      if (hit) {return hit;}
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Run not found by run-name (timeout)');
  }

  async getRun(runId: number) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    const { data } = await this.octokit.rest.actions.getWorkflowRun({
      owner: this.owner, repo: this.repo, run_id: runId
    });
    return data;
  }

  // We’ll just return the HTML logs page for simplicity; archive API returns a ZIP buffer
  getRunHtmlUrl(run: any) {
    return run?.html_url as string | undefined;
  }
}
