import { activityHead, activityWatchHash, retainedSourcePublication } from "./activityCapture";
import { publicationStatus } from "./activityPublication";
import { manifestOf, packageRow } from "./packages";
/**
 * A module's background work, as rows (docs/modules.md, "Jobs, watches and schedules"): the job keys that wait to
 * run (`moduleJobs`) and how far its deal feed has read the records ledger (`moduleCursors`). Only this file and
 * scope.ts name those tables (tests/moduleSurfaces.test.ts). Everything here runs inside the caller's transaction:
 * a key dirtied by an op is dirtied with the op, and the feed's cursors move with the keys it dirties.
 *
 * - A key is dirtied by bumping its row's `dirtySeq` (or adding the row). A run leases rows at their `dirtySeq` and
 *   applies only while it is unchanged: a key dirtied again during its run runs again, the stale result dropped.
 * - Keys equal but for their job's `order` part form a group, and a group runs one key at a time, lowest first, so
 *   one rep's periods run in order. A key that ran out of attempts doesn't hold its group up; it waits, with its
 *   error, for its inputs to change.
 * - `fresh` is the guard a close or a lock declares: no key under a prefix waits or runs, and every watch has read
 *   the ledger to its current end.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { ANY, type JobDecl, type ModuleManifest } from "../../../modules/kernel/manifest.ts";
import type { FeedItem } from "../../../modules/kernel/calls.ts";
import { jobKeyProblem } from "../../../modules/kernel/calls.ts";
import { projectedCollections } from "../../../modules/kernel/reports.ts";
import { SHARDS } from "../objects/write";
import { feedReadAccess, type FeedReadStamp } from "../connectors/grants";
import { feedOf } from "../connectors/registry";

type Db = QueryCtx["db"];
type Row = Doc<"moduleJobs">;
type Org = Id<"organizations">;

/** A bulk move's rows: Canon's own job, not a manifest's. */
export const BULK_JOB = "#bulk";
/**
 * The docs Canon projects into the record service for reports (docs/modules.md, "Reports and charts"), also Canon's
 * own: key `<collection>|<doc key>` (the doc key may hold "|"), dirtied by every write of a projected doc in the
 * write's transaction; `<collection>|*` rebuilds the collection, paging with its cursor in `payload`. A `*` key runs
 * alone, before the keys under it, so a doc changed during a rebuild is sent again after it.
 */
export const REPORT_JOB = "#report";
const REPORT_BATCH = 200;
/** How long a run holds the keys it leased; a run that dies frees them when this passes. */
export const LEASE_MS = 120_000;
/** Rows one lease looks through, and keys it hands out. */
const LEASE_SCAN = 4000;
export const LEASE_MAX = 500;
const ATTEMPTS = 5;
/** A failed key waits this long, doubling per attempt, before it runs again. */
const BACKOFF_MS = 5_000;
const SCHEDULE = (name: string) => `#schedule:${name}`;
export const scheduleNameOf = (job: string): string | null => job.startsWith("#schedule:") ? job.slice("#schedule:".length) : null;
const scheduleJobs = (m: ModuleManifest) => Object.keys(m.schedules ?? {}).map(SCHEDULE);
const RUNNER = "#jobs";

const refuse = (message: string): never => { throw new ConvexError(message); };
const shapeOf = (m: ModuleManifest, job: string): Pick<JobDecl, "key" | "batchBy" | "order"> =>
  job === BULK_JOB ? { key: ["move"] } : job === REPORT_JOB ? { key: ["doc"] } : scheduleNameOf(job) !== null ? { key: ["slot"] } : m.jobs?.[job] ?? refuse(`${m.title} has no job ${job}.`);
export const attemptsOf = (m: ModuleManifest, job: string) => (scheduleNameOf(job) !== null ? 1 : job === BULK_JOB || job === REPORT_JOB ? ATTEMPTS : m.jobs?.[job]?.attempts ?? ATTEMPTS);

/**
 * Where a key sits: its group (the key without its order part), its order value, and the parts its batch shares.
 * `order`: the sort value its job's `orderBy` read for the order part; without one, the part's own text.
 */
function placeOf(m: ModuleManifest, job: string, key: string, order?: string) {
  const shape = shapeOf(m, job);
  const parts = key.split("|");
  const at = shape.order === undefined ? -1 : shape.key.indexOf(shape.order);
  return { group: parts.filter((_, i) => i !== at).join("|"), order: at < 0 ? "" : order ?? parts[at], batch: parts.slice(0, shape.batchBy ?? 0).join("|") };
}

/** The value of a key's order part, for a job whose `orderBy` reads it from a doc; null otherwise. */
export function orderPartOf(m: ModuleManifest, job: string, key: string): string | null {
  const shape = m.jobs?.[job];
  if (!shape?.orderBy || shape.order === undefined) return null;
  const part = key.split("|")[shape.key.indexOf(shape.order)];
  return part === undefined || part === ANY ? null : part;
}

/**
 * A sort value as text that sorts as the value does: a number (a time in ms) zero-padded, a date or text as it is.
 * A key whose doc holds none sorts after every other, by its own text.
 */
export function sortText(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return value < 0 ? `-${String(Math.round(1e17 + value)).padStart(18, "0")}` : String(Math.round(value)).padStart(18, "0");
  if (typeof value === "string" && value) return value;
  return `~${fallback}`;
}

const runners = new WeakMap<object, Set<string>>();
/** Start a run for the module after this transaction, once per transaction. The one-minute sweep covers a lost one. */
export async function wakeJobs(ctx: MutationCtx, orgId: Org, moduleId: string) {
  const seen = runners.get(ctx) ?? new Set<string>();
  runners.set(ctx, seen);
  if (seen.has(`${orgId}:${moduleId}`)) return;
  seen.add(`${orgId}:${moduleId}`);
  await ctx.scheduler.runAfter(0, internal.moduleJobs.run, { orgId, moduleId });
}

/**
 * Mark `key` of `job` stale: its row's `dirtySeq` goes up, or a row is added. Its inputs changed, so a key that failed
 * starts over: it gets its attempts back, and one waiting out a failure (or out of attempts) runs now rather than
 * after its wait. A semantic run's old lease is revoked with the new dirty count; its result cannot apply.
 * `payload`: a bulk move's arguments.
 */
export async function markDirty(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, job: string, key: string, payload?: unknown, order?: string) {
  if (scheduleNameOf(job) !== null) refuse("Only Canon's schedule registration can create a schedule slot.");
  const problem = job === REPORT_JOB ? null : jobKeyProblem(key, shapeOf(m, job).key.length);
  if (problem) refuse(`${m.title} can't run ${job} on ${problem}.`);
  const row = await ctx.db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job).eq("key", key)).unique();
  // Time seeds a new key, but can repeat after deletion. Projection receipts also carry the row identity and
  // rebase a colliding count against the service's retained floor.
  const fresh = Date.now() * 1000;
  if (row) {
    const running = row.leaseSeq !== undefined && (row.leaseUntil ?? 0) > Date.now();
    // A sort value read again (a period's start moved) moves the key in its group.
    const moved = order !== undefined && order !== row.order ? { order } : {};
    const again = row.attempts > 0 ? { attempts: 0, ...(running ? {} : { leaseUntil: undefined, leaseSeq: undefined }) } : {};
    await ctx.db.patch(row._id, { dirtySeq: Math.max(row.dirtySeq + 1, fresh), ...moved, ...again, ...(job === REPORT_JOB ? {} : { leaseUntil: undefined, leaseSeq: undefined }), ...(payload !== undefined ? { payload } : {}) });
  } else {
    await ctx.db.insert("moduleJobs", { orgId, moduleId, job, key, ...placeOf(m, job, key, order), dirtySeq: fresh, attempts: 0, at: Date.now(), ...(payload !== undefined ? { payload } : {}) });
  }
  await wakeJobs(ctx, orgId, moduleId);
}

/**
 * A new version of the module serves: its jobs' keys that failed (their code may be what was fixed) start over, as a
 * dirty would start them, each with its attempts back and run now. A bulk move that stopped on refusing docs stays
 * stopped until a person retries it. At most LEASE_SCAN keys per job; the rest wait for their next dirty.
 */
export async function retryFailed(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, jobs: readonly string[] = [...Object.keys(m.jobs ?? {}), REPORT_JOB]) {
  let any = false;
  for (const job of jobs) {
    const rows = await ctx.db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).take(LEASE_SCAN);
    if (job === REPORT_JOB) {
      const collections = projectedCollections(m);
      if (collections.size > 100) refuse("This module exceeds the report projection protocol's supported bounds.");
      for (const collection of collections) {
        const row = await rowOf(ctx.db, orgId, moduleId, job, `${collection}|*`);
        if (row && !rows.some((r) => r._id === row._id)) rows.push(row);
      }
    }
    for (const r of rows) {
      if (r.attempts === 0 || (r.leaseSeq !== undefined && (r.leaseUntil ?? 0) > Date.now())) continue;
      await ctx.db.patch(r._id, { attempts: 0, leaseUntil: undefined, leaseSeq: undefined });
      any = true;
    }
  }
  if (any) await wakeJobs(ctx, orgId, moduleId);
}

export async function invalidateActivatedJobLeases(ctx: MutationCtx, orgId: Org, moduleId: string, previous: ModuleManifest | null): Promise<void> {
  const pkg = await packageRow(ctx, orgId, moduleId);
  if (!pkg || pkg.status !== "installed") return refuse("The activated job source is unavailable.");
  const current = manifestOf(pkg);
  let any = false;
  for (const job of new Set([...Object.keys(previous?.jobs ?? {}), ...Object.keys(current.jobs ?? {}), ...scheduleJobs(previous ?? current), ...scheduleJobs(current), BULK_JOB])) {
    const rows = await ctx.db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).take(LEASE_SCAN);
    for (const row of rows) {
      if (row.leaseSeq === undefined || (row.leaseUntil ?? 0) <= Date.now()) continue;
      await ctx.db.patch(row._id, { leaseSeq: undefined, leaseUntil: undefined });
      any = true;
    }
  }
  if (any) await wakeJobs(ctx, orgId, moduleId);
}

export type JobSource = { packageId: Id<"modulePackages">; epoch: number; manifestHash: string; bundleHash: string | null };
export type JobLease = { rowId: Id<"moduleJobs">; dirtySeq: number; leaseSeq: number; generation: number; leaseUntil: number };
export const jobLeaseV = v.object({ rowId: v.id("moduleJobs"), dirtySeq: v.number(), leaseSeq: v.number(), generation: v.number(), leaseUntil: v.number() });
export type PublicationWait = JobSource & { publicationId: Id<"moduleActivityPublications">; ordinal: number; publicationRevision: number };
export const jobSourceOf = (pkg: Doc<"modulePackages">): JobSource => ({ packageId: pkg._id, epoch: pkg.epoch ?? 1, manifestHash: pkg.manifestHash, bundleHash: pkg.bundleHash ?? null });
const sameJobSource = (pkg: Doc<"modulePackages">, source: JobSource) => pkg._id === source.packageId && (pkg.epoch ?? 1) === source.epoch && pkg.manifestHash === source.manifestHash && (pkg.bundleHash ?? null) === source.bundleHash;
export type Leased = { job: string; key: string; seq: number; id?: string; lease?: JobLease; payload?: unknown };
type OwnedLease = { pkg: Doc<"modulePackages">; row: Row; source: JobSource; lease: JobLease };

export async function exactJobLease(ctx: MutationCtx, orgId: Org, moduleId: string, job: string, key: string, source: JobSource, lease: JobLease): Promise<OwnedLease | null> {
  const pkg = await packageRow(ctx, orgId, moduleId), row = await ctx.db.get(lease.rowId);
  if (!pkg || pkg.status !== "installed" || !sameJobSource(pkg, source)
    || !row || row.orgId !== orgId || row.moduleId !== moduleId || row.job !== job || row.key !== key
    || row.dirtySeq !== lease.dirtySeq || row.leaseSeq !== lease.leaseSeq || lease.leaseSeq !== lease.dirtySeq
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1 || row.leaseGeneration !== lease.generation
    || row.leaseUntil !== lease.leaseUntil || lease.leaseUntil <= Date.now()) return null;
  return { pkg, row, source, lease };
}

export async function finishOwnedJob(ctx: MutationCtx, owned: OwnedLease): Promise<boolean> {
  const { row: original, lease, source } = owned;
  const pkg = await ctx.db.get(source.packageId), row = await ctx.db.get(lease.rowId);
  if (!pkg || pkg.status !== "installed" || !sameJobSource(pkg, source) || !row
    || row.orgId !== original.orgId || row.moduleId !== original.moduleId || row.job !== original.job || row.key !== original.key
    || row.dirtySeq !== lease.dirtySeq || row.leaseSeq !== lease.leaseSeq || row.leaseGeneration !== lease.generation || row.leaseUntil !== lease.leaseUntil || lease.leaseUntil <= Date.now()) return false;
  await ctx.db.delete(row._id);
  return true;
}

export async function waitForJobPublication(ctx: MutationCtx, owned: OwnedLease): Promise<PublicationWait | null> {
  const publication = await retainedSourcePublication(ctx, owned.pkg);
  if (!publication) return null;
  await ctx.db.patch(owned.row._id, { leaseSeq: undefined, leaseUntil: undefined });
  return { ...owned.source, publicationId: publication._id, ordinal: publication.ordinal, publicationRevision: publication.revision };
}

/**
 * Lease the keys that may run now, at most `max`, grouped into batches: by job and the parts a batch shares, at most
 * the job's `batch` keys each. Per group only its lowest waiting key, and none while one of the group runs. A job's
 * keys with a "*" run first and alone: they stand for the keys under them.
 */
export async function leaseKeys(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, now: number, max = LEASE_MAX, publicationPending = false): Promise<Leased[][]> {
  const batches: Leased[][] = [];
  const granted: Array<{ row: Row; semantic: boolean }> = [];
  let total = 0;
  for (const job of [...Object.keys(m.jobs ?? {}), ...scheduleJobs(m), BULK_JOB, REPORT_JOB]) {
    if (publicationPending && job !== REPORT_JOB) continue;
    const rows = (await ctx.db.query("moduleJobs").withIndex("by_orgId_moduleId_job_group_order", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).take(LEASE_SCAN))
      .sort((a, b) => (a.group === b.group ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : a.group < b.group ? -1 : 1));
    if (!rows.length) continue;
    const limit = attemptsOf(m, job);
    const live = rows.filter((r) => r.attempts < limit);
    // Running: leased by a run. Waiting out a failure: its lease without a count, until its retry is due.
    const running = (r: Row) => r.leaseSeq !== undefined && r.leaseUntil !== undefined && r.leaseUntil > now;
    const waiting = (r: Row) => r.leaseUntil !== undefined && r.leaseUntil > now;
    const wild = (r: Row) => (job === REPORT_JOB ? r.key.endsWith(`|${ANY}`) : r.key.split("|").includes(ANY));
    // Keys with a "*" stand for the keys under them: while one waits or runs, only they run.
    const wilds = live.filter(wild);
    // A failed rebuild cannot let incremental projection work overtake its initialization.
    if (job === REPORT_JOB && rows.some(wild) && !wilds.length) continue;
    const pool = wilds.length ? (live.some((r) => running(r) && !wild(r)) ? [] : wilds) : live;
    const ready: Row[] = [];
    const groups = new Map<string, Row[]>();
    for (const r of pool) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    // A group's lowest key runs, unless one of the group is running or the lowest waits out a failure.
    for (const g of groups.values()) if (!g.some(running) && !waiting(g[0])) ready.push(g[0]);
    const size = job === BULK_JOB || scheduleNameOf(job) !== null ? 1 : job === REPORT_JOB ? (pool === wilds && wilds.length ? 1 : REPORT_BATCH) : m.jobs![job].batch ?? 50;
    const byBatch = new Map<string, Row[]>();
    for (const r of ready) {
      if (total >= max) break;
      total++;
      byBatch.set(r.batch, [...(byBatch.get(r.batch) ?? []), r]);
    }
    for (const list of byBatch.values()) {
      for (let i = 0; i < list.length; i += size) {
        const chunk = list.slice(i, i + size);
        granted.push(...chunk.map((row) => ({ row, semantic: job !== REPORT_JOB })));
        batches.push(chunk.map((r) => ({ job, key: r.key, seq: r.dirtySeq, ...(job === REPORT_JOB ? { id: r._id } : { lease: { rowId: r._id, dirtySeq: r.dirtySeq, leaseSeq: r.dirtySeq, generation: (r.leaseGeneration ?? 0) + 1, leaseUntil: now + LEASE_MS } }), ...(r.payload !== undefined ? { payload: r.payload } : {}) })));
      }
    }
    if (total >= max) break;
  }
  if (granted.some(({ row, semantic }) => semantic && (!Number.isSafeInteger((row.leaseGeneration ?? 0) + 1) || (row.leaseGeneration ?? 0) < 0))) refuse("The module job lease generation is outside its supported range.");
  for (const { row, semantic } of granted) await ctx.db.patch(row._id, { leaseUntil: now + LEASE_MS, leaseSeq: row.dirtySeq, ...(semantic ? { leaseGeneration: (row.leaseGeneration ?? 0) + 1 } : {}) });
  if (batches.length) await stamp(ctx, orgId, moduleId, RUNNER, now);
  return batches;
}

const rowOf = (db: Db, orgId: Org, moduleId: string, job: string, key: string) =>
  db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job).eq("key", key)).unique();

/** Whether a leased key may apply its run: still at the `dirtySeq` it was leased at. If not, it is freed to run again. */
export async function stillLeased(ctx: MutationCtx, orgId: Org, moduleId: string, job: string, key: string, seq: number): Promise<boolean> {
  const row = await rowOf(ctx.db, orgId, moduleId, job, key);
  if (!row) return false;
  if (row.dirtySeq === seq) return true;
  await ctx.db.patch(row._id, { leaseUntil: undefined, leaseSeq: undefined });
  return false;
}

/** Free a leased key to run again, its count unchanged: it was computed under an earlier version of the module. */
export async function releaseKey(ctx: MutationCtx, orgId: Org, moduleId: string, job: string, key: string) {
  const row = await rowOf(ctx.db, orgId, moduleId, job, key);
  if (row) await ctx.db.patch(row._id, { leaseUntil: undefined, leaseSeq: undefined });
}

/** Whether some of the module's projected docs are still on their way to the record service. */
export async function reportsBehind(db: Db, orgId: Org, moduleId: string): Promise<boolean> {
  return (await db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", REPORT_JOB)).first()) !== null;
}

/** Projection CAS includes row identity: a deleted and recreated job may have the same time-seeded sequence. */
export async function projectionLeased(db: Db, orgId: Org, moduleId: string, key: string, id: string, seq: number) {
  const row = await rowOf(db, orgId, moduleId, REPORT_JOB, key);
  return row?._id === id && row.dirtySeq === seq && row.leaseSeq === seq;
}

/** Advance only this still-current dirty job after a receipt floor collision, then read its source again. */
export async function rebaseProjection(ctx: MutationCtx, orgId: Org, moduleId: string, key: string, id: string, seq: number, floor: number) {
  if (!(await projectionLeased(ctx.db, orgId, moduleId, key, id, seq))) return;
  if (!Number.isSafeInteger(floor) || !Number.isSafeInteger(Math.max(seq, floor) + 1)) refuse("The module projection sequence is outside its supported range.");
  const row = (await rowOf(ctx.db, orgId, moduleId, REPORT_JOB, key))!;
  await ctx.db.patch(row._id, { dirtySeq: Math.max(seq, floor) + 1, leaseSeq: undefined, leaseUntil: undefined, attempts: 0, ...(key.endsWith("|*") ? { payload: {} } : {}) });
  await wakeJobs(ctx, orgId, moduleId);
}

/** Whether the module has any key waiting, running or failed. */
export async function hasKeys(db: Db, orgId: Org, moduleId: string): Promise<boolean> {
  return (await db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).first()) !== null;
}

/** A run of the key applied: its row goes, unless the run itself (or a write in its transaction) dirtied it again. */
export async function finishKey(ctx: MutationCtx, orgId: Org, moduleId: string, job: string, key: string, seq: number) {
  const row = await rowOf(ctx.db, orgId, moduleId, job, key);
  if (!row) return;
  if (row.dirtySeq === seq) await ctx.db.delete(row._id);
  else await ctx.db.patch(row._id, { leaseUntil: undefined, leaseSeq: undefined });
}

/**
 * A run of the key failed: one more attempt counted, its error kept, and it waits before running again; past its
 * job's attempts it stops until something dirties it. A key dirtied since its lease just runs again.
 */
export async function failKey(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, job: string, key: string, seq: number, error: string, now: number) {
  const row = await rowOf(ctx.db, orgId, moduleId, job, key);
  if (!row) return;
  if (row.dirtySeq !== seq) return void (await ctx.db.patch(row._id, { leaseUntil: undefined, leaseSeq: undefined }));
  const attempts = row.attempts + 1;
  const dead = attempts >= attemptsOf(m, job);
  const wait = BACKOFF_MS * 2 ** (attempts - 1);
  await ctx.db.patch(row._id, { attempts, lastError: error.slice(0, 500), leaseSeq: undefined, leaseUntil: dead ? undefined : now + wait });
  // Its retry runs when its wait is over, not at the next sweep.
  if (!dead) await ctx.scheduler.runAfter(wait + 100, internal.moduleJobs.run, { orgId, moduleId });
}

/**
 * A bulk move that stopped on docs that refused their move (docs/modules.md, "State machines"): its row stays, out of
 * attempts so nothing retries it by itself, with the docs named in its error and in its payload, until a person
 * retries it (`markDirty` gives a dead key its attempts back) or the doc that waits moves on (`dropKey`).
 */
export async function stopKey(ctx: MutationCtx, orgId: Org, moduleId: string, key: string, seq: number, error: string, payload: unknown) {
  const row = await rowOf(ctx.db, orgId, moduleId, BULK_JOB, key);
  if (!row) return;
  if (row.dirtySeq !== seq) return void (await ctx.db.patch(row._id, { leaseUntil: undefined, leaseSeq: undefined }));
  await ctx.db.patch(row._id, { attempts: ATTEMPTS, lastError: error.slice(0, 500), leaseSeq: undefined, leaseUntil: undefined, payload });
}

/** Drop a key whatever its state: a bulk move whose waiting doc moved on. */
export async function dropKey(ctx: MutationCtx, orgId: Org, moduleId: string, job: string, key: string) {
  const row = await rowOf(ctx.db, orgId, moduleId, job, key);
  if (row) await ctx.db.delete(row._id);
}

/** A bulk move's row, as a page and a retry read it: its payload, and whether it stopped. Null when there is none. */
export async function bulkRow(db: Db, orgId: Org, moduleId: string, key: string): Promise<{ payload: unknown; stopped: boolean; error: string | null; running: boolean } | null> {
  const row = await rowOf(db, orgId, moduleId, BULK_JOB, key);
  if (!row) return null;
  return { payload: row.payload, stopped: row.attempts >= ATTEMPTS, error: row.lastError ?? null, running: row.leaseSeq !== undefined && (row.leaseUntil ?? 0) > Date.now() };
}

/** The last `seq` of each ledger shard. */
async function heads(db: Db, orgId: Org): Promise<Map<number, number>> {
  const rows = await db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).take(SHARDS);
  return new Map(rows.map((r) => [r.shard, r.seq]));
}

const cursorRows = (db: Db, orgId: Org, moduleId: string, watch: string) =>
  db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", watch)).take(SHARDS);

/**
 * Whether what `job` wrote under `prefix` is current: no key under it (or a "*" key over it) waits, runs or failed,
 * and every watch of the module has read each ledger shard to its last entry. Reading the shard heads here makes a
 * transition that checks this conflict with any record write that lands meanwhile.
 */
export async function isFresh(db: Db, orgId: Org, moduleId: string, m: ModuleManifest, job: string, prefix: readonly string[]): Promise<boolean> {
  const n = shapeOf(m, job).key.length;
  const keys = () => db.query("moduleJobs");
  if (!prefix.length) {
    if (await keys().withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).first()) return false;
  } else if (prefix.length === n) {
    if (await rowOf(db, orgId, moduleId, job, prefix.join("|"))) return false;
  } else {
    const p = `${prefix.join("|")}|`;
    if (await keys().withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job).gte("key", p).lt("key", `${p}\uffff`)).first()) return false;
  }
  for (let i = 0; i < Math.min(prefix.length, n); i++) {
    const over = [...prefix.slice(0, i), ...Array(n - i).fill(ANY)].join("|");
    if (await rowOf(db, orgId, moduleId, job, over)) return false;
  }
  if (!m.watches?.length) return true;
  const ends = await heads(db, orgId);
  for (const w of m.watches) {
    const read = new Map((await cursorRows(db, orgId, moduleId, w.call)).map((c) => [c.shard, c.seq]));
    for (const [shard, seq] of ends) if ((read.get(shard) ?? -1) < seq) return false;
  }
  return true;
}

async function ensureActivityBaseline(ctx: MutationCtx, pkg: Doc<"modulePackages">, m: ModuleManifest, previousManifest: ModuleManifest | null, w: NonNullable<ModuleManifest["watches"]>[number], previousRows: Doc<"moduleCursors">[]) {
  const { orgId, moduleId } = pkg;
  const current = await ctx.db.query("moduleActivityCursors").withIndex("by_orgId_moduleId_watch", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", w.call)).unique();
  const previous = previousManifest?.watches?.find((old) => old.call === w.call);
  const continuing = previous?.object === "activities";
  const declarationHash = await activityWatchHash(m, w, pkg.epoch ?? 1);
  const head = await activityHead(ctx.db, orgId);
  const identity = { packageId: pkg._id, epoch: pkg.epoch ?? 1, declarationHash, at: Date.now() };
  if (!current || !continuing) {
    const legacy = !current && continuing && previousRows.length > 0;
    const baseline = { ...identity, seq: legacy ? 0 : head?.readableSeq ?? 0, ordinal: legacy ? 0 : head?.publishedOrdinal ?? 0, error: null, nextLane: 0 };
    if (current) await ctx.db.patch(current._id, baseline);
    else await ctx.db.insert("moduleActivityCursors", { orgId, moduleId, watch: w.call, ...baseline });
  } else if (current.epoch !== identity.epoch || current.declarationHash !== declarationHash || current.packageId !== pkg._id) await ctx.db.patch(current._id, identity);
}

/** Only pre-existing ledger subscriptions are adopted while a legacy package is disabled. */
export async function adoptActivityBaselines(ctx: MutationCtx, pkg: Doc<"modulePackages">, m: ModuleManifest) {
  for (const w of m.watches ?? []) if (w.object === "activities") {
    const rows = await cursorRows(ctx.db, pkg.orgId, pkg.moduleId, w.call);
    if (rows.length) await ensureActivityBaseline(ctx, pkg, m, m, w, rows);
  }
}

export async function ensureActivityBaselines(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, previousManifest: ModuleManifest | null) {
  const watches = (m.watches ?? []).filter((w) => w.object === "activities");
  if (!watches.length) return;
  const pkg = await packageRow(ctx, orgId, moduleId);
  if (!pkg) return refuse("An activity subscription needs its installed package.");
  for (const w of watches) await ensureActivityBaseline(ctx, pkg, m, previousManifest, w, await cursorRows(ctx.db, orgId, moduleId, w.call));
}

/** Start watch and connector cursors at their current heads, with a pending backfill for each new connector feed. */
export async function ensureCursors(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, previousManifest: ModuleManifest | null) {
  await ensureConnectorCursors(ctx, orgId, moduleId, m);
  if (!m.watches?.length) return;
  const ends = await heads(ctx.db, orgId);
  for (const w of m.watches) {
    const previousRows = await cursorRows(ctx.db, orgId, moduleId, w.call);
    if (w.object === "activities") {
      const pkg = await packageRow(ctx, orgId, moduleId);
      if (!pkg) return refuse("An activity subscription needs its installed package.");
      await ensureActivityBaseline(ctx, pkg, m, previousManifest, w, previousRows);
    }
    const have = new Set(previousRows.map((c) => c.shard));
    for (let shard = 0; shard < SHARDS; shard++) if (!have.has(shard)) await ctx.db.insert("moduleCursors", { orgId, moduleId, watch: w.call, shard, seq: ends.get(shard) ?? 0 });
  }
}

/** A watch's cursors: the `seq` it has read through, per shard. */
export async function cursorsOf(db: Db, orgId: Org, moduleId: string, watch: string): Promise<Record<string, number> | null> {
  const rows = await cursorRows(db, orgId, moduleId, watch);
  return rows.length ? Object.fromEntries(rows.map((r) => [String(r.shard), r.seq])) : null;
}

/**
 * Move a watch's cursors from `from` to `to`, refused (false) when they aren't at `from` any more: another run read
 * these entries first. The caller dirties the keys the entries named in the same transaction.
 */
export async function advanceCursors(ctx: MutationCtx, orgId: Org, moduleId: string, watch: string, from: Record<string, number>, to: Record<string, number>, error?: string): Promise<boolean> {
  const rows = await cursorRows(ctx.db, orgId, moduleId, watch);
  if (rows.some((r) => from[String(r.shard)] !== r.seq)) return false;
  for (const r of rows) {
    const next = to[String(r.shard)] ?? r.seq;
    if (next !== r.seq || r.error !== error) await ctx.db.patch(r._id, { seq: next, at: Date.now(), error });
  }
  return true;
}

/** Whether the workspace has a module with a deal feed: a ledger write wakes the feed only then. */
export async function hasFeeds(db: Db, orgId: Org): Promise<boolean> {
  return (await db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId)).first()) !== null;
}

/** Note when something ran: a schedule's last run, the runner's last pass. */
async function stamp(ctx: MutationCtx, orgId: Org, moduleId: string, name: string, at: number) {
  const row = await ctx.db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", name).eq("shard", 0)).unique();
  if (row) await ctx.db.patch(row._id, { at });
  else await ctx.db.insert("moduleCursors", { orgId, moduleId, watch: name, shard: 0, seq: 0, at });
}

/** Registration and the original period stamp commit together; a pending slot is never replaced. */
export async function dueSchedules(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, now: number): Promise<string[]> {
  const out: string[] = [];
  for (const [name, sc] of Object.entries(m.schedules ?? {})) {
    const row = await ctx.db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", SCHEDULE(name)).eq("shard", 0)).unique();
    const last = row?.at ?? 0;
    let due: boolean;
    if (sc.everyMinutes !== undefined) due = now - last >= sc.everyMinutes * 60_000 - 5_000;
    else {
      const [h, min] = sc.dailyAt!.split(":").map(Number);
      const today = new Date(now);
      const slot = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), h, min);
      due = now >= slot && last < slot;
    }
    if (!due) continue;
    const existing = await rowOf(ctx.db, orgId, moduleId, SCHEDULE(name), "current");
    if (existing && (existing.attempts === 0 || existing.leaseSeq !== undefined || (existing.leaseUntil ?? 0) > now)) continue;
    const slot = sc.everyMinutes !== undefined ? `interval:${now}` : `daily:${new Date(now).toISOString().slice(0, 10)}:${sc.dailyAt}`;
    const payload = { slot, at: now };
    if (existing) await ctx.db.patch(existing._id, { dirtySeq: Math.max(existing.dirtySeq + 1, now * 1000), attempts: 0, lastError: undefined, payload, at: now });
    else await ctx.db.insert("moduleJobs", { orgId, moduleId, job: SCHEDULE(name), key: "current", group: "current", order: "", batch: "", dirtySeq: now * 1000, attempts: 0, payload, at: now });
    await stamp(ctx, orgId, moduleId, SCHEDULE(name), now);
    out.push(name);
  }
  if (out.length) await wakeJobs(ctx, orgId, moduleId);
  return out;
}

async function activityBaselineStatus(db: Db, orgId: Org, moduleId: string, m: ModuleManifest) {
  const out: Array<{ watch: string; seq: number | null; ordinal: number | null; epoch: number | null; declarationHash: string | null; inactive: true }> = [];
  for (const w of m.watches ?? []) if (w.object === "activities") {
    const baseline = await db.query("moduleActivityCursors").withIndex("by_orgId_moduleId_watch", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", w.call)).unique();
    out.push({ watch: w.call, seq: baseline?.seq ?? null, ordinal: baseline?.ordinal ?? null, epoch: baseline?.epoch ?? null, declarationHash: baseline?.declarationHash ?? null, inactive: true });
  }
  return out;
}

export type JobStatus = {
  waiting: number; running: number; failed: Array<{ job: string; key: string; error: string; attempts: number }>;
  feeds: ConnectorFeedStatus[];
  activityPublication: Awaited<ReturnType<typeof publicationStatus>>;
  activityBaselines: Awaited<ReturnType<typeof activityBaselineStatus>>;
  retrying: number; lastRunAt: number | null; feedBehind: number | null; feedError: string | null;
  schedules: Array<{ name: string; slot: string | null; state: "pending" | "waiting" | "running" | "failed"; error: string | null }>;
};

/** What the Recipes page shows of a module's background work: keys waiting, running and failed, and the feed's lag. */
export async function jobStatus(db: Db, orgId: Org, moduleId: string, m: ModuleManifest, now: number): Promise<JobStatus | null> {
  const activityPublication = await publicationStatus(db, orgId);
  if (!m.jobs && !m.watches && !m.feeds && !m.schedules && !activityPublication.pending && !Object.values(m.collections).some((c) => c.activity)) return null;
  const out: JobStatus = { activityPublication, activityBaselines: await activityBaselineStatus(db, orgId, moduleId, m), feeds: await connectorFeedStatus(db, orgId, moduleId, m), waiting: 0, running: 0, failed: [], retrying: 0, lastRunAt: null, feedBehind: null, feedError: null, schedules: [] };
  const schedulePkg = scheduleJobs(m).length ? await packageRow({ db }, orgId, moduleId) : null;
  for (const job of [...Object.keys(m.jobs ?? {}), ...scheduleJobs(m), BULK_JOB]) {
    const rows = await db.query("moduleJobs").withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).take(1000);
    for (const r of rows) {
      const schedule = scheduleNameOf(job);
      if (schedule !== null) {
        const payload = r.payload as { slot?: unknown } | undefined;
        out.schedules.push({ name: schedule, slot: typeof payload?.slot === "string" ? payload.slot : null,
          state: r.attempts >= 1 ? "failed" : r.leaseSeq !== undefined && (r.leaseUntil ?? 0) > now ? "running" : schedulePkg?.activityPublication ? "waiting" : "pending", error: r.lastError ?? null });
      }
      if (r.attempts >= attemptsOf(m, job)) { if (out.failed.length < 5) out.failed.push({ job, key: r.key, error: r.lastError ?? "", attempts: r.attempts }); continue; }
      if (r.leaseUntil !== undefined && r.leaseUntil > now) { if (r.leaseSeq !== undefined) out.running++; else out.retrying++; continue; }
      if (r.attempts > 0) out.retrying++;
      else out.waiting++;
    }
  }
  const runner = await db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", RUNNER).eq("shard", 0)).unique();
  out.lastRunAt = runner?.at ?? null;
  if (m.watches?.length) {
    const ends = await heads(db, orgId);
    let behind = 0;
    for (const w of m.watches) {
      const rows = await cursorRows(db, orgId, moduleId, w.call);
      for (const r of rows) { behind = Math.max(behind, (ends.get(r.shard) ?? 0) - r.seq); if (r.error) out.feedError = r.error; }
      if (!rows.length) behind = Math.max(behind, ...ends.values(), 0);
    }
    out.feedBehind = behind;
  }
  return out;
}

/** Rows one job status line reads under its prefix. */
const STATUS_SCAN = 2000;
export type PrefixStatus = {
  waiting: number; running: number; retrying: number; failed: Array<{ key: string; error: string; attempts: number }>;
  /** More keys than the line reads: the counts are at least these. */
  more: boolean; lastRunAt: number | null; feedBehind: number | null;
  /** The keys that wait, run or retry, at most BUSY_KEYS of them: a write's wait counts the keys it saw. */
  busy: string[];
  activityPublication: Awaited<ReturnType<typeof publicationStatus>>;
  activityBaselines: Awaited<ReturnType<typeof activityBaselineStatus>>;
};

/**
 * One job's keys under `prefix` (each a key part's value; none for the whole job), and the `*` keys over it, as a
 * page's status line shows them: waiting, running, retrying, stopped with an error, and when the module's jobs last
 * ran and how far its deal feed is behind.
 */
/** The busy keys a status names. */
const BUSY_KEYS = 200;
export async function prefixStatus(db: Db, orgId: Org, moduleId: string, m: ModuleManifest, job: string, prefix: readonly string[], now: number): Promise<PrefixStatus> {
  const n = shapeOf(m, job).key.length;
  const out: PrefixStatus = { waiting: 0, running: 0, retrying: 0, failed: [], more: false, lastRunAt: null, feedBehind: null, busy: [], activityPublication: await publicationStatus(db, orgId), activityBaselines: [] };
  out.activityBaselines = await activityBaselineStatus(db, orgId, moduleId, m);
  const limit = attemptsOf(m, job);
  const count = (r: Row) => {
    if (r.attempts >= limit) { if (out.failed.length < 5) out.failed.push({ key: r.key, error: r.lastError ?? "", attempts: r.attempts }); return; }
    if (out.busy.length < BUSY_KEYS) out.busy.push(r.key);
    if (r.leaseUntil !== undefined && r.leaseUntil > now) { if (r.leaseSeq !== undefined) out.running++; else out.retrying++; return; }
    if (r.attempts > 0) out.retrying++;
    else out.waiting++;
  };
  const keys = () => db.query("moduleJobs");
  let rows: Row[];
  if (prefix.length >= n) rows = [await rowOf(db, orgId, moduleId, job, prefix.slice(0, n).join("|"))].filter((r): r is Row => r !== null);
  else if (!prefix.length) rows = await keys().withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job)).take(STATUS_SCAN + 1);
  else {
    const p = `${prefix.join("|")}|`;
    rows = await keys().withIndex("by_orgId_moduleId_job_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("job", job).gte("key", p).lt("key", `${p}\uffff`)).take(STATUS_SCAN + 1);
  }
  if (rows.length > STATUS_SCAN) { out.more = true; rows = rows.slice(0, STATUS_SCAN); }
  rows.forEach(count);
  // A "*" key over the prefix stands for keys under it.
  for (let i = 0; i < Math.min(prefix.length, n); i++) {
    const over = await rowOf(db, orgId, moduleId, job, [...prefix.slice(0, i), ...Array(n - i).fill(ANY)].join("|"));
    if (over) count(over);
  }
  const runner = await db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", RUNNER).eq("shard", 0)).unique();
  out.lastRunAt = runner?.at ?? null;
  if (m.watches?.length) {
    const ends = await heads(db, orgId);
    let behind = 0;
    for (const w of m.watches) {
      const cursors = await cursorRows(db, orgId, moduleId, w.call);
      for (const r of cursors) behind = Math.max(behind, (ends.get(r.shard) ?? 0) - r.seq);
    }
    out.feedBehind = behind;
  }
  return out;
}

const woken = new WeakMap<object, Set<string>>();
/**
 * After a ledger entry (convex/objects.ts appendEntry): read it into the workspace's module feeds, once per
 * transaction, and only when a module there watches deals. Every entry moves the feeds' cursors, deal or not, so a
 * `fresh` guard holds again soon after any record write. A lost wake-up costs the one-minute sweep.
 */
export async function scheduleModuleFeed(ctx: MutationCtx, orgId: Org) {
  const done = woken.get(ctx) ?? new Set<string>();
  woken.set(ctx, done);
  if (done.has(orgId)) return;
  done.add(orgId);
  if (await hasFeeds(ctx.db, orgId)) await ctx.scheduler.runAfter(0, internal.moduleJobs.feed, { orgId });
}

const FEED = (name: string) => `#feed:${name}`;
const FILL = (name: string) => `#feedfill:${name}`;
const LINK_FILL = (name: string, linkId: Id<"connectorLinks">) => `${FILL(name)}:${linkId}`;
const FEED_RATE = "#feedrate";
const MINUTE = 60_000;
export const FEED_ITEMS_MAX = 100;
const FEED_PER_MINUTE = 600;
const feedCursor = (db: Db, orgId: Org, moduleId: string, watch: string) =>
  db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("watch", watch).eq("shard", 0)).unique();
const feedHead = async (db: Db, orgId: Org, feed: string) =>
  (await db.query("feedLog").withIndex("by_orgId_and_feed_and_seq", (q) => q.eq("orgId", orgId).eq("feed", feed)).order("desc").first())?.seq ?? 0;
const pendingLinkFill = async (db: Db, orgId: Org, moduleId: string, name: string) => {
  const prefix = `${FILL(name)}:`;
  return db.query("moduleCursors").withIndex("by_orgId_moduleId_watch_shard", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).gte("watch", prefix).lt("watch", `${prefix}\uffff`)).first();
};

async function ensureConnectorCursors(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest) {
  for (const [name, f] of Object.entries(m.feeds ?? {})) {
    if (await feedCursor(ctx.db, orgId, moduleId, FEED(name))) continue;
    const now = Date.now();
    await ctx.db.insert("moduleCursors", { orgId, moduleId, watch: FEED(name), shard: 0, seq: await feedHead(ctx.db, orgId, f.feed) });
    await ctx.db.insert("moduleCursors", { orgId, moduleId, watch: FILL(name), shard: 0, seq: now - (f.backfillDays ?? 30) * 86_400_000, at: now });
  }
}

export type ConnectorFeedStatus = { name: string; behind: number; backfill: boolean; error: string | null };
export async function connectorFeedStatus(db: Db, orgId: Org, moduleId: string, m: ModuleManifest): Promise<ConnectorFeedStatus[]> {
  const out: ConnectorFeedStatus[] = [];
  for (const [name, f] of Object.entries(m.feeds ?? {})) {
    const row = await feedCursor(db, orgId, moduleId, FEED(name));
    const fill = await feedCursor(db, orgId, moduleId, FILL(name)) ?? await pendingLinkFill(db, orgId, moduleId, name);
    out.push({ name, behind: Math.max(0, await feedHead(db, orgId, f.feed) - (row?.seq ?? 0)), backfill: !row || !!fill, error: row?.error ?? fill?.error ?? null });
  }
  return out;
}

export type ConnectorFeedPlan = {
  from: number; fill: string | null; next: string | null; to: number; items: FeedItem[]; count: number; call: string; epoch: number;
  generation: number; grants: FeedReadStamp[]; backfillLink: Id<"connectorLinks"> | null;
};

/** Restoring a member's read grant replays current state within the manifest's finite backfill window. */
export async function restartConnectorLinkBackfill(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, connector: string, linkId: Id<"connectorLinks">, revision: number) {
  const now = Date.now();
  for (const [name, f] of Object.entries(m.feeds ?? {})) {
    if (feedOf(f.feed)?.connector.id !== connector) continue;
    const row = await feedCursor(ctx.db, orgId, moduleId, FEED(name));
    if (!row) continue;
    const fill = await feedCursor(ctx.db, orgId, moduleId, LINK_FILL(name, linkId));
    const window = { seq: now - (f.backfillDays ?? 30) * 86_400_000, at: now, linkId, generation: revision, throughSeq: await feedHead(ctx.db, orgId, f.feed) };
    if (fill) await ctx.db.patch(fill._id, { ...window, cursor: undefined, error: undefined });
    else await ctx.db.insert("moduleCursors", { orgId, moduleId, watch: LINK_FILL(name, linkId), shard: 0, ...window });
  }
}

/** Backfill pages precede the log. Its fixed time bounds keep a busy feed's backfill finite. */
export async function connectorFeedPlan(ctx: MutationCtx, orgId: Org, moduleId: string, m: ModuleManifest, name: string, epoch: number): Promise<ConnectorFeedPlan | null> {
  const db = ctx.db;
  const f = m.feeds?.[name];
  const row = await feedCursor(db, orgId, moduleId, FEED(name));
  if (!f || !row) return null;
  const rate = await feedCursor(db, orgId, moduleId, FEED_RATE);
  const at = Math.floor(Date.now() / MINUTE) * MINUTE;
  const used = rate?.at === at ? rate.seq : 0;
  const limit = Math.min(FEED_ITEMS_MAX, FEED_PER_MINUTE - used);
  if (limit <= 0) return null;
  const reserve = async (plan: ConnectorFeedPlan) => {
    if (plan.count) {
      const seq = used + plan.count;
      if (rate) await db.patch(rate._id, { at, seq });
      else await db.insert("moduleCursors", { orgId, moduleId, watch: FEED_RATE, shard: 0, at, seq });
    }
    return plan;
  };
  const initial = await feedCursor(db, orgId, moduleId, FILL(name));
  const restored = initial ? null : await pendingLinkFill(db, orgId, moduleId, name);
  const fill = initial ?? (restored && row.seq >= (restored.throughSeq ?? 0) ? restored : null);
  const project = (data: Record<string, unknown> | null) => data === null ? null : Object.fromEntries(f.fields.map((field) => [field, data[field] ?? null]));
  const items: FeedItem[] = [];
  const grants = new Map<string, FeedReadStamp>();
  const item = async (r: { itemId: string; linkId: Id<"connectorLinks"> }, seq: number | null, at: number, before: Record<string, unknown> | null, after: Record<string, unknown> | null) => {
    const access = await feedReadAccess(ctx, orgId, moduleId, f.feed, r.linkId);
    if (!access) return;
    if (access.stamp) grants.set(r.linkId, access.stamp);
    const link = await db.get(r.linkId);
    items.push({ seq, id: r.itemId, link: { userId: link?.userId ?? null }, at, before: project(before), after: project(after) });
  };
  if (fill) {
    const query = fill.linkId
      ? db.query("feedItems").withIndex("by_orgId_and_feed_and_linkId_and_updatedAt", (q) => q.eq("orgId", orgId).eq("feed", f.feed).eq("linkId", fill.linkId!).gte("updatedAt", fill.seq).lte("updatedAt", fill.at!))
      : db.query("feedItems").withIndex("by_orgId_and_feed_and_updatedAt", (q) => q.eq("orgId", orgId).eq("feed", f.feed).gte("updatedAt", fill.seq).lte("updatedAt", fill.at!));
    const page = await query.paginate({ numItems: limit, cursor: fill.cursor ?? null });
    for (const r of page.page) if (!r.deleted) await item(r, null, r.updatedAt, null, r.data);
    return reserve({ from: row.seq, fill: fill.cursor ?? "", next: page.isDone ? null : page.continueCursor, to: row.seq, items, count: items.length, call: f.call, epoch, generation: fill.generation ?? 0, backfillLink: fill.linkId ?? null, grants: [...grants.values()] });
  }
  const rows = await db.query("feedLog").withIndex("by_orgId_and_feed_and_seq", (q) => q.eq("orgId", orgId).eq("feed", f.feed).gt("seq", row.seq)).take(limit);
  if (!rows.length) return null;
  for (const r of rows) await item(r, r.seq, r.at, r.before, r.after);
  return reserve({ from: row.seq, fill: null, next: null, to: rows[rows.length - 1].seq, items, count: items.length, call: f.call, epoch, generation: 0, backfillLink: null, grants: [...grants.values()] });
}

/** The caller applies writes in this transaction. A throw rolls back both writes and this cursor movement. */
export async function advanceConnectorFeed(ctx: MutationCtx, orgId: Org, moduleId: string, name: string, p: Pick<ConnectorFeedPlan, "from" | "fill" | "next" | "to" | "count"> & { generation?: number; backfillLink?: Id<"connectorLinks"> | null }, error?: string): Promise<boolean> {
  const row = await feedCursor(ctx.db, orgId, moduleId, FEED(name));
  const fill = await feedCursor(ctx.db, orgId, moduleId, p.backfillLink ? LINK_FILL(name, p.backfillLink) : FILL(name));
  if (!row || row.seq !== p.from || (fill?.generation ?? 0) !== (p.generation ?? 0) || (fill ? fill.cursor ?? "" : null) !== p.fill) return false;
  if (error !== undefined) { await ctx.db.patch((p.backfillLink ? fill! : row)._id, { error: error.slice(0, 500) }); return true; }
  if (!p.backfillLink) await ctx.db.patch(row._id, { seq: p.to, error: undefined });
  if (fill) {
    if (p.next === null) await ctx.db.delete(fill._id);
    else await ctx.db.patch(fill._id, { cursor: p.next, error: undefined });
  }
  return true;
}
