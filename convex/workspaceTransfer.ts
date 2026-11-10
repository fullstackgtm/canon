/**
 * Export one workspace to an archive (docs/self-hosting.md, "Export a workspace"). An admin creates an export key in
 * Settings; `canon workspace export` presents it to /api/v1/workspace/export, which calls the functions below. The key
 * names its workspace, so no caller can point an export anywhere else, and every read re-checks that the admin who
 * created it still may export. An agent never creates one: export is a person's decision.
 *
 * `exportPage` is the one reader of workspace rows for archives. It reads only tables the registry
 * (lib/workspaceArchive/tables.ts) exports, through the index that scopes each one, and refuses any row whose own
 * workspace field names another workspace.
 */
import { ConvexError, v } from "convex/values";
import { action, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { agentClientOf, getCurrentUser, requireCap, withRole } from "./lib";
import { can } from "./lib/capabilities";
import { credentialMember } from "./lib/membership";
import { REGISTER_SECTIONS, entryOf, exportOrder, exported, type ArchiveEntry, type ArchiveScope, type RegisterSection } from "./lib/workspaceArchive/tables";
import { emptyStats, encodeRow, encodeValue, type RowStats, type ValidatorShape } from "./lib/workspaceArchive/rows";
import { registerCounts, registerPage, registerService } from "./lib/workspaceArchive/register";
import { recordClient } from "./lib/recordClient";

const KEY_TTL_MS = 60 * 60 * 1000;
const KEY_RE = /^cwx_[A-Za-z0-9_-]{43}$/;
const PAGE_MAX = 512;
const PARENTS_MAX = 50;
const PER_PARENT_MAX = 100;
const BATCH_BYTES = 4_000_000;

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `cwx_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** The member's role in `orgId` with their workspace role's capabilities, or null when they aren't an active member. */
async function memberIn(ctx: QueryCtx, user: Doc<"users">, orgId: Id<"organizations">) {
  if (!user.isActive) return null;
  return withRole(ctx, await credentialMember(ctx, user, orgId));
}

/** The workspace a key exports and the admin who created it. Every archive read starts here. */
async function exportCaller(ctx: QueryCtx, key: string) {
  const refused = new ConvexError("This export key is unknown or has expired. Create a new one in Settings > Workspace.");
  if (!KEY_RE.test(key)) throw refused;
  const keyHash = await sha256Hex(key);
  const row = await ctx.db.query("workspaceExportKeys").withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash)).unique();
  if (!row || row.expiresAt <= Date.now()) throw refused;
  const user = await ctx.db.get(row.userId);
  const member = user ? await memberIn(ctx, user, row.orgId) : null;
  if (!user || !member || !can(member, "workspace.transfer")) throw new ConvexError("The admin who created this export key can no longer export the workspace.");
  const org = await ctx.db.get(row.orgId);
  if (!org) throw refused;
  return { orgId: row.orgId, user, org, expiresAt: row.expiresAt };
}

export const createExportKey = mutation({
  args: {},
  handler: async (ctx) => {
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person exports a workspace; an admin creates the export key in Settings.");
    const user = await requireCap(ctx, "workspace.transfer");
    for (const old of await ctx.db.query("workspaceExportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(20)) await ctx.db.delete(old._id);
    const key = newKey();
    const now = Date.now();
    await ctx.db.insert("workspaceExportKeys", { orgId: user.orgId, userId: user._id, keyHash: await sha256Hex(key), createdAt: now, expiresAt: now + KEY_TTL_MS });
    return { key, expiresAt: now + KEY_TTL_MS };
  },
});

export const revokeExportKey = mutation({
  args: {},
  handler: async (ctx) => {
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person manages export keys.");
    const user = await requireCap(ctx, "workspace.transfer");
    for (const old of await ctx.db.query("workspaceExportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(20)) await ctx.db.delete(old._id);
    return null;
  },
});

/** The live export key's expiry, for Settings. Null for anyone who can't export. */
export const exportKeyStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "workspace.transfer") || (await agentClientOf(ctx))) return null;
    const row = await ctx.db.query("workspaceExportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).first();
    return { canExport: true, expiresAt: row && row.expiresAt > Date.now() ? row.expiresAt : null };
  },
});

type Tables = typeof schema.tables;
const validatorOf = (table: string) => (schema.tables as Record<string, Tables[keyof Tables]>)[table].validator as unknown as ValidatorShape;
const hasField = (table: string, field: string) => {
  const shape = validatorOf(table);
  return shape.kind === "object" && field in (shape as { fields: Record<string, unknown> }).fields;
};
const orgIndexOf = (table: string) =>
  ((schema.tables as Record<string, unknown>)[table] as { indexes: { indexDescriptor: string; fields: string[] }[] }).indexes.find((i) => i.fields[0] === "orgId")?.indexDescriptor ?? null;

type Row = Record<string, unknown> & { _id: string; _creationTime: number };
type Page = { page: Row[]; isDone: boolean; continueCursor: string };
/** The few query methods this reads with, over any table: the registry and its test pin the table and index names. */
type LooseQuery = {
  withIndex(index: string, range: (q: { eq(field: string, value: unknown): unknown }) => unknown): LooseQuery;
  paginate(opts: { numItems: number; cursor: string | null }): Promise<Page>;
  take(n: number): Promise<Row[]>;
};
const rowsOf = (ctx: QueryCtx, table: string) => ctx.db.query(table as TableNames) as unknown as LooseQuery;
type Eq = { eq(field: string, value: unknown): Eq };
const byScope = (ctx: QueryCtx, table: string, index: string, field: string, value: unknown, orgId?: string) =>
  rowsOf(ctx, table).withIndex(index, (q) => (orgId === undefined ? q.eq(field, value) : (q.eq(field, value) as Eq).eq("orgId", orgId)));

/** Whether a member row belongs to the workspace: its home, or an active membership. */
async function isMember(ctx: QueryCtx, orgId: Id<"organizations">, userId: string) {
  const id = ctx.db.normalizeId("users", userId);
  const user = id ? await ctx.db.get(id) : null;
  if (!user) return false;
  if (user.orgId === orgId) return true;
  const m = await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", user._id).eq("orgId", orgId)).first();
  return Boolean(m?.isActive);
}

/** Whether `id` is a row of `table` the workspace's archive carries, walking parents up to a workspace-scoped table. */
async function inWorkspace(ctx: QueryCtx, orgId: Id<"organizations">, table: string, id: string, depth = 0): Promise<boolean> {
  const entry = entryOf(table);
  if (!exported(entry) || depth > 4) return false;
  const scope = entry.scope;
  if (scope.by === "members") return isMember(ctx, orgId, id);
  if (scope.by === "self") return id === orgId;
  const normalized = ctx.db.normalizeId(table as TableNames, id);
  const row = normalized ? ((await ctx.db.get(normalized)) as Row | null) : null;
  if (!row) return false;
  if (scope.by === "org") return row[scope.field ?? "orgId"] === orgId;
  return typeof row[scope.via] === "string" && inWorkspace(ctx, orgId, scope.parent, row[scope.via] as string, depth + 1);
}

/** A row the scope read that names another workspace is a broken index or registry entry: stop the export, never ship it. */
function assertOwn(table: string, scope: ArchiveScope, row: Row, orgId: string) {
  const field = scope.by === "org" ? (scope.field ?? "orgId") : scope.by === "self" ? "_id" : scope.by === "members" ? null : "orgId";
  if (field === null || (field === "orgId" && !hasField(table, "orgId"))) return;
  if (row[field] !== orgId) throw new ConvexError(`Export stopped: a ${table} row read for this workspace belongs to another one.`);
}

/** The workspace's members, home first and then those who joined through orgMemberships, as the users section. */
async function memberPage(ctx: QueryCtx, orgId: Id<"organizations">, cursor: string | null, numItems: number): Promise<{ rows: Row[]; cursor: string | null }> {
  const at = cursor ? (JSON.parse(cursor) as { phase: "home" | "joined"; c: string | null }) : { phase: "home" as const, c: null };
  const manager = async (row: Row) => (typeof row.managerId === "string" && (await isMember(ctx, orgId, row.managerId)) ? row.managerId : undefined);
  if (at.phase === "home") {
    const p = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems, cursor: at.c });
    const rows = await Promise.all(p.page.map(async (u) => ({ ...u, managerId: await manager(u as unknown as Row) }) as unknown as Row));
    return { rows, cursor: JSON.stringify(p.isDone ? { phase: "joined", c: null } : { phase: "home", c: p.continueCursor }) };
  }
  const p = await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems, cursor: at.c });
  const rows: Row[] = [];
  for (const m of p.page) {
    const user = m.isActive ? await ctx.db.get(m.userId) : null;
    if (!user || user.orgId === orgId) continue;
    rows.push({ ...user, role: m.role, managerId: await manager(user as unknown as Row) } as unknown as Row);
  }
  return { rows, cursor: p.isDone ? null : JSON.stringify({ phase: "joined", c: p.continueCursor }) };
}

/**
 * One page of one exported table. A child table is read per parent: `parents` takes up to 50 parent ids the archive
 * already holds and answers their rows, naming in `pending` the parents with more than 100 rows (page those alone with
 * `parentId` and `cursor`) and in `rest` the parents a full batch left for the next call.
 */
export const exportPage = query({
  args: {
    key: v.string(),
    section: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    parents: v.optional(v.array(v.string())),
    parentId: v.optional(v.string()),
    countOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { orgId } = await exportCaller(ctx, args.key);
    const entry = entryOf(args.section);
    if (!exported(entry)) throw new ConvexError(`${args.section} is not an archive section.`);
    const scope = entry.scope;
    const numItems = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.numItems ?? 128)));
    let rows: Row[] = [];
    let cursor: string | null = null;
    const pending: string[] = [];
    let rest: string[] = [];
    if (scope.by === "self") {
      rows = args.cursor ? [] : [(await ctx.db.get(orgId)) as unknown as Row];
    } else if (scope.by === "members") {
      ({ rows, cursor } = await memberPage(ctx, orgId, args.cursor ?? null, numItems));
    } else if (scope.by === "org") {
      const p = await byScope(ctx, args.section, scope.index, scope.field ?? "orgId", orgId).paginate({ numItems, cursor: args.cursor ?? null });
      rows = p.page;
      cursor = p.isDone ? null : p.continueCursor;
    } else if (args.parentId !== undefined) {
      if (!(await inWorkspace(ctx, orgId, scope.parent, args.parentId))) throw new ConvexError(`${args.parentId} is not a ${scope.parent} row of this workspace.`);
      const p = await byScope(ctx, args.section, scope.index, scope.via, args.parentId, scope.andOrg ? orgId : undefined).paginate({ numItems, cursor: args.cursor ?? null });
      rows = p.page;
      cursor = p.isDone ? null : p.continueCursor;
    } else {
      const parents = args.parents ?? [];
      if (parents.length > PARENTS_MAX) throw new ConvexError(`Send at most ${PARENTS_MAX} parents at a time.`);
      let bytes = 0;
      for (const [i, parentId] of parents.entries()) {
        if (bytes > BATCH_BYTES) { rest = parents.slice(i); break; }
        if (!(await inWorkspace(ctx, orgId, scope.parent, parentId))) throw new ConvexError(`${parentId} is not a ${scope.parent} row of this workspace.`);
        const children = await byScope(ctx, args.section, scope.index, scope.via, parentId, scope.andOrg ? orgId : undefined).take(PER_PARENT_MAX + 1);
        if (children.length > PER_PARENT_MAX) { pending.push(parentId); continue; }
        rows.push(...children);
        bytes += children.reduce((n, r) => n + JSON.stringify(r).length, 0);
      }
    }
    for (const row of rows) assertOwn(args.section, scope, row, orgId);
    if (args.countOnly) return { count: rows.length, cursor, pending, rest };
    const stats = emptyStats();
    const resolve = (id: string, tables: readonly string[]) =>
      tables.find((t) => (t === "_storage" ? tables.length === 1 : ctx.db.normalizeId(t as TableNames, id) !== null)) ?? null;
    const opts = { omit: entry.omit, pick: entry.pick };
    const lines = rows.map((row) => encodeRow(validatorOf(args.section), row, resolve, stats, opts));
    return { count: rows.length, rows: lines, ids: rows.map((r) => r._id), cursor, pending, rest, stats };
  },
});

/** What an archive of the key's workspace holds, in the order to read it, and what it deliberately leaves out. */
export const exportPlan = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const { orgId, org, user, expiresAt } = await exportCaller(ctx, args.key);
    const sections = exportOrder().map((table) => {
      const scope = (entryOf(table) as Extract<ArchiveEntry, { scope: ArchiveScope }>).scope;
      return { name: table, ...(scope.by === "parent" ? { parent: scope.parent } : {}) };
    });
    const notExported = [];
    for (const table of Object.keys(schema.tables)) {
      const entry = entryOf(table);
      if (exported(entry)) continue;
      const cls = entry ? (entry.class === "data" || entry.class === "ledger" ? "needs-index" : entry.class) : "operator";
      const why = !entry ? "Canon's operator tables (convex/lib/operatorTables.ts) hold no workspace's rows" : "rebuiltBy" in entry ? `rebuilt by ${entry.rebuiltBy}` : "why" in entry ? entry.why : "scope" in entry && entry.scope.by === "needsIndex" ? `left out until the index ${entry.scope.index} exists` : undefined;
      const index = entry && (entry.class === "secret" || entry.class === "identity") ? orgIndexOf(table) : null;
      const counted = index ? await byScope(ctx, table, index, "orgId", orgId).take(101) : null;
      notExported.push({ table, class: cls, ...(why ? { why } : {}), ...(counted ? (counted.length > 100 ? { atLeast: 100 } : { count: counted.length }) : {}) });
    }
    return {
      workspace: { id: orgId, name: org.name, slug: org.slug },
      exportedBy: user.email,
      expiresAt,
      sourceKind: process.env.CANON_AUTH === "local" ? ("selfhost" as const) : ("hosted" as const),
      sections,
      registerSections: [...REGISTER_SECTIONS],
      notExported,
    };
  },
});

export const keyWorkspace = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => (await exportCaller(ctx, args.key)).orgId,
});

/** The register's contract and row counts, from the record service; `mode: "convex"` when the register is the fakeRecord* tables. */
export const exportRegisterInfo = action({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ mode: "service" | "convex"; contract: string | null; counts: Record<RegisterSection, number> | null }> => {
    const orgId: string = await ctx.runQuery(internal.workspaceTransfer.keyWorkspace, { key: args.key });
    const service = registerService(process.env);
    if (!service) return { mode: "convex", contract: null, counts: null };
    return { mode: "service", contract: await recordClient({ env: process.env }).contractVersion(), counts: await registerCounts(service, orgId) };
  },
});

/** One page of the register from the record service, every stored column, keyed by `id` (field history by `seq`). */
export const exportRegister = action({
  args: { key: v.string(), section: v.union(...REGISTER_SECTIONS.map((s) => v.literal(s))), after: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ count: number; rows: string[]; next: string | null; stats: RowStats }> => {
    const orgId: string = await ctx.runQuery(internal.workspaceTransfer.keyWorkspace, { key: args.key });
    const service = registerService(process.env);
    const stats = emptyStats();
    if (!service) return { count: 0, rows: [], next: null, stats };
    const page = await registerPage(service, orgId, args.section, args.after, Math.max(1, Math.min(2000, Math.floor(args.limit ?? 500))));
    const rows = page.rows.map((row) => { stats.rows++; return JSON.stringify(encodeValue({ kind: "any" }, row, () => null, stats)); });
    return { count: rows.length, rows, next: page.next, stats };
  },
});

