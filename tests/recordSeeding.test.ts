/**
 * A record-service person put on the ledger by a research run or a deal play's job check: their stream starts from
 * their whole row, so a field the reader's role hides is not cleared. Avery, a rep, can't see people's titles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { loadConvex, memoryDb, type Handler } from "./convexHandlers.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import type { Access } from "../convex/lib/access.ts";

const ORG = "organizations:org";
const AVERY = "users:avery";
let records: ReturnType<typeof createFakeRecordClient>;
const M = loadConvex(["researchAgentActions.ts", "dealPlayActions.ts", "canonEntities.ts", "researchAgents.ts", "permissions.ts"], {
  "records.ts": (real) => ({
    ...real,
    principalClient: (_ctx: unknown, _org: unknown, accesses: Access[]) => scopedRecordClient(records, accesses, async () => null),
    clientFor: () => records,
  }),
  "lib/treg.ts": (real) => ({
    ...real,
    paidCallsAllowed: () => true,
    tregCall: async () => ({ status: 200, costMicro: 0, body: { job_change_detected: true, current_company: "Elsewhere" } }),
  }),
});
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const real = (path: string): Handler => {
  const [file, name] = path.replace(/^(internal|api)\./, "").split(".");
  return M[`${file}.ts`]![name]!;
};
/** The job check's bookkeeping, which this test doesn't read; recording the departure ends the check. */
const STUBS: Record<string, (args: Record<string, unknown>) => unknown> = {
  "internal.credits.chargeOf": () => null,
  "internal.credits.balanceOf": () => ({ spendableMicro: 1e12 }),
  "internal.credits.charge": () => true,
  "internal.credits.meterCharge": () => null,
  "internal.records.recordProviderCall": () => "providerCalls:1",
  "internal.researchAgents.recordDeparture": () => { throw new Error("departure recorded"); },
};

async function workspace() {
  const db = memoryDb({
    organizations: [{ _id: ORG, name: "Org" }],
    users: [{ _id: AVERY, orgId: ORG, role: "rep", isActive: true, name: "Avery Chen" }],
    rolePermissions: [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: [{ object: "contact", fields: [{ apiName: "title", level: "hidden" }] }] }],
    researchAgents: [{ _id: "researchAgents:remit", orgId: ORG, slug: "remit", entityType: "contact", kind: "text", question: "What do they own?" }],
  });
  const store = createMemoryRecordStore();
  await store.putAccounts(ORG, [{ id: "northstar", domain: "northstar.example", name: "Northstar", fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1 }]);
  const person = (id: string, fullName: string) => ({ id, accountId: "northstar", fullName, title: "VP Sales", linkedinUrl: `https://www.linkedin.com/in/${id}`, status: "new", updatedAt: 1 });
  await store.putContacts(ORG, [person("sam", "Sam Rivera"), person("lee", "Lee Park")]);
  records = createFakeRecordClient({ store });
  const perms = M["permissions.ts"] as unknown as { accessFor: (ctx: unknown, user: unknown) => Promise<Access> };
  const access = await perms.accessFor({ db }, await db.get(AVERY));
  const call = async (ref: unknown, args: Record<string, unknown>) => plain(STUBS[String(ref)] ? await STUBS[String(ref)]!(args) : await real(String(ref)).handler(ctx, args));
  const ctx = { db, runQuery: call, runMutation: call, runAction: call };
  const sees: RecordClient = scopedRecordClient(records, [access], async () => null);
  return { db, ctx, access, sees };
}

/** The title the person's history starts from (the record-service row their stream was seeded from), and on the ledger now. */
function seeded(db: ReturnType<typeof memoryDb>, recordId: string) {
  const entity = db.rows("canonEntities").find((e) => e.projectionId === recordId)!;
  const seed = db.rows("ledgerEntries").find((e) => e.streamId === entity._id && (e.source as { ref: string }).ref === `record:contact:${recordId}`);
  const assertions = (seed?.body as { assertions?: Array<{ fieldId: string; value: unknown }> } | undefined)?.assertions ?? [];
  const now = db.rows("canonFieldState").find((s) => s.entityId === entity._id && s.attribute === "title");
  return [assertions.find((a) => a.fieldId === "title")?.value, now?.value];
}

test("a research run and a job check put a person on the ledger from their whole row, so a title the role hides isn't cleared", async () => {
  const { db, ctx, access, sees } = await workspace();
  const research = M["researchAgentActions.ts"] as unknown as { contactScopeBatch: (...args: unknown[]) => Promise<{ todo: Array<{ subject: { person?: { title?: string } } }> }> };
  const batch = await research.contactScopeBatch(ctx, sees, { orgId: ORG, agentId: "researchAgents:remit", attribute: "custom.remit", remaining: 10, scope: { ids: ["sam"] }, cursor: undefined });
  assert.deepEqual(plain(batch.todo.map((t) => t.subject.person?.title ?? null)), [null], "the research subject leaves the hidden title out");
  const deals = M["dealPlayActions.ts"] as unknown as { checkDealPeople: (...args: unknown[]) => Promise<unknown> };
  process.env.TREG_TOKEN = "test";
  try {
    await deals.checkDealPeople(ctx, { orgId: ORG, userId: AVERY, access }, { companyId: "northstar", companyName: "Northstar" }, "employed", ["lee"]);
  } finally {
    delete process.env.TREG_TOKEN;
  }
  assert.deepEqual(plain(["sam", "lee"].map((id) => seeded(db, id))), [["VP Sales", "VP Sales"], ["VP Sales", "VP Sales"]]);
});

/**
 * Every way a record-service row starts a ledger stream, and the one module allowed to hand it a row. Each of those
 * reads the row with the bare client (clientFor), never a caller's or agent's scoped one, whose rows leave out hidden
 * fields. A new caller of an entry point, or a new place that turns a row into seed values, fails here: route a
 * promotion through lib/recordPromotion.ts (it takes ids and reads the whole row), or add the entry with its client.
 */
const SEED_ENTRY_POINTS: Record<string, string[]> = {
  // Promotion: promoteAccounts and promoteContacts, given ids the caller's client admitted.
  "internal.canonEntities.promoteRecords": ["convex/lib/recordPromotion.ts"],
  "internal.canonEntities.anchorContacts": ["convex/lib/recordPromotion.ts"],
  // A first edit, archive or restore of an unworked row (recordEditPorts, bulkRegister): clientFor.
  "internal.canon.saveRecordEdit": ["convex/records.ts"],
  "internal.canon.saveRecordLifecycle": ["convex/records.ts"],
  // A merge's unworked rows (partyOf): clientFor, for rows the caller's client listed.
  "internal.recordMerges.apply": ["convex/recordMerges.ts"],
  // A CSV row that updates an unworked row: the register rows lookupMatches reads with clientFor.
  "writeImportRow(": ["convex/csvImports.ts", "convex/lib/objects/csvImport.ts"],
  // Row to seed values: the entry points above and the snapshot builders their actions call.
  "recordSeed(": ["convex/canonEntities.ts", "convex/lib/canon/partyLedger.ts", "convex/lib/objects/csvImport.ts"],
  "recordContactValues(": ["convex/canonEntities.ts", "convex/lib/canon/partyLedger.ts"],
  "recordAccountValues(": ["convex/lib/canon/partyLedger.ts"],
  "promoteRecord(": ["convex/lib/canon/partyLedger.ts", "convex/lib/canon/partyMerge.ts"],
  "recordSnapshotOf(": ["convex/lib/recordPromotion.ts", "convex/recordMerges.ts", "convex/records.ts"],
  "contactSnapshotOf(": ["convex/recordMerges.ts", "convex/records.ts"],
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "_generated" || e.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

test("a ledger stream starts from a record-service row only through the listed entry points", () => {
  const files = ["convex", "src", "engine/src", "modules"].flatMap(sources).map((path) => [path, readFileSync(path, "utf8")] as const);
  const found = Object.fromEntries(Object.keys(SEED_ENTRY_POINTS).map((name) => [name, files.filter(([, text]) => text.includes(name)).map(([path]) => path).sort()]));
  assert.deepEqual(found, SEED_ENTRY_POINTS);
});
