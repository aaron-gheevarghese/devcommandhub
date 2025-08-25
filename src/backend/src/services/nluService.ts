// src/backend/src/services/nluService.ts
import path from 'path';
import dotenv from 'dotenv';

// ✅ CRITICAL FIX: Force load the same .env file as other modules
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const DEFAULT_HF_MODEL = (process.env.HF_MODEL || "facebook/bart-large-mnli").trim();

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

export function regexParse(command: string): ParsedIntent {
  const c = command.toLowerCase();
  const envMatch = /(prod|production|staging|stage|dev|development|local)\b/.exec(c);
  const serviceMatch = /\b(api|backend|server|web(app)?|frontend|db|database|worker)\b/.exec(c);
  const replicasMatch = /(\d+)\s*(replica|replicas|pods?)/.exec(c);
  const action: ParsedIntent["action"] =
    /rollback/.test(c) ? "rollback" :
    /scale|replica|autoscal/.test(c) ? "scale" :
    /restart|reboot/.test(c) ? "restart" :
    /log/.test(c) ? "logs" :
    /status|health|ping/.test(c) ? "status" :
    /deploy|release|ship/.test(c) ? "deploy" : "unknown";

  return {
    action,
    environment: envMatch?.[1] ?? null,
    service: serviceMatch?.[0] ?? null,
    replicas: replicasMatch ? Number(replicasMatch[1]) : undefined,
    confidence: 0.5,
    source: "regex",
  };
}

const ACTIONS = ["deploy","rollback","scale","restart","logs","status"] as const;

const ACTION_HYPOTHESES = [
  { action: "deploy",   hypothesis: "The user wants to deploy a service." },
  { action: "rollback", hypothesis: "The user wants to roll back a deployment." },
  { action: "scale",    hypothesis: "The user wants to scale the number of replicas." },
  { action: "restart",  hypothesis: "The user wants to restart a service or pod." },
  { action: "logs",     hypothesis: "The user wants to view logs." },
  { action: "status",   hypothesis: "The user wants to check the status or health of services." },
] as const;

const ZERO_SHOT_LABELS = [
  { action: "deploy",   label: "deploy a service" },
  { action: "rollback", label: "roll back a deployment" },
  { action: "scale",    label: "scale replicas" },
  { action: "restart",  label: "restart a service" },
  { action: "logs",     label: "view logs" },
  { action: "status",   label: "check status" },
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
  const url = `https://api-inference.huggingface.co/models/${model}`;
  // Try structured pair first
  let data = await fetchJson(url, {
    inputs: { text: premise, text_pair: hypothesis },
    parameters: { return_all_scores: true },
    options: { wait_for_model: true, use_cache: true },
  }, apiKey);

  // Defensive fallback to Roberta separator format if needed
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
  const url = `https://api-inference.huggingface.co/models/${model}`;
  const labels = ZERO_SHOT_LABELS.map(z => z.label);
  const data = await fetchJson(url, {
    inputs: input,
    parameters: {
      candidate_labels: labels,
      hypothesis_template: "The user wants to {}.",
      multi_label: false,
    },
    options: { wait_for_model: true, use_cache: true },
  }, apiKey);

  const out: Array<{ action: typeof ACTIONS[number]; score: number; label: string }> = [];
  if (Array.isArray(data?.labels) && Array.isArray(data?.scores)) {
    for (let i = 0; i < data.labels.length; i++) {
      const lbl = data.labels[i];
      const sc = data.scores[i] ?? 0;
      const mapped = ZERO_SHOT_LABELS.find(z => z.label === lbl);
      if (mapped) {out.push({ action: mapped.action, score: sc, label: lbl });}
    }
  }
  out.sort((a,b) => b.score - a.score);
  return out;
}

export async function parseCommand(opts: {
  command: string;
  hfApiKey: string | null;
  confidenceThreshold?: number;
}): Promise<ParsedIntent> {
  const { command, hfApiKey, confidenceThreshold = 0.7 } = opts;
  const coarse = regexParse(command);

  if (!hfApiKey) {
    console.log('[NLU] No HF API key provided, using regex fallback');
    return { ...coarse, source: "regex" };
  }

  const model = DEFAULT_HF_MODEL;
  console.log(`[NLU] Using model: ${model}, threshold: ${confidenceThreshold}`);

  try {
    let ranked: Array<{ action: typeof ACTIONS[number]; score: number; detail?: unknown }> = [];

    if (isZeroShotModel(model)) {
      console.log('[NLU] Using zero-shot classification');
      const z = await zeroShotScores(command, hfApiKey, model);
      ranked = z.map(({ action, score, label }) => ({ action, score, detail: { label } }));
      console.log(`[NLU] Zero-shot results:`, ranked.slice(0, 3));
    } else {
      console.log('[NLU] Using NLI classification');
      const scores = await Promise.all(
        ACTION_HYPOTHESES.map(async h => ({
          action: h.action,
          score: await nliEntailmentScore(command, h.hypothesis, hfApiKey, model),
          detail: { hypothesis: h.hypothesis },
        }))
      );
      scores.sort((a,b) => b.score - a.score);
      ranked = scores;
      console.log(`[NLU] NLI results:`, ranked.slice(0, 3));
    }

    const top = ranked[0];
    const accept = (top?.score ?? 0) >= confidenceThreshold;
    
    console.log(`[NLU] Top result: ${top?.action} (${top?.score?.toFixed(3)}), accept: ${accept}`);

    return {
      action: accept ? top.action : "unknown",
      environment: coarse.environment,
      service: coarse.service,
      replicas: coarse.replicas,
      confidence: Number((top?.score ?? 0).toFixed(3)),
      source: accept ? `hf:${model}` : "regex-fallback",
      debug: { 
        model, 
        threshold: confidenceThreshold, 
        isZeroShot: isZeroShotModel(model), 
        rankedActions: ranked.slice(0, 6) 
      },
    };
  } catch (err: any) {
    console.error('[NLU] HF API error:', err.message);
    return { 
      ...coarse, 
      source: "regex-error-fallback", 
      error: String(err), 
      debug: { model } 
    };
  }
}