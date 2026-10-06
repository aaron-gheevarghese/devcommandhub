// src/backend/src/services/githubService.ts
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
  private owner: string;
  private repo: string;
  private ref: string;
  private workflowFile: string;

  constructor(token?: string, owner?: string, repo?: string, workflowFile?: string, branch?: string) {
    this.owner = owner || process.env.GH_REPO_OWNER!;
    this.repo = repo || process.env.GH_REPO_NAME!;
    this.ref = branch || process.env.GH_DEFAULT_REF || 'main';
    this.workflowFile = workflowFile || 'ops.yml';
    
    if (token) {
      this.octokit = new Octokit({ auth: token });
    }
  }

  async authenticate(token?: string) {
    const authToken = token || process.env.GITHUB_API_KEY || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!authToken) {
      throw new Error('GitHub token not provided or set in environment');
    }
    this.octokit = new Octokit({ auth: authToken });
    await this.octokit.rest.users.getAuthenticated();
  }

  async validateScopes() {
    if (!this.octokit) {throw new Error("GitHub not authenticated");}
    const { headers } = await this.octokit.request("GET /user");
    const scopes = headers["x-oauth-scopes"] || "";
    console.log("Token scopes:", scopes);
    if (!scopes.includes("repo")) {console.warn("❌ Missing repo scope");}
    if (!scopes.includes("workflow")) {console.warn("❌ Missing workflow scope");}
    return scopes;
  }

  async getWorkflows() {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    const { data } = await this.octokit.rest.actions.listRepoWorkflows({
      owner: this.owner,
      repo: this.repo
    });
    return data.workflows || [];
  }

  async getWorkflowDetails() {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    try {
      if (/^\d+$/.test(this.workflowFile)) {
        const { data } = await this.octokit.rest.actions.getWorkflow({
          owner: this.owner,
          repo: this.repo,
          workflow_id: parseInt(this.workflowFile, 10)
        });
        return data;
      } else {
        const { data } = await this.octokit.rest.actions.getWorkflow({
          owner: this.owner,
          repo: this.repo,
          workflow_id: this.workflowFile
        });
        return data;
      }
    } catch (error) {
      throw new Error(`Cannot find workflow '${this.workflowFile}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async dryRunDispatch(inputs: Record<string, any>) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    const workflow = await this.getWorkflowDetails();
    if (!workflow.state || workflow.state !== 'active') {
      throw new Error(`Workflow '${workflow.name}' is not active`);
    }
    return {
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      branch: this.ref,
      inputs: inputs,
      valid: true
    };
  }

  async dispatchWorkflow(inputs: Record<string, any>) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner,
      repo: this.repo,
      workflow_id: this.workflowFile,
      ref: this.ref,
      inputs
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    const { data } = await this.octokit.rest.actions.listWorkflowRuns({
      owner: this.owner,
      repo: this.repo,
      workflow_id: this.workflowFile,
      event: 'workflow_dispatch',
      per_page: 1
    });
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      return data.workflow_runs[0].id;
    }
    throw new Error('Could not find the dispatched run');
  }

  async dispatch(workflowFile: string, inputs: Record<string, any>, ref = this.ref) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner, repo: this.repo, workflow_id: workflowFile, ref, inputs
    });
  }

  async listWorkflows() {
    return this.getWorkflows();
  }

  async findRunByName(workflowFile: string, runName: string, tries = 12, delayMs = 1500) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    for (let i = 0; i < tries; i++) {
      const { data } = await this.octokit.rest.actions.listWorkflowRuns({
        owner: this.owner, repo: this.repo, workflow_id: workflowFile, event: 'workflow_dispatch', per_page: 10
      });
      const hit = data.workflow_runs?.find(r => r.name === runName || r.name?.startsWith(runName));
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

  async cancelRun(runId: number) {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    await this.octokit.rest.actions.cancelWorkflowRun({ owner: this.owner, repo: this.repo, run_id: runId });
  }

  /** Plain-text logs of every job in the run (GitHub serves them via a redirect Octokit follows). */
  async getRunLogs(runId: number): Promise<string> {
    if (!this.octokit) {throw new Error('GitHub not authenticated');}
    const { data } = await this.octokit.rest.actions.listJobsForWorkflowRun({
      owner: this.owner, repo: this.repo, run_id: runId,
    });
    const parts: string[] = [];
    for (const job of data.jobs) {
      const res = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner: this.owner, repo: this.repo, job_id: job.id,
      });
      parts.push(String(res.data));
    }
    return parts.join('\n');
  }

  getRunHtmlUrl(run: any) {
    return run?.html_url as string | undefined;
  }
}