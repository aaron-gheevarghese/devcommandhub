// backend/src/services/nluService.ts
const HF_MODEL = process.env.HF_MODEL || "cross-encoder/nli-deberta-v3-base";

export type ParsedIntent = {
  action: "deploy" | "rollback" | "scale" | "restart" | "logs" | "status" | "unknown";
  environment: string | null;
  service: string | null;
  replicas?: number;
  confidence: number;
  source: string;           // "hf:...", "regex", "regex-fallback", "regex-error-fallback"
  debug?: unknown;
  error?: string;
};

export function regexParse(command: string): ParsedIntent {
  const c = command.toLowerCase();

  // env
  const envMatch = /\b(prod|production|staging|stage|dev|development|local)\b/.exec(c);

  // service: try "<name> service" then common names
  const svcFromPhrase = /([\w-]+)\s+(?:service|svc)\b/.exec(c)?.[1];
  const svcList = /\b(api|backend|server|web(?:app)?|frontend|db|database|worker|auth|user)\b/.exec(c)?.[1];
  const service = (svcFromPhrase || svcList) ?? null;

  // replicas: “to 3 replicas”, “=3 pods”, “spin up 3 …”, “scale 3”
  let replicas: number | undefined;
  const r1 = /\b(?:to|=)\s*(\d+)\s*(?:replicas?|pods?)\b/.exec(c);
  const r2 = /\bscale\b[^\d]*(\d+)\b/.exec(c);
  const r3 = /\b(?:spin\s*up|bring\s*up|scale\s*up?)\s*(\d+)\b/.exec(c);
  if (r1?.[1]) {replicas = Number(r1[1]);}
  else if (r2?.[1]) {replicas = Number(r2[1]);}
  else if (r3?.[1]) {replicas = Number(r3[1]);}

  // action
  const action: ParsedIntent["action"] =
    /rollback/.test(c) ? "rollback" :
    /\b(?:spin\s*up|bring\s*up|scale|replica|autoscal)/.test(c) ? "scale" :
    /restart|reboot/.test(c) ? "restart" :
    /\blogs?/.test(c) ? "logs" :
    /\b(status|health|ping)\b/.test(c) ? "status" :
    /\b(deploy|release|ship)\b/.test(c) ? "deploy" :
    "unknown";

  return {
    action,
    environment: envMatch?.[1] ?? null,
    service,
    replicas,
    confidence: 0.5,
    source: "regex",
  };
}

async function nliEntailmentScore(premise: string, hypothesis: string, apiKey: string | null): Promise<number> {
  const url = `https://api-inference.huggingface.co/models/${HF_MODEL}?wait_for_model=true`;
  const input = `${premise} </s></s> ${hypothesis}`;

  // helper to call once with optional auth
  const call = async (useKey: string | null) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (useKey) {headers["Authorization"] = `Bearer ${useKey}`;}
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ inputs: input }) });
    return res;
  };

  let res = await call(apiKey);
  // If the key is bad (401) or not allowed for providers (403), try anonymously once
  if ((res.status === 401 || res.status === 403) && apiKey) {
    res = await call(null);
  }

  if (!res.ok) {
    throw new Error(`HF ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  const labels: Array<{ label: string; score: number }> =
    Array.isArray(data) && Array.isArray(data[0]) ? data[0] :
    Array.isArray(data) ? data : [];
  return labels.find((x) => /entail/i.test(x.label))?.score ?? 0;
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
  const coarse = regexParse(command);

  // No key is fine — we’ll try anonymous first in the scorer
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
      action: accept ? top.action : coarse.action, // fall back to regex action if low confidence
      environment: coarse.environment,
      service: coarse.service,
      replicas: coarse.replicas,
      confidence: Number((top?.score ?? 0).toFixed(3)),
      source: accept ? `hf:${HF_MODEL}` : "regex-fallback",
      debug: { rankedActions: scored.slice(0, 3) },
    };
  } catch (err: any) {
    // Hard failure → keep regex result but explain
    return { ...coarse, source: "regex-error-fallback", error: String(err) };
  }
}
