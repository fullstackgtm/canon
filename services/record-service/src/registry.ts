// Per-workspace registry: lazily opens /data/ws/{wsId}.duckdb, keeps at most
// maxOpen open (LRU), and never closes a workspace that has requests in flight.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ID_RE } from "./contract.ts";
import { HttpError } from "./errors.ts";
import { metrics } from "./metrics.ts";
import { Workspace, type WorkspaceOptions } from "./workspace.ts";

type Entry = { ws: Promise<Workspace>; refs: number; lastUsed: number };

export class Registry {
  private open = new Map<string, Entry>();
  private closing = new Map<string, Promise<void>>();
  private shuttingDown = false;
  readonly wsDir: string;

  readonly dataDir: string;
  readonly maxOpen: number;
  readonly opts: WorkspaceOptions;
  constructor(dataDir: string, maxOpen: number, opts: WorkspaceOptions) {
    this.dataDir = dataDir;
    this.maxOpen = maxOpen;
    this.opts = opts;
    this.wsDir = join(dataDir, "ws");
    mkdirSync(this.wsDir, { recursive: true });
    metrics.openWorkspaces.bind(() => this.open.size);
  }

  get openCount() {
    return this.open.size;
  }

  /** Validates the id and returns the file path. Rejects anything that could escape the directory. */
  pathFor(wsId: string) {
    if (!WORKSPACE_ID_RE.test(wsId)) throw new HttpError(400, "invalid workspace id");
    return join(this.wsDir, `${wsId}.duckdb`);
  }

  exists(wsId: string) {
    return existsSync(this.pathFor(wsId));
  }

  /** Creates the workspace file if needed. Returns whether it was created. */
  async provision(wsId: string): Promise<boolean> {
    const existed = this.exists(wsId) || this.open.has(wsId);
    await this.with(wsId, async () => {}, true);
    return !existed;
  }

  async with<T>(wsId: string, fn: (ws: Workspace) => Promise<T>, create = false): Promise<T> {
    if (this.shuttingDown) throw new HttpError(503, "shutting down");
    const path = this.pathFor(wsId);
    let e = this.open.get(wsId);
    // A just-evicted workspace must finish closing before its file is reopened.
    while (!e && this.closing.has(wsId)) {
      await this.closing.get(wsId);
      e = this.open.get(wsId);
    }
    if (!e) {
      if (!create && !existsSync(path)) throw new HttpError(404, "workspace not provisioned");
      e = { ws: Workspace.open(wsId, path, this.opts), refs: 0, lastUsed: Date.now() };
      this.open.set(wsId, e);
      e.ws.catch(() => this.open.delete(wsId));
    }
    e.refs++;
    e.lastUsed = Date.now();
    try {
      return await fn(await e.ws);
    } finally {
      e.refs--;
      this.evict();
    }
  }

  private evict() {
    if (this.open.size <= this.maxOpen) return;
    const idle = [...this.open.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, e] of idle) {
      if (this.open.size <= this.maxOpen) break;
      this.open.delete(id);
      metrics.evictions.inc();
      const p = e.ws.then((w) => w.close()).catch((err) => console.error(JSON.stringify({ msg: "close failed", ws: id, err: String(err) })));
      this.closing.set(id, p);
      void p.finally(() => this.closing.delete(id));
    }
  }

  /**
   * Close and delete a workspace's files (database + WAL). Refuses while it
   * has requests in flight. Backups in object storage are kept on purpose, so
   * a mistaken delete can still be restored.
   */
  async remove(wsId: string): Promise<boolean> {
    const path = this.pathFor(wsId);
    const e = this.open.get(wsId);
    if (e) {
      if (e.refs > 0) throw new HttpError(409, "workspace has requests in flight; retry");
      this.open.delete(wsId);
      await e.ws.then((w) => w.close()).catch(() => {});
    }
    while (this.closing.has(wsId)) await this.closing.get(wsId);
    const existed = existsSync(path);
    for (const f of [path, `${path}.wal`]) rmSync(f, { force: true });
    return existed;
  }

  /** Checkpoint every open workspace that has written since its last checkpoint. */
  async checkpointDirty() {
    for (const [id, e] of this.open) {
      const ws = await e.ws.catch(() => null);
      if (!ws?.dirty) continue;
      try {
        await ws.checkpoint();
        metrics.checkpoints.inc();
      } catch (err) {
        console.error(JSON.stringify({ msg: "checkpoint failed", ws: id, err: String(err) }));
      }
    }
  }

  /** Stop accepting work, drain every queue, checkpoint and close all files. */
  async closeAll() {
    this.shuttingDown = true;
    const entries = [...this.open.values()];
    this.open.clear();
    await Promise.all(entries.map(async (e) => (await e.ws.catch(() => null))?.close()));
    await Promise.all(this.closing.values());
  }
}
