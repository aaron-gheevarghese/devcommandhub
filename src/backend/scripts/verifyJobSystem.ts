// src/backend/scripts/verifyJobSystem.ts
// End-to-end checks of the job state machine against the real Supabase database.
//   npm run verify:jobs            # simulation executor only (~1-2 min)
//   npm run verify:jobs -- --github  # also run one real GitHub Actions + Kubernetes job (~3 min)
// Spawns its own API / worker processes on port 3101 with fast timings.
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { supabaseAdmin } from '../src/services/supabase';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3101;
const API = `http://localhost:${PORT}`;
const TS_NODE = require.resolve('ts-node/dist/bin.js');
const FAST_ENV = {
  PORT: String(PORT),
  WORKER_POLL_INTERVAL: '500',
  MAX_JOBS_PER_USER: '2',
  MAX_CONCURRENT_JOBS: '6',
  JOB_STALE_SECONDS: '8',
  SIMULATION_FAILURE_RATE: '0',
  JOB_EXECUTOR: 'simulation',
};

let failures = 0;
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) {failures++;}
}

function start(script: string, env: Record<string, string> = {}): ChildProcess {
  const p = spawn('node', [TS_NODE, script], { cwd: ROOT, env: { ...process.env, ...FAST_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', d => { if (process.env.VERBOSE) {process.stdout.write(`  [${script}] ${d}`);} });
  p.stderr!.on('data', d => { if (process.env.VERBOSE) {process.stderr.write(`  [${script}] ${d}`);} });
  procs.push(p);
  return p;
}

async function stop(p: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (p.exitCode !== null) {return;}
  p.kill(signal);
  await new Promise(r => p.once('exit', r));
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${API}/health`)).ok) {return;} } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('API did not start');
}

async function submit(userId: string, command = 'deploy api to staging', mode = 'simulation') {
  const res = await fetch(`${API}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DCH-User-Id': userId },
    body: JSON.stringify({ command, execution_mode: mode }),
  });
  const body: any = await res.json();
  if (res.status !== 201) {throw new Error(`submit failed ${res.status}: ${JSON.stringify(body)}`);}
  return body.job_id as string;
}

async function job(id: string) {
  const { data } = await supabaseAdmin.from('jobs').select('*').eq('id', id).single();
  return data as any;
}

async function waitFor(id: string, pred: (j: any) => boolean, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = await job(id);
    if (pred(j)) {return j;}
    await sleep(400);
  }
  return job(id);
}

async function events(id: string) {
  const { data } = await supabaseAdmin.from('job_events').select('from_status,to_status').eq('job_id', id).order('id');
  return (data ?? []).map((e: any) => `${e.from_status ?? '∅'}→${e.to_status}`).join(', ');
}

async function main() {
  const user = randomUUID();

  // 1. Queue without a worker: the API only enqueues
  let api = start('src/app.ts', { RUN_WORKER: 'false' });
  await waitForApi();
  const queuedId = await submit(user);
  await sleep(2000);
  check('API enqueues without executing (no worker running)', (await job(queuedId)).status === 'queued');

  // 2. Cancel a queued job
  const cancelRes = await fetch(`${API}/api/jobs/${queuedId}/cancel`, { method: 'POST' });
  const cj = await job(queuedId);
  check('cancel queued job -> cancelled immediately', cancelRes.status === 202 && cj.status === 'cancelled', await events(queuedId));

  // 3. Illegal transitions are rejected by the database trigger
  const { error: illegal } = await supabaseAdmin.from('jobs').update({ status: 'running' }).eq('id', queuedId);
  check('DB rejects cancelled -> running', Boolean(illegal), illegal?.message.slice(0, 60));
  const { error: skip } = await supabaseAdmin.from('jobs').insert({ user_id: user, original_command: 'x', job_type: 'deploy', status: 'queued' }).select('id').single()
    .then(async ({ data }) => supabaseAdmin.from('jobs').update({ status: 'completed' }).eq('id', data!.id));
  check('DB rejects queued -> completed (must run first)', Boolean(skip), skip?.message.slice(0, 60));
  await stop(api);

  // 4. Happy path with the in-process worker + full event log
  api = start('src/app.ts');
  await waitForApi();
  const okId = await submit(user);
  const done = await waitFor(okId, j => ['completed', 'failed'].includes(j.status));
  const okEvents = await events(okId);
  check('job runs queued -> running -> completed', done.status === 'completed' && okEvents === '∅→queued, queued→running, running→completed', okEvents);
  check('worker recorded output, lease cleared', (done.output?.length ?? 0) > 3 && done.locked_by === null);

  // 5. Cancel a running job
  const runId = await submit(user);
  await waitFor(runId, j => j.status === 'running');
  await fetch(`${API}/api/jobs/${runId}/cancel`, { method: 'POST' });
  const cancelled = await waitFor(runId, j => j.status !== 'running', 20000);
  check('cancel running job -> worker stops it -> cancelled', cancelled.status === 'cancelled', await events(runId));

  // 6. Per-user concurrency limit (MAX_JOBS_PER_USER=2) while another user is unaffected
  const busy = randomUUID();
  const other = randomUUID();
  const busyIds = await Promise.all([1, 2, 3, 4].map(() => submit(busy)));
  const otherId = await submit(other);
  let maxRunning = 0;
  let otherRanEarly = false;
  for (let i = 0; i < 30; i++) {
    const { data } = await supabaseAdmin.from('jobs').select('id,status').in('id', [...busyIds, otherId]);
    const running = (data ?? []).filter((j: any) => busyIds.includes(j.id) && j.status === 'running').length;
    maxRunning = Math.max(maxRunning, running);
    if ((data ?? []).some((j: any) => j.id === otherId && j.status !== 'queued') && running === 2) {otherRanEarly = true;}
    if ((data ?? []).every((j: any) => j.status === 'completed')) {break;}
    await sleep(700);
  }
  check('per-user limit: at most 2 of one user\'s jobs run at once', maxRunning === 2, `max running = ${maxRunning}`);
  check('another user\'s job is not blocked by that user', otherRanEarly);
  for (const id of busyIds) {await waitFor(id, j => j.status === 'completed');}
  await stop(api);

  // 7. Crash recovery: kill -9 the worker mid-job; a new worker re-queues and finishes it
  api = start('src/app.ts', { RUN_WORKER: 'false' });
  await waitForApi();
  const workerA = start('src/worker.ts', { WORKER_ID: 'worker-A' });
  const crashId = await submit(user);
  await waitFor(crashId, j => j.status === 'running');
  await stop(workerA, 'SIGKILL');
  const workerB = start('src/worker.ts');
  const recovered = await waitFor(crashId, j => j.status === 'completed', 90000);
  const crashEvents = await events(crashId);
  check('crashed job recovered after missed heartbeats and completed', recovered.status === 'completed' && recovered.retry_count === 1, crashEvents);
  await stop(workerB);

  // 8. Graceful shutdown hands the running job back to the queue
  const workerC = start('src/worker.ts');
  const shutdownId = await submit(user);
  await waitFor(shutdownId, j => j.status === 'running');
  await stop(workerC, 'SIGTERM');
  const requeued = await job(shutdownId);
  check('graceful worker shutdown re-queues its job', requeued.status === 'queued' && requeued.retry_count === 0, await events(shutdownId));
  const workerD = start('src/worker.ts');
  const finished = await waitFor(shutdownId, j => j.status === 'completed');
  check('re-queued job is picked up by the next worker', finished.status === 'completed');
  await stop(workerD);

  // 9. Optional: one real GitHub Actions + Kubernetes job through the whole pipeline
  if (process.argv.includes('--github')) {
    const workerE = start('src/worker.ts');
    const ghId = await submit(user, 'scale api to 2 replicas in staging', 'github_actions');
    const gh = await waitFor(ghId, j => ['completed', 'failed'].includes(j.status), 10 * 60000);
    const out: string[] = gh.output ?? [];
    check('GitHub Actions job completed with kubectl output', gh.status === 'completed' && out.some(l => l.includes('scaled to 2/2')), gh.external_url ?? gh.error_message);
    await stop(workerE);
  }
  await stop(api);
}

main()
  .catch(e => { console.error('❌ verification crashed:', e.message); failures++; })
  .finally(async () => {
    for (const p of procs) {if (p.exitCode === null) {p.kill('SIGKILL');}}
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  });
