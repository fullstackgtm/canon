import worker, { PiRun as CanonPiRun, type Env } from "./worker.ts";
import type { Input } from "./runtime.ts";
import { localLease, leaseStorage } from "./local-lease.ts";
import { conformance } from "./conformance.ts";
import { verifyWatchTicket } from "../../../convex/lib/piRuntimeTokens.ts";

export class PiRun extends CanonPiRun {
  constructor(state: DurableObjectState, private prototypeEnv: Env) { super(state, prototypeEnv); }

  protected override async callCanon(input: Input, operation: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const env = this.prototypeEnv;
    if (env.PI_LOCAL_PROBE !== "on" || !env.PI_LOCAL_ADMIN_KEY || !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.PI_LOCAL_CONVEX_URL ?? "")) throw new Error("Local research fixture disabled");
    const kind = operation === "status" || operation === "fail" ? "mutation" : "action";
    const path = ["next", "effect", "finish"].includes(operation) ? `piResearchActions:${operation}` : ["status", "fail"].includes(operation) ? `piResearch:${operation}` : null;
    if (!path) throw new Error("Unknown local Canon callback");
    const response = await fetch(`${env.PI_LOCAL_CONVEX_URL}/api/${kind}`, {
      method: "POST", headers: { Authorization: `Convex ${env.PI_LOCAL_ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: { ...data, runId: input.runId }, format: "json" }),
      signal,
    });
    const result = await response.json() as { status: string; value: unknown };
    if (!response.ok || result.status !== "success") throw new Error(`Local Canon ${operation} refused`);
    if (operation === "finish" && (result.value as { completed: number }).completed === 1) await new Promise((resolve) => setTimeout(resolve, env.PI_LOCAL_VISUAL === "on" ? 60_000 : 5000));
    return result.value;
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.PI_LOCAL_PROBE !== "on") return new Response("Disabled", { status: 404 });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/demo/")) {
      const id = url.pathname.split("/")[2];
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !await verifyWatchTicket(env.CANON_PI_SECRET, url.searchParams.get("ticket") ?? "", id)) return new Response("Unauthorized", { status: 401 });
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Research run</title><style>body{font:16px system-ui;background:#faf9f6;color:#242424;margin:40px}main{max-width:720px;margin:auto}section{padding:24px;background:white;border:1px solid #ddd;border-radius:12px}progress{width:100%;accent-color:#368564}li{margin:12px 0}small{color:#666}</style></head><body><main><h1>Research run</h1><p>Pi Durable live run</p><section><p id="status">Connecting</p><progress id="progress" max="8" value="0"></progress><ol id="steps"></ol><small>Local fake model. No vendor spend.</small></section></main><script>function connect(){const u=new URL(location.href);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/runs/${id}';const ws=new WebSocket(u);ws.onopen=()=>document.getElementById('status').textContent='Watching live';ws.onmessage=e=>{const p=JSON.parse(e.data).progress;if(!p)return;document.getElementById('progress').value=p.completed;document.getElementById('status').textContent=p.completed===8?'Complete':p.completed+' of 8 steps committed';document.getElementById('steps').replaceChildren(...p.outputs.map(x=>{const li=document.createElement('li');li.textContent=x;return li}))};ws.onclose=()=>{document.getElementById('status').textContent='Reconnecting';setTimeout(connect,500)}}connect()</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/runs/")) return worker.fetch(request, env, ctx);
    if (request.headers.get("Authorization") !== `Bearer ${env.CANON_PI_SECRET}`) return new Response("Unauthorized", { status: 401 });
    if (url.pathname.startsWith("/leases/")) return localLease(request, env, ctx);
    if (url.pathname === "/lease-conformance") return Response.json(await conformance(() => leaseStorage(env, `pi-probe-${crypto.randomUUID()}`)));
    return worker.fetch(request, env, ctx);
  },
};
