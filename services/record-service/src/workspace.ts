// One open workspace: a DuckDB file with a single writer connection (group
// commit) and a small pool of read connections.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { migrate, one, reseatSequences } from "./db.ts";
import { metrics } from "./metrics.ts";

export type WorkspaceOptions = { memoryLimit: string; threads: number; readPool: number; maxGroup: number; lockWaitMs: number };

type WriteJob = {
  fn: (c: DuckDBConnection) => Promise<unknown>;
  exclusive: boolean; // runs alone in its own transaction
  raw: boolean; // runs alone with no transaction (CHECKPOINT, file copy)
  queued: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export class Workspace {
  readonly id: string;
  readonly path: string;
  private instance: DuckDBInstance;
  private writer: DuckDBConnection;
  private readers: DuckDBConnection[];
  private idle: DuckDBConnection[];
  private waiters: Array<(c: DuckDBConnection) => void> = [];
  private queue: WriteJob[] = [];
  private draining: Promise<void> | null = null;
  private closed = false;
  private readonly maxGroup: number;
  private lastAt: number;
  dirty = false; // writes since the last checkpoint

  private constructor(id: string, path: string, instance: DuckDBInstance, writer: DuckDBConnection, readers: DuckDBConnection[], maxGroup: number, lastAt: number) {
    this.id = id;
    this.path = path;
    this.instance = instance;
    this.writer = writer;
    this.readers = readers;
    this.idle = [...readers];
    this.maxGroup = maxGroup;
    this.lastAt = lastAt;
  }

  static async open(id: string, path: string, opts: WorkspaceOptions): Promise<Workspace> {
    // During a redeploy the previous container can still hold the file for a
    // few seconds (it drains on SIGTERM). DuckDB's file lock makes that a clean
    // "Could not set lock" error, so wait it out instead of failing.
    let instance: DuckDBInstance;
    for (let waited = 0; ; ) {
      try {
        instance = await DuckDBInstance.create(path, { memory_limit: opts.memoryLimit, threads: String(opts.threads) });
        break;
      } catch (e) {
        if (!/lock/i.test(String((e as Error).message)) || waited >= opts.lockWaitMs) throw e;
        await new Promise((r) => setTimeout(r, 250));
        waited += 250;
      }
    }
    const writer = await instance.connect();
    await migrate(writer);
    await reseatSequences(writer);
    const readers: DuckDBConnection[] = [];
    for (let i = 0; i < opts.readPool; i++) readers.push(await instance.connect());
    // Every edit's `at` is stored as its idempotency row's ts, so the clock resumes past the last one.
    const lastAt = Number((await one(writer, `SELECT coalesce(max(ts), 0) AS m FROM idempotency`))!.m);
    return new Workspace(id, path, instance, writer, readers, opts.maxGroup, lastAt);
  }

  /**
   * The workspace's commit clock: the wall clock, but always past the last
   * reading. Called only inside a write, where jobs run one at a time in the
   * order they commit, so the readings order writes as they were applied.
   */
  nextAt(): number {
    this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    return this.lastAt;
  }

  get queueDepth() {
    return this.queue.length;
  }

  async read<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("workspace closed");
    const c = this.idle.pop() ?? (await new Promise<DuckDBConnection>((r) => this.waiters.push(r)));
    try {
      return await fn(c);
    } finally {
      const w = this.waiters.shift();
      if (w) w(c);
      else this.idle.push(c);
    }
  }

  /**
   * A read whose statements all see one snapshot: DuckDB's MVCC gives a
   * transaction the catalog and rows as of its start, so a view swapped or a
   * table dropped by a write that commits meanwhile stays as it was.
   */
  snapshot<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
    return this.read(async (c) => {
      await c.run("BEGIN TRANSACTION READ ONLY");
      try {
        return await fn(c);
      } finally {
        await c.run("ROLLBACK");
      }
    });
  }

  /**
   * Queue a write. Non-exclusive writes are drained in groups of up to maxGroup
   * into ONE transaction (group commit). If a group fails, it is rolled back and
   * each write re-runs alone, so one bad write cannot fail its neighbours.
   * A write's promise resolves only after its transaction committed.
   */
  write<T>(fn: (c: DuckDBConnection) => Promise<T>, mode: "group" | "exclusive" | "raw" = "group"): Promise<T> {
    if (this.closed) return Promise.reject(new Error("workspace closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, exclusive: mode !== "group", raw: mode === "raw", queued: performance.now(), resolve: resolve as (v: unknown) => void, reject });
      metrics.queueDepth.set(this.queue.length);
      if (!this.draining) this.draining = this.drain();
    });
  }

  private async drain() {
    const c = this.writer;
    while (this.queue.length) {
      let n = 1;
      if (!this.queue[0].exclusive) {
        while (n < this.queue.length && n < this.maxGroup && !this.queue[n].exclusive) n++;
      }
      const group = this.queue.splice(0, n);
      metrics.queueDepth.set(this.queue.length);
      metrics.groupSize.observe(group.length);
      for (const j of group) metrics.queueWaitMs.observe(performance.now() - j.queued);
      if (group[0].raw) {
        try {
          group[0].resolve(await group[0].fn(c));
        } catch (e) {
          group[0].reject(e);
        }
        continue;
      }
      const outs: unknown[] = [];
      try {
        await c.run("BEGIN TRANSACTION");
        for (const j of group) outs.push(await j.fn(c));
        await c.run("COMMIT");
        this.dirty = true;
        group.forEach((j, i) => j.resolve(outs[i]));
      } catch (groupErr) {
        await c.run("ROLLBACK").catch(() => {});
        if (group.length === 1) {
          group[0].reject(groupErr);
          continue;
        }
        for (const j of group) {
          try {
            await c.run("BEGIN TRANSACTION");
            const out = await j.fn(c);
            await c.run("COMMIT");
            this.dirty = true;
            j.resolve(out);
          } catch (e) {
            await c.run("ROLLBACK").catch(() => {});
            j.reject(e);
          }
        }
      }
    }
    // Cleared in the same tick the queue is seen empty: a write resolved above
    // may queue the next one before a .finally() callback would run.
    this.draining = null;
  }

  /**
   * DuckDB refuses a CHECKPOINT while a read transaction older than the last
   * write is open (FORCE would instead stall every new read until it ends).
   * Reads are short, so retry for a while, each try queued as its own write.
   */
  async checkpoint(retries = 40) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.write(async (c) => {
          await c.run("CHECKPOINT");
          this.dirty = false;
        }, "raw");
      } catch (e) {
        if (attempt >= retries || !/Cannot CHECKPOINT/.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** Drain queued writes, checkpoint, and release the file. */
  async close() {
    if (this.closed) return;
    // Let everything already queued commit first.
    await this.write(async (c) => {
      await c.run("CHECKPOINT");
    }, "raw").catch(() => {});
    this.closed = true;
    for (const c of this.readers) c.closeSync();
    this.writer.closeSync();
    this.instance.closeSync();
  }
}
