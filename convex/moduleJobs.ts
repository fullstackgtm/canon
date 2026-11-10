/**
 * Modules' background work (docs/modules.md, "Jobs, watches and schedules"), run by Canon as the module's system
 * principal:
 *
 * - **Jobs.** `run` leases the keys that may run (convex/lib/modules/jobs.ts), runs each batch's call in the recipe
 *   runtime (one read plan, one isolate `<org>:system`), and applies each key's writes in a mutation of its own, all
 *   or none, only while the key is still at the `dirtySeq` it was leased at. A batch that fails is split in two until
 *   the key that fails is alone; that key keeps its error and is tried again, a few times, after a wait.
 * - **The deal feed.** `feed` reads the records ledger from each watch's cursors, folds each deal change into its
 *   fields before and after (convex/automations.ts statesAround), hands them to the watch's call, and in one mutation
 *   dirties the keys the call names and moves the cursors.
 * - **Schedules, timed transitions and bulk moves**, started by the one-minute `sweep`, which also restarts runs a
 *   lost wake-up or a dead action left behind.
 *
 * Every read and write of module data goes through moduleScope's system scope (scope.ts) or jobs.ts.
 */
import { moduleRuntimeAvailable } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { retainedSourcePublication } from "./lib/modules/activityCapture";
import { exactJobLease, finishOwnedJob, jobLeaseV, jobSourceOf, scheduleNameOf, waitForJobPublication, type JobSource, type JobLease, type PublicationWait } from "./lib/modules/jobs";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { admitV, stageAndApply, withProposedRows, written } from "./modules";
import { statesAround } from "./automations";
import { loadDef } from "./objects";
import { rowOf } from "./lib/automations";
import { boundedPage } from "./lib/objects/tail";
import { SHARDS } from "./lib/objects/write";
import { installedModule, manifestOf } from "./lib/modules/packages";
import { initializeProjection, projectionOf, sameProjection } from "./lib/modules/projection";
import { systemScope, type Admit, type AppliedIntent, type BulkMove, type ModuleScope, type Snapshot } from "./lib/modules/scope";
import { clientFor } from "./records";
import type { RecordClient } from "./lib/recordClient";
import { MODULE_SYNC_BYTES, MODULE_SYNC_MAX, type ModuleDocRow, type ModuleProjection, type ModuleProjectionWork } from "./lib/objects/moduleReport";
import { projectedCollections } from "../modules/kernel/reports.ts";
import { BULK_JOB, REPORT_JOB, advanceConnectorFeed, connectorFeedPlan, connectorFeedStatus, advanceCursors, cursorsOf, dueSchedules, ensureCursors, failKey, finishKey, chargeLeaseRows, claimRunSlot, hasKeys, holdsRunSlot, leaseKeys, markDirty, releaseRunSlot, projectionLeased, rebaseProjection, releaseKey, stillLeased, stopKey, type Leased, type ConnectorFeedPlan } from "./lib/modules/jobs";
import { isSuperseded, moduleErrorMessage, superseded } from "./lib/modules/revision";
import { isMissingBundle, runModuleCall } from "./lib/recipeRuntime";
import { historyState } from "./dealHistory";
import { readRecordsOf, readTreesOf } from "./lib/modules/recordReadAction";
import { outputProblems, type CallOutput, type RecordChange } from "../modules/kernel/calls.ts";
import { ACTIVITY_OBJECTS } from "./lib/activities";
import { currentFeedGrants } from "./lib/connectors/grants";
import { feedOf } from "./lib/connectors/registry";
import type { ModuleManifest, WatchDecl } from "../modules/kernel/manifest.ts";

/** How long one `run` or `feed` keeps going before it hands the rest to a fresh action. */
const RUN_MS = 60_000;
/** Ledger entries the feed reads per shard per pass, deal changes it hands one call, and stream entries it folds. */
const FEED_PAGE = 50;
const FEED_CHANGES = 100;
const FEED_FOLDS = 3000;
/** The records one activity's change names as its targets, past its lookups. */
const ACTIVITY_TARGETS_MAX = 20;
const ERROR_MAX = 500;
/** Keys of one batch applied at once, each in its own transaction. */
const APPLY_PARALLEL = 8;
/** Timed transitions one sweep runs per module. */
const TIMED_MAX = 100;

const org = v.id("organizations");
const jobSourceV = v.object({ packageId: v.id("modulePackages"), epoch: v.number(), manifestHash: v.string(), bundleHash: v.union(v.string(), v.null()) });
type Waiting = { status: "waiting"; wait: PublicationWait };
class JobControl extends Error {
  constructor(readonly result: Waiting | { status: "stale" }) { super("The job must recompute from current state."); }
}
type JobRun = { orgId: Id<"organizations">; moduleId: string; job: string; key: string; seq: number; source: JobSource; lease: JobLease };
async function applyJob(ctx: ActionCtx, run: JobRun, call: string, epoch: number, intents: AppliedIntent[], admit: Admit) {
  const result = await ctx.runMutation(internal.moduleJobs.applyKey, { ...run, call, epoch, intents, admit });
  if (result.status !== "applied") throw new JobControl(result.status === "waiting" ? result : { status: "stale" });
  return { writes: result.writes, proposed: [], retired: result.retired };
}
async function stageJob(ctx: ActionCtx, run: JobRun, call: string, epoch: number, chunk: { collection: string; parentKey: string; gen: number; offset: number; docs: Array<Record<string, unknown>> }, admit: Admit) {
  const result = await ctx.runMutation(internal.moduleJobs.stageKey, { ...run, call, epoch, ...chunk, admit });
  if (result.status !== "staged") throw new JobControl(result);
  return result.count;
}
const projectionV = v.object({ packageId: v.string(), epoch: v.number(), generation: v.number(), collections: v.array(v.string()) });
const projectionArgs = (p: ModuleProjection) => ({ ...p, collections: [...p.collections] });
const message = (e: unknown) => moduleErrorMessage(e).slice(0, ERROR_MAX);

/** Whether a module's calls read deals as they stood (deals.asOf, deals.changesBetween). */
const readsDealHistory = (m: ModuleManifest) => Object.values(m.calls ?? {}).some((c) => Object.values(c.reads).some((r) => "canon" in r && (r.canon === "deals.asOf" || r.canon === "deals.changesBetween")));

/** Canon's scope on an installed module that is on, or null. */
async function scopeIn(ctx: Parameters<typeof systemScope>[0], orgId: Id<"organizations">, moduleId: string, admit?: Admit): Promise<ModuleScope | null> {
  return systemScope(ctx, orgId, moduleId, false, admit);
}

// ── Jobs ──

/** Lease the keys that may run now, in batches; null when the module isn't on. */
export const lease = internalMutation({
  args: { orgId: org, moduleId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ epoch: number; source: JobSource; manifest: ModuleManifest; projection: ModuleProjection | null; batches: Leased[][] } | null> => {
    // A run leases only while it holds the module's run slot and the runner is within its read budget.
    if (a.token !== undefined && !await holdsRunSlot(ctx.db, a.orgId, a.moduleId, a.token, Date.now())) return null;
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    if (!scope) {
      if (a.token !== undefined) await releaseRunSlot(ctx, a.orgId, a.moduleId, a.token);
      return null;
    }
    const pkg = (await installedModule(ctx, a.orgId, scope.moduleId))!;
    const source = jobSourceOf(pkg);
    // Its keys wait while an upgrade migrates its docs, and run under the new version.
    if (scope.migrating) return { epoch: scope.epoch, source, manifest: scope.manifest, projection: null, batches: [] };
    const projection = await initializeProjection(ctx, pkg, scope.manifest);
    const meter = { rows: 0 };
    const batches = await leaseKeys(ctx, a.orgId, scope.moduleId, scope.manifest, Date.now(), undefined, !!await retainedSourcePublication(ctx, pkg), meter);
    const paused = await chargeLeaseRows(ctx, a.orgId, scope.moduleId, meter.rows, Date.now());
    if (paused) console.error(`moduleJobs: ${a.orgId}/${scope.moduleId}: ${paused}`);
    // A run that finds nothing to lease ends, and frees the slot for the next dirty's run.
    if (a.token !== undefined && !batches.length) await releaseRunSlot(ctx, a.orgId, scope.moduleId, a.token);
    return { epoch: scope.epoch, source, manifest: scope.manifest, projection, batches };
  },
});

/** Take or renew the module's run slot; false when another run holds it or the runner is paused. */
export const claimRun = internalMutation({
  args: { orgId: org, moduleId: v.string(), token: v.string() },
  handler: async (ctx, a): Promise<boolean> => !!await scopeIn(ctx, a.orgId, a.moduleId) && claimRunSlot(ctx, a.orgId, a.moduleId, a.token, Date.now()),
});

/**
 * One key's writes, all or none, as Canon: applied only while the key is still at the count it was leased at and the
 * module at the version it was computed under. "stale": it changed since; it runs again.
 */
export const applyKey = internalMutation({
  args: { orgId: org, moduleId: v.string(), job: v.string(), key: v.string(), seq: v.number(), epoch: v.number(), source: jobSourceV, lease: jobLeaseV, call: v.string(), intents: v.array(v.any()), admit: admitV },
  handler: async (ctx, a): Promise<Waiting | { status: "applied" | "stale"; writes: number; retired: Array<{ collection: string; parentKey: string; gen: number }> }> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId, a.admit);
    if (!scope || scope.epoch !== a.epoch || a.source.epoch !== a.epoch || scope.migrating || a.seq !== a.lease.dirtySeq) return { status: "stale", writes: 0, retired: [] };
    const owned = await exactJobLease(ctx, a.orgId, scope.moduleId, a.job, a.key, a.source, a.lease);
    if (!owned) return { status: "stale", writes: 0, retired: [] };
    const schedule = scheduleNameOf(a.job);
    if (schedule !== null && scope.manifest.schedules?.[schedule]?.call !== a.call) return { status: "stale", writes: 0, retired: [] };
    const wait = await waitForJobPublication(ctx, owned);
    if (wait) return { status: "waiting", wait };
    const out = await written(scope, scope.apply(a.call, a.intents as AppliedIntent[]));
    await finishOwnedJob(ctx, owned);
    return { status: "applied", writes: out.writes, retired: out.retired };
  },
});

export const stageKey = internalMutation({
  args: { orgId: org, moduleId: v.string(), job: v.string(), key: v.string(), seq: v.number(), epoch: v.number(), source: jobSourceV, lease: jobLeaseV, call: v.string(), collection: v.string(), parentKey: v.string(), gen: v.number(), offset: v.number(), docs: v.array(v.record(v.string(), v.any())), admit: admitV },
  handler: async (ctx, a): Promise<Waiting | { status: "stale" } | { status: "staged"; count: number }> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId, a.admit);
    if (!scope || scope.epoch !== a.epoch || a.source.epoch !== a.epoch || scope.migrating || a.seq !== a.lease.dirtySeq) return { status: "stale" };
    const owned = await exactJobLease(ctx, a.orgId, scope.moduleId, a.job, a.key, a.source, a.lease);
    if (!owned) return { status: "stale" };
    const schedule = scheduleNameOf(a.job);
    if (schedule !== null && scope.manifest.schedules?.[schedule]?.call !== a.call) return { status: "stale" };
    const wait = await waitForJobPublication(ctx, owned);
    if (wait) return { status: "waiting", wait };
    return { status: "staged", count: await written(scope, scope.stage(a.call, a.collection, a.parentKey, a.gen, a.docs, a.offset)) };
  },
});

/** Keys whose run returned no writes, done together: each only while still at the count it was leased at. */
export const finishEmpty = internalMutation({
  args: { orgId: org, moduleId: v.string(), job: v.string(), epoch: v.number(), source: jobSourceV, keys: v.array(v.object({ key: v.string(), seq: v.number(), lease: jobLeaseV })) },
  handler: async (ctx, a): Promise<number> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    if (!scope) return 0;
    let finished = 0;
    for (const k of a.keys) {
      if (scope.epoch !== a.epoch || a.source.epoch !== a.epoch || scope.migrating || k.seq !== k.lease.dirtySeq) continue;
      const owned = await exactJobLease(ctx, a.orgId, scope.moduleId, a.job, k.key, a.source, k.lease);
      if (owned && await finishOwnedJob(ctx, owned)) finished++;
    }
    return finished;
  },
});

export const failed = internalMutation({
  args: { orgId: org, moduleId: v.string(), job: v.string(), key: v.string(), seq: v.number(), epoch: v.number(), error: v.string(), source: v.optional(jobSourceV), lease: v.optional(jobLeaseV), id: v.optional(v.string()), projection: v.optional(projectionV) },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    if (!scope) return null;
    if (a.job === REPORT_JOB) {
      const pkg = await installedModule(ctx, a.orgId, scope.moduleId);
      if (!pkg || !a.id || !sameProjection(projectionOf(pkg, scope.manifest), a.projection) || !(await projectionLeased(ctx.db, a.orgId, scope.moduleId, a.key, a.id, a.seq))) return null;
    } else {
      if (!a.source || !a.lease || a.source.epoch !== a.epoch || a.lease.dirtySeq !== a.seq || scope.epoch !== a.epoch || scope.migrating) return null;
      if (!await exactJobLease(ctx, a.orgId, scope.moduleId, a.job, a.key, a.source, a.lease)) return null;
      await failKey(ctx, a.orgId, scope.moduleId, scope.manifest, a.job, a.key, a.seq, a.error, Date.now());
      return null;
    }
    if (!(await stillLeased(ctx, a.orgId, scope.moduleId, a.job, a.key, a.seq))) return null;
    if (scope.epoch !== a.epoch || scope.migrating) await releaseKey(ctx, a.orgId, scope.moduleId, a.job, a.key);
    else await failKey(ctx, a.orgId, scope.moduleId, scope.manifest, a.job, a.key, a.seq, a.error, Date.now());
    return null;
  },
});

/**
 * One batch of a bulk move, as Canon; done once every doc has moved and the waiting doc has moved on. Stopped when
 * the docs left all refuse their move: the key stays with them named, until a person retries it.
 */
export const bulkBatch = internalMutation({
  args: { orgId: org, moduleId: v.string(), key: v.string(), seq: v.number(), source: jobSourceV, lease: jobLeaseV, move: v.any() },
  handler: async (ctx, a): Promise<Waiting | { status: "more" | "done" | "stopped" | "stale" }> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    const owned = scope && scope.epoch === a.source.epoch && !scope.migrating && a.seq === a.lease.dirtySeq ? await exactJobLease(ctx, a.orgId, scope.moduleId, BULK_JOB, a.key, a.source, a.lease) : null;
    if (!scope || !owned) return { status: "stale" };
    const wait = await waitForJobPublication(ctx, owned);
    if (wait) return { status: "waiting", wait };
    const move = a.move as BulkMove;
    const out = await scope.bulkStep(move);
    if (out.state === "stopped") {
      const named = out.refused.slice(0, 3).map((r) => `${r.key}: ${r.message}`).join("; ");
      if (await exactJobLease(ctx, a.orgId, scope.moduleId, BULK_JOB, a.key, a.source, a.lease)) await stopKey(ctx, a.orgId, scope.moduleId, a.key, a.seq, `${out.count} ${out.count === 1 ? "doc" : "docs"} refused to move. ${named}`, { ...move, stopped: { refused: out.refused, count: out.count } });
      return { status: "stopped" };
    }
    // More to move: the key stays, freed for the next batch.
    if (out.state === "more") await markDirty(ctx, a.orgId, scope.moduleId, scope.manifest, BULK_JOB, a.key, a.move);
    await finishOwnedJob(ctx, owned);
    return { status: out.state };
  },
});

// ── The report projection (docs/modules.md, "Reports and charts") ──

/** Keys read per query, so one read stays far below a query's result limit (a doc holds at most 256 KB). */
const PROJECT_READ = 25;
/** Docs a rebuild reads per page. */
const PROJECT_PAGE = 200;
const projectionKeyV = v.object({ key: v.string(), id: v.string(), seq: v.number() });

/** Lazy migration for already installed packages; the sweep also initializes packages nobody has opened. */
export const initializeReports = internalMutation({
  args: { orgId: org, moduleId: v.string() },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    if (!scope || scope.migrating) return null;
    const pkg = (await installedModule(ctx, a.orgId, scope.moduleId))!;
    return initializeProjection(ctx, pkg, scope.manifest);
  },
});

/** The projected docs a batch of report keys names, as Canon reads them: each doc, or null when it is gone. */
export const projectRead = internalQuery({
  args: { orgId: org, moduleId: v.string(), projection: projectionV, keys: v.array(projectionKeyV) },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    const pkg = scope && await installedModule(ctx, a.orgId, scope.moduleId);
    if (!scope || scope.migrating || !pkg || !sameProjection(projectionOf(pkg, scope.manifest), a.projection)) return null;
    for (const k of a.keys) if (!(await projectionLeased(ctx.db, a.orgId, scope.moduleId, k.key, k.id, k.seq))) return null;
    return scope.projectRows(a.keys.map((k) => k.key));
  },
});

/** A page of a collection's docs for a rebuild, after `after`. */
export const projectPage = internalQuery({
  args: { orgId: org, moduleId: v.string(), projection: projectionV, key: projectionKeyV, collection: v.string(), after: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    const pkg = scope && await installedModule(ctx, a.orgId, scope.moduleId);
    return scope && !scope.migrating && pkg && sameProjection(projectionOf(pkg, scope.manifest), a.projection)
      && await projectionLeased(ctx.db, a.orgId, scope.moduleId, a.key.key, a.key.id, a.key.seq)
      ? scope.projectPage(a.collection, a.after, PROJECT_PAGE) : null;
  },
});

/** Report keys sent: each done unless dirtied since; a rebuild with more to send waits for its next page. */
export const projectDone = internalMutation({
  args: { orgId: org, moduleId: v.string(), projection: projectionV, keys: v.array(projectionKeyV), next: v.optional(v.object({ after: v.string(), rebuildSeq: v.number() })), retryAfter: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    const pkg = scope && await installedModule(ctx, a.orgId, scope.moduleId);
    if (!scope || scope.migrating || !pkg || !sameProjection(projectionOf(pkg, scope.manifest), a.projection)) return null;
    for (const k of a.keys) {
      if (!(await projectionLeased(ctx.db, a.orgId, scope.moduleId, k.key, k.id, k.seq))) continue;
      if (a.retryAfter !== undefined) { await rebaseProjection(ctx, a.orgId, scope.moduleId, k.key, k.id, k.seq, a.retryAfter); continue; }
      if (a.next) await markDirty(ctx, a.orgId, scope.moduleId, scope.manifest, REPORT_JOB, k.key, a.next);
      else if (k.key.endsWith("|*")) {
        const completed = [...new Set([...pkg.projection!.completed, k.key.slice(0, -2)])];
        await ctx.db.patch(pkg._id, { projection: { ...pkg.projection!, completed } });
      }
      await finishKey(ctx, a.orgId, scope.moduleId, REPORT_JOB, k.key, k.seq);
    }
    return null;
  },
});

class ProjectionRetry extends Error { constructor(readonly floor: number) { super("Projection sequence needs rebasing."); } }

async function sendProjection(client: Pick<RecordClient, "moduleSync">, orgId: string, moduleId: string, upserts: readonly ModuleDocRow[], deletes: ReadonlyArray<{ collection: string; key: string }>, projection: ModuleProjection, work: ModuleProjectionWork) {
  const out = await client.moduleSync(orgId, { module: moduleId, upserts, deletes, projection, work });
  if (!out.receipt || !sameProjection(out.receipt.projection, projection) || JSON.stringify(out.receipt.work) !== JSON.stringify(work)) throw new ConvexError("Module reports need record service 1.43.0 with projection receipts. No work was completed.");
  if (!out.receipt.accepted) {
    if (out.receipt.retryAfter !== undefined && Number.isSafeInteger(out.receipt.retryAfter)) throw new ProjectionRetry(out.receipt.retryAfter);
    throw new ConvexError("The module report projection generation changed. Try again shortly.");
  }
  return out;
}

/** Send every bounded chunk before completion; retain the legacy timestamp return for unfenced callers. */
export async function sendDocs(client: Pick<RecordClient, "moduleSync">, orgId: string, moduleId: string, upserts: readonly ModuleDocRow[], deletes: ReadonlyArray<{ collection: string; key: string }>, fenced?: { projection: ModuleProjection; work: ModuleProjectionWork }): Promise<number> {
  let first: number | null = null;
  const send = async (u: ModuleDocRow[], d: ReadonlyArray<{ collection: string; key: string }>) => {
    const work = fenced?.work.kind === "keys" ? { kind: "keys" as const, keys: fenced.work.keys.filter((k) => [...u, ...d].some((r) => r.collection === k.collection && r.key === k.key)) } : fenced?.work;
    const { at } = fenced && work ? await sendProjection(client, orgId, moduleId, u, d, fenced.projection, work) : await client.moduleSync(orgId, { module: moduleId, upserts: u, deletes: d });
    first ??= at;
  };
  let chunk: ModuleDocRow[] = [], bytes = 0;
  for (const row of upserts) {
    const size = JSON.stringify(row).length;
    if (chunk.length && (chunk.length >= MODULE_SYNC_MAX || bytes + size > MODULE_SYNC_BYTES)) { await send(chunk, []); chunk = []; bytes = 0; }
    chunk.push(row);
    bytes += size;
  }
  await send(chunk, deletes);
  return first!;
}

/**
 * One batch of report keys: each doc read as it is now and sent (or deleted when it's gone), then the keys done. A
 * `*` key sends its collection a page at a time, and its last page sweeps the rows the rebuild didn't send.
 */
async function projectBatch(ctx: ActionCtx, orgId: Id<"organizations">, moduleId: string, batch: Leased[], stamp: ModuleProjection) {
  const projection = projectionArgs(stamp);
  const first = batch[0];
  const keys = batch.map((b) => ({ key: b.key, seq: b.seq, id: b.id! }));
  try {
    if (!projection.collections.includes(first.key.slice(0, first.key.indexOf("|"))) && first.key.endsWith("|*")) {
      await ctx.runMutation(internal.moduleJobs.projectDone, { orgId, moduleId, projection, keys });
      return;
    }
    if (first.key.endsWith("|*")) {
      const collection = first.key.slice(0, -2);
      const at = (first.payload ?? {}) as { after?: string; rebuildSeq?: number };
      const seq = at.rebuildSeq ?? first.seq;
      const page = await ctx.runQuery(internal.moduleJobs.projectPage, { orgId, moduleId, projection, key: keys[0], collection, after: at.after ?? null });
      if (!page) return;
      const work = { kind: "rebuild" as const, collection, job: first.id!, seq, complete: false };
      await sendDocs(clientFor(ctx), orgId, moduleId, page.rows, [], { projection, work });
      if (!page.more) await sendProjection(clientFor(ctx), orgId, moduleId, [], [], projection, { ...work, complete: true });
      const last = page.rows[page.rows.length - 1]?.key;
      await ctx.runMutation(internal.moduleJobs.projectDone, { orgId, moduleId, projection, keys, ...(page.more && last ? { next: { after: last, rebuildSeq: seq } } : {}) });
      return;
    }
    const upserts: ModuleDocRow[] = [], deletes: Array<{ collection: string; key: string }> = [];
    const eligible = keys.filter((k) => projection.collections.includes(k.key.slice(0, k.key.indexOf("|"))));
    for (let i = 0; i < eligible.length; i += PROJECT_READ) {
      const read = await ctx.runQuery(internal.moduleJobs.projectRead, { orgId, moduleId, projection, keys: eligible.slice(i, i + PROJECT_READ) });
      if (!read) return;
      for (const r of read) { if (r.row) upserts.push(r.row); else deletes.push({ collection: r.collection, key: r.key }); }
    }
    if (eligible.length) await sendDocs(clientFor(ctx), orgId, moduleId, upserts, deletes, { projection, work: { kind: "keys", keys: eligible.map((k) => ({ collection: k.key.slice(0, k.key.indexOf("|")), key: k.key.slice(k.key.indexOf("|") + 1), job: k.id, seq: k.seq })) } });
    await ctx.runMutation(internal.moduleJobs.projectDone, { orgId, moduleId, projection, keys });
  } catch (e) {
    if (!(e instanceof ProjectionRetry)) throw e;
    await ctx.runMutation(internal.moduleJobs.projectDone, { orgId, moduleId, projection, keys, retryAfter: e.floor });
  }
}

/** A batch's call arguments: its keys, the parts they share as values, the others as lists. */
function argsOf(m: ModuleManifest, job: string, keys: readonly string[]) {
  const decl = m.jobs![job];
  const by = decl.batchBy ?? 0;
  const split = keys.map((k) => k.split("|"));
  return { keys: [...keys], ...Object.fromEntries(decl.key.map((p, i) => [p, i < by ? split[0][i] : [...new Set(split.map((s) => s[i]))]])) };
}

type RunState = { keys: number; writes: number; failed: number };

/** One batch: its read plan, its call, then each key's writes; a batch that fails splits until the failing key is alone. */
async function runBatch(ctx: ActionCtx, orgId: Id<"organizations">, moduleId: string, batch: Leased[], revision: { manifest: ModuleManifest; epoch: number; source: JobSource; projection: ModuleProjection | null }, st: RunState): Promise<void> {
  const job = batch[0].job;
  if (job === REPORT_JOB) {
    try { if (revision.projection) await projectBatch(ctx, orgId, moduleId, batch, revision.projection); st.keys += batch.length; }
    catch (e) { st.failed++; for (const b of batch) await ctx.runMutation(internal.moduleJobs.failed, { orgId, moduleId, job, key: b.key, seq: b.seq, id: b.id, ...(revision.projection ? { projection: projectionArgs(revision.projection) } : {}), epoch: revision.epoch, error: message(e) }); }
    return;
  }
  if (batch.some((key) => !key.lease)) return;
  const schedule = scheduleNameOf(job);
  if (schedule !== null) {
    const key = batch[0];
    const run: JobRun = { orgId, moduleId, job, key: key.key, seq: key.seq, source: revision.source, lease: key.lease! };
    try { const out = await scheduledCall(ctx, { orgId, moduleId, schedule }, run); st.keys++; st.writes += out.writes; }
    catch (error) {
      if (error instanceof JobControl) return;
      st.failed++;
      await ctx.runMutation(internal.moduleJobs.failed, { ...run, epoch: revision.epoch, error: message(error) });
    }
    return;
  }
  if (job === BULK_JOB) {
    try {
      const result = await ctx.runMutation(internal.moduleJobs.bulkBatch, { orgId, moduleId, key: batch[0].key, seq: batch[0].seq, source: revision.source, lease: batch[0].lease!, move: batch[0].payload });
      if (result.status !== "waiting" && result.status !== "stale") st.keys++;
    }
    catch (e) { st.failed++; await ctx.runMutation(internal.moduleJobs.failed, { orgId, moduleId, job, key: batch[0].key, seq: batch[0].seq, source: revision.source, lease: batch[0].lease!, epoch: revision.epoch, error: message(e) }); }
    return;
  }
  const call = revision.manifest.jobs![job].call;
  let out: CallOutput;
  let snap: Snapshot;
  try {
    const args = argsOf(revision.manifest, job, batch.map((b) => b.key));
    snap = await ctx.runQuery(internal.modules.callPlan, { module: moduleId, call, args, system: orgId, canon: true, epoch: revision.epoch });
    await readRecordsOf(ctx, snap, snap.reads, orgId);
    await readTreesOf(ctx, snap, snap.reads, orgId);
    const result = await runModuleCall(ctx, snap.bundle!, { isolate: snap.isolate, call, ctx: { now: Date.now(), caller: snap.caller, args, workspace: snap.workspace }, reads: snap.reads });
    if (!result.ok) throw new ConvexError(`${snap.label} failed in the module's code (${result.error.kind}): ${result.error.message}`);
    const problems = outputProblems(result.value);
    if (problems.length) throw new ConvexError(`${snap.label} returned writes Canon can't apply: ${problems.slice(0, 5).join("; ")}.`);
    out = result.value as CallOutput;
    if (out.intents?.length) throw new ConvexError(`${snap.label} is a job's call: it returns its writes by key, in byKey.`);
    const stray = Object.keys(out.byKey ?? {}).filter((k) => !batch.some((b) => b.key === k));
    if (stray.length) throw new ConvexError(`${snap.label} returned writes for ${stray.slice(0, 3).join(", ")}, which it wasn't given.`);
  } catch (e) {
    if (batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await runBatch(ctx, orgId, moduleId, batch.slice(0, half), revision, st);
      await runBatch(ctx, orgId, moduleId, batch.slice(half), revision, st);
      return;
    }
    st.failed++;
    await ctx.runMutation(internal.moduleJobs.failed, { orgId, moduleId, job, key: batch[0].key, seq: batch[0].seq, source: revision.source, lease: batch[0].lease!, epoch: revision.epoch, error: message(e) });
    return;
  }
  // Keys with nothing to write finish together; each other key applies in a transaction of its own, a few at once.
  const empty = batch.filter((b) => !out.byKey?.[b.key]?.length);
  if (empty.length) {
    await ctx.runMutation(internal.moduleJobs.finishEmpty, { orgId, moduleId, job, epoch: revision.epoch, source: revision.source, keys: empty.map((b) => ({ key: b.key, seq: b.seq, lease: b.lease! })) });
    st.keys += empty.length;
  }
  const queue = batch.filter((b) => out.byKey?.[b.key]?.length);
  await Promise.all(Array.from({ length: Math.min(APPLY_PARALLEL, queue.length) }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        const run: JobRun = { orgId, moduleId, job, key: b.key, seq: b.seq, source: revision.source, lease: b.lease! };
        const applied = await stageAndApply(ctx, { module: moduleId, call, label: snap.label, epoch: snap.epoch }, orgId, await withProposedRows(ctx, moduleId, snap.label, orgId, out.byKey![b.key]),
          (intents, admit) => applyJob(ctx, run, call, revision.epoch, intents, admit), undefined,
          (chunk, admit) => stageJob(ctx, run, call, revision.epoch, chunk, admit));
        st.keys++;
        st.writes += applied?.writes ?? 0;
      } catch (e) {
        if (e instanceof JobControl) continue;
        st.failed++;
        await ctx.runMutation(internal.moduleJobs.failed, { orgId, moduleId, job, key: b.key, seq: b.seq, epoch: revision.epoch, source: revision.source, lease: b.lease!, error: message(e) });
      }
    }
  }));
}

/**
 * Run a module's waiting keys until none may run, for at most a minute, then hand on to a fresh run when some are
 * left. One run per module at a time (the run slot, lib/modules/jobs.ts): every dirty and every sweep schedules a
 * run, and the ones that find the slot held end at once. A group never runs two of its keys at once.
 */
export const run = internalAction({
  args: { orgId: org, moduleId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ keys: number; writes: number; failed: number }> => {
    const st: RunState = { keys: 0, writes: 0, failed: 0 };
    const token = a.token ?? crypto.randomUUID();
    const slot = { orgId: a.orgId, moduleId: a.moduleId, token };
    if (!await ctx.runMutation(internal.moduleJobs.claimRun, slot)) return st;
    const deadline = Date.now() + RUN_MS;
    while (Date.now() < deadline) {
      const leased = await ctx.runMutation(internal.moduleJobs.lease, slot);
      if (!leased || !leased.batches.length) return { keys: st.keys, writes: st.writes, failed: st.failed };
      // Batches of different groups run side by side, a few at a time.
      const queue = [...leased.batches];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let b = queue.shift(); b; b = queue.shift()) await runBatch(ctx, a.orgId, a.moduleId, b, leased, st);
      }));
    }
    // The next run keeps this run's token, so it renews the slot rather than waiting for it.
    await ctx.scheduler.runAfter(0, internal.moduleJobs.run, slot);
    return { keys: st.keys, writes: st.writes, failed: st.failed };
  },
});

/** The manifest and epoch of an installed module that is on, read together. */
export const manifestFor = internalQuery({
  args: { orgId: org, moduleId: v.string() },
  handler: async (ctx, a): Promise<{ manifest: ModuleManifest; epoch: number } | null> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    return scope ? { manifest: scope.manifest, epoch: scope.epoch } : null;
  },
});

// ── The deal feed ──

type FeedPlan = { epoch: number; from: Record<string, number>; to: Record<string, number>; changes: RecordChange[]; more: boolean };
/** The ledger objects a watch on each module object reads. */
const LEDGER_OBJECTS: Record<WatchDecl["object"], readonly string[]> = { deals: ["deal"], companies: ["account"], people: ["contact"], activities: ACTIVITY_OBJECTS };

/** A deal's watched fields from a fold state, in a module's names; `ownerId` falls back to the row's owner. */
function dealFields(def: Awaited<ReturnType<typeof loadDef>>, state: Parameters<typeof rowOf>[1], fields: readonly string[], rowOwner: string | null): Record<string, unknown> | null {
  const row = rowOf(def, state);
  if (row.deletedAt !== null) return null;
  return Object.fromEntries(fields.map((f) => [f, f === "ownerId" ? (row.values.ownerId ?? rowOwner) : (row.values[f] ?? null)]));
}

/**
 * The deal changes after a watch's cursors, at most a call's worth: each shard read in `seq` order and stopped at the
 * first gap, as the record service's projector reads it, so the cursors never pass an entry they didn't read.
 */
export const feedPlan = internalQuery({
  args: { orgId: org, moduleId: v.string(), watch: v.string() },
  handler: async (ctx, a): Promise<FeedPlan | null> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    const w = scope?.manifest.watches?.find((x) => x.call === a.watch);
    const from = scope && w ? await cursorsOf(ctx.db, a.orgId, scope.moduleId, a.watch) : null;
    if (!scope || !w || !from) return null;
    return { ...await readFeed(ctx, a.orgId, w, from), epoch: scope.epoch };
  },
});

async function readFeed(ctx: QueryCtx, orgId: Id<"organizations">, w: WatchDecl, from: Record<string, number>): Promise<Omit<FeedPlan, "epoch">> {
  const to = { ...from };
  const changes: RecordChange[] = [];
  let folds = 0, more = false;
  const objects = LEDGER_OBJECTS[w.object];
  const defs = new Map<string, Awaited<ReturnType<typeof loadDef>>>();
  const defOf = async (o: string) => defs.get(o) ?? defs.set(o, await loadDef(ctx, orgId, o)).get(o)!;
  for (let shard = 0; shard < SHARDS; shard++) {
    const after = from[String(shard)] ?? 0;
    const page = await boundedPage(ctx.db.query("ledgerEntries").withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", orgId).eq("shard", shard).gt("seq", after)), { limit: FEED_PAGE, maxBytes: 400_000 });
    let seq = after;
    for (const row of page.items) {
      if (row.seq !== seq + 1) break;
      if (changes.length >= FEED_CHANGES || folds >= FEED_FOLDS) { more = true; break; }
      seq = row.seq;
      if (!objects.includes(row.object) || row.redactedAt !== undefined) continue;
      const change = w.object === "deals" ? await dealChange(ctx, await defOf("deal"), w, row) : await recordChange(ctx, await defOf(row.object), w, row);
      folds += change.read;
      if (change.change) changes.push(change.change);
    }
    to[String(shard)] = seq;
    more ||= page.more;
  }
  return { from, to, changes, more };
}

/** One deal entry as a watch sees it: its watched fields before and after, or nothing when none of them changed. */
async function dealChange(ctx: QueryCtx, def: Awaited<ReturnType<typeof loadDef>>, w: WatchDecl, row: Doc<"ledgerEntries">): Promise<{ change: RecordChange | null; read: number }> {
  const entity = await ctx.db.get(row.streamId);
  const dealId = entity?.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  if (!dealId) return { change: null, read: 0 };
  const { states, read } = await statesAround(ctx, row.streamId, row.version, row.observedAt);
  if (!states || states === "too_long") return { change: null, read };
  const deal = await ctx.db.get(dealId);
  const owner = deal?.primaryRepId ?? null;
  // A deal a CRM import created without an owner fact has its owner on the row only: both sides read it there, until
  // an owner write puts one on the ledger, whose earlier owner the ledger then never knew (null).
  const ledgerOwner = (rowOf(def, states.after).values.ownerId ?? null) !== null;
  const after = dealFields(def, states.after, w.fields, owner);
  const before = states.before ? dealFields(def, states.before, w.fields, ledgerOwner ? null : owner) : null;
  if (JSON.stringify(before) === JSON.stringify(after)) return { change: null, read };
  return { change: { id: dealId, at: row.observedAt, before, after }, read };
}

/** A deal's id from its ledger stream id, or null: how a module names a deal an activity is about. */
async function dealOfStream(ctx: QueryCtx, streamId: string): Promise<string | null> {
  const id = ctx.db.normalizeId("canonEntities", streamId);
  const e = id ? await ctx.db.get(id) : null;
  return e?.projectionTable === "deals" ? e.projectionId : null;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
/** A company's, person's or activity's watched fields from a fold state, in a module's names (recordReads.ts), or null when deleted. */
async function recordFields(ctx: QueryCtx, def: Awaited<ReturnType<typeof loadDef>>, object: string, state: Parameters<typeof rowOf>[1], fields: readonly string[]): Promise<Record<string, unknown> | null> {
  const row = rowOf(def, state);
  if (row.deletedAt !== null) return null;
  const v = row.values;
  const named = (f: string): unknown => {
    if (f === "name") return v.name ?? v.fullName ?? null;
    if (f === "kind") return object;
    if (f === "at") return (object === "call" ? v.callAt : object === "meeting" ? v.startAt : null) ?? row.createdAt;
    if (f === "companyId") return v.accountId ?? null;
    if (f === "personId") return v.contactId ?? null;
    if (f === "subject") return object === "meeting" ? v.title ?? null : object === "note" ? null : v.subject ?? null;
    return v[f] ?? null;
  };
  const out = Object.fromEntries(fields.map((f) => [f, named(f)]));
  if ("dealId" in out) out.dealId = str(out.dealId) ? await dealOfStream(ctx, str(out.dealId)!) : null;
  return out;
}

/**
 * One company, person or activity entry as a watch sees it: its watched fields before and after, or nothing when none
 * changed. A company or person is named by its register id; an activity carries the deals, companies and people it is
 * about after the change, from its lookups and its activity edges.
 */
async function recordChange(ctx: QueryCtx, def: Awaited<ReturnType<typeof loadDef>>, w: WatchDecl, row: Doc<"ledgerEntries">): Promise<{ change: RecordChange | null; read: number }> {
  const entity = await ctx.db.get(row.streamId);
  if (!entity) return { change: null, read: 0 };
  const activity = w.object === "activities";
  const id = activity ? entity._id as string : entity.projectionTable === "recordAccounts" || entity.projectionTable === "recordContacts" ? entity.projectionId : null;
  if (!id) return { change: null, read: 0 };
  const { states, read } = await statesAround(ctx, row.streamId, row.version, row.observedAt);
  if (!states || states === "too_long") return { change: null, read };
  const after = await recordFields(ctx, def, row.object, states.after, w.fields);
  const before = states.before ? await recordFields(ctx, def, row.object, states.before, w.fields) : null;
  if (JSON.stringify(before) === JSON.stringify(after)) return { change: null, read };
  if (!activity) return { change: { id, at: row.observedAt, before, after }, read };
  const lookups = rowOf(def, states.after).values;
  const edges = await ctx.db.query("associations")
    .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", row.orgId).eq("association", "activity_target").eq("fromId", entity._id))
    .take(ACTIVITY_TARGETS_MAX);
  const about = [...new Set([str(lookups.dealId), str(lookups.accountId), str(lookups.contactId), ...edges.filter((e) => e.active).map((e) => e.toId)].filter((x): x is string => !!x))];
  const targets = { deals: [] as string[], companies: about.filter((x) => x.startsWith("acc_")), people: about.filter((x) => x.startsWith("con_")) };
  for (const x of about.filter((x) => !x.startsWith("acc_") && !x.startsWith("con_"))) { const d = await dealOfStream(ctx, x); if (d) targets.deals.push(d); }
  return { change: { id, at: row.observedAt, before, after, targets }, read };
}

/** Dirty the keys a watch's call named and move its cursors, together; refused when another run moved them first. */
export const feedApply = internalMutation({
  args: { orgId: org, moduleId: v.string(), watch: v.string(), epoch: v.number(), from: v.record(v.string(), v.number()), to: v.record(v.string(), v.number()), dirty: v.array(v.object({ job: v.string(), key: v.string() })), error: v.optional(v.string()) },
  handler: async (ctx, a): Promise<boolean> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    if (!scope || scope.epoch !== a.epoch || scope.migrating) return false;
    if (!(await advanceCursors(ctx, a.orgId, scope.moduleId, a.watch, a.from, a.error ? a.from : a.to, a.error))) return false;
    if (!a.error) for (const d of a.dirty) await scope.dirty(d.job, d.key);
    return true;
  },
});

/** Read every watch of every module with a feed in the workspace to the ledger's end, for at most a minute. */
export const feed = internalAction({
  args: { orgId: org },
  handler: async (ctx, a): Promise<number> => {
    const modules: Array<{ moduleId: string; watches: string[] }> = await ctx.runQuery(internal.moduleJobs.feedModules, a);
    const deadline = Date.now() + RUN_MS;
    let changes = 0;
    for (const { moduleId, watches } of modules) {
      for (const watch of watches) {
        for (;;) {
          const plan = await ctx.runQuery(internal.moduleJobs.feedPlan, { orgId: a.orgId, moduleId, watch });
          if (!plan || JSON.stringify(plan.from) === JSON.stringify(plan.to)) break;
          let dirty: Array<{ job: string; key: string }> = [];
          let error: string | undefined;
          if (plan.changes.length) {
            try { dirty = await watchCall(ctx, a.orgId, moduleId, watch, plan.changes, plan.epoch); }
            catch (e) { error = message(e); }
          }
          const moved = await ctx.runMutation(internal.moduleJobs.feedApply, { orgId: a.orgId, moduleId, watch, epoch: plan.epoch, from: plan.from, to: plan.to, dirty, ...(error ? { error } : {}) });
          changes += plan.changes.length;
          // A failed call keeps the cursors where they were, with its error: the sweep tries again.
          if (error || !moved) break;
          if (Date.now() > deadline) { await ctx.scheduler.runAfter(0, internal.moduleJobs.feed, a); return changes; }
        }
      }
    }
    return changes;
  },
});

/** A watch's call on a batch of record changes: the keys it dirties, and nothing else. */
async function watchCall(ctx: ActionCtx, orgId: Id<"organizations">, moduleId: string, call: string, changes: RecordChange[], epoch: number): Promise<Array<{ job: string; key: string }>> {
  const args = { changes };
  const snap: Snapshot = await ctx.runQuery(internal.modules.callPlan, { module: moduleId, call, args, system: orgId, canon: true, epoch });
  await readRecordsOf(ctx, snap, snap.reads, orgId);
  await readTreesOf(ctx, snap, snap.reads, orgId);
  const result = await runModuleCall(ctx, snap.bundle!, { isolate: snap.isolate, call, ctx: { now: Date.now(), caller: snap.caller, args, workspace: snap.workspace }, reads: snap.reads });
  if (!result.ok) throw new ConvexError(`${snap.label} failed in the module's code (${result.error.kind}): ${result.error.message}`);
  const problems = outputProblems(result.value);
  if (problems.length) throw new ConvexError(`${snap.label} returned writes Canon can't apply: ${problems.slice(0, 5).join("; ")}.`);
  const out = result.value as CallOutput;
  const intents = out.intents ?? [];
  if (out.byKey || intents.some((i) => i.op !== "dirty")) throw new ConvexError(`${snap.label} is a watch's call: it returns only dirty intents.`);
  return intents.map((i) => i as { op: "dirty"; job: string; key: string }).map(({ job, key }) => ({ job, key }));
}

/** The workspace's modules that are on and watch deals, with their watches. */
export const feedModules = internalQuery({
  args: { orgId: org },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", a.orgId).eq("status", "installed")).take(50);
    const out: Array<{ moduleId: string; watches: string[] }> = [];
    for (const pkg of rows) {
      const m = manifestOf(pkg);
      if (m.watches?.length && (await scopeIn(ctx, a.orgId, pkg.moduleId))) out.push({ moduleId: pkg.moduleId, watches: m.watches.map((w) => w.call) });
    }
    return out;
  },
});

// ── Connector feeds ──

export const connectorFeedModules = internalMutation({
  args: { orgId: org },
  handler: async (ctx, a): Promise<Array<{ moduleId: string; feeds: string[] }>> => {
    const rows = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", a.orgId).eq("status", "installed")).take(50);
    const modules: Array<{ moduleId: string; feeds: string[] }> = [];
    for (const pkg of rows) {
      if (!manifestOf(pkg).feeds) continue;
      const scope = await scopeIn(ctx, a.orgId, pkg.moduleId);
      if (!scope || scope.migrating) continue;
      await ensureCursors(ctx, a.orgId, pkg.moduleId, scope.manifest, scope.manifest);
      modules.push({ moduleId: pkg.moduleId, feeds: Object.keys(scope.manifest.feeds ?? {}) });
    }
    return modules;
  },
});

/** Reserve capacity before the runtime call so failures and concurrent wakes share the minute limit. */
export const connectorItemsPlan = internalMutation({
  args: { orgId: org, moduleId: v.string(), name: v.string() },
  handler: async (ctx, a): Promise<ConnectorFeedPlan | null> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    return scope && !scope.migrating ? connectorFeedPlan(ctx, a.orgId, scope.moduleId, scope.manifest, a.name, scope.epoch) : null;
  },
});

export const connectorItemsApply = internalMutation({
  args: { admit: admitV,
    orgId: org, moduleId: v.string(), name: v.string(), call: v.string(), epoch: v.number(),
    from: v.number(), to: v.number(), fill: v.union(v.string(), v.null()), next: v.union(v.string(), v.null()), count: v.number(),
    generation: v.optional(v.number()), grants: v.optional(v.array(v.object({ linkId: v.id("connectorLinks"), revision: v.number() }))),
    backfillLink: v.optional(v.union(v.id("connectorLinks"), v.null())),
    intents: v.array(v.any()), error: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Awaited<ReturnType<ModuleScope["apply"]>> | null> => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId, a.admit);
    if (!scope || scope.migrating || scope.epoch !== a.epoch || scope.manifest.feeds?.[a.name]?.call !== a.call) return null;
    const feed = scope.manifest.feeds[a.name].feed;
    if (a.count > 0 && feedOf(feed)?.connector.scope === "member" && !a.grants?.length) return null;
    if (!await currentFeedGrants(ctx, a.orgId, scope.moduleId, feed, a.grants ?? [])) return null;
    if (a.intents.some((i) => i.op === "replaceSet")) throw new ConvexError("A feed call cannot return replaceSet intents.");
    if (!await advanceConnectorFeed(ctx, a.orgId, scope.moduleId, a.name, a, a.error)) return null;
    return a.error === undefined ? written(scope, scope.apply(a.call, a.intents as AppliedIntent[])) : null;
  },
});

/** Current items first, then ordered changes. The sweep retries failures and passes that reach their minute budget. */
export const feedItems = internalAction({
  args: { orgId: org },
  handler: async (ctx, a): Promise<number> => {
    const modules = await ctx.runMutation(internal.moduleJobs.connectorFeedModules, a);
    const deadline = Date.now() + RUN_MS;
    let delivered = 0;
    for (const { moduleId, feeds } of modules) {
      for (const name of feeds) {
        while (Date.now() < deadline) {
          const p: ConnectorFeedPlan | null = await ctx.runMutation(internal.moduleJobs.connectorItemsPlan, { ...a, moduleId, name });
          if (!p) break;
          const { items, ...progress } = p;
          const apply = { ...a, moduleId, name, ...progress };
          try {
            let intents: AppliedIntent[] = [];
            if (items.length) {
              const args = { items };
              const snap: Snapshot = await ctx.runQuery(internal.modules.callPlan, { module: moduleId, call: p.call, args, system: a.orgId, canon: true });
              await readRecordsOf(ctx, snap, snap.reads, a.orgId);
              await readTreesOf(ctx, snap, snap.reads, a.orgId);
              const result = await runModuleCall(ctx, snap.bundle!, { isolate: snap.isolate, call: p.call, ctx: { now: Date.now(), caller: snap.caller, args, workspace: snap.workspace }, reads: snap.reads });
              if (!result.ok) throw new ConvexError(`${snap.label} failed in the module's code (${result.error.kind}): ${result.error.message}`);
              const problems = outputProblems(result.value);
              if (problems.length) throw new ConvexError(`${snap.label} returned writes Canon can't apply: ${problems.slice(0, 5).join("; ")}.`);
              const out = result.value as CallOutput;
              if (out.byKey) throw new ConvexError("A feed call cannot return byKey. Return intents instead.");
              if (out.intents?.some((i) => i.op === "replaceSet")) throw new ConvexError("A feed call cannot return replaceSet intents.");
              intents = (out.intents ?? []) as AppliedIntent[];
            }
            const applied = await stageAndApply(ctx, { module: moduleId, call: p.call, label: p.call, epoch: p.epoch }, a.orgId, intents,
              (intents, admit) => ctx.runMutation(internal.moduleJobs.connectorItemsApply, { ...apply, intents, admit }));
            if (!applied) break;
            delivered += items.length;
          } catch (e) {
            const admit: Admit = [];
            await ctx.runMutation(internal.moduleJobs.connectorItemsApply, { ...apply, intents: [], error: message(e), admit });
            break;
          }
        }
        if (Date.now() >= deadline) {
          await ctx.scheduler.runAfter(0, internal.moduleJobs.feedItems, a);
          return delivered;
        }
      }
    }
    return delivered;
  },
});

// ── Schedules and timed transitions ──

/** A schedule's call, as Canon: its writes applied all or none, as any call's. */
export const scheduled = internalAction({
  args: { orgId: org, moduleId: v.string(), schedule: v.string() },
  handler: async (ctx, a): Promise<{ writes: number }> => {
    try { return await scheduledCall(ctx, a); }
    catch (error) { if (!isSuperseded(error)) throw error; }
    return scheduledCall(ctx, a);
  },
});

async function scheduledCall(ctx: ActionCtx, a: { orgId: Id<"organizations">; moduleId: string; schedule: string }, run?: JobRun): Promise<{ writes: number }> {
  const pkg = await ctx.runQuery(internal.moduleJobs.manifestFor, { orgId: a.orgId, moduleId: a.moduleId });
  const call = pkg ? pkg.manifest.schedules?.[a.schedule]?.call : undefined;
  if (!call) { if (run) throw new JobControl({ status: "stale" }); return { writes: 0 }; }
  if (run && pkg!.epoch !== run.source.epoch) throw new JobControl({ status: "stale" });
  const snap: Snapshot = await ctx.runQuery(internal.modules.callPlan, { module: a.moduleId, call, args: {}, system: a.orgId, canon: true, epoch: pkg!.epoch });
  await readRecordsOf(ctx, snap, snap.reads, a.orgId);
  await readTreesOf(ctx, snap, snap.reads, a.orgId);
  const result = await runModuleCall(ctx, snap.bundle!, { isolate: snap.isolate, call, ctx: { now: Date.now(), caller: snap.caller, args: {}, workspace: snap.workspace }, reads: snap.reads }).catch(async (error: unknown) => {
    if (isMissingBundle(error)) await ctx.runQuery(internal.modules.callEpoch, { module: a.moduleId, system: a.orgId, epoch: snap.epoch }).catch((check: unknown) => { if (isSuperseded(check)) throw check; });
    throw error;
  });
  if (!result.ok) throw new ConvexError(`${snap.label} failed in the module's code (${result.error.kind}): ${result.error.message}`);
  const problems = outputProblems(result.value);
  if (problems.length) throw new ConvexError(`${snap.label} returned writes Canon can't apply: ${problems.slice(0, 5).join("; ")}.`);
  const out = result.value as CallOutput;
  const applied = await stageAndApply(ctx, { module: a.moduleId, call, label: snap.label, epoch: snap.epoch }, a.orgId, await withProposedRows(ctx, a.moduleId, snap.label, a.orgId, out.intents ?? []),
    (intents, admit) => run ? applyJob(ctx, run, call, snap.epoch, intents, admit) : ctx.runMutation(internal.modules.applyCall, { module: a.moduleId, call, epoch: snap.epoch, intents, system: a.orgId, admit }), undefined,
    run ? (chunk, admit) => stageJob(ctx, run, call, snap.epoch, chunk, admit) : undefined);
  if (!applied) throw superseded();
  return { writes: applied.writes };
}

/** The docs a timed transition is due on now. */
export const timedDue = internalQuery({
  args: { orgId: org, moduleId: v.string() },
  handler: async (ctx, a) => {
    const scope = await scopeIn(ctx, a.orgId, a.moduleId);
    return scope ? scope.timedDue(Date.now(), TIMED_MAX) : [];
  },
});

/** Run each due timed transition, as Canon, each in its own transaction: one whose guard refuses waits for the next sweep. */
export const timed = internalAction({
  args: { orgId: org, moduleId: v.string() },
  handler: async (ctx, a): Promise<{ moved: number; refused: number }> => {
    const due = await ctx.runQuery(internal.moduleJobs.timedDue, a);
    let moved = 0, refused = 0;
    for (const d of due) {
      try {
        await ctx.runMutation(internal.modules.systemTransition, { orgId: a.orgId, module: a.moduleId, machine: d.machine, name: d.name, key: d.key, expect: d.version });
        moved++;
      } catch { refused++; }
    }
    return { moved, refused };
  },
});

// ── The sweep ──

/**
 * Each minute: every installed module that is on gets its feed's cursors, its due schedules and timed transitions,
 * a run when it has keys waiting (a lost wake-up, an expired lease, a retry's wait over) and a feed pass when its
 * watches are behind the ledger.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.wake, {});
    await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.adopt, {});
    const pkgs = await ctx.db.query("modulePackages").withIndex("by_status", (q) => q.eq("status", "installed")).take(500);
    const feeds = new Set<Id<"organizations">>();
    const histories = new Set<Id<"organizations">>();
    const connectorOrgs = new Set<Id<"organizations">>();
    for (const pkg of pkgs) {
      const m = manifestOf(pkg);
      // A module that reads deal history needs its workspace's history folded: the first fold is its backfill.
      if (readsDealHistory(m) && !histories.has(pkg.orgId) && !(await historyState(ctx, pkg.orgId)).built && (await scopeIn(ctx, pkg.orgId, pkg.moduleId))) {
        histories.add(pkg.orgId);
        await ctx.scheduler.runAfter(0, internal.dealHistory.step, { orgId: pkg.orgId });
      }
      const timedOnes = Object.values(m.machines ?? {}).some((mc) => Object.values(mc.transitions).some((t) => t.at !== undefined));
      if (!m.jobs && !m.watches && !m.feeds && !m.schedules && !timedOnes && !projectedCollections(m).size) continue;
      const scope = await scopeIn(ctx, pkg.orgId, pkg.moduleId);
      // An upgrade migrating its docs holds the module's background work until the new version serves.
      if (!scope || scope.migrating) continue;
      await initializeProjection(ctx, pkg, m);
      await ensureCursors(ctx, pkg.orgId, pkg.moduleId, m, m);
      if (!moduleRuntimeAvailable(m)) continue;
      if (m.watches?.length) feeds.add(pkg.orgId);
      if ((await connectorFeedStatus(ctx.db, pkg.orgId, pkg.moduleId, m)).some((f) => f.behind > 0 || f.backfill)) connectorOrgs.add(pkg.orgId);
      await dueSchedules(ctx, pkg.orgId, pkg.moduleId, m, now);
      if (timedOnes && (await scope.timedDue(now, 1)).length) await ctx.scheduler.runAfter(0, internal.moduleJobs.timed, { orgId: pkg.orgId, moduleId: pkg.moduleId });
      if (await hasKeys(ctx.db, pkg.orgId, pkg.moduleId)) await ctx.scheduler.runAfter(0, internal.moduleJobs.run, { orgId: pkg.orgId, moduleId: pkg.moduleId });
    }
    for (const orgId of connectorOrgs) await ctx.scheduler.runAfter(0, internal.moduleJobs.feedItems, { orgId });
    for (const orgId of feeds) await ctx.scheduler.runAfter(0, internal.moduleJobs.feed, { orgId });
    return null;
  },
});
