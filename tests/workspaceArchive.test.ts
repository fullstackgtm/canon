/**
 * Workspace archives (convex/workspaceTransfer.ts, cli/workspaceArchive.ts). The registry classifies every schema
 * table; an export of one workspace, run by the CLI's own loop against the real handlers, holds none of another
 * workspace's rows and no row of a table the registry keeps out; only a person who is an admin creates the key.
 * Rae is workspace A's admin, Avery a rep there, and Bo workspace B's admin.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { ARCHIVE_TABLES, entryOf, exported, type ArchiveEntry, type ArchiveScope } from "../convex/lib/workspaceArchive/tables.ts";
import { exportWorkspace, liveCounts, readArchive, tarFileSink, verifyArchive, type Transport } from "../cli/workspaceArchive.ts";

const A = "organizations:a";
const B = "organizations:b";
type Validator = { kind: string; isOptional?: string; tableName?: string; fields?: Record<string, Validator> };
type TableDef = { validator: Validator; indexes: { indexDescriptor: string; fields: string[] }[] };

const register = (ws: string) => [{ id: `acc_${ws}`, domain: `${ws}.example`, actorId: "users:x" }];
const fakeService: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/healthz")) return Response.json({ version: "1.48.0+test" });
  const ws = new Headers(init?.headers).get("X-Workspace-Id") ?? "";
  if (url.endsWith("/export/counts")) return Response.json({ accounts: 1, contacts: 0, field_history: 0 });
  return Response.json({ rows: url.endsWith("/export/accounts") ? register(ws) : [], next: null });
};
const M = loadConvex(["schema.ts", "workspaceTransfer.ts"], {}, { fetch: fakeService });
const T = M["workspaceTransfer.ts"];
const tables = (M["schema.ts"] as unknown as { default: { tables: Record<string, TableDef> } }).default.tables;
const operatorFile = resolve(import.meta.dirname, "../convex/lib/operatorTables.ts");
const operatorTables = existsSync(operatorFile) ? Object.keys((loadConvex(["lib/operatorTables.ts"])["lib/operatorTables.ts"] as unknown as { operatorTables: object }).operatorTables) : [];

test("every schema table is classified once, and the registry names only schema tables", () => {
  const names = Object.keys(tables);
  assert.deepEqual(names.filter((t) => !(t in ARCHIVE_TABLES) && !operatorTables.includes(t)), [], "unclassified tables");
  assert.deepEqual(Object.keys(ARCHIVE_TABLES).filter((t) => !names.includes(t)), [], "registry tables the schema lacks");
  assert.deepEqual(operatorTables.filter((t) => t in ARCHIVE_TABLES), [], "operator tables classify themselves");
});

test("each exported table is read through an index that scopes it, and a table waiting on an index has none yet", () => {
  const problems: string[] = [];
  for (const [table, entry] of Object.entries(ARCHIVE_TABLES as Record<string, ArchiveEntry>)) {
    if (!("scope" in entry)) continue;
    const scope = entry.scope as ArchiveScope;
    const def = tables[table];
    const fields = def.validator.fields ?? {};
    const index = (name: string) => def.indexes.find((i) => i.indexDescriptor === name);
    if (scope.by === "org" && index(scope.index)?.fields[0] !== (scope.field ?? "orgId")) problems.push(`${table}: ${scope.index} does not start with ${scope.field ?? "orgId"}`);
    if (scope.by === "parent") {
      if (index(scope.index)?.fields[0] !== scope.via) problems.push(`${table}: ${scope.index} does not start with ${scope.via}`);
      if (fields[scope.via]?.tableName !== scope.parent) problems.push(`${table}.${scope.via} is not an id of ${scope.parent}`);
      if (scope.andOrg && index(scope.index)?.fields[1] !== "orgId") problems.push(`${table}: ${scope.index} has no orgId second`);
      if (!exported(entryOf(scope.parent))) problems.push(`${table}: parent ${scope.parent} is not exported`);
    }
    if (scope.by === "needsIndex" && index(scope.index)) problems.push(`${table}: ${scope.index} exists now; export it through that index`);
    for (const f of [...(entry.omit ?? []), ...(entry.pick ?? [])]) if (!(f in fields)) problems.push(`${table}: no field ${f}`);
  }
  assert.deepEqual(problems, []);
});

/** Two workspaces with a row in every table: exported tables scoped as the registry reads them, every other one by orgId. */
function seedTwoWorkspaces() {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  const add = (table: string, row: Record<string, unknown>) => (rows[table] ??= []).push(row);
  for (const [org, tag] of [[A, "a"], [B, "b"]] as const) {
    add("organizations", { _id: org, name: `Org ${tag}`, slug: `org-${tag}`, clerkOrgId: `clerk_org_${tag}`, stripeCustomerId: `cus_${tag}` });
    add("users", { _id: `users:admin${tag}`, orgId: org, clerkUserId: `clerk_admin${tag}`, email: `admin@${tag}.example`, name: `Admin ${tag}`, role: "admin", isActive: true });
    add("users", { _id: `users:rep${tag}`, orgId: org, clerkUserId: `clerk_rep${tag}`, email: `rep@${tag}.example`, name: `Rep ${tag}`, role: "rep", isActive: true, managerId: `users:admin${tag}` });
    for (const [table, entry] of Object.entries(ARCHIVE_TABLES)) {
      if (table === "organizations" || table === "users") continue;
      const scope = "scope" in entry ? (entry.scope as ArchiveScope) : null;
      const hasOrg = "orgId" in (tables[table].validator.fields ?? {});
      const base = { _id: `${table}:${tag}`, ...(hasOrg ? { orgId: org } : {}) };
      if (scope?.by === "org") add(table, { ...base, [scope.field ?? "orgId"]: org });
      else if (scope?.by === "parent") add(table, { ...base, [scope.via]: scope.parent === "users" ? `users:admin${tag}` : `${scope.parent}:${tag}` });
      else add(table, { ...base, orgId: org });
    }
    for (const table of operatorTables) add(table, { _id: `${table}:${tag}`, orgId: org });
  }
  add("dialerProfiles", { _id: "dialerProfiles:admina-in-b", userId: "users:admina", orgId: B });
  return memoryDb(rows);
}

const identityOf = (clerkUserId: string, extra: Record<string, unknown> = {}) => ({ tokenIdentifier: clerkUserId, subject: clerkUserId, issuer: "https://clerk.example", ...extra });
const ctxFor = (db: ReturnType<typeof memoryDb>, identity: Record<string, unknown> | null) => {
  const ctx = { db, auth: { getUserIdentity: async () => identity }, runQuery: async (ref: unknown, args: { key: string }) => {
    assert.equal(String(ref), "internal.workspaceTransfer.keyWorkspace");
    return T.keyWorkspace.handler(ctx, args);
  } };
  return ctx;
};

function transport(db: ReturnType<typeof memoryDb>, key: string): Transport {
  const ctx = ctxFor(db, null);
  return {
    plan: async () => ({ ...(await T.exportPlan.handler(ctx, { key })), source: { appCommit: null, dataEpoch: 1, minEpoch: 0 } }),
    page: (args) => T.exportPage.handler(ctx, { key, ...args }),
    registerInfo: () => T.exportRegisterInfo.handler(ctx, { key }),
    register: (args) => T.exportRegister.handler(ctx, { key, ...args }),
    // These workspaces hold no stored files (tests/workspaceImport.test.ts moves them).
    files: async () => ({ files: [] }),
    download: async () => new Uint8Array(),
  };
}

function memorySink() {
  const files = new Map<string, Uint8Array>();
  return { files, add: (path: string, bytes: Uint8Array) => void files.set(path, bytes) };
}

const rowsIn = (files: Map<string, Uint8Array>) => [...files].filter(([p]) => p.startsWith("sections/")).flatMap(([p, bytes]) =>
  gunzipSync(bytes).toString("utf8").split("\n").filter(Boolean).map((line) => ({ section: p.split("/")[1], line })));

test("an export holds one workspace's rows, none of another's, and nothing from a table the registry keeps out", async () => {
  process.env.RECORD_SERVICE_URL = "http://record.test";
  process.env.RECORD_SERVICE_TOKEN = "t";
  try {
    const db = seedTwoWorkspaces();
    const { key } = await T.createExportKey.handler(ctxFor(db, identityOf("clerk_admina")), {});
    const sink = memorySink();
    const manifest = await exportWorkspace(transport(db, key), sink);
    const rows = rowsIn(sink.files);
    assert.deepEqual(rows.filter((r) => /:b"|organizations:b|users:adminb|users:repb|acc_organizations:b/.test(r.line)).map((r) => r.section), [], "rows of workspace B");
    const kept = new Set(rows.map((r) => r.section));
    const leaked = Object.keys(tables).filter((t) => !exported(entryOf(t)) && kept.has(t));
    assert.deepEqual(leaked, [], "sections of tables the registry keeps out");
    for (const table of Object.keys(tables)) if (!exported(entryOf(table))) assert.equal(rows.some((r) => r.line.includes(`"${table}:a"`)), false, `${table}'s row`);
    assert.equal(manifest.sections.organizations.count, 1);
    assert.equal(rows.some((r) => r.line.includes("clerk_org_a") || r.line.includes("cus_a") || r.line.includes("clerk_admina")), false, "sign-in and billing ids");
    assert.equal(manifest.sections.users.count, 2);
    assert.equal(manifest.sections["register.accounts"].count, 1);
    assert.equal(manifest.sections.dealChatMessages.count, 1, "a child row read through its parent");
    assert.equal(manifest.sections.dialerProfiles.count, 1, "a member's profile in another workspace is not read");
    const rep = JSON.parse(rows.find((r) => r.line.includes('"users:repa"'))!.line);
    assert.deepEqual(rep.managerId, { $ref: "users", id: "users:admina" });
    assert.equal(manifest.source.recordContract, "1.48.0");
    assert.equal(manifest.exportedBy, "admin@a.example");
    assert.equal(manifest.notExported.find((n) => n.table === "integrations")?.count, 1, "a secret table is counted, never carried");

    const live = await liveCounts(transport(db, key));
    assert.equal(verifyArchive(sink.files, live).ok, true);
    await assert.rejects(T.exportPage.handler(ctxFor(db, null), { key, section: "dealChatMessages", parents: ["dealChats:b"] }), /not a dealChats row of this workspace/);
  } finally {
    delete process.env.RECORD_SERVICE_URL;
    delete process.env.RECORD_SERVICE_TOKEN;
  }
});

test("only a person who is an admin creates an export key, and the key stops working when they can't export", async () => {
  const db = seedTwoWorkspaces();
  await assert.rejects(T.createExportKey.handler(ctxFor(db, identityOf("clerk_repa")), {}), /Your role can't do this/);
  process.env.CANON_SERVICE_JWT_ISSUER = "https://canon.example";
  try {
    await assert.rejects(T.createExportKey.handler(ctxFor(db, identityOf("clerk_admina", { issuer: "https://canon.example", azp: "canon-cli" })), {}), /Only a person exports/);
  } finally {
    delete process.env.CANON_SERVICE_JWT_ISSUER;
  }
  const { key } = await T.createExportKey.handler(ctxFor(db, identityOf("clerk_admina")), {});
  await db.patch("users:admina", { role: "rep" });
  await assert.rejects(T.exportPlan.handler(ctxFor(db, null), { key }), /can no longer export/);
  await assert.rejects(T.exportPlan.handler(ctxFor(db, null), { key: `cwx_${"x".repeat(43)}` }), /unknown or has expired/);
});

test("an archive file reads back and verifies, and a changed part fails", async () => {
  const db = seedTwoWorkspaces();
  const { key } = await T.createExportKey.handler(ctxFor(db, identityOf("clerk_admina")), {});
  const dir = mkdtempSync(join(tmpdir(), "canon-archive-"));
  try {
    const path = join(dir, "a.tar");
    const sink = tarFileSink(path);
    await exportWorkspace(transport(db, key), sink);
    sink.close();
    const files = readArchive(path);
    assert.equal(verifyArchive(files).ok, true);
    const part = [...files.keys()].find((p) => p.startsWith("sections/deals/"))!;
    files.set(part, Buffer.from(files.get(part)!).fill(0, 20, 21));
    const checked = verifyArchive(files);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.checks.find((c) => c.section === "deals")?.problems, [`${part} checksum differs`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
