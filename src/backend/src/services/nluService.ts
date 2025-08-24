// backend/src/services/nluService.ts
const HF_MODEL = "cross-encoder/nli-deberta-v3-base";

export type ParsedIntent = {
  action: "deploy" | "rollback" | "scale" | "restart" | "logs" | "status" | "unknown";
  environment: string | null;
  service: string | null;
  replicas?: number;
  confidence: number;
  source: string;           // "hf:...", "regex", "regex-error-fallback"
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

async function nliEntailmentScore(premise: string, hypothesis: string, apiKey: string): Promise<number> {
  const input = `${premise} </s></s> ${hypothesis}`;
  const res = await fetch(`https://api-inference.huggingface.co/models/${HF_MODEL}?wait_for_model=true`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: input }),
  });

  if (!res.ok) {throw new Error(`HF ${res.status}: ${await res.text()}`);}
  const data: any = await res.json();

  // HF may return [{label,score}, ...] or [[{label,score},...]]
  const labels: Array<{ label: string; score: number }> =
    Array.isArray(data) && Array.isArray(data[0]) ? data[0] :
    Array.isArray(data) ? data :
    [];

  const ent = labels.find((x) => /entail/i.test(x.label))?.score ?? 0;
  return ent;
}

const ACTION_HYPOTHESES = [
  { action: "deploy",   hypothesis: "The user wants to deploy a service." },
  { action: "rollback", hypothesis: "The user wants to roll back a deployment." },
  { action: "scale",    hypothesis: "The user wants to scale the number of replicas." },
  { action: "restart",  hypothesis: "The user wants to restart a service or pod." },
  { action: "logs",     hypothesis: "The user wants to view logs." },
  { action: "status",   hypothesis: "The user wants to check the status or health of services." },
] as const;

export async function parseCommand(opts: {
  command: string;
  hfApiKey: string | null;
  confidenceThreshold?: number; // default 0.7
}): Promise<ParsedIntent> {
  const { command, hfApiKey, confidenceThreshold = 0.7 } = opts;

  // Always grab coarse entities via regex
  const coarse = regexParse(command);

  // No key → regex only
  if (!hfApiKey) {return { ...coarse, source: "regex" };}

  try {
    const scored = await Promise.all(
      ACTION_HYPOTHESES.map(async (h) => ({
        ...h,
        score: await nliEntailmentScore(command, h.hypothesis, hfApiKey),
      }))
    );
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    const accept = (top?.score ?? 0) >= confidenceThreshold;

    return {
      action: accept ? top.action : "unknown",
      environment: coarse.environment,
      service: coarse.service,
      replicas: coarse.replicas,
      confidence: Number((top?.score ?? 0).toFixed(3)),
      source: accept ? `hf:${HF_MODEL}` : "regex-fallback",
      debug: { rankedActions: scored.slice(0, 3) },
    };
  } catch (err: any) {
    return { ...coarse, source: "regex-error-fallback", error: String(err) };
  }
}
