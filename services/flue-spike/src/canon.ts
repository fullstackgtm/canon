import { signPiCallback } from "../../../convex/lib/piRuntimeTokens.ts";

export type Env = {
  CANON_ORG: string;
  CANON_PI_SECRET: string;
  CANON_CONVEX_SITE: string;
  PI_LOCAL_PROBE?: string;
  PI_LOCAL_CONVEX_URL?: string;
  PI_LOCAL_ADMIN_KEY?: string;
  FLUE_RESEARCH_AGENT: DurableObjectNamespace;
};

export async function callCanon(env: Env, runId: string, operation: string, data: Record<string, unknown>): Promise<unknown> {
  if (env.PI_LOCAL_PROBE === "on") return callLocalCanon(env, runId, operation, data);
  const body = JSON.stringify({ runId, operation, data });
  const timestamp = String(Date.now());
  const response = await fetch(`${env.CANON_CONVEX_SITE}/pi-runtime`, {
    method: "POST",
    headers: { "X-Canon-Pi-Time": timestamp, "X-Canon-Pi-Signature": await signPiCallback(env.CANON_PI_SECRET, body, timestamp), "Content-Type": "application/json" },
    body, signal: AbortSignal.timeout(95_000),
  });
  if (!response.ok) throw new Error(`Canon callback ${operation}: ${response.status}`);
  return response.json();
}

// Same local admin bridge as services/pi-runtime/src/prototype-worker.ts, including its kill window.
async function callLocalCanon(env: Env, runId: string, operation: string, data: Record<string, unknown>): Promise<unknown> {
  if (!env.PI_LOCAL_ADMIN_KEY || !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.PI_LOCAL_CONVEX_URL ?? "")) throw new Error("Local research fixture disabled");
  const kind = operation === "status" || operation === "fail" ? "mutation" : "action";
  const path = ["next", "effect", "finish"].includes(operation) ? `piResearchActions:${operation}` : ["status", "fail"].includes(operation) ? `piResearch:${operation}` : null;
  if (!path) throw new Error("Unknown local Canon callback");
  const response = await fetch(`${env.PI_LOCAL_CONVEX_URL}/api/${kind}`, {
    method: "POST", headers: { Authorization: `Convex ${env.PI_LOCAL_ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: { ...data, runId }, format: "json" }),
  });
  const result = await response.json() as { status: string; value: unknown };
  if (!response.ok || result.status !== "success") throw new Error(`Local Canon ${operation} refused`);
  if (operation === "finish" && (result.value as { completed: number }).completed === 1) await new Promise((resolve) => setTimeout(resolve, 5000));
  return result.value;
}
