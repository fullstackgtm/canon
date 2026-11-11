/**
 * Import an archive into an empty workspace (docs/workspace-export.md, "Import a workspace"). An admin creates an import
 * key in Settings; `canon workspace import` presents it to /api/v1/workspace/import, which calls the functions below a
 * page at a time. The key names its workspace, so nothing in the file chooses where rows go.
 *
 * Every archived row passes through `writeRow`, the one writer: it writes only tables lib/workspaceArchive/importRows.ts
 * imports, only into the key's workspace, only rows decodeRow checked against this schema with every id remapped. The
 * ledger is replayed through the object layer's appendHistory, which rebuilds hot rows, unique claims and proposals;
 * edges and deal history are rebuilt from it. Facts arrive as rows and each field's state is resolved again; `finish`
 * asks for a rescore against the imported ICPs. A row that needs what isn't imported, or a module not installed here,
 * is left out and counted. A module's rows go to the module installed here with that id, or wait in moduleHeldRows
 * until it is installed (`restoreHeld`). Ids in the file are never ids here: the id map is workspaceImportIds.
 *
 * Nothing sends or acts after an import until a person turns it on here: writeRow applies each table's arrival
 * (lib/workspaceArchive/actors.ts) to every row, and `finish` refuses while any switch the archive could bring is open.
 *
 * Hosted deployments keep import switched off (`importEnabled`) until a dry-run screen and a proof on dev exist.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { agentClientOf, getCurrentUser, requireCap, withRole } from "./lib";
import { can } from "./lib/capabilities";
import { credentialMember } from "./lib/membership";
import { entryOf, exported, REGISTER_SECTIONS, type RegisterSection } from "./lib/workspaceArchive/tables";
import { decodeRow, foreignLabel, idsIn, importOrder, IMPORT_TABLES, moduleOf, registerIdOf, SELF, SKIPPED, secondPassOf, shapeOf, type Decoded, type RemapEnv, type Shape, type Unmapped } from "./lib/workspaceArchive/importRows";
import { contractAtLeast, REGISTER_IMPORT_VERSION, registerCounts, registerImport, registerService } from "./lib/workspaceArchive/register";
import { recordClient } from "./lib/recordClient";
import { convexObjectStore, asEntry } from "./objects";
import { edgeStore } from "./associations";
import { appendHistory } from "./lib/objects/write";
import { loadOrgObject } from "./lib/objects/orgDefs";
import { ASSOCIATION_OBJECT, associationObjectDef, edgeOf } from "./lib/objects/registry";
import { project } from "./lib/objects/fold";
import { shardOf } from "./lib/objects/write";
import { subjectKey } from "./lib/signals/observations";
import { convexLedgerStore } from "./canon";
import { resolveAttribute } from "./lib/canon/policy";
import { invalidateFit } from "./lib/fitInvalidation";
import { shardHeads } from "./ledgerFeed";
import { arrive, CENSUS, type ArrivalAt, type Mechanism, type Switch } from "./lib/workspaceArchive/actors";
import { restoreImportedDocs } from "./lib/modules/scope";
import { enabledModules, installedModule, isEnabled, manifestOf } from "./lib/modules/packages";
import { setModuleEnabled } from "./modules";

const KEY_TTL_MS = 60 * 60 * 1000;
const KEY_RE = /^cwi_[A-Za-z0-9_-]{43}$/;
/** Rows one import mutation writes: the repo's import batch (convex/objects.ts MAX_IMPORT_BATCH). */
export const IMPORT_PAGE_MAX = 100;
const USERS_MAX = 200;
const REPLACE_MAX = 500;
const REFUSALS_SHOWN = 10;
/** Rows read per switch when proving the gates closed: more than any workspace's rules, plans or launches. */
const GATE_SCAN = 2000;
/** Held module rows restored per mutation, as an import page writes. */
const HELD_BATCH = 100;

/** Import is on for a self-hosted install and a local stack; a hosted deployment turns it on with CANON_WORKSPACE_IMPORT=on. */
export const importEnabled = () => process.env.CANON_AUTH === "local" || process.env.CANONCRM_LOCAL_STACK === "true" || process.env.CANON_WORKSPACE_IMPORT === "on";

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `cwi_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** The workspace a key imports into and the admin who created it. Every import call starts here. */
async function importCaller(ctx: QueryCtx, key: string) {
  if (!importEnabled()) throw new ConvexError("Importing a workspace is not switched on for this deployment.");
  const refused = new ConvexError("This import key is unknown or has expired. Create a new one in Settings > Workspace.");
  if (!KEY_RE.test(key)) throw refused;
  const keyHash = await sha256Hex(key);
  const row = await ctx.db.query("workspaceImportKeys").withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash)).unique();
  if (!row || row.expiresAt <= Date.now()) throw refused;
  const user = await ctx.db.get(row.userId);
  const member = user && user.orgId === row.orgId ? await withRole(ctx, await credentialMember(ctx, user, row.orgId)) : null;
  if (!user || !member || !can(member, "workspace.transfer")) throw new ConvexError("The admin who created this import key can no longer import into the workspace.");
  return { orgId: row.orgId, user };
}

export const createImportKey = mutation({
  args: {},
  handler: async (ctx) => {
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person imports a workspace; an admin creates the import key in Settings.");
    if (!importEnabled()) throw new ConvexError("Importing a workspace is not switched on for this deployment.");
    const user = await requireCap(ctx, "workspace.transfer");
    for (const old of await ctx.db.query("workspaceImportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(20)) await ctx.db.delete(old._id);
    const key = newKey();
    const now = Date.now();
    await ctx.db.insert("workspaceImportKeys", { orgId: user.orgId, userId: user._id, keyHash: await sha256Hex(key), createdAt: now, expiresAt: now + KEY_TTL_MS });
    return { key, expiresAt: now + KEY_TTL_MS };
  },
});

export const revokeImportKey = mutation({
  args: {},
  handler: async (ctx) => {
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person manages import keys.");
    const user = await requireCap(ctx, "workspace.transfer");
    for (const old of await ctx.db.query("workspaceImportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(20)) await ctx.db.delete(old._id);
    return null;
  },
});

/** The live import key's expiry, for Settings. Null for anyone who can't import, or where import is off. */
export const importKeyStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!importEnabled() || !user || !can(user, "workspace.transfer") || (await agentClientOf(ctx))) return null;
    const row = await ctx.db.query("workspaceImportKeys").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).first();
    return { canImport: true, expiresAt: row && row.expiresAt > Date.now() ? row.expiresAt : null };
  },
});

type Tables = typeof schema.tables;
const shapes = new Map<string, Shape>();
const shapeOfTable = (table: string): Shape => {
  if (!shapes.has(table)) shapes.set(table, shapeOf((schema.tables as Record<string, Tables[keyof Tables]>)[table].validator as unknown as Record<string, unknown>));
  return shapes.get(table)!;
};
const convexTables = () => Object.keys(IMPORT_TABLES).filter((t) => !t.startsWith("register."));
const scopeFieldOf = (table: string) => {
  const entry = entryOf(table);
  return entry && "scope" in entry && entry.scope.by === "org" ? (entry.scope.field ?? "orgId") : shapeOfTable(table).fields?.orgId ? "orgId" : null;
};
/** A table whose rows carry no workspace field belongs to the workspace through its parent row (`via`). */
const parentOf = (table: string) => {
  const entry = entryOf(table);
  return entry && "scope" in entry && entry.scope.by === "parent" ? { table: entry.scope.parent, via: entry.scope.via } : null;
};

/**
 * What in this workspace would act on records as the import writes them: replayed history must reach no rule or
 * endpoint. A rule fires on entries dated after it started, and an endpoint sends every entry after its cursor, which
 * starts at this empty workspace's heads, so either one made here before or during an import would see the archive.
 */
async function actorsIn(ctx: QueryCtx, orgId: Id<"organizations">, modules = false): Promise<string[]> {
  const why: string[] = [];
  // A module that is on runs its schedules and watches on what the import writes. `begin` turns them all off.
  if (modules) for (const { pkg } of await enabledModules(ctx, orgId)) why.push(`the module ${pkg.moduleId} is on`);
  if (await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active")).first()) why.push("it has an active automation rule");
  if ((await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(20)).some((e) => e.enabled)) why.push("it has a live record webhook");
  return why;
}

/** The modules installed in this workspace: only their rows of the archive are imported. */
async function installedModules(ctx: QueryCtx, orgId: Id<"organizations">): Promise<string[]> {
  return (await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "installed")).take(200)).map((p) => p.moduleId);
}

/** Why the workspace can't take an import: it must be new, with nothing in it but the importing admin. */
async function notEmpty(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<string[]> {
  const why: string[] = [];
  if (await ctx.db.query("canonEntities").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).first()) why.push("it has records");
  else if (await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId)).first()) why.push("it has records");
  if (await ctx.db.query("deals").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).first()) why.push("it has deals");
  if (await ctx.db.query("fakeRecordAccounts").withIndex("by_ws_recordId", (q) => q.eq("ws", orgId)).first()) why.push("its register has companies");
  const members = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(5);
  const joined = (await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(5)).filter((m) => m.isActive && m.userId !== userId);
  if (members.some((m) => m._id !== userId) || joined.length) why.push("it has members other than you");
  return [...why, ...(await actorsIn(ctx, orgId))];
}

/** What the destination is, for the dry run and the import: the schema of each table it writes, its order, its members. */
export const importPlan = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const { orgId, user } = await importCaller(ctx, args.key);
    const org = await ctx.db.get(orgId);
    const tables = convexTables();
    const tableShapes = Object.fromEntries(tables.map((t) => [t, shapeOfTable(t)]));
    const running = await ctx.db.query("workspaceImports").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").first();
    return {
      workspace: { id: orgId, name: org?.name ?? "", slug: org?.slug ?? "" },
      importedBy: { id: user._id, email: user.email },
      order: importOrder(tableShapes),
      shapes: tableShapes,
      secondPass: Object.fromEntries(tables.flatMap((t) => { const p = secondPassOf(t, tableShapes[t]); return p ? [[t, p]] : []; })),
      scopeFields: Object.fromEntries(tables.map((t) => [t, scopeFieldOf(t)])),
      registerMode: registerService(process.env) ? ("service" as const) : ("convex" as const),
      installedModules: await installedModules(ctx, orgId),
      notEmpty: running ? [] : await notEmpty(ctx, orgId, user._id),
      current: running ? { digest: running.digest, status: running.status, progress: running.written } : null,
      gates: running?.status === "done" ? await gatesIn(ctx, orgId) : null,
    };
  },
});

export const callerOf = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const { orgId, user } = await importCaller(ctx, args.key);
    return { orgId, userId: user._id };
  },
});

/** Start (or resume) importing the archive with this digest. Refuses a workspace that isn't empty, or a register it can't write. */
export const begin = action({
  args: { key: v.string(), digest: v.string(), sourceWorkspaceId: v.string(), registerRows: v.number() },
  handler: async (ctx, args): Promise<{ importId: string; status: "running" | "done"; progress: Record<string, number> }> => {
    const { orgId } = await ctx.runQuery(internal.workspaceImport.callerOf, { key: args.key });
    const service = registerService(process.env);
    let registerEmpty = true;
    if (service) {
      const contract = await recordClient({ env: process.env }).contractVersion();
      if (!contractAtLeast(contract, REGISTER_IMPORT_VERSION)) throw new ConvexError(`This deployment's record service (${contract ?? "unknown"}) is older than import needs (${REGISTER_IMPORT_VERSION}). Update it first.`);
      registerEmpty = Object.values(await registerCounts(service, orgId)).every((n) => n === 0);
    } else if (args.registerRows > 0) {
      throw new ConvexError("The archive's register came from a record service, and this deployment has none. Import into a deployment that runs one.");
    }
    return ctx.runMutation(internal.workspaceImport.beginImport, { key: args.key, digest: args.digest, sourceWorkspaceId: args.sourceWorkspaceId, registerEmpty });
  },
});

export const beginImport = internalMutation({
  args: { key: v.string(), digest: v.string(), sourceWorkspaceId: v.string(), registerEmpty: v.boolean() },
  handler: async (ctx, args) => {
    const { orgId, user } = await importCaller(ctx, args.key);
    const latest = await ctx.db.query("workspaceImports").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").first();
    if (latest) {
      if (latest.digest !== args.digest) throw new ConvexError("This workspace already took an import of another archive. Import into a fresh workspace.");
      return { importId: latest._id as string, status: latest.status, progress: latest.written };
    }
    // Every module here arrives off: one that is on would run its schedules and watches on what the import writes.
    // Turned off as a person would, so turning one on again later is the module's normal switch.
    for (const { pkg } of await enabledModules(ctx, orgId)) await setModuleEnabled(ctx, user, { moduleId: pkg.moduleId, enabled: false });
    const why = await notEmpty(ctx, orgId, user._id);
    if (!args.registerEmpty) why.push("its register has rows");
    if (why.length) throw new ConvexError(`Import only goes into a new, empty workspace, and this one isn't: ${why.join("; ")}.`);
    const importId = await ctx.db.insert("workspaceImports", {
      orgId, userId: user._id, digest: args.digest, sourceWorkspaceId: args.sourceWorkspaceId, status: "running", replaced: [], written: {}, startedAt: Date.now(),
    });
    // The archive's workspace is this one: refs to it land here.
    await ctx.db.insert("workspaceImportIds", { orgId, importId, table: "organizations", oldId: args.sourceWorkspaceId, newId: orgId });
    return { importId: importId as string, status: "running" as const, progress: {} };
  },
});

async function running(ctx: QueryCtx, key: string) {
  const { orgId, user } = await importCaller(ctx, key);
  const imp = await ctx.db.query("workspaceImports").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").first();
  if (!imp || imp.status !== "running") throw new ConvexError("No import is running in this workspace. Start it with canon workspace import.");
  return { orgId, user, imp };
}

/** The map entries for the ids a page names. */
async function mapFor(ctx: QueryCtx, importId: Id<"workspaceImports">, ids: Iterable<string>) {
  const map = new Map<string, string>();
  for (const id of ids) {
    const row = await ctx.db.query("workspaceImportIds").withIndex("by_importId_oldId", (q) => q.eq("importId", importId).eq("oldId", id)).first();
    if (row) map.set(id, row.newId);
  }
  return map;
}

const refuse = (problems: readonly Unmapped[]): never => {
  const shown = problems.slice(0, REFUSALS_SHOWN).map((u) => `${u.table}${u.id ? ` ${u.id}` : ""} ${u.field}: ${u.value} (${u.why})`);
  throw new ConvexError(`Import refused ${problems.length} value${problems.length === 1 ? "" : "s"} it can't map, and wrote nothing from this page: ${shown.join("; ")}${problems.length > shown.length ? "; …" : ""}`);
};

/** Rows of `section` consumed so far must be exactly `offset`: pages arrive in order, and a page already taken is skipped. */
function claimPage(imp: Doc<"workspaceImports">, key: string, offset: number, n: number): "write" | "skip" {
  const done = imp.written[key] ?? 0;
  if (offset + n <= done) return "skip";
  if (offset !== done) throw new ConvexError(`${key}: this page starts at row ${offset}, but ${done} rows are imported. Run the import again to resume.`);
  return "write";
}

const optionalFields = (s: Shape): Shape => ({ ...s, fields: Object.fromEntries(Object.entries(s.fields ?? {}).map(([k, f]) => [k, { ...f, optional: true }])) });

/**
 * The one writer of archived rows. Only a table the importer writes, only into the import's workspace, and only a row
 * whose workspace field is that workspace: decodeRow set it, and this checks it again before anything is stored.
 */
async function writeRow(ctx: MutationCtx, imp: Doc<"workspaceImports">, table: string, row: Record<string, unknown>, oldId: string, replacing?: string): Promise<string> {
  const spec = IMPORT_TABLES[table];
  if (!spec || spec.kind === "register" || spec.kind === "module" || !exported(entryOf(table))) throw new ConvexError(`${table} is not a table an import writes.`);
  const scope = scopeFieldOf(table);
  const parent = scope ? null : parentOf(table);
  const parentRow = parent && typeof row[parent.via] === "string" ? await ctx.db.get(row[parent.via] as Id<TableNames>) as Record<string, unknown> | null : null;
  const parentScope = parent ? scopeFieldOf(parent.table) : null;
  const ours = scope ? row[scope] === imp.orgId : !!parentRow && !!parentScope && parentRow[parentScope] === imp.orgId;
  if (!ours) throw new ConvexError(`An imported ${table} row must belong to this workspace.`);
  // A row that can act arrives switched off, whatever the file says.
  if (spec.arrive) row = arrive(table, spec.arrive, row, await arrivalAt(ctx, imp.orgId));
  const self = Object.keys(row).filter((k) => typeof row[k] === "string" && (row[k] as string).startsWith(SELF));
  const doc = { ...row, ...Object.fromEntries(self.map((k) => [k, ""])) };
  let id: string;
  if (replacing) {
    const held = await ctx.db.get(replacing as Id<TableNames>) as Record<string, unknown> | null;
    if (!held || !scope || held[scope] !== imp.orgId) throw new ConvexError(`An imported ${table} row can only replace this workspace's own.`);
    await ctx.db.replace(replacing as Id<TableNames>, doc as never);
    id = replacing;
  } else id = await ctx.db.insert(table as TableNames, doc as never) as string;
  if (self.length) {
    const patch: Record<string, string> = {};
    for (const k of self) patch[k] = (row[k] as string) === SELF ? id : await registerIdOf((row[k] as string).endsWith(":account") ? "account" : "contact", id);
    await ctx.db.patch(id as Id<TableNames>, patch as never);
  }
  await ctx.db.insert("workspaceImportIds", { orgId: imp.orgId, importId: imp._id, table, oldId, newId: id });
  return id;
}

/** This deployment's clock and the workspace's ledger heads, for a row's arrival. */
async function arrivalAt(ctx: QueryCtx, orgId: Id<"organizations">): Promise<ArrivalAt> {
  return { now: Date.now(), heads: await shardHeads(ctx, orgId) };
}

/**
 * Every switch an archive could bring, read in this workspace: `open` counts rows that could act now (finish
 * refuses while any is open); `here` counts connections and grants made on this deployment, which an import never
 * writes. The import summary prints it, so an admin sees what arrived switched off and what is connected here.
 */
export async function gatesIn(ctx: QueryCtx, orgId: Id<"organizations">) {
  type Indexed = { withIndex(i: string, f: (q: { eq(f: string, v: unknown): unknown }) => unknown): { take(n: number): Promise<Array<Record<string, unknown>>> } };
  /** Rows whose index's first field (orgId, or a parent's id) is `value`. */
  const rowsOf = async (table: string, index: string, value: unknown) => {
    const first = (schema.tables as unknown as Record<string, { indexes: Array<{ indexDescriptor: string; fields: string[] }> }>)[table].indexes.find((i) => i.indexDescriptor === index)!.fields[0];
    return (ctx.db.query(table as TableNames) as unknown as Indexed).withIndex(index, (q) => q.eq(first, value)).take(GATE_SCAN);
  };
  // A switch under a parent reads the rows of each of the workspace's parent rows (an agent's turns, a play's steps).
  const read = async (m: Mechanism, s: Switch) => {
    const parentSwitch = s.parent ? m.imported.find((p) => p.table === s.parent && !p.parent) : null;
    const parents = parentSwitch ? await rowsOf(parentSwitch.table, parentSwitch.index, orgId) : [];
    const rows = parentSwitch ? (await Promise.all(parents.map((p) => rowsOf(s.table, s.index, p._id)))).flat() : await rowsOf(s.table, s.index, orgId);
    return { rows: rows.length, open: rows.filter((r) => (s.open ? s.open(r) : true)).length };
  };
  const out = [];
  for (const m of CENSUS) {
    const imported = await Promise.all(m.imported.map(async (s) => ({ table: s.table, ...(await read(m, s)) })));
    const here = await Promise.all(m.here.map(async (s) => ({ table: s.table, ...(await read(m, s)) })));
    out.push({ key: m.key, does: m.does, arrives: m.arrives, imported, here: here.filter((h) => h.open).map((h) => ({ table: h.table, count: h.open })), open: imported.reduce((n, s) => n + s.open, 0) });
  }
  return out;
}
export type GateReport = Awaited<ReturnType<typeof gatesIn>>;

/** Remove the new workspace's own rows of a settings table (its defaults) the first time the archive's arrive. */
async function replaceDefaults(ctx: MutationCtx, imp: Doc<"workspaceImports">, table: string) {
  if (!IMPORT_TABLES[table]?.replace || imp.replaced.includes(table)) return;
  const scope = scopeFieldOf(table)!;
  const index = (entryOf(table) as { scope: { index: string } }).scope.index;
  const rows = await (ctx.db.query(table as TableNames) as unknown as { withIndex(i: string, f: (q: { eq(f: string, v: unknown): unknown }) => unknown): { take(n: number): Promise<Array<{ _id: Id<TableNames> }>> } })
    .withIndex(index, (q) => q.eq(scope, imp.orgId)).take(REPLACE_MAX + 1);
  if (rows.length > REPLACE_MAX) throw new ConvexError(`This workspace has more than ${REPLACE_MAX} ${table} rows of its own; import into a fresh workspace.`);
  for (const r of rows) await ctx.db.delete(r._id);
  await ctx.db.patch(imp._id, { replaced: [...imp.replaced, table] });
  imp.replaced = [...imp.replaced, table];
}

const parseLine = (line: string) => {
  const raw = JSON.parse(line) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { _id?: unknown })._id !== "string") throw new ConvexError("An archive row must be a JSON object with an _id.");
  return raw as Record<string, unknown> & { _id: string };
};

/**
 * The archive's members: each is matched to a member of this workspace by email, or added as an inactive placeholder
 * that keeps their name, email and role so owners and history stay readable. A placeholder is never active and never
 * an admin: the importing admin stays the only one. `formerIds` are members the history names whom the archive no
 * longer lists; each becomes a "Former member" placeholder.
 */
export const importUsers = mutation({
  args: { key: v.string(), offset: v.number(), rows: v.array(v.string()), formerIds: v.array(v.string()), pass: v.optional(v.literal(2)) },
  handler: async (ctx, args) => {
    const { orgId, imp } = await running(ctx, args.key);
    if (args.rows.length + args.formerIds.length > USERS_MAX) throw new ConvexError(`Send at most ${USERS_MAX} members at a time.`);
    const rows = args.rows.map(parseLine);
    const key = args.pass ? "users#refs" : "users";
    if (claimPage(imp, key, args.offset, rows.length + args.formerIds.length) === "skip") return { mapping: [] };
    const map = await mapFor(ctx, imp._id, [...rows.map((r) => r._id), ...rows.flatMap((r) => [...idsIn(r.managerId)]), ...args.formerIds]);
    const mapping: Array<{ oldId: string; email: string; name: string; role: string; as: "you" | "member" | "placeholder" | "former"; newId: string }> = [];
    if (args.pass) {
      for (const r of rows) {
        const id = map.get(r._id), manager = typeof (r.managerId as { id?: unknown } | undefined)?.id === "string" ? map.get((r.managerId as { id: string }).id) : undefined;
        const row = id ? await ctx.db.get(id as Id<"users">) : null;
        if (row && row.orgId === orgId && row.clerkUserId.startsWith(`member:${orgId}:`) && manager) await ctx.db.patch(row._id, { managerId: manager as Id<"users"> });
      }
    } else {
      const str = (x: unknown, max = 200) => (typeof x === "string" ? x.trim().slice(0, max) : "");
      for (const r of rows) {
        if (map.has(r._id)) continue;
        const email = str(r.email, 320).toLowerCase();
        const name = str(r.name) || email;
        if (!email) throw new ConvexError(`Member ${r._id} has no email.`);
        const existing = await ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", orgId).eq("email", email)).first();
        const role = str(r.role, 64) || "rep";
        let newId: string;
        if (existing) newId = existing._id;
        else {
          newId = await ctx.db.insert("users", {
            clerkUserId: `member:${orgId}:${email}`, orgId, email, name, role: role === "admin" ? "rep" : role, isActive: false, createdAt: Date.now(),
            ...(str(r.title) ? { title: str(r.title) } : {}), ...(str(r.department) ? { department: str(r.department) } : {}),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(str(r.startDate)) ? { startDate: str(r.startDate) } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(str(r.endDate)) ? { endDate: str(r.endDate) } : {}),
          });
        }
        await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: "users", oldId: r._id, newId });
        map.set(r._id, newId);
        mapping.push({ oldId: r._id, email, name, role: existing ? existing.role : role === "admin" ? "rep" : role, as: existing ? (existing._id === imp.userId ? "you" : "member") : "placeholder", newId });
      }
      for (const oldId of args.formerIds) {
        if (map.has(oldId) || !/^[0-9a-z]{31,37}$/.test(oldId)) continue;
        const label = foreignLabel(oldId);
        const email = `${label}@former.invalid`;
        const newId = await ctx.db.insert("users", { clerkUserId: `member:${orgId}:${email}`, orgId, email, name: "Former member", role: "rep", isActive: false, createdAt: Date.now() });
        await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: "users", oldId, newId });
        mapping.push({ oldId, email, name: "Former member", role: "rep", as: "former", newId });
      }
    }
    await ctx.db.patch(imp._id, { written: { ...imp.written, [key]: args.offset + rows.length + args.formerIds.length } });
    return { mapping };
  },
});

/**
 * A page's outcome. `notWritten` counts rows left out on purpose, by why: `needs <table>` (a required ref to what
 * this import doesn't write, or to a row it left out) and `module <id>` (a module not installed here). `cleared`
 * counts refs dropped from optional fields, by the table they named (`_storage` for files).
 */
type PageResult = { written: number; skipped: number; cleared: Record<string, number>; notWritten: Record<string, number>; foreign: number; held: Record<string, number> };

/**
 * One page of one section, in the order importPlan gives. `pass: 2` fills in refs to rows of the same table, once the
 * section's rows all exist. A page with any value the import can't map writes nothing and says what.
 */
export const importPage = mutation({
  args: { key: v.string(), section: v.string(), offset: v.number(), rows: v.array(v.string()), pass: v.optional(v.literal(2)) },
  handler: async (ctx, args): Promise<PageResult> => {
    const { orgId, imp } = await running(ctx, args.key);
    const spec = IMPORT_TABLES[args.section];
    if (!spec || spec.kind === "register" || spec.kind === "members" || !exported(entryOf(args.section))) throw new ConvexError(`${args.section} is not a section this import writes.`);
    if (args.rows.length > IMPORT_PAGE_MAX) throw new ConvexError(`Send at most ${IMPORT_PAGE_MAX} rows at a time.`);
    const progressKey = args.pass ? `${args.section}#refs` : args.section;
    const result: PageResult = { written: 0, skipped: 0, cleared: {}, notWritten: {}, foreign: 0, held: {} };
    if (claimPage(imp, progressKey, args.offset, args.rows.length) === "skip") return { ...result, skipped: args.rows.length };
    const acting = await actorsIn(ctx, orgId, true);
    if (acting.length) throw new ConvexError(`The import stopped because ${acting.join(" and ")}: imported history must not set it off. Turn it off, then run the import again to resume.`);
    const raws = args.rows.map(parseLine);
    const ids = new Set<string>();
    for (const r of raws) idsIn(r, ids);
    const map = await mapFor(ctx, imp._id, ids);
    // Settings arrive field by field onto this workspace, which keeps its own sign-in fields; the source's signup research stays there.
    const shape = spec.kind === "self" ? optionalFields(shapeOfTable(args.section)) : shapeOfTable(args.section);
    if (spec.kind === "self") for (const r of raws) delete r.signupInvestigation;
    const second = secondPassOf(args.section, shape);
    const deferSelf = !args.pass && !!second;
    const omit = !args.pass ? IMPORT_TABLES[args.section].defer?.fields : undefined;
    const decode = async (raw: Record<string, unknown> & { _id: string }): Promise<Decoded> => {
      // A stream's own register id (acc_s_/con_s_ of its stream id) is known once the stream exists.
      const own = args.section === "canonEntities" && !args.pass ? new Map([[await registerIdOf("account", raw._id), `${SELF}:account`], [await registerIdOf("contact", raw._id), `${SELF}:contact`]]) : null;
      const env: RemapEnv = { orgId, map: (id) => own?.get(id) ?? map.get(id), imported: (t) => t in IMPORT_TABLES || t === "organizations" };
      return decodeRow(args.section, shape, raw, env, { deferSelf, omit, scopeField: scopeFieldOf(args.section) ?? undefined });
    };
    const decoded = await Promise.all(raws.map(decode));
    const problems = decoded.flatMap((d) => d.unmapped);
    if (problems.length) refuse(problems);
    for (const d of decoded) {
      for (const [t, n] of Object.entries(d.cleared)) result.cleared[t] = (result.cleared[t] ?? 0) + n;
      result.foreign += d.foreign;
    }
    const modules = spec.module ? new Set(await installedModules(ctx, orgId)) : null;
    /** Why a row is left out, or null to write it. Its id maps to SKIPPED, so rows that need it are left out too. */
    const leftOut = (raw: Record<string, unknown>, d: Decoded) => {
      const owner = modules ? moduleOf(args.section, raw) : null;
      return owner && !modules!.has(owner) ? `module ${owner}` : d.needs ? `needs ${d.needs}` : null;
    };

    if (args.pass) {
      const selfFields = second?.fields ?? [];
      for (const [i, raw] of raws.entries()) {
        const id = map.get(raw._id);
        const patch = Object.fromEntries(selfFields.filter((k) => decoded[i].row[k] !== undefined && !spec.arrive?.fields.includes(k)).map((k) => [k, decoded[i].row[k]]));
        if (id && id !== SKIPPED && Object.keys(patch).length) { await ctx.db.patch(id as Id<TableNames>, patch as never); result.written++; }
      }
    } else if (spec.kind === "ledger") {
      result.written = await replayLedger(ctx, imp, decoded.map((d) => d.row));
    } else if (spec.kind === "module") {
      const rows: Array<{ oldId: string } & ModuleRow> = [];
      for (const [i, raw] of raws.entries()) {
        if (map.has(raw._id)) { result.skipped++; continue; }
        rows.push({ oldId: raw._id, ...(await moduleRowOf(ctx, imp.orgId, args.section, decoded[i].row, raw._creationTime)) });
      }
      const placed = await placeModuleRows(ctx, imp.orgId, rows);
      for (const [i, r] of rows.entries()) {
        const p = placed[i];
        await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: args.section, oldId: r.oldId, newId: p.id });
        if (p.held) result.held[r.moduleId] = (result.held[r.moduleId] ?? 0) + 1;
        else result.written++;
      }
    } else {
      await replaceDefaults(ctx, imp, args.section);
      const resolve = new Map<string, { entityId: string; attribute: string; at: number }>();
      for (const [i, raw] of raws.entries()) {
        const row = decoded[i].row;
        // The source workspace's id is mapped from the start (it is this one), so its settings are never "already in".
        if (spec.kind === "self") { await importSettings(ctx, imp, row); result.written++; continue; }
        if (map.has(raw._id)) { result.skipped++; continue; }
        const why = leftOut(raw, decoded[i]);
        if (why) {
          result.notWritten[why] = (result.notWritten[why] ?? 0) + 1;
          await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: args.section, oldId: raw._id, newId: SKIPPED });
          map.set(raw._id, SKIPPED);
          continue;
        }
        if (spec.kind === "observations") await sequenceObservation(ctx, orgId, row);
        // A unique claim the replay wrote, or a default a module installed here: the archive's row replaces it.
        const held = spec.dedupe ? await heldRow(ctx, orgId, args.section, spec.dedupe, row) : null;
        const id = await writeRow(ctx, imp, args.section, row, raw._id, held ?? undefined);
        if (held) result.skipped++;
        else result.written++;
        if (spec.kind === "facts") {
          const k = `${row.entityId}\u0000${row.attribute}`;
          resolve.set(k, { entityId: row.entityId as string, attribute: row.attribute as string, at: Math.max(resolve.get(k)?.at ?? 0, row.observedAt as number) });
        }
        // A deal whose company was its CRM mirror account (never in an archive) gets that account's register company below.
        const mirror = raw.accountId as { $ref?: string; id?: string } | undefined;
        if (args.section === "deals" && mirror?.$ref === "crmAccounts" && typeof mirror.id === "string" && !row.companyId) {
          await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: "deals.crmAccount", oldId: foreignLabel(mirror.id), newId: id });
        }
        if (args.section === "fakeRecordAccounts") await linkMirroredDeals(ctx, imp, [{ stream: (row.row as { stream?: unknown } | undefined)?.stream, recordId: row.recordId }]);
        // A record whose register id the record service derives from its stream id gets the one its new stream implies.
        if (args.section === "canonEntities" && (row.entityType === "account" || row.entityType === "contact")) {
          const object = row.entityType;
          await ctx.db.insert("workspaceImportIds", { orgId, importId: imp._id, table: "register", oldId: await registerIdOf(object, raw._id), newId: await registerIdOf(object, id) });
        }
      }
      // Field values and the review queue's contested fields come from the facts: resolve each one these touched.
      const store = resolve.size ? convexLedgerStore(ctx) : null;
      for (const r of resolve.values()) await store!.upsertFieldState({ entityId: r.entityId, attribute: r.attribute, ...resolveAttribute(await store!.factsFor(r.entityId, r.attribute)), updatedAt: r.at });
    }
    await ctx.db.patch(imp._id, { written: { ...imp.written, [progressKey]: args.offset + raws.length } });
    return result;
  },
});

/** One module row as it lands: the module it belongs to, the module table it is a row of, and its fields but those two. */
type ModuleRow = { moduleId: string; table: Doc<"moduleHeldRows">["table"]; row: Record<string, unknown> };
const MODULE_TABLES: ReadonlyArray<string> = schema.tables.moduleHeldRows.validator.fields.table.members.map((m) => m.value);

/**
 * A decoded row of a module section as the module row it carries: a held row of the archive carries the row it held.
 * It keeps its creation time where its table has one, and arrives switched off as its table's arrival says.
 */
async function moduleRowOf(ctx: QueryCtx, orgId: Id<"organizations">, section: string, decoded: Record<string, unknown>, createdAt: unknown): Promise<ModuleRow> {
  const held = section === "moduleHeldRows";
  const table = held ? String(decoded.table) : section;
  if (!MODULE_TABLES.includes(table)) throw new ConvexError(`A held module row can't be a ${table} row.`);
  const { orgId: _o, moduleId, ...fields } = held ? { ...(decoded.row as Record<string, unknown>), moduleId: decoded.moduleId } : decoded;
  void _o;
  let row: Record<string, unknown> = fields;
  if (shapeOfTable(table).fields?.sourceCreatedAt && row.sourceCreatedAt === undefined && typeof createdAt === "number") row.sourceCreatedAt = createdAt;
  const arrival = IMPORT_TABLES[table]?.arrive;
  if (arrival) row = arrive(table, arrival, row, await arrivalAt(ctx, orgId));
  return { moduleId: String(moduleId), table: table as ModuleRow["table"], row };
}

/**
 * The package that takes a module's rows here, or why they wait: it isn't installed, it is mid-upgrade (its new
 * version restores them when it serves), or a private module's rows meet an install that isn't Canon's own.
 */
async function receiverOf(ctx: QueryCtx, orgId: Id<"organizations">, moduleId: string): Promise<Doc<"modulePackages"> | string> {
  const pkg = await installedModule(ctx, orgId, moduleId);
  if (!pkg) return `${moduleId} isn't installed here`;
  if (pkg.pending && !pkg.pending.error) return `${moduleId} is upgrading`;
  if (manifestOf(pkg).visibility === "private" && pkg.source.kind !== "canon") return `${moduleId} is a private module, restored only into Canon's own install of it`;
  return pkg;
}

/**
 * Module rows into the module installed here (docs and history through its scope, AI receipts and snapshots as they
 * are), or into moduleHeldRows with why. Returns each row's id here and whether it was held.
 */
async function placeModuleRows(ctx: MutationCtx, orgId: Id<"organizations">, rows: ReadonlyArray<ModuleRow>): Promise<Array<{ id: string; held: boolean }>> {
  const out: Array<{ id: string; held: boolean }> = new Array(rows.length);
  const receivers = new Map<string, Doc<"modulePackages"> | string>();
  for (const r of rows) if (!receivers.has(r.moduleId)) receivers.set(r.moduleId, await receiverOf(ctx, orgId, r.moduleId));
  const hold = async (i: number, why?: string, pkg?: Doc<"modulePackages">) => {
    const r = rows[i];
    const id = await ctx.db.insert("moduleHeldRows", { orgId, moduleId: r.moduleId, table: r.table, row: r.row, heldAt: Date.now(), ...(why && pkg ? { problem: { why, epoch: pkg.epoch ?? 1 } } : {}) });
    out[i] = { id, held: true };
  };
  for (const [moduleId, pkg] of receivers) {
    const mine = rows.flatMap((r, i) => (r.moduleId === moduleId ? [i] : []));
    if (typeof pkg === "string") { for (const i of mine) await hold(i); continue; }
    const scoped = mine.filter((i) => rows[i].table !== "moduleAiRuns" && rows[i].table !== "moduleSnapshots");
    const restored = await restoreImportedDocs(ctx, pkg, scoped.map((i) => rows[i]));
    for (const [j, i] of scoped.entries()) {
      const p = restored[j];
      if ("id" in p) out[i] = { id: p.id, held: false };
      else await hold(i, p.why, pkg);
    }
    for (const i of mine.filter((i) => !scoped.includes(i))) {
      const r = rows[i];
      out[i] = { id: await ctx.db.insert(r.table as "moduleAiRuns", { ...(r.row as Omit<Doc<"moduleAiRuns">, "_id" | "_creationTime" | "orgId" | "moduleId">), orgId, moduleId }), held: false };
    }
  }
  return out;
}

/**
 * Restore what an import held for a module, once it is installed here (lib/modules/scope.ts startImports schedules
 * it when a version starts serving). A row that doesn't fit the installed version stays held with why, and is tried
 * again when another version serves.
 */
export const restoreHeld = internalMutation({
  args: { orgId: v.id("organizations"), moduleId: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const pkg = await receiverOf(ctx, a.orgId, a.moduleId);
    if (typeof pkg === "string") return { restored: 0, held: 0, waiting: pkg };
    const page = await ctx.db.query("moduleHeldRows").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", a.orgId).eq("moduleId", a.moduleId)).paginate({ numItems: HELD_BATCH, cursor: a.cursor });
    const epoch = pkg.epoch ?? 1;
    const due = page.page.filter((h) => h.problem?.epoch !== epoch);
    const placed = await placeModuleRows(ctx, a.orgId, due.map((h) => ({ moduleId: h.moduleId, table: h.table, row: h.row as Record<string, unknown> })));
    let restored = 0;
    for (const [i, h] of due.entries()) {
      // A row placeModuleRows held again is a new held row with why; this one is done either way.
      await ctx.db.delete(h._id);
      if (!placed[i].held) restored++;
    }
    if (restored) {
      // As at import: the module is off while it holds what arrived, and fit is computed from any ICPs among them.
      const imp = await ctx.db.query("workspaceImports").withIndex("by_orgId", (q) => q.eq("orgId", a.orgId)).order("desc").first();
      const admin = imp && (await ctx.db.get(imp.userId));
      if (admin && (await isEnabled(ctx, a.orgId, a.moduleId))) await setModuleEnabled(ctx, admin, { moduleId: a.moduleId, enabled: false });
      await invalidateFit(ctx, a.orgId);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.workspaceImport.restoreHeld, { ...a, cursor: page.continueCursor });
    return { restored, held: due.length - restored, waiting: null };
  },
});

/**
 * Deals linked to a CRM mirror account take the register company that account's stream projects to: the mirror is
 * rebuilt only by a CRM sync, and an imported workspace has no connection, so without this the deal shows no company.
 */
async function linkMirroredDeals(ctx: MutationCtx, imp: Doc<"workspaceImports">, rows: ReadonlyArray<{ stream: unknown; recordId: unknown }>) {
  for (const r of rows) {
    if (typeof r.stream !== "string" || typeof r.recordId !== "string") continue;
    const id = ctx.db.normalizeId("canonEntities", r.stream);
    const entity = id && (await ctx.db.get(id));
    if (!entity || entity.orgId !== imp.orgId || entity.projectionTable !== "crmAccounts") continue;
    const links = await ctx.db.query("workspaceImportIds").withIndex("by_importId_oldId", (q) => q.eq("importId", imp._id).eq("oldId", entity.projectionId)).take(200);
    for (const link of links.filter((l) => l.table === "deals.crmAccount")) {
      const deal = await ctx.db.get(link.newId as Id<"deals">);
      if (deal && deal.orgId === imp.orgId && !deal.companyId) await ctx.db.patch(deal._id, { companyId: r.recordId });
    }
  }
}

/** This workspace's row with the same `dedupe` fields as an archived one, which the archive's then replaces. */
async function heldRow(ctx: QueryCtx, orgId: Id<"organizations">, table: string, dedupe: { index: string; fields: readonly string[] }, row: Record<string, unknown>) {
  if (dedupe.fields.some((f) => row[f] === undefined)) return null;
  const held = await (ctx.db.query(table as TableNames) as unknown as { withIndex(i: string, f: (q: { eq(f: string, v: unknown): unknown }) => unknown): { first(): Promise<{ _id: string } | null> } })
    .withIndex(dedupe.index, (q) => dedupe.fields.reduce((acc: { eq(f: string, v: unknown): unknown }, f) => acc.eq(f, row[f]) as never, q.eq("orgId", orgId) as never)).first();
  return held?._id ?? null;
}

/** The archive's workspace settings onto this workspace. Its sign-in, billing and slug stay this deployment's. */
async function importSettings(ctx: MutationCtx, imp: Doc<"workspaceImports">, row: Record<string, unknown>) {
  const org = await ctx.db.get(imp.orgId);
  if (!org) throw new ConvexError("Workspace not found");
  const { orgId: _drop, slug: _slug, clerkOrgId: _clerk, ...settings } = row;
  void _drop; void _slug; void _clerk;
  await ctx.db.patch(imp.orgId, settings as never);
  await ctx.db.insert("workspaceImportIds", { orgId: imp.orgId, importId: imp._id, table: "organizations#settings", oldId: imp.sourceWorkspaceId, newId: imp.orgId });
}

/** An observation's place in this deployment's log of its subject: its shard and the next gap-free seq there. */
async function sequenceObservation(ctx: MutationCtx, orgId: Id<"organizations">, row: Record<string, unknown>) {
  const shard = shardOf(subjectKey(row.subject as Doc<"observations">["subject"]));
  const head = await ctx.db.query("observationHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId).eq("shard", shard)).unique();
  const seq = (head?.seq ?? 0) + 1;
  if (head) await ctx.db.patch(head._id, { seq });
  else await ctx.db.insert("observationHeads", { orgId, shard, seq });
  row.shard = shard;
  row.seq = seq;
}

/**
 * Append each stream's entries after the version its hot row holds, in order, through appendHistory: it folds them,
 * writes the hot row, unique claims and proposals, and issues this deployment's seqs. A stream longer than one page
 * arrives over several pages, each folding onto the hot row the last one wrote. An edge stream's index row follows.
 */
async function replayLedger(ctx: MutationCtx, imp: Doc<"workspaceImports">, rows: Record<string, unknown>[]) {
  const byStream = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) byStream.set(r.streamId as string, [...(byStream.get(r.streamId as string) ?? []), r]);
  const store = convexObjectStore(ctx);
  let written = 0;
  for (const [streamId, entries] of byStream) {
    const entity = await ctx.db.get(streamId as Id<"canonEntities">);
    if (!entity || entity.orgId !== imp.orgId) throw new ConvexError(`Ledger entries name a stream ${streamId} this import didn't create.`);
    const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", imp.orgId).eq("streamId", entity._id)).unique();
    let version = hot?.version ?? 0;
    const fresh = entries.filter((e) => (e.version as number) > version).sort((a, b) => (a.version as number) - (b.version as number));
    for (const e of fresh) {
      if (e.version !== version + 1) throw new ConvexError(`Stream ${streamId} jumps from version ${version} to ${e.version}; the archive is missing entries.`);
      version++;
    }
    if (!fresh.length) continue;
    const object = fresh[0].object as string;
    if (fresh.some((e) => e.object !== object)) throw new ConvexError(`Stream ${streamId} has entries of two objects.`);
    const def = object === ASSOCIATION_OBJECT ? associationObjectDef() : await loadOrgObject(ctx, imp.orgId, object);
    if (!def) throw new ConvexError(`The archive has ${object} records, and no ${object} object is defined here.`);
    const state = await appendHistory(store, { orgId: imp.orgId, def, now: Date.now() }, streamId, fresh.map((e) => asEntry(e as unknown as Doc<"ledgerEntries">)));
    written += fresh.length;
    // An entry erased at the source stays erased: its body arrives erased, and readers skip it by redactedAt.
    for (const e of fresh) {
      if (typeof e.redactedAt !== "number") continue;
      const stored = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id).eq("version", e.version as number)).unique();
      if (stored) await ctx.db.patch(stored._id, { redactedAt: e.redactedAt });
    }
    if (def.apiName === ASSOCIATION_OBJECT && state) {
      const row = project(def, state);
      const edge = edgeOf(row.values, row.deletedAt);
      if (edge) await edgeStore(ctx).putEdge(imp.orgId, { ...edge, streamId, createdAt: state.createdAt });
    }
  }
  return written;
}

/** The import's workspace and the map entries a register page names, for the action that writes it to the record service. */
export const registerContext = internalQuery({
  args: { key: v.string(), section: v.string(), offset: v.number(), count: v.number(), ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { orgId, imp } = await running(ctx, args.key);
    const state = claimPage(imp, args.section, args.offset, args.count);
    return { orgId, state, map: state === "skip" ? [] : [...(await mapFor(ctx, imp._id, args.ids))] };
  },
});

export const registerProgress = internalMutation({
  args: { key: v.string(), section: v.string(), offset: v.number(), count: v.number(), links: v.array(v.object({ stream: v.string(), recordId: v.string() })) },
  handler: async (ctx, args) => {
    const { imp } = await running(ctx, args.key);
    if (claimPage(imp, args.section, args.offset, args.count) !== "write") return;
    await linkMirroredDeals(ctx, imp, args.links);
    await ctx.db.patch(imp._id, { written: { ...imp.written, [args.section]: args.offset + args.count } });
  },
});

/** One page of the register (record service rows), every id remapped, written to this deployment's record service. */
export const importRegister = action({
  args: { key: v.string(), section: v.union(...REGISTER_SECTIONS.map((s) => v.literal(s))), offset: v.number(), rows: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ written: number; skipped: number; foreign: number }> => {
    if (args.rows.length > 1000) throw new ConvexError("Send at most 1000 register rows at a time.");
    const service = registerService(process.env);
    if (!service) throw new ConvexError("This deployment has no record service to take the archive's register.");
    const raws = args.rows.map((line) => JSON.parse(line) as Record<string, unknown>);
    const ids = new Set<string>();
    for (const r of raws) idsIn(r, ids);
    const context: { orgId: string; state: "write" | "skip"; map: Array<[string, string]> } = await ctx.runQuery(internal.workspaceImport.registerContext, { key: args.key, section: args.section, offset: args.offset, count: raws.length, ids: [...ids] });
    if (context.state === "skip") return { written: 0, skipped: raws.length, foreign: 0 };
    const map = new Map(context.map);
    const env: RemapEnv = { orgId: context.orgId, map: (id) => map.get(id), imported: () => true };
    const decoded = raws.map((raw) => decodeRow(args.section, { kind: "any" }, { ...raw, _id: undefined }, env));
    const problems = decoded.flatMap((d) => d.unmapped);
    if (problems.length) refuse(problems);
    await registerImport(service, context.orgId, args.section as RegisterSection, decoded.map((d) => d.row));
    const links = args.section === "register.accounts" ? decoded.flatMap((d) => (typeof d.row.stream === "string" && typeof d.row.id === "string" ? [{ stream: d.row.stream, recordId: d.row.id }] : [])) : [];
    await ctx.runMutation(internal.workspaceImport.registerProgress, { key: args.key, section: args.section, offset: args.offset, count: raws.length, links });
    return { written: raws.length, skipped: 0, foreign: decoded.reduce((n, d) => n + d.foreign, 0) };
  },
});

/** Finish once every section the archive holds is in. Afterwards the import is done and this workspace takes no other. */
export const finish = mutation({
  args: { key: v.string(), expected: v.record(v.string(), v.number()) },
  handler: async (ctx, args) => {
    const { imp } = await running(ctx, args.key);
    const short = Object.entries(args.expected).filter(([k, n]) => (imp.written[k] ?? 0) < n).map(([k, n]) => `${k} ${imp.written[k] ?? 0}/${n}`);
    if (short.length) throw new ConvexError(`The import isn't complete: ${short.join(", ")}. Run it again to resume.`);
    // Arrivals stamped from the finished ledger (an automation's cursors), whatever order the pages came in.
    const at = await arrivalAt(ctx, imp.orgId);
    for (const [table, spec] of Object.entries(IMPORT_TABLES)) {
      if (!spec.arrive?.again) continue;
      const rows = await (ctx.db.query(table as TableNames) as unknown as { withIndex(i: string, f: (q: { eq(f: string, v: unknown): unknown }) => unknown): { take(n: number): Promise<Array<Record<string, unknown> & { _id: Id<TableNames> }>> } })
        .withIndex((entryOf(table) as { scope: { index: string } }).scope.index, (q) => q.eq("orgId", imp.orgId)).take(GATE_SCAN);
      for (const r of rows) {
        const { _id, _creationTime, ...row } = r;
        void _creationTime;
        await ctx.db.replace(_id, arrive(table, spec.arrive, row, at) as never);
      }
    }
    const gates = await gatesIn(ctx, imp.orgId);
    const open = gates.filter((g) => g.open);
    if (open.length) throw new ConvexError(`The import can't finish: ${open.map((g) => `${g.key} (${g.imported.filter((s) => s.open).map((s) => `${s.open} ${s.table}`).join(", ")})`).join("; ")} arrived able to act.`);
    await ctx.db.patch(imp._id, { status: "done", finishedAt: Date.now() });
    // Fit is computed here, from the ICPs and scoring settings the archive brought: rescore every company against them.
    await invalidateFit(ctx, imp.orgId);
    return { finishedAt: Date.now(), gates };
  },
});
