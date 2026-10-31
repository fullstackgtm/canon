import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openRuntime, context, type Input } from "./runtime.ts";
import { nextRecovery, type Recovery } from "./recovery.ts";
import { signPiCallback, verifyPiService, verifyWatchTicket } from "../../../convex/lib/piRuntimeTokens.ts";

export interface Env {
  RUNS: DurableObjectNamespace;
  CANON_PI_SECRET: string;
  CANON_CONVEX_SITE: string;
  PI_LOCAL_PROBE?: string;
  PI_LOCAL_CONVEX_URL?: string;
  PI_LOCAL_ADMIN_KEY?: string;
  PI_LOCAL_VISUAL?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!/^\/runs\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname) || !["GET", "POST"].includes(request.method)) return new Response("Not found", { status: 404 });
    const runId = url.pathname.split("/")[2];
    if (!runId || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) return new Response("Missing run", { status: 400 });
    const service = await verifyPiService(env.CANON_PI_SECRET, request.method, url.pathname + url.search, request.headers);
    const viewer = request.method === "GET" && await verifyWatchTicket(env.CANON_PI_SECRET, url.searchParams.get("ticket") ?? "", runId);
    if (!service && !viewer) return new Response("Unauthorized", { status: 401 });
    if (request.method === "POST" && await request.clone().text() !== "") return new Response("Admission takes no body", { status: 400 });
    if (env.PI_LOCAL_PROBE !== "on" && !/^https:\/\/[a-z0-9-]+\.convex\.site$/.test(env.CANON_CONVEX_SITE ?? "")) return new Response("Canon callback origin is not configured", { status: 503 });
    return env.RUNS.get(env.RUNS.idFromName(runId)).fetch(request);
  },
};

export class PiRun {
  private runtime?: ReturnType<typeof openRuntime>;
  private publishing = false;
  constructor(private state: DurableObjectState, private env: Env) {}

  protected async callCanon(input: Input, operation: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({ runId: input.runId, operation, data });
    const timestamp = String(Date.now());
    const response = await fetch(`${this.env.CANON_CONVEX_SITE}/pi-runtime`, {
      method: "POST", headers: { "X-Canon-Pi-Time": timestamp, "X-Canon-Pi-Signature": await signPiCallback(this.env.CANON_PI_SECRET, body, timestamp), "Content-Type": "application/json" }, body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95_000)]) : AbortSignal.timeout(95_000),
    });
    if (!response.ok) throw new Error(`Canon callback ${operation}: ${response.status}`);
    return response.json();
  }

  private async open() {
    this.runtime ??= (async () => {
      const storage = await openDurableObjectSqliteStorage(this.state.storage);
      const input = await this.state.storage.get<Input>("input");
      if (!input) throw new Error("Run was not admitted");
      return openRuntime(storage, (operation, data, signal) => this.callCanon(input, operation, data, signal), () => { void this.publish(); });
    })();
    return this.runtime;
  }

  private async publish() {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const data = JSON.stringify(await this.snapshot());
      for (const socket of this.state.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as { expiresAt?: number } | null;
        if (attachment?.expiresAt && attachment.expiresAt <= Date.now()) { socket.close(1008, "Viewer ticket expired"); continue; }
        try { socket.send(data); } catch { socket.close(); }
      }
    } finally { this.publishing = false; }
  }

  private async snapshot() {
    return { ...await (await this.open()).snapshot(), host: {
      alarmResumes: await this.state.storage.get<number>("alarmResumes") ?? 0,
      exhausted: await this.state.storage.get<boolean>("exhausted") ?? false,
    } };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const mode = this.env.PI_LOCAL_PROBE === "on" && new URL(request.url).searchParams.get("probe") === "1" ? "probe" : "research";
      const input: Input = { runId: new URL(request.url).pathname.split("/")[2], mode, delayMs: 1500 };
      return this.state.blockConcurrencyWhile(async () => {
        if (await this.state.storage.get("exhausted")) return new Response("Run exhausted its recovery budget", { status: 409 });
        const previous = await this.state.storage.get<Input>("input");
        if (previous && (previous.runId !== input.runId || previous.mode !== input.mode)) return new Response("Run already admitted with different input", { status: 409 });
        if (!previous) await this.state.storage.put("input", input);
        await this.state.storage.setAlarm(Date.now() + 1000);
        const runtime = await this.open();
        const id = await runtime.start(input);
        this.state.waitUntil(runtime.wait(id).then(async () => { await this.state.storage.deleteAlarm(); await this.publish(); }));
        return Response.json({ taskId: id }, { status: 202 });
      });
    }
    if (!await this.state.storage.get("input")) return new Response("Run not found", { status: 404 });
    if (request.headers.get("Upgrade") === "websocket") {
      if (this.state.getWebSockets().length >= 32) return new Response("Viewer limit", { status: 429 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      const url = new URL(request.url);
      const ticket = await verifyWatchTicket(this.env.CANON_PI_SECRET, url.searchParams.get("ticket") ?? "", url.pathname.split("/")[2]);
      if (ticket) pair[1].serializeAttachment(ticket);
      pair[1].send(JSON.stringify(await this.snapshot()));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json(await this.snapshot());
  }

  async alarm(): Promise<void> {
    const input = (await this.state.storage.get<Input>("input"))!;
    let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
    const previous = await this.state.storage.get<Recovery>("recovery");
    let checkpointAt = previous?.checkpointAt ?? -1;
    try {
      runtime = await this.open();
      checkpointAt = (await runtime.snapshot()).progress?.lastCommitAt ?? checkpointAt;
    } catch { this.runtime = undefined; }
    const recovery = nextRecovery(previous, checkpointAt);
    if (recovery.attempts > 6) {
      await this.state.storage.put("exhausted", true);
      await this.state.storage.deleteAlarm();
      if (input.mode === "research") await this.callCanon(input, "fail", {}).catch(() => {});
      await this.publish();
      return;
    }
    await this.state.storage.put("recovery", recovery);
    await this.state.storage.put("alarmResumes", (await this.state.storage.get<number>("alarmResumes") ?? 0) + 1);
    await this.state.storage.setAlarm(Date.now() + Math.min(60_000, 1000 * 2 ** (recovery.attempts - 1)));
    try {
      runtime ??= await this.open();
      await runtime.wait(await runtime.start(input));
      await this.state.storage.delete("recovery");
      await this.state.storage.deleteAlarm();
      await this.publish();
    } catch {
      this.runtime = undefined;
      await runtime?.harness.close(context);
    }
  }

  webSocketMessage(): void { void this.publish(); }
  webSocketClose(socket: WebSocket): void { socket.close(); }
}
