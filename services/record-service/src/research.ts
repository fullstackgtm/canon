// Prepared imports have no workspace id and live outside Registry's ws directory.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrepareResearchBody, type ResearchCommitResult } from "./contract.ts";
import { HttpError } from "./errors.ts";
import type { Registry } from "./registry.ts";
import { upsertAccounts } from "./upsert.ts";

type Prepared = PrepareResearchBody & {
  digest: string;
  org?: string;
  offset: number;
  importedAccounts: number;
  total: number;
};
const BATCH = 500;
const TTL = 7 * 24 * 60 * 60 * 1000;

export class ResearchImports {
  private readonly dir: string;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(dataDir: string) { this.dir = join(dataDir, "research"); }

  private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = this.pending.get(id) ?? Promise.resolve();
    const job = before.catch(() => {}).then(fn);
    this.pending.set(id, job);
    try { return await job; }
    finally { if (this.pending.get(id) === job) this.pending.delete(id); }
  }

  private async load(id: string): Promise<Prepared | null> {
    try { return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  private async save(id: string, value: Prepared) {
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `${id}.${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, join(this.dir, `${id}.json`));
    const dir = await open(this.dir, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }

  async prepare(body: PrepareResearchBody) {
    return this.exclusive(body.sessionId, async () => {
      const now = Date.now();
      if (body.expiresAt <= now || body.expiresAt > now + TTL) throw new HttpError(410, "research session expired or invalid expiry");
      const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const prior = await this.load(body.sessionId);
      if (prior) {
        if (prior.expiresAt <= now) throw new HttpError(410, "research session expired");
        if (prior.digest !== digest) throw new HttpError(409, "research preparation is immutable");
        return { total: prior.total };
      }
      await this.save(body.sessionId, { ...body, digest, offset: 0, importedAccounts: 0, total: body.records.length });
      return { total: body.records.length };
    });
  }

  async commit(sessionId: string, org: string, registry: Registry): Promise<ResearchCommitResult> {
    return this.exclusive(sessionId, async () => {
      const state = await this.load(sessionId);
      if (!state || state.expiresAt <= Date.now()) throw new HttpError(410, "research session expired or not prepared");
      if (state.org && state.org !== org) throw new HttpError(409, "research session belongs to another workspace");
      if (!state.org) {
        state.org = org;
        // Persist the binding before the first workspace write, including across crashes.
        await this.save(sessionId, state);
      }
      if (state.offset < state.total) {
        const records = state.records.slice(state.offset, state.offset + BATCH);
        await registry.provision(org);
        const result = await registry.with(org, (ws) => upsertAccounts(ws, {
          records, source: state.source, fill: "missing",
          idempotencyKey: `research:${sessionId}:${state.offset}`,
        }));
        if (result.rejected.length) throw new HttpError(409, "research account batch rejected");
        state.offset += records.length;
        state.importedAccounts += result.upserted;
      }
      const done = state.offset === state.total;
      // Keep only a small retry receipt once the records are attached.
      if (done) state.records = [];
      await this.save(sessionId, state);
      return { importedAccounts: state.importedAccounts, total: state.total, done };
    });
  }

  async expire() {
    let files: string[];
    try { files = await readdir(this.dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const name of files) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      await this.exclusive(id, async () => {
        const state = await this.load(id);
        if (state && state.expiresAt <= Date.now()) await rm(join(this.dir, name), { force: true });
      });
    }
  }
}
