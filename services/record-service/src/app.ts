// HTTP layer: auth, routing, zod validation, metrics, graceful shutdown.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  PrepareResearchBody, CommitResearchBody, ActivityAggregateBody, AggregateBody, AnnotateAccountsBody, ChangesQuery, CONTRACT_VERSION, FacetsBody, DefineObjectsBody, EditBody, EditObjectBody, GetAccountBody, GetContactBody, GetObjectBody, HistoryBody, ListAccountsBody,
  ListContactsBody, ListObjectsBody, OBJECT_NAME_RE, ProspectFacetsBody, ProspectLookupBody, ProspectSearchBody, RescoreBody, IcpTreeCountsBody, TerritoryTreeBody, SegmentCountBody, UpsertAccountsBody, UpsertContactsBody,
  UpsertObjectsBody, WORKSPACE_ID_RE, ProjectionListBody, ProjectionSearchBody, ProjectorNudgeBody, ProjectorRebuildBody, DuplicatesBody, ModuleAggregateBody, ModuleSyncBody,
} from "./contract.ts";
import { ResearchImports } from "./research.ts";
import * as objects from "./objects.ts";
import { icpTreeCounts, territoryTreeCounts } from "./icpTree.ts";
import { HttpError } from "./errors.ts";
import { metrics, renderMetrics } from "./metrics.ts";
import * as ops from "./ops.ts";
import { PdlIndex } from "./pdl.ts";
import { listProjected, listRegister, searchProjected } from "./projectionQuery.ts";
import { aggregateObject } from "./aggregate.ts";
import { aggregateModuleDocs, syncModuleDocs } from "./moduleDocs.ts";
import { inboundMatchInput } from "./core/objects/inboundMatch.ts";
import { registerInboundMatch } from "./inboundMatch.ts";
import { registerDuplicates } from "./duplicates.ts";
import type { RegisterObject } from "./core/objects/listSpec.ts";
import { httpLedgerSource, projectedThrough, Projector, type ProjectorOptions } from "./projector.ts";
import { Registry } from "./registry.ts";
import type { Workspace } from "./workspace.ts";

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  token: string;
  maxOpen: number;
  memoryLimit: string;
  threads: number;
  readPool: number;
  maxGroup: number;
  checkpointIntervalMs: number;
  version: string;
  /** Enables POST /admin/crash (SIGKILL self) for durability testing on real infra. Never leave on. */
  allowCrash?: boolean;
  /**
   * Where the projector pulls the ledger from (Convex's HTTP site). Optional:
   * Convex sends its URL with every nudge. The service's own token is the
   * bearer for both directions.
   */
  projector?: { sourceUrl?: string } & Partial<ProjectorOptions>;
};

export function configFromEnv(env = process.env): Config {
  const token = env.RECORD_SERVICE_TOKEN ?? "";
  if (token.length < 16) throw new Error("RECORD_SERVICE_TOKEN is missing or shorter than 16 characters");
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "/data",
    token,
    maxOpen: Number(env.MAX_OPEN ?? 64),
    memoryLimit: env.WS_MEMORY_LIMIT ?? "512MB",
    threads: Number(env.WS_THREADS ?? 2),
    readPool: Number(env.READ_POOL ?? 4),
    maxGroup: Number(env.MAX_GROUP ?? 64),
    checkpointIntervalMs: Number(env.CHECKPOINT_INTERVAL_MS ?? 60_000),
    allowCrash: env.ALLOW_CRASH_ENDPOINT === "1",
    projector: projectorFromEnv(env),
    version: `${CONTRACT_VERSION}+${(env.GIT_SHA ?? "dev").slice(0, 7)}`,
  };
}

function projectorFromEnv(env: NodeJS.ProcessEnv): Config["projector"] {
  return env.PROJECTOR_POLL_MS ? { pollMs: Number(env.PROJECTOR_POLL_MS) } : {};
}

/** The ledger URL learned from an earlier nudge, if any. */
function readLedgerUrl(file: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown };
    return typeof saved.url === "string" ? saved.url : null;
  } catch {
    return null;
  }
}

const MAX_BODY = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "invalid request", r.error.issues);
  return r.data;
}

type Ctx = { req: IncomingMessage; url: URL; ws: string; params: string[]; body: () => Promise<unknown> };
type Handler = (ctx: Ctx) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; name: string; handler: Handler; workspace: boolean };

export function createApp(cfg: Config) {
  const registry = new Registry(cfg.dataDir, cfg.maxOpen, {
    memoryLimit: cfg.memoryLimit, threads: cfg.threads, readPool: cfg.readPool, maxGroup: cfg.maxGroup, lockWaitMs: 45_000,
  });
  const research = new ResearchImports(cfg.dataDir);
  const pdl = new PdlIndex(cfg.dataDir);
  const { sourceUrl, ...projectorOptions } = cfg.projector ?? {};
  // Learned from the first nudge (see ProjectorNudgeBody.source) unless configured.
  // Saved under DATA_DIR so a restart can catch up before Convex's next nudge.
  const ledgerUrlFile = join(cfg.dataDir, "ledger-source.json");
  let ledgerUrl: string | null = sourceUrl ?? readLedgerUrl(ledgerUrlFile);
  const projector = new Projector(registry, httpLedgerSource({ baseUrl: () => ledgerUrl, token: cfg.token }), projectorOptions);
  const tokenHash = createHash("sha256").update(cfg.token).digest();
  const authorized = (req: IncomingMessage) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return !!m && timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenHash);
  };

  const routes: Route[] = [];
  const wsRoute = (method: string, path: string, name: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^/v1/workspaces/([^/]+)/${path}$`), name, handler, workspace: true });

  routes.push({ method: "POST", pattern: /^\/v1\/research\/prepare$/, name: "research.prepare", workspace: false,
    handler: async ({ body }) => research.prepare(parse(PrepareResearchBody, await body())) });
  wsRoute("POST", "research/commit", "research.commit", async ({ ws, body }) => {
    const b = parse(CommitResearchBody, await body());
    return research.commit(b.sessionId, ws, registry);
  });
  wsRoute("POST", "provision", "provision", async ({ ws, body }) => {
    parse(z.object({}).strict(), await body());
    return { created: await registry.provision(ws) };
  });
  // Deleting requires repeating the workspace id in the body, so a stray call
  // with only the path can't wipe a workspace.
  wsRoute("POST", "delete", "workspace.delete", async ({ ws, body }) => {
    const b = parse(z.object({ confirm: z.string() }).strict(), await body());
    if (b.confirm !== ws) throw new HttpError(400, "confirm must equal the workspace id");
    return { deleted: await registry.remove(ws) };
  });
  wsRoute("POST", "accounts/upsert", "accounts.upsert", async ({ ws, body }) => {
    const b = parse(UpsertAccountsBody, await body());
    return registry.with(ws, (w) => ops.upsertAccounts(w, b));
  });
  wsRoute("POST", "contacts/upsert", "contacts.upsert", async ({ ws, body }) => {
    const b = parse(UpsertContactsBody, await body());
    return registry.with(ws, (w) => ops.upsertContacts(w, b));
  });
  wsRoute("POST", "accounts/list", "accounts.list", async ({ ws, body }) => {
    const b = parse(ListAccountsBody, await body());
    return registry.with(ws, (w) => ops.listAccounts(w, b));
  });
  wsRoute("POST", "contacts/list", "contacts.list", async ({ ws, body }) => {
    const b = parse(ListContactsBody, await body());
    return registry.with(ws, (w) => ops.listContacts(w, b));
  });
  wsRoute("POST", "accounts/get", "accounts.get", async ({ ws, body }) => {
    const b = parse(GetAccountBody, await body());
    return registry.with(ws, (w) => ops.getAccount(w, b.id));
  });
  wsRoute("POST", "contacts/get", "contacts.get", async ({ ws, body }) => {
    const b = parse(GetContactBody, await body());
    return registry.with(ws, (w) => ops.getContact(w, b.id));
  });
  wsRoute("POST", "records/edit", "records.edit", async ({ ws, body }) => {
    const b = parse(EditBody, await body());
    return registry.with(ws, (w) => ops.edit(w, b));
  });
  wsRoute("POST", "segments/count", "segments.count", async ({ ws, body }) => {
    const b = parse(SegmentCountBody, await body());
    return registry.with(ws, (w) => ops.countSegment(w, b.filter));
  });
  wsRoute("POST", "accounts/facets", "accounts.facets", async ({ ws, body }) => {
    const b = parse(FacetsBody, await body());
    return registry.with(ws, (w) => ops.facets(w, b));
  });
  wsRoute("POST", "accounts/annotate", "accounts.annotate", async ({ ws, body }) => {
    const b = parse(AnnotateAccountsBody, await body());
    return registry.with(ws, (w) => ops.annotate(w, b));
  });
  wsRoute("POST", "rescore", "rescore", async ({ ws, body }) => {
    const b = parse(RescoreBody, await body());
    return registry.with(ws, (w) => ops.rescore(w, b.icp, b.version, b.gates));
  });
  wsRoute("POST", "icp-stats", "icp.stats", async ({ ws }) => registry.with(ws, (w) => ops.icpStats(w)));
  wsRoute("POST", "icp-tree/counts", "icp.tree.counts", async ({ ws, body }) => {
    const b = parse(IcpTreeCountsBody, await body());
    return registry.with(ws, (w) => icpTreeCounts(w, b));
  });
  wsRoute("POST", "territory-tree/counts", "territory.tree.counts", async ({ ws, body }) => {
    const b = parse(TerritoryTreeBody, await body());
    return registry.with(ws, (w) => territoryTreeCounts(w, b));
  });
  wsRoute("POST", "history", "history", async ({ ws, body }) => {
    const b = parse(HistoryBody, await body());
    return registry.with(ws, (w) => ops.history(w, b.object, b.id));
  });
  wsRoute("POST", "objects/define", "objects.define", async ({ ws, body }) => {
    const b = parse(DefineObjectsBody, await body());
    return registry.with(ws, (w) => objects.defineObjects(w, b));
  });
  const objectName = (p: string) => {
    if (!OBJECT_NAME_RE.test(p)) throw new HttpError(400, "invalid object name");
    return p;
  };
  wsRoute("POST", "objects/([^/]+)/upsert", "objects.upsert", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(UpsertObjectsBody, await body());
    return registry.with(ws, (w) => objects.upsertObjects(w, o, b));
  });
  wsRoute("POST", "objects/([^/]+)/list", "objects.list", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(ListObjectsBody, await body());
    return registry.with(ws, (w) => objects.listObjects(w, o, b));
  });
  wsRoute("POST", "objects/([^/]+)/get", "objects.get", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(GetObjectBody, await body());
    return registry.with(ws, (w) => objects.getObject(w, o, b.id));
  });
  wsRoute("POST", "objects/([^/]+)/edit", "objects.edit", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(EditObjectBody, await body());
    return registry.with(ws, (w) => objects.editObject(w, o, b));
  });
  // A workspace with nothing projected yet lists as empty rather than 404.
  const projected = <T>(ws: string, fn: (w: Workspace | null) => Promise<T>) => {
    projector.touch(ws);
    return registry.exists(ws) ? registry.with(ws, fn) : fn(null);
  };
  wsRoute("POST", "p/search", "projection.search", async ({ ws, body }) => {
    const b = parse(ProjectionSearchBody, await body());
    return projected(ws, (w) => searchProjected(w, b));
  });
  wsRoute("POST", "p/([^/]+)/list", "projection.list", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(ProjectionListBody, await body());
    return projected(ws, (w) => listProjected(w, o, b));
  });
  wsRoute("POST", "register/(account|contact)/list", "register.list", async ({ ws, params, body }) => {
    const b = parse(ProjectionListBody, await body());
    return registry.with(ws, (w) => listRegister(w, params[0] as RegisterObject, b));
  });
  wsRoute("POST", "p/([^/]+)/aggregate", "projection.aggregate", async ({ ws, params, body }) => {
    const o = objectName(params[0]);
    const b = parse(ActivityAggregateBody, await body());
    return projected(ws, (w) => aggregateObject(w, o, b));
  });
  wsRoute("POST", "register/(account|contact)/aggregate", "register.aggregate", async ({ ws, params, body }) => {
    const b = parse(AggregateBody, await body());
    return registry.with(ws, (w) => aggregateObject(w, params[0], b));
  });
  // Module reports (1.33.0): a module id's scope and name, URL-encoded (`%40canon%2Ffield-visits`).
  const moduleOf = (raw: string) => {
    const id = decodeURIComponent(raw);
    if (!/^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new HttpError(400, "invalid module id");
    return id;
  };
  wsRoute("POST", "modules/([^/]+)/sync", "modules.sync", async ({ ws, params, body }) => {
    const m = moduleOf(params[0]);
    const b = parse(ModuleSyncBody, await body());
    return registry.with(ws, (w) => syncModuleDocs(w, m, b), true);
  });
  wsRoute("POST", "modules/([^/]+)/aggregate", "modules.aggregate", async ({ ws, params, body }) => {
    const m = moduleOf(params[0]);
    const b = parse(ModuleAggregateBody, await body());
    return registry.exists(ws) ? registry.with(ws, (w) => aggregateModuleDocs(w, m, b)) : aggregateModuleDocs(null, m, b);
  });
  wsRoute("POST", "match/inbound", "match.inbound", async ({ ws, body }) => {
    const raw = parse(z.object({ email: z.string().max(320), companyName: z.string().max(200).optional() }).strict(), await body());
    let input;
    try { input = inboundMatchInput(raw); }
    catch { throw new HttpError(400, "invalid inbound match input"); }
    return registry.with(ws, (w) => registerInboundMatch(w, input));
  });
  wsRoute("POST", "register/(account|contact)/duplicates", "register.duplicates", async ({ ws, params, body }) => {
    const b = parse(DuplicatesBody, await body());
    return registry.with(ws, (w) => registerDuplicates(w, params[0] as RegisterObject, b.limit ?? 200, b.scope));
  });
  wsRoute("POST", "projector/nudge", "projector.nudge", async ({ ws, body }) => {
    const b = parse(ProjectorNudgeBody, await body());
    if (b.source && b.source !== ledgerUrl) {
      ledgerUrl = b.source;
      await writeFile(ledgerUrlFile, JSON.stringify({ url: ledgerUrl }));
    }
    if (!ledgerUrl) throw new HttpError(503, "projector has no ledger source yet");
    const run = projector.catchUp(ws, b.heads);
    if (!b.wait) {
      run.catch((e) => console.error(JSON.stringify({ msg: "projector catch-up failed", ws, err: String(e).slice(0, 500) })));
      return { queued: projector.enabled };
    }
    await run;
    return { projectedThrough: await registry.with(ws, projectedThrough) };
  });
  wsRoute("POST", "projector/rebuild", "projector.rebuild", async ({ ws, body }) => {
    const b = parse(ProjectorRebuildBody, await body());
    return projector.rebuild(ws, b.object);
  });
  wsRoute("GET", "changes", "changes", async ({ ws, url }) => {
    const q = parse(ChangesQuery, Object.fromEntries(url.searchParams));
    return registry.with(ws, (w) => ops.getChanges(w, q.after, q.limit));
  });
  routes.push({
    method: "POST", pattern: /^\/v1\/shared\/prospects\/search$/, name: "prospects.search", workspace: false,
    handler: async ({ body }) => pdl.search(parse(ProspectSearchBody, await body())),
  });
  routes.push({
    method: "POST", pattern: /^\/v1\/shared\/prospects\/facets$/, name: "prospects.facets", workspace: false,
    handler: async ({ body }) => pdl.facets(parse(ProspectFacetsBody, await body())),
  });
  routes.push({
    method: "POST", pattern: /^\/v1\/shared\/prospects\/lookup$/, name: "prospects.lookup", workspace: false,
    handler: async ({ body }) => pdl.lookup(parse(ProspectLookupBody, await body())),
  });

  const send = (res: ServerResponse, status: number, payload: unknown, type = "application/json", t0?: number) => {
    res.writeHead(status, { "content-type": type, ...(t0 !== undefined ? { "server-timing": `app;dur=${(performance.now() - t0).toFixed(1)}` } : {}) });
    res.end(type === "application/json" ? JSON.stringify(payload) : String(payload));
  };

  let inFlight = 0;
  let draining = false;
  const server: Server = createServer(async (req, res) => {
    const t0 = performance.now();
    let route = "unknown";
    let status = 500;
    inFlight++;
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") {
        route = "healthz";
        status = 200;
        return send(res, 200, { ok: true, version: cfg.version, openWorkspaces: registry.openCount }, "application/json", t0);
      }
      if (!authorized(req)) throw new HttpError(401, "unauthorized");
      if (draining) throw new HttpError(503, "shutting down");
      if (req.method === "GET" && url.pathname === "/metrics") {
        route = "metrics";
        status = 200;
        return send(res, 200, renderMetrics(), "text/plain; version=0.0.4", t0);
      }
      if (cfg.allowCrash && req.method === "POST" && url.pathname === "/admin/crash") {
        route = "admin.crash";
        status = 202;
        send(res, 202, { crashing: true }, "application/json", t0);
        console.error(JSON.stringify({ msg: "crash requested: SIGKILL in 50ms" }));
        setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
        return;
      }
      let matched: Route | undefined;
      let m: RegExpExecArray | null = null;
      for (const r of routes) {
        m = r.pattern.exec(url.pathname);
        if (m) {
          if (r.method !== req.method) throw new HttpError(405, "method not allowed");
          matched = r;
          break;
        }
      }
      if (!matched) throw new HttpError(404, "not found");
      route = matched.name;
      let ws = "";
      if (matched.workspace) {
        try {
          ws = decodeURIComponent(m![1]);
        } catch {
          throw new HttpError(400, "invalid workspace id");
        }
        if (!WORKSPACE_ID_RE.test(ws)) throw new HttpError(400, "invalid workspace id");
        if (req.headers["x-workspace-id"] !== ws) throw new HttpError(403, "X-Workspace-Id must match the workspace in the path");
      }
      const params = matched.workspace ? m!.slice(2).map((p) => decodeURIComponent(p)) : [];
      const out = await matched.handler({ req, url, ws, params, body: () => readBody(req) });
      status = 200;
      send(res, 200, out, "application/json", t0);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(res, e.status, e.issues ? { error: e.message, issues: e.issues } : { error: e.message }, "application/json", t0);
      } else {
        status = 500;
        console.error(JSON.stringify({ msg: "request failed", route, err: String((e as Error)?.stack ?? e).slice(0, 2000) }));
        send(res, 500, { error: "internal error" }, "application/json", t0);
      }
    } finally {
      inFlight--;
      const ms = performance.now() - t0;
      metrics.requests.inc({ route, status: String(status) });
      metrics.latencyMs.observe(ms, { route });
    }
  });
  server.keepAliveTimeout = 65_000;

  const expireResearch = () => research.expire().catch((err) => console.error(JSON.stringify({ msg: "research expiry failed", err: String(err) })));
  void expireResearch();
  const researchTimer = setInterval(() => void expireResearch(), 60_000);
  researchTimer.unref();
  const checkpointTimer = setInterval(() => void registry.checkpointDirty(), cfg.checkpointIntervalMs);
  checkpointTimer.unref();

  const listWorkspaces = async () =>
    (await readdir(registry.wsDir)).filter((f) => f.endsWith(".duckdb")).map((f) => f.slice(0, -".duckdb".length)).filter((id) => WORKSPACE_ID_RE.test(id));

  let stopping: Promise<void> | null = null;
  /**
   * Refuse new requests and projector runs, then give in-flight requests and the
   * projector's running catch-ups (cut off at their next page) until the
   * deadline. Then drain write queues, checkpoint, close files.
   */
  const shutdown = (timeoutMs = 25_000) =>
    (stopping ??= (async () => {
      const deadline = Date.now() + timeoutMs;
      draining = true;
      clearInterval(checkpointTimer);
      clearInterval(researchTimer);
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      let projectorStopped = false;
      void projector.stop().then(() => (projectorStopped = true));
      while ((inFlight > 0 || !projectorStopped) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      pdl.close();
    })());

  return {
    server,
    registry,
    pdl,
    projector,
    listWorkspaces,
    shutdown,
    listen: () => new Promise<number>((r) => server.listen(cfg.port, cfg.host, () => r((server.address() as { port: number }).port))),
  };
}
