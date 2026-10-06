// src/backend/src/services/nluService.ts
import path from "path";
import fs from "fs";
import yaml from "yaml";
import dotenv from "dotenv";
import { commandParser } from "./commandParser";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DEFAULT_HF_MODEL = (process.env.HF_MODEL || "facebook/bart-large-mnli").trim();
// The legacy api-inference.huggingface.co endpoint was retired; use the HF router.
const HF_BASE_URL = (process.env.HF_BASE_URL || "https://router.huggingface.co/hf-inference/models").replace(/\/+$/, "");
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 8000);
const HF_MULTI_LABEL = process.env.HF_MULTI_LABEL === "true";
// Selected on the dev split by `npm run eval:intents` (see src/eval/results.json)
export const DEFAULT_CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.4);

export type ParsedIntent = {
  action: "deploy" | "rollback" | "scale" | "restart" | "logs" | "status" | "unknown";
  environment: string | null;
  service: string | null;
  replicas?: number;
  confidence: number;
  source: string;
  /** True when the parse is too uncertain to execute without the user picking an action. */
  needs_confirmation?: boolean;
  candidates?: RankedAction[];
  debug?: unknown;
  error?: string;
};

type Action = Exclude<ParsedIntent["action"], "unknown">;
/** "unknown" = the model's out-of-scope label */
export type RankedAction = { action: ParsedIntent["action"]; score: number };

/** Services declared in this repo's .devcommandhub.yml (fallback when the client sends none). */
function loadServicesFromConfig(): string[] {
  try {
    const doc = yaml.parse(fs.readFileSync(path.resolve(__dirname, "../../../../.devcommandhub.yml"), "utf8"));
    return Object.keys(doc?.services ?? {}).map(s => s.toLowerCase());
  } catch {
    return [];
  }
}

const VALID_SERVICES = loadServicesFromConfig();

// ✅ Match user input against ops.yml service list
function extractServiceToken(command: string, services: string[] = VALID_SERVICES): string | null {
  if (!services.length) {return null;}

  const tokens = command.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean);

  // Exact match first
  for (const token of tokens) {
    if (services.includes(token)) {return token;}
  }

  // Partial prefix/suffix match ("front" -> "frontend"); ignore short filler tokens
  for (const token of tokens.filter(t => t.length >= 3)) {
    const found = services.find(s => s.startsWith(token) || s.endsWith(token));
    if (found) {return found;}
  }

  return null;
}

export function regexParse(command: string, services?: string[]): ParsedIntent {
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

  const service = extractServiceToken(c, services?.length ? services : VALID_SERVICES);

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
  // Out-of-scope catch-all: lets the model say "none of the above" instead of forcing an action
  { action: "unknown",  label: "do something unrelated to running services" },
] as const;

export const ZERO_SHOT_LABEL_SET = ZERO_SHOT_LABELS.map(z => z.label).join("|");

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

async function zeroShotScores(input: string, apiKey: string, model: string, multiLabel = HF_MULTI_LABEL) {
  const url = `${HF_BASE_URL}/${model}`;
  const labels = ZERO_SHOT_LABELS.map(z => z.label);
  const data = await fetchJson(url, {
    inputs: input,
    parameters: { candidate_labels: labels, hypothesis_template: "The user wants to {}.", multi_label: multiLabel },
    options: { wait_for_model: true, use_cache: true },
  }, apiKey);

  const out: Array<{ action: ParsedIntent["action"]; score: number; label: string }> = [];
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

/** Score every action for a command with the configured HF model (zero-shot or NLI). */
export async function classifyActions(
  command: string,
  apiKey: string,
  opts: { model?: string; multiLabel?: boolean } = {}
): Promise<RankedAction[]> {
  const model = opts.model ?? DEFAULT_HF_MODEL;
  const normalized = command.toLowerCase().trim();
  if (isZeroShotModel(model)) {
    const z = await zeroShotScores(normalized, apiKey, model, opts.multiLabel ?? HF_MULTI_LABEL);
    return z.map(({ action, score }) => ({ action, score }));
  }
  const scores = await Promise.all(
    ACTION_HYPOTHESES.map(async h => ({
      action: h.action as ParsedIntent["action"],
      score: await nliEntailmentScore(normalized, h.hypothesis, apiKey, model),
    }))
  );
  return scores.sort((a, b) => b.score - a.score);
}

export type Decision = {
  action: ParsedIntent["action"];
  confidence: number;
  source: string;
  needs_confirmation: boolean;
  candidates: RankedAction[];
};

/**
 * Gate execution on confidence. Pure function shared by the API and eval/evaluateIntents.ts.
 *  - model top score >= threshold                         -> execute model's action
 *  - below threshold but strict regex grammar agrees      -> execute (two independent signals)
 *  - otherwise                                            -> ask the user to confirm an action
 * Without model scores (no key / API error) only an exact grammar match executes.
 */
export function decideAction(
  ranked: RankedAction[] | null,
  command: string,
  threshold: number,
  modelSource = `hf:${DEFAULT_HF_MODEL}`
): Decision {
  const strict = commandParser.parseCommand(command);
  const strictAction = strict.success && strict.intent && strict.intent.action !== "unknown"
    ? (strict.intent.action as Action) : null;
  const looseAction = regexParse(command).action;

  if (ranked && ranked.length) {
    const top = ranked[0];
    const confidence = Number(top.score.toFixed(3));
    const candidates = ranked.filter(r => r.action !== "unknown").slice(0, 3);
    if (top.action === "unknown") {
      return { action: "unknown", confidence, source: "out-of-scope", needs_confirmation: true, candidates };
    }
    if (top.score >= threshold) {
      return { action: top.action, confidence, source: modelSource, needs_confirmation: false, candidates };
    }
    if (strictAction && strictAction === top.action) {
      return { action: top.action, confidence, source: `${modelSource}+grammar`, needs_confirmation: false, candidates };
    }
    return { action: top.action, confidence, source: "low-confidence", needs_confirmation: true, candidates };
  }

  if (strictAction) {
    return { action: strictAction, confidence: 0.9, source: "grammar", needs_confirmation: false, candidates: [{ action: strictAction, score: 0.9 }] };
  }
  const guess = looseAction !== "unknown" ? [{ action: looseAction as Action, score: 0.5 }] : [];
  return { action: looseAction, confidence: guess.length ? 0.5 : 0, source: "regex-guess", needs_confirmation: true, candidates: guess };
}

export async function parseCommand(opts: {
  command: string;
  hfApiKey: string | null;
  confidenceThreshold?: number;
  /** Services from the target repo's .devcommandhub.yml */
  services?: string[];
}): Promise<ParsedIntent> {
  const { command, hfApiKey, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD, services } = opts;
  const normalized = command.toLowerCase().trim();
  const coarse = regexParse(normalized, services);
  const model = DEFAULT_HF_MODEL;

  let ranked: RankedAction[] | null = null;
  let error: string | undefined;
  if (hfApiKey) {
    try {
      ranked = await classifyActions(normalized, hfApiKey, { model });
      console.log(`[NLU] ${model} top:`, ranked.slice(0, 3));
    } catch (err: any) {
      error = String(err?.message ?? err);
      console.error("[NLU] HF API error, using grammar/regex only:", error);
    }
  }

  const d = decideAction(ranked, normalized, confidenceThreshold, `hf:${model}`);
  return {
    action: d.action,
    environment: coarse.environment,
    service: coarse.service,
    replicas: coarse.replicas,
    confidence: d.confidence,
    source: error ? `${d.source} (hf-error)` : d.source,
    needs_confirmation: d.needs_confirmation,
    candidates: d.candidates,
    debug: { model, threshold: confidenceThreshold, rankedActions: ranked ?? [], validServices: services?.length ? services : VALID_SERVICES },
    ...(error ? { error } : {}),
  };
}
