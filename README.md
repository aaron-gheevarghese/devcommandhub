# DevCommandHub

A personal VS Code extension that turns plain-English DevOps commands into real GitHub Actions and Kubernetes operations on the repo you have open.

```
"deploy web to staging"  →  GitHub Actions run in your repo  →  kubectl rollout  →  result in the chat panel
```

DevCommandHub is a **personal tool**: the backend runs on your own machine (`localhost:3001`) and acts with your GitHub sign-in. It has no hosted service or multi-user login.

## What it does

- **Chat panel in VS Code** (`Cmd+Shift+D`). You type a command, and a job card shows its status, the parse, a link to the GitHub Actions run, live output and a Cancel button.
- **Six operations** on any service in your repo: `deploy`, `scale`, `restart`, `rollback`, `logs` and `status`.
- **Runs in your own repo.** The extension reads the open workspace's GitHub remote and signs in with VS Code's built-in GitHub auth. A small workflow in your repo calls this repo's reusable workflow, which builds your images and runs `kubectl`.
- **Real or sandbox cluster.** With a `KUBECONFIG` repo secret it deploys to your cluster and pushes images to GHCR. Without one, each run spins up a throwaway [kind](https://kind.sigs.k8s.io/) cluster on the GitHub runner.
- **Intent parsing with a confidence gate.** Zero-shot classification (`facebook/bart-large-mnli`) plus a strict grammar fallback. Commands it isn't sure about are never run silently; you pick the action from a list instead.
- **Durable job queue.** Jobs live in Supabase with a database-enforced state machine. A worker claims them, sends heartbeats, honors cancellation, limits concurrent jobs per user, and recovers jobs after a crash.

## Architecture

```
┌──────────────── VS Code ────────────────┐
│ Chat webview  ⇄  extension (src/)       │  repo + services + GitHub token
└──────────────────────┬──────────────────┘
                       │ POST /api/commands
┌──────────────── Backend (src/backend) ──┴──────────────────────────────┐
│ Express API ─ parse (HF zero-shot + grammar) ─ confidence gate          │
│      │ enqueue                                                          │
│      ▼                                                                  │
│ Supabase: jobs + job_events (DB-enforced state machine)                 │
│      ▲ claim_next_job (SKIP LOCKED, per-user limit) / heartbeat         │
│ Worker ─ executor: github_actions | kubernetes | simulation             │
└──────┬──────────────────────────────────────────────────────────────────┘
       │ workflow_dispatch (as the signed-in user)
┌──────▼────────── Your repo ─────────────────────────────────────────────┐
│ .github/workflows/devcommandhub.yml  (stub)                             │
│   └─ uses aaron-gheevarghese/devcommandhub/.github/workflows/dch-ops.yml│
│        └─ scripts/k8s-ops.sh: docker build → kind/GHCR → kubectl         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Job state machine

```
queued ──claim──▶ running ──▶ completed
  │                 │  ├────▶ failed
  │                 │  └────▶ cancelled
  │                 └─(heartbeat lost, retries left)─▶ queued
  └──cancel────────────────────────────────────────▶ cancelled
```

A trigger in Postgres enforces these transitions, so illegal moves such as `cancelled → running` or `queued → completed` are rejected by the database itself. A second trigger records every transition in `job_events`.

## Setup

### Prerequisites

- Node.js 20+ and VS Code 1.102+
- A [Supabase](https://supabase.com) project (the free tier is fine)
- A [Hugging Face](https://huggingface.co/settings/tokens) access token (optional; without one, only exact grammar matches run)
- A GitHub account. Repos you target need GitHub Actions enabled.

### 1. Install

```bash
npm install
cd src/backend && npm install
```

### 2. Database

In the Supabase dashboard, open **SQL Editor** and run these two files in order:

1. `src/database/schema.sql`: the `jobs` table
2. `src/database/2026-10-06_job_state_machine.sql`: the state machine, `job_events`, the worker queue functions and crash recovery

Both are safe to re-run.

### 3. Configure the backend

```bash
cp src/backend/.env.example src/backend/.env
```

Fill in at least `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the **service_role** key) and `HF_API_KEY`. Every variable is documented in [`.env.example`](src/backend/.env.example).

### 4. Run

```bash
cd src/backend && npm run dev
```

Then open this folder in VS Code and press **F5**. An **Extension Development Host** window opens with the extension loaded.

## Using it on a repo

1. In the Extension Development Host window, open a project that is a GitHub repo with at least one `Dockerfile`.
2. Run **DevCommandHub: Set Up This Repo** from the Command Palette. It adds two files and never overwrites existing ones:
   - `.github/workflows/devcommandhub.yml`: the workflow the backend dispatches
   - `.devcommandhub.yml`: your services (one per `Dockerfile` found)
3. Review `.devcommandhub.yml`, then commit and push both files to your default branch.
4. Press `Cmd+Shift+D` and type a command. Sign in to GitHub when VS Code asks.

### Example commands

| Command | Does |
|---|---|
| `deploy web to staging` | build image → apply → `kubectl rollout status` |
| `scale api to 3 replicas` | `kubectl scale` |
| `restart api in production` | `kubectl rollout restart` |
| `rollback web` | `kubectl rollout undo` to the previous revision |
| `show logs for api` | `kubectl logs` across the deployment's pods |
| `status of web` | deployment, pods and rollout history |

If a command is missing something, such as which service or how many replicas, the extension asks for it. If the parser isn't confident, it asks you to pick the action.

### `.devcommandhub.yml`

```yaml
services:
  api:
    context: services/api        # docker build context
    dockerfile: Dockerfile       # relative to context (default: Dockerfile)
    manifests: k8s/api           # optional k8s dir, applied on deploy; `image: DCH_IMAGE` is replaced
    deployment: api              # Deployment name in the cluster (default: service name)
    port: 8080                   # container port
  worker:
    context: .
    command: python -m workers.poller   # start command (services without manifests)
    env:                                # plain env vars (services without manifests)
      LOG_LEVEL: info
  cache:
    image: redis:7-alpine        # prebuilt image: nothing is built
environments:
  staging: { namespace: my-staging }     # default namespace: dch-<environment>
```

Environments accepted in commands: `development`, `staging`, `production`, `test`, `qa` and `uat`, plus aliases like `prod`, `stage` and `dev`.

### Cluster modes

| Mode | When | Images | Persists between commands |
|---|---|---|---|
| **Sandbox** | no `KUBECONFIG` secret | built and loaded into a kind cluster on the runner | No: each run starts fresh, and actions other than deploy first deploy the service (rollback deploys the previous commit first) |
| **Your cluster** | `KUBECONFIG` repo secret (raw or base64) | pushed to `ghcr.io/<owner>/<repo>/<service>` | Yes |

For your own cluster, the nodes must be able to pull from GHCR. Make the package public or add an image pull secret.

## Intent parsing results

Each command ends in one of two outcomes: the system **runs** an action, or it **asks** you. A decision counts as correct if it runs the labeled action, or asks when the command is out of scope ("write me a poem"). The threshold is chosen on the dev split and reported on the held-out test split.

110 hand-labeled commands (`src/backend/src/eval/intents.labeled.json`): 58 dev, 52 test, including 15 out-of-scope commands.

| Policy (test split, n=52) | Accuracy | Wrong executions |
|---|---|---|
| Regex only (original version) | 57.7% | 0 |
| Model top-1, no threshold | 78.8% | 11 |
| Model + confidence gate @ 0.40 | 78.8% | 5 |
| **Full pipeline (gate + required-slot check)** | **82.7%** | **1** |

Reproduce with `cd src/backend && npm run eval:intents`. Results are saved to `src/backend/src/eval/results.json`, and model scores are cached in `src/backend/src/eval/.cache/`.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/commands` | Parse and enqueue. `201` with `job_id`, `422 LOW_CONFIDENCE` / `MISSING_SLOT` when it needs your input |
| `GET /api/jobs/:id` | Job status, output, run link |
| `GET /api/jobs/:id/events` | State transition history |
| `POST /api/jobs/:id/cancel` | Cancel (immediately if queued; the worker stops it if running) |
| `GET /api/jobs` | Your recent jobs (`?status=`, `?limit=`) |
| `GET /health`, `GET /api` | Health, worker stats, configuration |

## Verification

```bash
cd src/backend
npm run verify:jobs              # job system against your Supabase project (~1 min)
npm run verify:jobs -- --github  # plus one real GitHub Actions + Kubernetes job (~3 min)
npm run eval:intents             # intent-parsing accuracy
```

`verify:jobs` starts its own API and worker processes and checks enqueueing, database-enforced transitions, cancelling queued and running jobs, per-user limits, crash recovery after `kill -9`, and re-queueing on graceful shutdown.

## Project structure

```
src/extension.ts                    VS Code extension + chat webview controller
media.html                          chat panel markup/styles
templates/devcommandhub-workflow.yml  stub added to user repos
.github/workflows/dch-ops.yml       reusable workflow (cluster setup + ops)
scripts/k8s-ops.sh                  kubectl operations driven by .devcommandhub.yml
services/, k8s/, .devcommandhub.yml demo services this repo deploys to itself
src/database/                       Supabase schema + state machine migration
src/backend/src/
  app.ts                            Express API
  worker.ts                         job worker (claim, heartbeat, cancel, recovery)
  executors/                        github_actions | kubernetes | simulation
  services/nluService.ts            zero-shot parsing + confidence gate
  services/commandParser.ts         strict grammar + required slots
  services/supabase.ts              job store / state transitions
  services/tokenVault.ts            AES-256-GCM encryption for stored GitHub tokens
  eval/                             labeled commands + evaluation script
src/backend/scripts/verifyJobSystem.ts
```

## Security notes

- Commands come from free text, so workflow inputs are passed as environment variables, never interpolated into scripts. `k8s-ops.sh` validates action, service, environment and replica values.
- The user's GitHub token is stored AES-256-GCM encrypted only while their job is queued or running, and is cleared when the job finishes.
- The API has no authentication and trusts the user ID the extension sends. That's fine for a personal tool on `localhost`; don't expose it publicly as-is.
- VS Code's GitHub sign-in requests the `repo` scope (GitHub offers no narrower OAuth scope). Without a `KUBECONFIG` secret, workflows only touch a throwaway cluster.

## Limitations

- Personal, local tool: no hosted backend, no login, single machine.
- Sandbox clusters don't persist between commands.
- The labeled set is small (52 test commands), so accuracy figures have wide error bars.
