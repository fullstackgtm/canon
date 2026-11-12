/**
 * Load Convex modules for an in-process test: every relative import is the
 * real source, transpiled; `_generated/server` registers a function as its
 * definition (a test calls `.handler(ctx, args)`), and `_generated/api`
 * references read as their path ("internal.records.callerContext").
 * `overrides` replace a module (by its path under convex/) with a function of
 * the real one. `globals` replace sandbox globals, such as a `Date` frozen at one instant. `memoryDb` stands in for
 * Convex tables.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as convexAuthServer from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";

const nodeRequire = createRequire(import.meta.url);
const CONVEX = resolve(dirname(fileURLToPath(import.meta.url)), "../convex");
const register = (definition: unknown) => definition;
const server = new Proxy({}, { get: () => register });
const ref = (path: string[]): unknown =>
  new Proxy({}, { get: (_t, k) => (k === Symbol.toPrimitive || k === "toString" ? () => path.join(".") : typeof k === "symbol" ? undefined : ref([...path, k])) });
const api = { api: ref(["api"]), internal: ref(["internal"]), components: ref(["components"]) };

export type Handler = { handler: (ctx: any, args: any) => Promise<any> };
type Module = Record<string, unknown>;

export function loadConvex(files: readonly string[], overrides: Record<string, (real: Module) => Module> = {}, globals: Record<string, unknown> = {}): Record<string, Record<string, Handler>> {
  const cache = new Map<string, Module>();
  const load = (path: string): Module => {
    const hit = cache.get(path);
    if (hit) return hit;
    const exports: Module = {};
    cache.set(path, exports);
    const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const req = (id: string) => {
      if (id.endsWith("_generated/server")) return server;
      if (id.endsWith("_generated/api")) return api;
      if (id === "@convex-dev/auth/server") return convexAuthServer;
      if (id === "@convex-dev/auth/providers/Password") return { Password };
      if (id === "@auth/core/providers/google") return { default: Google };
      if (id === "@auth/core/providers/resend") return { default: Resend };
      if (!id.startsWith(".")) return nodeRequire(id);
      const base = resolve(dirname(path), id);
      const target = [base, `${base}.ts`, `${base}/index.ts`].find((p) => p.endsWith(".ts") && existsSync(p));
      return target ? load(target) : nodeRequire(base);
    };
    runInNewContext(outputText, { exports, module: { exports }, require: req, process, console, URL, TextEncoder, TextDecoder, crypto, setTimeout, clearTimeout, structuredClone, fetch, AbortSignal, Blob, Request, Response, Headers, atob, btoa, ...globals }, { filename: path });
    const override = overrides[relative(CONVEX, path)];
    if (override) {
      const replaced = override({ ...exports });
      for (const k of Object.keys(exports)) delete exports[k];
      Object.assign(exports, replaced);
    }
    return exports;
  };
  return Object.fromEntries(files.map((f) => [f, load(resolve(CONVEX, f)) as Record<string, Handler>]));
}

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

/** Convex tables in memory: get, normalizeId, writes, and index reads by equality (`withIndex(name, q => q.eq(...))`). */
export function memoryDb(tables: Record<string, Array<Record<string, unknown>>>) {
  let clock = 0;
  const rows = new Map<string, { table: string; row: Row }>();
  const put = (table: string, r: Record<string, unknown>) => {
    const row = { _creationTime: ++clock, ...r } as Row;
    rows.set(row._id, { table, row });
    return row._id;
  };
  for (const [table, list] of Object.entries(tables)) for (const r of list) put(table, r);
  const query = (table: string) => {
    const where: Array<[string, unknown]> = [];
    const ranges: Array<(row: Row) => boolean> = [];
    let desc = false;
    // An index field may be a nested path ("subject.contactId").
    const at = (row: Row, k: string) => k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], row);
    const all = () => [...rows.values()].filter((x) => x.table === table && where.every(([k, v]) => at(x.row, k) === v) && ranges.every((r) => r(x.row))).map((x) => x.row)
      .sort((a, b) => (desc ? b._creationTime - a._creationTime : a._creationTime - b._creationTime));
    const chain = {
      withIndex(_name: string, fn?: (q: unknown) => unknown) {
        const range = (test: (a: number, b: number) => boolean) => (k: string, v: number) => (ranges.push((row) => test(at(row, k) as number, v)), q);
        const q = { eq: (k: string, v: unknown) => (where.push([k, v]), q), gt: range((a, b) => a > b), gte: range((a, b) => a >= b), lt: range((a, b) => a < b), lte: range((a, b) => a <= b) };
        fn?.(q);
        return chain;
      },
      order(dir: "asc" | "desc") { desc = dir === "desc"; return chain; },
      take: async (n: number) => all().slice(0, n),
      first: async () => all()[0] ?? null,
      unique: async () => all()[0] ?? null,
      collect: async () => all(),
      // As Convex's: a cursor is a position in the index (the last row's), so rows deleted before it move nothing.
      paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
        const list = all();
        const at = cursor ? (JSON.parse(cursor) as { t: number; id: string }) : null;
        const found = at ? list.findIndex((r) => r._id === at.id) : -1;
        const start = !at ? 0 : found >= 0 ? found + 1 : list.findIndex((r) => (desc ? r._creationTime < at.t : r._creationTime > at.t));
        const rest = start < 0 ? [] : list.slice(start);
        const page = rest.slice(0, numItems);
        const last = page.at(-1);
        return { page, isDone: numItems >= rest.length, continueCursor: last ? JSON.stringify({ t: last._creationTime, id: last._id }) : cursor ?? "" };
      },
      async *[Symbol.asyncIterator]() { yield* all(); },
    };
    return chain;
  };
  return {
    rows: (table: string) => [...rows.values()].filter((x) => x.table === table).map((x) => x.row),
    /** Every row as it stands, to put back if a mutation throws: Convex rolls a failed mutation back whole. */
    checkpoint: () => ({ clock, entries: [...rows].map(([id, x]) => [id, { table: x.table, row: structuredClone(x.row) }] as const) }),
    rollback: (cp: { clock: number; entries: ReadonlyArray<readonly [string, { table: string; row: Row }]> }) => {
      rows.clear();
      for (const [id, x] of cp.entries) rows.set(id, { table: x.table, row: structuredClone(x.row) });
      clock = cp.clock;
    },
    get: async (id: string) => rows.get(id)?.row ?? null,
    normalizeId: (table: string, id: string) => (rows.get(id)?.table === table ? id : null),
    query,
    insert: async (table: string, doc: Record<string, unknown>) => put(table, { _id: `${table}:${clock + 1}`, ...doc }),
    patch: async (id: string, patch: Record<string, unknown>) => { const x = rows.get(id); if (x) Object.assign(x.row, patch); },
    replace: async (id: string, doc: Record<string, unknown>) => { const x = rows.get(id); if (x) x.row = { _id: id, _creationTime: x.row._creationTime, ...doc }; },
    delete: async (id: string) => { rows.delete(id); },
  };
}
