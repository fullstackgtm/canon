import { ConvexLeaseStorage } from "./lease-storage.ts";
import { openRuntime, context } from "./runtime.ts";

type ProbeEnv = { PI_LOCAL_PROBE?: string; PI_LOCAL_CONVEX_URL?: string; PI_LOCAL_ADMIN_KEY?: string };

export async function leaseStorage(env: ProbeEnv, key: string) {
  if (env.PI_LOCAL_PROBE !== "on" || !env.PI_LOCAL_ADMIN_KEY || !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.PI_LOCAL_CONVEX_URL ?? "")) throw new Error("Local prototype disabled");
  return new ConvexLeaseStorage(async (args) => {
    const res = await fetch(`${env.PI_LOCAL_CONVEX_URL}/api/mutation`, {
      method: "POST", headers: { Authorization: `Convex ${env.PI_LOCAL_ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "piPrototype:operate", args, format: "json" }),
    });
    const reply = await res.json() as { status: string; value: Record<string, unknown> };
    if (!res.ok || reply.status !== "success") throw new Error(`Local lease ${args.operation} refused: HTTP ${res.status}, ${reply.status}`);
    return reply.value;
  }, key, crypto.randomUUID()).acquire();
}

export async function localLease(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
  if (env.PI_LOCAL_PROBE !== "on" || !env.PI_LOCAL_ADMIN_KEY || !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.PI_LOCAL_CONVEX_URL ?? "")) return new Response("Local prototype disabled", { status: 404 });
  const key = new URL(request.url).pathname.split("/")[2];
  if (!/^pi-probe-[a-zA-Z0-9-]{1,80}$/.test(key)) return new Response("Invalid key", { status: 400 });
  const storage = await leaseStorage(env, key).catch(() => null);
  if (!storage) return new Response("Lease unavailable", { status: 409 });
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let sending = Promise.resolve();
      const publish = () => {
        if (!runtime || closed) return sending;
        sending = sending.then(async () => {
          const snapshot = await runtime!.snapshot();
          if (!closed) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`));
        });
        return sending;
      };
      ctx.waitUntil((async () => {
        try {
          runtime = await openRuntime(storage, async () => { throw new Error("Probe cannot call Canon or vendors"); }, () => { void publish().catch(() => {}); });
          const id = await runtime.start({ runId: key, mode: "probe", delayMs: 1500 });
          await publish();
          await runtime.wait(id);
          await publish();
          closed = true;
          controller.close();
        } catch {
          if (!closed) { closed = true; controller.error(new Error("Lease owner failed")); }
        } finally {
          if (runtime) await runtime.harness.close(context);
          else await storage.close();
        }
      })());
    },
    async cancel() {
      closed = true;
      await runtime?.harness.close(context);
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
