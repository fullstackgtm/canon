// The object-layer projector (docs/cp0-object-layer.md, migration step 6).
//
// Per workspace (a Convex org), it pulls ledger entries shard by shard from
// Convex (GET /ledger/tail), keeps a cursor per shard, mirrors the entries it
// applied, folds them with the same pure fold Convex saves with (src/core is a
// generated copy of convex/lib), and keeps one typed wide table per object.
//
// - A page is applied in one transaction: mirror rows, projected rows, fold
//   states and the shard cursor commit together, so a crash replays the page
//   and the replay changes nothing (entries at or below a stream's version are
//   skipped, mirror rows are keyed by (stream, version)).
// - A version gap (a stream's earlier entry never reached the mirror) is filled
//   from GET /ledger/stream before folding.
// - Every catch-up reads the object definitions with the shard heads, so a
//   registry change that alters an object's columns rebuilds that object even
//   when no shard moved. A rebuild folds the mirror into new tables, in chunks
//   that each commit with a cursor, and then swaps the p_<object> view. A
//   rebuild cut off partway resumes there, and before the swap re-folds every
//   stream the mirror has moved past since it was built.
// - Runs for one workspace are serialized; nudges that arrive while one is
//   queued merge into it. stop() refuses new runs and cuts running ones off at
//   the next page or chunk; a later catch-up resumes from the committed cursors.
import { fold, type FoldState, type LedgerEntry } from "./core/objects/fold.ts";
import { ASSOCIATION_OBJECT, indexObjectDef, plainObjectDef, type ObjectDef, type ResolvedObjectDef } from "./core/objects/registry.ts";
import { writeBackAssociations } from "./associations.ts";
import type { DuckDBConnection } from "@duckdb/node-api";
import { all, lit } from "./db.ts";
import { HttpError } from "./errors.ts";
import { metrics } from "./metrics.ts";
import { appendRecord, columnsOf, createBuildTables, ident, indexBuildTables, OBJECT_TABLE_RE, rowTable, signatureOf, stateTable, viewName, type Column } from "./projection.ts";
import type { Registry } from "./registry.ts";
import { isRegisterObject, writeBackRegister } from "./register.ts";
import type { Workspace } from "./workspace.ts";

export const SHARDS = 16;

export type WireEntry = LedgerEntry & { object: string; shard: number; seq: number };
export type TailPage = { entries: WireEntry[]; head: number };
/** Last issued `seq` per shard, keyed by the shard number as a string. */
export type Heads = Record<string, number>;
export type HeadsPage = { heads: Heads; defs: ObjectDef[] };

export interface LedgerSource {
  tail(ws: string, shard: number, after: number, limit: number): Promise<TailPage>;
  /** The shard heads and the org's object definitions, read together on every catch-up. */
  heads(ws: string): Promise<HeadsPage>;
  /** A stream's entries from `fromVersion` on, ascending. */
  stream(ws: string, streamId: string, fromVersion: number): Promise<WireEntry[]>;
  /** False until the source knows where the ledger is (see httpLedgerSource). */
  ready?(): boolean;
}

const STREAM_PAGE = 500;

/**
 * The ledger over Convex's HTTP site. `baseUrl` may be a function: the
 * service learns the URL from Convex's nudges, so it needs no configuration,
 * and the source is not ready until the first nudge arrives.
 */
export function httpLedgerSource(opts: { baseUrl: string | (() => string | null); token: string; timeoutMs?: number; fetchImpl?: typeof fetch }): LedgerSource {
  const baseOf = () => {
    const url = typeof opts.baseUrl === "function" ? opts.baseUrl() : opts.baseUrl;
    return url ? url.replace(/\/$/, "") : null;
  };
  const doFetch = opts.fetchImpl ?? fetch;
  async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const base = baseOf();
    if (!base) throw new Error("ledger source not known yet: no nudge from Convex has arrived");
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await doFetch(`${base}${path}?${query}`, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`ledger source ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    ready: () => baseOf() !== null,
    tail: (ws, shard, after, limit) => get<TailPage>("/ledger/tail", { org: ws, shard, after, limit }),
    heads: (ws) => get<HeadsPage>("/ledger/heads", { org: ws }),
    async stream(ws, id, fromVersion) {
      const out: WireEntry[] = [];
      for (let from = fromVersion; ; ) {
        const page = await get<{ entries: WireEntry[]; done: boolean }>("/ledger/stream", { org: ws, id, fromVersion: from, limit: STREAM_PAGE });
        out.push(...page.entries);
        if (page.done || page.entries.length === 0) return out;
        from = page.entries[page.entries.length - 1].version + 1;
      }
    },
  };
}

export type ProjectorOptions = {
  /** Most entries per tail request (Convex may return fewer: it also bounds a page by bytes). */
  pageSize: number;
  /** Streams per committed rebuild chunk. */
  rebuildChunk: number;
  /** How often recently active workspaces are caught up without a nudge; 0 disables. */
  pollMs: number;
  /** A workspace nudged or listed within this window is polled. */
  activeMs: number;
  /** Called after each committed rebuild chunk (tests use it to cut a rebuild off). */
  onRebuildChunk?: (object: string, chunk: number) => void;
};

export const DEFAULT_PROJECTOR_OPTIONS: ProjectorOptions = { pageSize: 500, rebuildChunk: 2000, pollMs: 30_000, activeMs: 15 * 60_000 };

/** The current table set of one object: the build its p_<object> view points at. */
type Build = { build: number; def: ResolvedObjectDef; stored: string; signature: string; cols: Column[] };

/** The definition as projection_builds stores it. */
const storedDef = (def: ResolvedObjectDef) => JSON.stringify(plainObjectDef(def));

type Job = { heads: Heads | "all"; done: Promise<void> };

export class Projector {
  private readonly registry: Registry;
  private readonly source: LedgerSource | null;
  private readonly opts: ProjectorOptions;
  /** The last run scheduled per workspace; each run starts after the one before it. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** A catch-up waiting to start, which later nudges merge into. */
  private readonly queued = new Map<string, Job>();
  private readonly lastActive = new Map<string, number>();
  private readonly timer: NodeJS.Timeout | null;
  private stopping = false;

  constructor(registry: Registry, source: LedgerSource | null, opts: Partial<ProjectorOptions> = {}) {
    this.registry = registry;
    this.source = source;
    this.opts = { ...DEFAULT_PROJECTOR_OPTIONS, ...opts };
    this.timer = source && this.opts.pollMs > 0 ? setInterval(() => this.poll(), this.opts.pollMs) : null;
    this.timer?.unref();
  }

  get enabled() {
    return this.source !== null;
  }

  /** Mark a workspace as in use, so the poll keeps it caught up. */
  touch(ws: string) {
    this.lastActive.set(ws, Date.now());
  }

  private serial<T>(ws: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(ws) ?? Promise.resolve()).catch(() => {}).then(() => {
      this.checkStopping();
      return fn();
    });
    this.chains.set(ws, run);
    void run.catch(() => {}).finally(() => {
      if (this.chains.get(ws) === run) this.chains.delete(ws);
    });
    return run;
  }

  /**
   * Catch a workspace up to `heads` (every shard behind it), or to Convex's
   * current heads when omitted. Resolves once applied.
   */
  catchUp(ws: string, heads?: Heads): Promise<void> {
    if (!this.source) return Promise.reject(new HttpError(503, "projector not configured"));
    if (this.stopping) return Promise.reject(new HttpError(503, "projector stopping"));
    this.touch(ws);
    const waiting = this.queued.get(ws);
    if (waiting) {
      if (!heads) waiting.heads = "all";
      else if (waiting.heads !== "all") for (const [s, seq] of Object.entries(heads)) waiting.heads[s] = Math.max(waiting.heads[s] ?? 0, seq);
      return waiting.done;
    }
    const job = { heads: heads ? { ...heads } : "all" } as Job;
    job.done = this.serial(ws, () => {
      this.queued.delete(ws);
      return this.runCatchUp(ws, job.heads);
    });
    this.queued.set(ws, job);
    return job.done;
  }

  /** Rebuild one object from the mirror into new tables and swap its view, even if its columns did not change. */
  rebuild(ws: string, object: string): Promise<{ build: number; rows: number }> {
    return this.serial(ws, () => this.registry.with(ws, async (w) => {
      const current = (await loadBuilds(w)).get(object);
      if (!current) throw new HttpError(404, `no projection of ${object}`);
      const build = await this.rebuildObject(w, current.def, { force: true });
      await w.checkpoint();
      const [{ n }] = await w.read((c) => all(c, `SELECT count(*) AS n FROM ${ident(viewName(object))}`));
      return { build, rows: Number(n) };
    }));
  }

  private poll() {
    if (this.source?.ready?.() === false) return;
    const now = Date.now();
    for (const [ws, at] of this.lastActive) {
      if (now - at > this.opts.activeMs) {
        this.lastActive.delete(ws);
        continue;
      }
      if (this.queued.has(ws) || this.chains.has(ws)) continue;
      this.catchUp(ws).catch((e) => console.error(JSON.stringify({ msg: "projector poll failed", ws, err: String(e).slice(0, 500) })));
      // catchUp refreshes lastActive; a poll alone must not keep a workspace active forever.
      this.lastActive.set(ws, at);
    }
  }

  /**
   * Stop polling, refuse new runs, and cut running ones off at their next page
   * or rebuild chunk. Resolves once every scheduled run has settled.
   */
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.chains.values()]);
  }

  private checkStopping() {
    if (this.stopping) throw new HttpError(503, "projector stopping");
  }

  private async runCatchUp(ws: string, heads: Heads | "all") {
    const source = this.source!;
    const t0 = performance.now();
    const current = await source.heads(ws);
    const target = heads === "all" ? current.heads : heads;
    await this.registry.with(ws, async (w) => {
      const builds = await this.ensureDefs(w, current.defs, await loadBuilds(w));
      const cursors = await readCursors(w);
      for (let shard = 0; shard < SHARDS; shard++) {
        const after = cursors[String(shard)] ?? 0;
        if ((target[String(shard)] ?? 0) > after) await this.pullShard(w, shard, after, builds);
      }
    }, true);
    metrics.projectorCatchUpMs.observe(performance.now() - t0);
  }

  private async pullShard(w: Workspace, shard: number, after: number, builds: Map<string, Build>) {
    const source = this.source!;
    for (;;) {
      this.checkStopping();
      const t0 = performance.now();
      const page = await source.tail(w.id, shard, after, this.opts.pageSize);
      metrics.projectorTailMs.observe(performance.now() - t0);
      this.checkStopping();
      if (page.entries.length === 0) return;
      page.entries.forEach((e, i) => {
        if (e.shard !== shard || e.seq !== after + i + 1) throw new Error(`tail page for shard ${shard} after ${after} is not contiguous at ${i}`);
      });
      const t1 = performance.now();
      await this.apply(w, shard, page.entries, builds);
      metrics.projectorApplyMs.observe(performance.now() - t1);
      metrics.projectorEntries.inc({}, page.entries.length);
      after = page.entries[page.entries.length - 1].seq;
      // Convex cuts a page short at its byte budget, so only the head says the shard is drained.
      if (after >= page.head) return;
    }
  }

  /**
   * Create tables for new objects, rebuild objects whose columns changed, and
   * store the definition of every other object whose definition changed (an
   * apiName, label or option), which list requests are validated against.
   */
  private async ensureDefs(w: Workspace, defs: readonly ObjectDef[], builds: Map<string, Build>): Promise<Map<string, Build>> {
    let changed = false;
    for (const plain of defs) {
      if (plain.storage !== "ledger" || !OBJECT_TABLE_RE.test(plain.apiName)) continue;
      const def = indexObjectDef(plain);
      const current = builds.get(def.apiName);
      if (current?.signature === signatureOf(def)) {
        if (current.stored === storedDef(def)) continue;
        await w.write((c) => c.run(`UPDATE projection_builds SET def = $d WHERE object = $o AND build_id = $b`, { d: storedDef(def), o: def.apiName, b: current.build }), "exclusive");
      } else {
        await this.rebuildObject(w, def, { force: false });
      }
      changed = true;
    }
    if (!changed) return builds;
    await w.checkpoint();
    return loadBuilds(w);
  }

  private async apply(w: Workspace, shard: number, entries: readonly WireEntry[], builds: Map<string, Build>) {
    const mirrored = await mirroredOf(w, entries);

    const states = new Map<string, FoldState>();
    const objects = new Set(entries.map((e) => e.object).filter((o) => builds.has(o)));
    for (const object of objects) {
      const ids = [...new Set(entries.filter((e) => e.object === object).map((e) => e.streamId))].map(lit).join(", ");
      const rows = await w.read((c) => all(c, `SELECT state FROM ${ident(stateTable(object, builds.get(object)!.build))} WHERE id IN (${ids})`));
      for (const r of rows) {
        const st = JSON.parse(String(r.state)) as FoldState;
        states.set(st.streamId, st);
      }
    }

    const toMirror: WireEntry[] = [];
    const mirror = (e: WireEntry) => {
      const key = mirrorKey(e);
      if (mirrored.has(key)) return;
      mirrored.add(key);
      toMirror.push(e);
    };
    const touched = new Map<string, Map<string, FoldState>>();
    // Streams a merge's undo reverted in this batch: what it puts back goes to the outbox as op `merge` (register.ts).
    const reverted = new Set<string>();
    for (const e of entries) {
      mirror(e);
      // An object with no definition yet is only mirrored; its first build folds it from the mirror.
      if (!builds.has(e.object)) continue;
      let st = states.get(e.streamId) ?? null;
      if (st && e.version <= st.version) continue;
      if (e.version !== (st?.version ?? 0) + 1) {
        const fetched = await this.source!.stream(w.id, e.streamId, (st?.version ?? 0) + 1);
        const gap = fetched.filter((m) => m.version < e.version);
        for (const key of await mirroredOf(w, gap.filter((m) => !mirrored.has(mirrorKey(m))))) mirrored.add(key);
        for (const missing of gap) {
          mirror(missing);
          st = fold(st, missing);
          if (missing.body.kind === "revert") reverted.add(missing.streamId);
        }
      }
      st = fold(st, e);
      states.set(e.streamId, st);
      if (e.body.kind === "revert") reverted.add(e.streamId);
      const perObject = touched.get(e.object) ?? new Map<string, FoldState>();
      perObject.set(e.streamId, st);
      touched.set(e.object, perObject);
    }

    const lastSeq = entries[entries.length - 1].seq;
    await w.write(async (c) => {
      for (const [object, changed] of touched) {
        if (isRegisterObject(object)) await writeBackRegister(c, object, builds.get(object)!.def, [...changed.values()], Date.now(), reverted);
        if (object === ASSOCIATION_OBJECT) await writeBackAssociations(c, builds.get(object)!.def, [...changed.values()], Date.now());
        const b = builds.get(object)!;
        const ids = [...changed.keys()].map(lit).join(", ");
        await c.run(`DELETE FROM ${ident(rowTable(object, b.build))} WHERE id IN (${ids})`);
        await c.run(`DELETE FROM ${ident(stateTable(object, b.build))} WHERE id IN (${ids})`);
        const rows = await c.createAppender(rowTable(object, b.build));
        const states = await c.createAppender(stateTable(object, b.build));
        for (const st of changed.values()) appendRecord(rows, states, b.def, b.cols, st);
        rows.closeSync();
        states.closeSync();
      }
      if (toMirror.length) {
        const m = await c.createAppender("ledger_mirror");
        for (const e of toMirror) {
          m.appendVarchar(e.streamId);
          m.appendInteger(e.version);
          m.appendVarchar(e.object);
          m.appendInteger(e.shard);
          m.appendBigInt(BigInt(e.seq));
          m.appendVarchar(JSON.stringify(e));
          m.endRow();
        }
        m.closeSync();
      }
      await c.run(`DELETE FROM projector_cursor WHERE shard = ${shard}`);
      await c.run(`INSERT INTO projector_cursor VALUES (${shard}, ${lastSeq})`);
    }, "exclusive");
  }

  /**
   * Fold one object's streams from the mirror into a new build and point its
   * view at it. A build left `building` with the same columns is resumed from
   * its cursor (the last stream it committed); one with other columns is dropped.
   * Catch-ups that ran while it was cut off moved the mirror past streams it had
   * already committed, so before the swap it re-folds every stream whose mirror
   * holds a later version than the build.
   */
  private async rebuildObject(w: Workspace, def: ResolvedObjectDef, opts: { force: boolean }): Promise<number> {
    const object = def.apiName;
    const signature = signatureOf(def);
    const open = await w.read((c) => all(c, `SELECT build_id, signature, cursor FROM projection_builds WHERE object = $o AND status = 'building'`, { o: object }));
    let build: number | null = null;
    let cursor = "";
    for (const b of open) {
      if (b.signature === signature && build === null) {
        build = Number(b.build_id);
        cursor = String(b.cursor);
      } else {
        await w.write(async (c) => {
          await c.run(`DROP TABLE IF EXISTS ${ident(rowTable(object, Number(b.build_id)))}`);
          await c.run(`DROP TABLE IF EXISTS ${ident(stateTable(object, Number(b.build_id)))}`);
          await c.run(`UPDATE projection_builds SET status = 'abandoned', finished_at = $t WHERE object = $o AND build_id = $b`, { o: object, b: Number(b.build_id), t: Date.now() });
        }, "exclusive");
      }
    }
    if (build === null && !opts.force) {
      const current = (await loadBuilds(w)).get(object);
      if (current?.signature === signature) return current.build;
    }
    if (build === null) {
      const [{ next }] = await w.read((c) => all(c, `SELECT coalesce(max(build_id), 0) + 1 AS next FROM projection_builds WHERE object = $o`, { o: object }));
      const id = Number(next);
      await w.write(async (c) => {
        for (const stmt of createBuildTables(def, id)) await c.run(stmt);
        await c.run(`INSERT INTO projection_builds VALUES ($b, $o, $s, $d, '', 'building', $t, NULL)`, {
          b: id, o: object, s: signature, d: JSON.stringify(plainObjectDef(def)), t: Date.now(),
        });
      }, "exclusive");
      build = id;
    }

    const cols = columnsOf(def);
    const b = build;
    const unbuilt = () => `SELECT DISTINCT stream FROM ledger_mirror WHERE object = $o AND stream > $cur ORDER BY stream LIMIT ${this.opts.rebuildChunk}`;
    const stale = () => `SELECT m.stream FROM ledger_mirror m LEFT JOIN ${ident(stateTable(object, b))} s ON s.id = m.stream
      WHERE m.object = $o GROUP BY m.stream HAVING max(m.version) > coalesce(max(s.version), 0) ORDER BY m.stream LIMIT ${this.opts.rebuildChunk}`;
    let refreshing = false;
    for (let chunk = 1; ; chunk++) {
      this.checkStopping();
      const rows = await w.read((c) => all(c,
        `SELECT entry FROM ledger_mirror WHERE object = $o AND stream IN (${refreshing ? stale() : unbuilt()}) ORDER BY stream, version`,
        refreshing ? { o: object } : { o: object, cur: cursor }));
      if (rows.length === 0) {
        if (refreshing) break;
        refreshing = true;
        continue;
      }
      const folded: FoldState[] = [];
      let st: FoldState | null = null;
      for (const r of rows) {
        const e = JSON.parse(String(r.entry)) as WireEntry;
        if (st && st.streamId !== e.streamId) {
          folded.push(st);
          st = null;
        }
        st = fold(st, e);
      }
      folded.push(st!);
      const last = refreshing ? cursor : folded[folded.length - 1].streamId;
      await w.write(async (c) => {
        if (refreshing) {
          const ids = folded.map((f) => lit(f.streamId)).join(", ");
          await c.run(`DELETE FROM ${ident(rowTable(object, b))} WHERE id IN (${ids})`);
          await c.run(`DELETE FROM ${ident(stateTable(object, b))} WHERE id IN (${ids})`);
        }
        const rowApp = await c.createAppender(rowTable(object, b));
        const stateApp = await c.createAppender(stateTable(object, b));
        for (const s of folded) appendRecord(rowApp, stateApp, def, cols, s);
        rowApp.closeSync();
        stateApp.closeSync();
        // A rebuild links and writes back every stream it folds; rows already current change nothing.
        if (isRegisterObject(object)) await writeBackRegister(c, object, def, folded, Date.now());
        if (object === ASSOCIATION_OBJECT) await writeBackAssociations(c, def, folded, Date.now());
        await c.run(`UPDATE projection_builds SET cursor = $cur WHERE object = $o AND build_id = $b`, { cur: last, o: object, b });
      }, "exclusive");
      cursor = last;
      this.opts.onRebuildChunk?.(object, chunk);
    }

    const previous = (await loadBuilds(w)).get(object);
    await w.write(async (c) => {
      for (const stmt of indexBuildTables(object, b)) await c.run(stmt);
      await c.run(`CREATE OR REPLACE VIEW ${ident(viewName(object))} AS SELECT * FROM ${ident(rowTable(object, b))}`);
      await c.run(`UPDATE projection_builds SET status = 'done', def = $d, finished_at = $t WHERE object = $o AND build_id = $b`, { o: object, b, d: storedDef(def), t: Date.now() });
      if (previous) {
        await c.run(`UPDATE projection_builds SET status = 'replaced' WHERE object = $o AND build_id = $b`, { o: object, b: previous.build });
        await c.run(`DROP TABLE IF EXISTS ${ident(rowTable(object, previous.build))}`);
        await c.run(`DROP TABLE IF EXISTS ${ident(stateTable(object, previous.build))}`);
      }
    }, "exclusive");
    return b;
  }
}

const mirrorKey = (e: { streamId: string; version: number }) => `${e.streamId}@${e.version}`;

/**
 * Which of these (stream, version) pairs the mirror already holds. Reads only
 * those pairs (the stream index narrows the scan), never a stream's whole
 * history, so a hot record's catch-up does not grow with its version count.
 */
async function mirroredOf(w: Workspace, pairs: readonly { streamId: string; version: number }[]): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  for (const p of pairs) if (!Number.isSafeInteger(p.version)) throw new Error(`ledger entry ${p.streamId} has a bad version`);
  const streams = [...new Set(pairs.map((p) => lit(p.streamId)))].join(", ");
  const keys = pairs.map((p) => `(${lit(p.streamId)}, ${p.version})`).join(", ");
  const rows = await w.read((c) => all(c, `SELECT m.stream, m.version FROM ledger_mirror m
    JOIN (VALUES ${keys}) AS k(stream, version) ON m.stream = k.stream AND m.version = k.version
    WHERE m.stream IN (${streams})`));
  return new Set(rows.map((r) => `${r.stream}@${r.version}`));
}

/** Every object's current build (the one its view points at). */
export async function buildsOf(c: DuckDBConnection): Promise<Map<string, Build>> {
  const rows = await all(c, `SELECT object, build_id, signature, def FROM projection_builds WHERE status = 'done'`);
  const out = new Map<string, Build>();
  for (const r of rows) {
    const def = indexObjectDef(JSON.parse(String(r.def)) as ObjectDef);
    out.set(String(r.object), { build: Number(r.build_id), def, stored: String(r.def), signature: String(r.signature), cols: columnsOf(def) });
  }
  return out;
}

export const loadBuilds = (w: Workspace) => w.read(buildsOf);

async function cursorsOf(c: DuckDBConnection): Promise<Heads> {
  const rows = await all(c, `SELECT shard, seq FROM projector_cursor`);
  return Object.fromEntries(rows.map((r) => [String(r.shard), Number(r.seq)]));
}

const readCursors = (w: Workspace) => w.read(cursorsOf);

/** The projector's cursor for every shard, 0 where it has applied nothing. */
export async function throughOf(c: DuckDBConnection): Promise<Heads> {
  const cursors = await cursorsOf(c);
  return Object.fromEntries(Array.from({ length: SHARDS }, (_, s) => [String(s), cursors[String(s)] ?? 0]));
}

export const projectedThrough = (w: Workspace) => w.read(throughOf);
