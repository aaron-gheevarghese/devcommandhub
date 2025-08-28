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
  
  // More comprehensive environment matching
  const envPatterns = [
    /\b(?:to|in|on|for)\s+(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\b/,
    /\b(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\s+(?:env|environment)\b/,
    /\benv(?:ironment)?[:=]\s*(prod|production|staging|stage|dev|development|local|test|testing|qa|uat)\b/
  ];
  
  let environment: string | null = null; // ✅ Fix: Explicit type annotation
  for (const pattern of envPatterns) {
    const match = c.match(pattern);
    if (match?.[1]) {
      environment = match[1];
      break;
    }
  }
  
  // More comprehensive service matching
  const servicePatterns = [
    // Specific service patterns first (more precise)
    /\b(api|backend|server|web|webapp|frontend|db|database|worker|auth|user|payment|notification|gateway|proxy)-?(?:service|svc|app)?\b/,
    // Generic service-name patterns
    /\b([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)-(?:service|svc|app)\b/,
    // Fallback to any reasonable service name
    /\b([a-zA-Z][a-zA-Z0-9._-]{1,30})\b(?=\s+(?:to|in|on|for|$))/
  ];
  
  let service: string | null = null; // ✅ Fix: Explicit type annotation
  for (const pattern of servicePatterns) {
    const match = c.match(pattern);
    if (match?.[1]) {
      // Skip common words that aren't services
      const word = match[1].toLowerCase();
      if (!['the', 'and', 'or', 'but', 'to', 'in', 'on', 'for', 'show', 'get', 'set'].includes(word)) {
        service = match[1];
        break;
      }
    }
  }
  
  // Enhanced replicas matching
  const replicaPatterns = [
    /(\d+)\s*(?:replica|replicas|pods?|instances?)\b/,
    /\bto\s+(\d+)\s*(?:replica|replicas|pods?|instances?)?\b/,
    /\breplica(?:s|count)?[:=]\s*(\d+)\b/,
    /\bscale\b[^\d]*(\d+)\b/
  ];
  
  let replicas: number | undefined = undefined; // ✅ Fix: Explicit type annotation
  for (const pattern of replicaPatterns) {
    const match = c.match(pattern);
    if (match?.[1]) {
      const num = Number(match[1]);
      if (num >= 0 && num <= 100) {
        replicas = num;
        break;
      }
    }
  }
  
  // Enhanced action detection with better precedence
  const actionPatterns = [
    { pattern: /\b(?:roll\s*back|rollback)\b/, action: 'rollback' as const },
    { pattern: /\bscale\b|\breplica\b|\bautoscal\b/, action: 'scale' as const },
    { pattern: /\brestart\b|\breboot\b|\breload\b/, action: 'restart' as const },
    { pattern: /\blog\b|\blogs\b|\btail\b/, action: 'logs' as const },
    { pattern: /\bstatus\b|\bhealth\b|\bping\b|\bcheck\b/, action: 'status' as const },
    { pattern: /\bdeploy\b|\brelease\b|\bship\b|\bpush\b/, action: 'deploy' as const }
  ];
  
  let action: ParsedIntent["action"] = "unknown";
  for (const { pattern, action: act } of actionPatterns) {
    if (pattern.test(c)) {
      action = act;
      break;
    }
  }
  
  return {
    action,
    environment,
    service,
    replicas,
    confidence: 0.5,
    source: "regex",
  };
}


const ACTIONS = ["deploy","rollback","scale","restart","logs","status"] as const;

// Replace the ACTION_HYPOTHESES in your nluService.ts with these more specific ones:

const ACTION_HYPOTHESES = [
  { action: "deploy",   hypothesis: "This is a request to deploy, ship, release, or push code to a service or environment." },
  { action: "rollback", hypothesis: "This is a request to roll back, revert, or undo a previous deployment." },
  { action: "scale",    hypothesis: "This is a request to scale, resize, or change the number of replicas or instances." },
  { action: "restart",  hypothesis: "This is a request to restart, reboot, or reload a service or application." },
  { action: "logs",     hypothesis: "This is a request to view, show, or tail logs from a service or application." },
  { action: "status",   hypothesis: "This is a request to check the status, health, or state of a service or system." },
] as const;

// Also update the ZERO_SHOT_LABELS to be more specific:
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