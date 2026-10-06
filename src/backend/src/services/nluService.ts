// src/backend/src/services/nluService.ts
import path from "path";
import fs from "fs";
import yaml from "yaml";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DEFAULT_HF_MODEL = (process.env.HF_MODEL || "facebook/bart-large-mnli").trim();
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || ".github/workflows/ops.yml";
// The legacy api-inference.huggingface.co endpoint was retired; use the HF router.
const HF_BASE_URL = (process.env.HF_BASE_URL || "https://router.huggingface.co/hf-inference/models").replace(/\/+$/, "");
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 8000);

export type ParsedIntent = {
  action: "deploy" | "rollback" | "scale" | "restart" | "logs" | "status" | "unknown";
  environment: string | null;
  service: string | null;
  replicas?: number;
  confidence: number;
  source: string;
  debug?: unknown;
  error?: string;
};

// ✅ Load service options directly from ops.yml
function loadServicesFromOps(): string[] {
  try {
    // Try cwd first, then the repo root (backend usually runs from src/backend)
    const candidates = [
      path.resolve(process.cwd(), WORKFLOW_FILE),
      path.resolve(__dirname, "../../../../", WORKFLOW_FILE),
    ];
    const wfPath = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
    const raw = fs.readFileSync(wfPath, "utf8");
    const doc = yaml.parse(raw);

    const inputs = doc?.on?.workflow_dispatch?.inputs?.service;
    if (inputs?.options && Array.isArray(inputs.options)) {
      const services = inputs.options.map((s: string) => s.toLowerCase().trim());
      console.log("[NLU] Loaded services from ops.yml:", services);
      return services;
    }
  } catch (err: any) {
    console.warn("[NLU] Could not load services from ops.yml:", err.message);
  }
  return [];
}

const VALID_SERVICES = loadServicesFromOps();

// ✅ Match user input against ops.yml service list
function extractServiceToken(command: string): string | null {
  if (!VALID_SERVICES.length) {return null;}

  const tokens = command.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean);

  // Exact match first
  for (const token of tokens) {
    if (VALID_SERVICES.includes(token)) {return token;}
  }

  // Partial prefix/suffix match
  for (const token of tokens) {
    const found = VALID_SERVICES.find(s => s.startsWith(token) || s.endsWith(token));
    if (found) {return found;}
  }

  return null;
}

export function regexParse(command: string): ParsedIntent {
  const c = command.toLowerCase();

  // Match environments
  const envPatterns = [
    /\b(?:to|in|on|for)\s+(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\b/,
    /\b(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\s+(?:env|environment)\b/,
    /\benv(?:ironment)?[:=]\s*(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\b/
  ];
  let environment: string | null = null;
  for (const pattern of envPatterns) {
    const match = c.match(pattern);
    if (match?.[1]) { environment = match[1]; break; }
  }

  const service = extractServiceToken(c);

  // Replicas
  const replicaPatterns = [
    /(\d+)\s*(?:replica|replicas|pods?|instances?)\b/,
    /\bto\s+(\d+)\s*(?:replica|replicas|pods?|instances?)?\b/,
    /\breplica(?:s|count)?[:=]\s*(\d+)\b/,
    /\bscale\b[^\d]*(\d+)\b/
  ];
  let replicas: number | undefined = undefined;
  for (const pattern of replicaPatterns) {
    const match = c.match(pattern);
    if (match?.[1]) {
      const num = Number(match[1]);
      if (num >= 0 && num <= 100) { replicas = num; break; }
    }
  }

  // Action detection
  const actionPatterns = [
    { pattern: /\b(?:roll\s*back|rollback)\b/, action: "rollback" as const },
    { pattern: /\bscale\b|\breplica\b|\bautoscal\b/, action: "scale" as const },
    { pattern: /\brestart\b|\breboot\b|\breload\b/, action: "restart" as const },
    { pattern: /\blog\b|\blogs\b|\btail\b/, action: "logs" as const },
    { pattern: /\bstatus\b|\bhealth\b|\bping\b|\bcheck\b/, action: "status" as const },
    { pattern: /\bdeploy\b|\brelease\b|\bship\b|\bpush\b/, action: "deploy" as const }
  ];
  let action: ParsedIntent["action"] = "unknown";
  for (const { pattern, action: act } of actionPatterns) {
    if (pattern.test(c)) { action = act; break; }
  }

  return { action, environment, service, replicas, confidence: 0.5, source: "regex" };
}

const ACTIONS = ["deploy","rollback","scale","restart","logs","status"] as const;

const ACTION_HYPOTHESES = [
  { action: "deploy",   hypothesis: "This is a request to deploy, ship, release, or push code to a service or environment." },
  { action: "rollback", hypothesis: "This is a request to roll back, revert, or undo a previous deployment." },
  { action: "scale",    hypothesis: "This is a request to scale, resize, or change the number of replicas or instances." },
  { action: "restart",  hypothesis: "This is a request to restart, reboot, or reload a service or application." },
  { action: "logs",     hypothesis: "This is a request to view, show, or tail logs from a service or application." },
  { action: "status",   hypothesis: "This is a request to check the status, health, or state of a service or system." },
] as const;

const ZERO_SHOT_LABELS = [
  { action: "deploy",   label: "deploy or release code" },
  { action: "rollback", label: "rollback or revert deployment" },
  { action: "scale",    label: "scale or resize service" },
  { action: "restart",  label: "restart or reboot service" },
  { action: "logs",     label: "view or show logs" },
  { action: "status",   label: "check status or health" },
] as const;

function isZeroShotModel(model: string) {
  const m = model.toLowerCase();
  return m.includes("bart-large-mnli") || m.includes("zero-shot");
}

async function fetchJson(url: string, body: any, apiKey: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HF_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : text;
    throw new Error(`HF ${res.status} for ${url.split("/").slice(-1)[0]}: ${detail || "Unknown error"}`);
  }
  return json;
}

async function nliEntailmentScore(premise: string, hypothesis: string, apiKey: string, model: string): Promise<number> {
  const url = `${HF_BASE_URL}/${model}`;
  let data = await fetchJson(url, {
    inputs: { text: premise, text_pair: hypothesis },
    parameters: { return_all_scores: true },
    options: { wait_for_model: true, use_cache: true },
  }, apiKey);

  if (!Array.isArray(data)) {
    data = await fetchJson(url, {
      inputs: `${premise} </s></s> ${hypothesis}`,
      parameters: { return_all_scores: true },
      options: { wait_for_model: true, use_cache: true },
    }, apiKey);
  }

  const labels: Array<{ label: string; score: number }> =
    Array.isArray(data) && Array.isArray(data[0]) ? data[0] :
    Array.isArray(data) ? data : [];

  return labels.find(x => /entail/i.test(x.label))?.score ?? 0;
}

async function zeroShotScores(input: string, apiKey: string, model: string) {
  const url = `${HF_BASE_URL}/${model}`;
  const labels = ZERO_SHOT_LABELS.map(z => z.label);
  const data = await fetchJson(url, {
    inputs: input,
    parameters: { candidate_labels: labels, hypothesis_template: "The user wants to {}.", multi_label: false },
    options: { wait_for_model: true, use_cache: true },
  }, apiKey);

  const out: Array<{ action: typeof ACTIONS[number]; score: number; label: string }> = [];
  // Router format: [{ label, score }]; legacy format: { labels: [], scores: [] }
  const pairs: Array<{ label: string; score: number }> =
    Array.isArray(data) ? data :
    Array.isArray(data?.labels) ? data.labels.map((label: string, i: number) => ({ label, score: data.scores?.[i] ?? 0 })) :
    [];
  for (const { label, score } of pairs) {
    const mapped = ZERO_SHOT_LABELS.find(z => z.label === label);
    if (mapped) {out.push({ action: mapped.action, score: score ?? 0, label });}
  }
  out.sort((a,b) => b.score - a.score);
  return out;
}

export async function parseCommand(opts: { command: string; hfApiKey: string | null; confidenceThreshold?: number; }): Promise<ParsedIntent> {
  const { command, hfApiKey, confidenceThreshold = 0.7 } = opts;
  const normalized = command.toLowerCase().trim();
  const coarse = regexParse(normalized);

  if (!hfApiKey) {
    console.log("[NLU] No HF API key provided, using regex fallback");
    return { ...coarse, source: "regex" };
  }

  const model = DEFAULT_HF_MODEL;
  console.log(`[NLU] Using model: ${model}, threshold: ${confidenceThreshold}`);

  try {
    let ranked: Array<{ action: typeof ACTIONS[number]; score: number; detail?: unknown }> = [];

    if (isZeroShotModel(model)) {
      console.log("[NLU] Using zero-shot classification");
      const z = await zeroShotScores(normalized, hfApiKey, model);
      ranked = z.map(({ action, score, label }) => ({ action, score, detail: { label } }));
      console.log("[NLU] Zero-shot results:", ranked.slice(0, 3));
    } else {
      console.log("[NLU] Using NLI classification");
      const scores = await Promise.all(
        ACTION_HYPOTHESES.map(async h => ({
          action: h.action,
          score: await nliEntailmentScore(normalized, h.hypothesis, hfApiKey, model),
          detail: { hypothesis: h.hypothesis },
        }))
      );
      scores.sort((a,b) => b.score - a.score);
      ranked = scores;
      console.log("[NLU] NLI results:", ranked.slice(0, 3));
    }

    const top = ranked[0];
    const accept = (top?.score ?? 0) >= confidenceThreshold;

    if (accept) {
      // Pick the top action, even if other actions are also above the threshold.
      return {
        action: top.action,
        environment: coarse.environment,
        service: coarse.service,
        replicas: coarse.replicas,
        confidence: Number((top.score ?? 0).toFixed(3)),
        source: `hf:${model}`,
        debug: { model, threshold: confidenceThreshold, rankedActions: ranked.slice(0, 6), validServices: VALID_SERVICES },
      };
    }

    // Fallback to regex if the top score is below the threshold.
    // The "regex-fallback" source serves as a flag for low confidence.
    return {
      action: coarse.action,
      environment: coarse.environment,
      service: coarse.service,
      replicas: coarse.replicas,
      confidence: Number((top?.score ?? 0).toFixed(3)),
      source: "regex-fallback",
      debug: { model, threshold: confidenceThreshold, rankedActions: ranked.slice(0, 6), validServices: VALID_SERVICES },
    };
  } catch (err: any) {
    console.error("[NLU] HF API error:", err.message);
    return { ...coarse, source: "regex-error-fallback", error: String(err), debug: { model } };
  }
}