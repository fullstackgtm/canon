import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { accessOf, type ObjectRule } from "../convex/lib/access.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const parentItem = (accountId: string, from: string | null, to: string | null) =>
  ({ op: "set_parent", accountId, from, to, why: "researched", citations: [], warn: [], key: `ah:parent:${accountId}:${to}` });

const QUOTE = { url: "https://child.test/about", quote: "Child SAS has its head office in Paris" };
const fieldItem = (fields: Record<string, string>, expect: Record<string, string | null>) =>
  ({ op: "set_fields", accountId: "child", fields, expect, why: "researched", citations: [QUOTE], warn: [], key: `ah:fields:child:${Object.entries(fields).map(([f, v]) => `${f}=${v}`).join(",")}` });
const COUNTRY = "ah:fields:child:country=France";

// The record pages' link changes read through the caller's client (a memory record service); a field fix's edit goes through
// records.ts's own client, the stand-in record service in Convex tables (convexFakeStore). Both hold the same companies.
let client = createFakeRecordClient({ store: createMemoryRecordStore() });
const files = loadConvex(["accountHierarchy.ts", "associations.ts", "hubspotImport.ts", "records.ts", "canon.ts", "hubspot.ts", "objects.ts", "recordMerges.ts"], { "records.ts": (real) => ({ ...real, callerClient: () => client }) });

/** Companies in the stand-in record service (records.ts convexFakeStore), each with a country unless `countries` says otherwise. */
async function fixture(opts: { provider?: "canon" | "salesforce"; companies?: string[]; countries?: Record<string, string>; industries?: Record<string, string>; fill?: Record<string, string>; rules?: ObjectRule[] } = {}) {
  const companies = opts.companies ?? ["top", "old", "child"];
  const rows = companies.map((id) => ({ id, name: id, domain: `${id}.test`, fit: 0, status: "new", segmentIds: [], source: "test", version: 1, updatedAt: 1, ...(opts.countries?.[id] ? { country: opts.countries[id] } : {}), ...(opts.industries?.[id] ? { industry: opts.industries[id] } : {}) }) as AccountRow);
  const store = createMemoryRecordStore();
  await store.putAccounts("org", rows);
  client = createFakeRecordClient({ store });
  const items = [
    parentItem("child", "old", "top"), parentItem("top", null, "child"), { op: "merge", survivorId: "top", loserId: "old", fill: opts.fill ?? {}, why: "dup", moves: "", warn: [], key: "ah:merge:old" },
    fieldItem({ country: "France" }, { country: opts.countries?.child ?? null }), fieldItem({ BillingCountry: "France" }, { BillingCountry: null }),
    fieldItem({ industry: "Luxury goods" }, { industry: "Software" }),
  ];
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org" }],
    users: [{ _id: "admin", clerkUserId: "clerk_admin", orgId: "org", role: "admin", isActive: true, name: "Ada" }],
    hierarchyScans: [{ _id: "scan", orgId: "org", provider: opts.provider ?? "canon", status: "done", startedBy: "admin", startedAt: 1 }],
    hierarchyGroups: [{ _id: "group", orgId: "org", scanId: "scan", rank: 0, groupKey: "g", size: 3, shellCount: 0, accounts: companies.map((id) => ({ id, name: id, shell: false })), reasons: [], suggestedRootId: "top" }],
    hierarchyResearch: [{
      _id: "research", orgId: "org", scanId: "scan", groupId: "group", groupName: "Top", rootAccountId: "top", status: "done", startedBy: "admin", startedAt: 1, proposal: { items },
      verification: { checkedAt: "2026-11-10T00:00:00Z", checks: [{ ...QUOTE, result: "verified" }] },
    }],
    fakeRecordAccounts: rows.map((row) => ({ _id: `fakeRecordAccounts:${row.id}`, ws: "org", recordId: row.id, row })),
  });
  const ctx = (): any => ({
    db,
    auth: { getUserIdentity: async () => ({ subject: "clerk_admin", tokenIdentifier: "token_admin", org_id: "clerk_org" }) },
    scheduler: { runAfter: async () => null },
  });
  const call = (ref: unknown, args: any) => {
    const [, file, fn] = String(ref).split(".");
    // A role with rules is a manager: an admin's access ignores rules.
    if (`${file}.${fn}` === "records.callerContext") return { orgId: "org", userId: "admin", name: "Ada", role: "admin", access: accessOf({ userId: "admin", role: opts.rules ? "manager" : "admin", rules: opts.rules ?? null }) };
    const cp = db.checkpoint();
    return files[`${file}.ts`][fn].handler(ctx(), args).catch((error: unknown) => { db.rollback(cp); throw error; });
  };
  const actionCtx = { ...ctx(), runQuery: call, runMutation: call };
  const h = files["accountHierarchy.ts"];
  const parentOf = async (id: string) => (await files["associations.ts"].edges.handler(ctx(), { orgId: "org", association: "account_parent", side: "from", id })).active.map((e: { toId: string }) => e.toId);
  const setParent = (accountId: string, parentId: string | null) => files["associations.ts"].apply.handler(ctx(), { orgId: "org", userId: "admin", command: { op: "setParent", accountId, parentId } });
  const args = (accountId = "child", to = "top") => ({ researchId: "research", itemKey: `ah:parent:${accountId}:${to}` });
  const decision = async (key = args().itemKey) => plain((await h.group.handler(ctx(), { groupId: "group" })).decisions[key] ?? null);
  const approve = (a = args()) => h.approveParent.handler(actionCtx, a).then(plain);
  const undo = (a = args()) => h.undoParent.handler(actionCtx, a).then(plain);
  const hubspotParent = (accountId: string, parentId: string) =>
    files["hubspotImport.ts"].writeLinks.handler(ctx(), { orgId: "org", userId: "admin", links: [{ kind: "parent", ref: `hs-${accountId}`, accountId, parentId }] });
  const useCrmParent = (accountId: string, crmRef: string) => files["associations.ts"].useCrmParent.handler(actionCtx, { accountId, crmRef }).then(plain);
  const fix = (itemKey = COUNTRY) => h.approveFields.handler(actionCtx, { researchId: "research", itemKey }).then(plain);
  const undoFix = (itemKey = COUNTRY) => h.undoFields.handler(actionCtx, { researchId: "research", itemKey }).then(plain);
  /** Whether the company holds `values` in Canon (its ledger). */
  const holds = (values: Record<string, string | null>) => files["canon.ts"].recordHolds.handler(ctx(), { orgId: "org", object: "account", recordId: "child", values });
  const country = (value: string | null) => holds({ country: value });
  /** The company's row in the stand-in record service. */
  const row = async () => plain((await files["records.ts"].fakeGetAccounts.handler(ctx(), { ws: "org", ids: ["child"] }))[0]);
  const ledger = (): any[] => plain(f.db.rows("ledgerEntries").filter((e: any) => e.body?.kind === "assert"));
  const edit = (patch: Record<string, unknown>, id = "child") => files["records.ts"].edit.handler(actionCtx, { object: "account", id, patch, idempotencyKey: `edit:${id}:${JSON.stringify(patch)}` });
  const hubspotIndustry = (industry: string, id = "child") =>
    files["hubspot.ts"].upsertAccounts.handler(ctx(), { orgId: "org", accounts: [{ crmId: `hs-${id}`, name: id, domain: `${id}.test`, industry }] });
  /** The company as a HubSpot sync first wrote it, its register row linked to that stream, as the projector links it. */
  const fromHubspot = async (value: string, id = "child") => {
    await hubspotIndustry(value, id);
    const stream = db.rows("canonExternalIds").find((x) => x.provider === "hubspot:account" && x.externalId === `hs-${id}`)!.entityId;
    const row = db.rows("fakeRecordAccounts").find((r) => r.recordId === id)!;
    await db.patch(row._id, { row: { ...(row.row as object), stream } });
  };
  const merge = () => h.approveMerge.handler(actionCtx, { researchId: "research", itemKey: "ah:merge:old" }).then(plain);
  const undoMerge = () => h.undoMerge.handler(actionCtx, { researchId: "research", itemKey: "ah:merge:old" }).then(plain);
  /** The stream a record id names, and the one it was merged into, if any. */
  const streamOf = (id: string) => db.rows("canonExternalIds").find((x) => x.provider === "record:account" && x.externalId === id)?.entityId as string | undefined;
  const mergedInto = (id: string) => (db.rows("canonEntities").find((e) => e._id === streamOf(id))?.mergedInto ?? null) as string | null;
  const f = { merge, undoMerge, streamOf, mergedInto, fromHubspot, db, h, ctx, parentOf, setParent, args, decision, approve, undo, hubspotParent, useCrmParent, fix, undoFix, holds, country, row, ledger, edit, hubspotIndustry };
  await setParent("child", "old");
  return f;
}

test("approving a Canon parent move links the company under its new parent as the approver, and approving again changes nothing", async () => {
  const f = await fixture();
  assert.deepEqual(await f.approve(), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["top"]);
  const d = await f.decision();
  assert.equal(d.decision, "approved");
  assert.equal(d.decidedBy, "Ada");
  assert.equal(typeof d.appliedAt, "number");
  assert.deepEqual(plain(f.db.rows("ledgerEntries").at(-1)?.actor), { kind: "user", id: "admin" });
  assert.deepEqual(plain((await f.h.group.handler(f.ctx(), { groupId: "group" })).parents), { top: null, old: null, child: "top" });

  const entries = f.db.rows("ledgerEntries").length;
  assert.deepEqual(await f.approve(), { status: "unchanged" });
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  assert.deepEqual(await f.decision(), d);
});

test("a parent changed since the scan is refused, kept on the decision, and nothing is written", async () => {
  const f = await fixture({ companies: ["top", "old", "child", "elsewhere"] });
  await f.setParent("child", "elsewhere");
  const entries = f.db.rows("ledgerEntries").length;
  const result = await f.approve();
  assert.equal(result.status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["elsewhere"]);
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  const d = await f.decision();
  assert.equal(d.applyError, result.message);
  assert.equal(d.appliedAt, undefined);
});

test("a cycle is refused and kept, and the move applies once its cause is fixed", async () => {
  const f = await fixture();
  // Proposed: top under child, while child sits under old; first put old under top, so child is below top.
  await f.setParent("old", "top");
  const refused = await f.approve(f.args("top", "child"));
  assert.equal(refused.status, "invalid");
  assert.deepEqual(await f.parentOf("top"), []);
  assert.equal((await f.decision(f.args("top", "child").itemKey)).applyError, refused.message);

  await f.setParent("old", null);
  assert.deepEqual(await f.approve(f.args("top", "child")), { status: "applied" });
  const d = await f.decision(f.args("top", "child").itemKey);
  assert.equal(d.applyError, undefined);
  assert.equal(typeof d.appliedAt, "number");
});

test("a parent the approver cannot see is refused through the record flow and kept; nothing is written", async () => {
  const f = await fixture({ companies: ["old", "child"] });
  const entries = f.db.rows("ledgerEntries").length;
  const result = await f.approve();
  assert.equal(result.status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  assert.equal((await f.decision()).applyError, result.message);
});

test("undo puts the previous parent back and clears the decision; once the parent moved again, undo is refused", async () => {
  const f = await fixture({ companies: ["top", "old", "child", "elsewhere"] });
  await f.approve();
  await assert.rejects(f.h.decide.handler(f.ctx(), { ...f.args(), decision: "rejected" }));
  await assert.rejects(f.h.decide.handler(f.ctx(), { ...f.args(), decision: "clear" }));
  assert.deepEqual(await f.undo(), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.equal(await f.decision(), null);

  await f.approve();
  await f.setParent("child", "elsewhere");
  assert.equal((await f.undo()).status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["elsewhere"]);
  assert.equal(typeof (await f.decision()).appliedAt, "number");
});

test("rejecting writes nothing, a Canon scan's items are approved only by applying them, and Salesforce scans record the decision only", async () => {
  const canon = await fixture();
  const entries = canon.db.rows("ledgerEntries").length;
  await canon.h.decide.handler(canon.ctx(), { ...canon.args(), decision: "rejected" });
  await canon.h.decide.handler(canon.ctx(), { researchId: "research", itemKey: "ah:merge:old", decision: "rejected" });
  await assert.rejects(canon.h.decide.handler(canon.ctx(), { researchId: "research", itemKey: "ah:merge:old", decision: "approved" }));
  await assert.rejects(canon.h.decide.handler(canon.ctx(), { ...canon.args(), decision: "approved" }));
  assert.equal(canon.db.rows("ledgerEntries").length, entries);
  assert.deepEqual(await canon.parentOf("child"), ["old"]);
  assert.equal((await canon.decision("ah:merge:old")).decision, "rejected");

  const sf = await fixture({ provider: "salesforce" });
  const before = sf.db.rows("ledgerEntries").length;
  await sf.h.decide.handler(sf.ctx(), { ...sf.args(), decision: "approved" });
  await assert.rejects(sf.approve());
  assert.equal(sf.db.rows("ledgerEntries").length, before);
  assert.equal((await sf.decision()).decision, "approved");
  assert.equal((await sf.decision()).appliedAt, undefined);
});

test("an approved move holds against the next CRM import, whose parent the group page shows; using it hands the parent back to the CRM", async () => {
  const f = await fixture();
  await f.approve();
  await f.hubspotParent("child", "old");
  assert.deepEqual(await f.parentOf("child"), ["top"]);
  const group = plain(await f.h.group.handler(f.ctx(), { groupId: "group" }));
  assert.deepEqual(group.crmParents.child.map((c: { ref: string; parentId: string }) => [c.ref, c.parentId]), [["hubspot:hs-child", "old"]]);

  assert.deepEqual(await f.useCrmParent("child", "hubspot:hs-child"), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.deepEqual(plain(f.db.rows("ledgerEntries").at(-1)?.source), { kind: "hubspot", ref: "hubspot:hs-child" });
  assert.deepEqual(plain((await f.h.group.handler(f.ctx(), { groupId: "group" })).crmParents), {});
  await f.hubspotParent("child", "top");
  assert.deepEqual(await f.parentOf("child"), ["top"]);
});

test("approving a field fix sets the company's field as the approver's edit, with the research's quotes as its evidence; approving again writes nothing", async () => {
  const f = await fixture();
  assert.deepEqual(await f.fix(), { status: "applied" });
  assert.equal(await f.country("France"), true);
  const entry = f.ledger().at(-1);
  assert.deepEqual(entry.actor, { kind: "user", id: "admin" });
  assert.match(entry.source.ref, /^user:admin:.+:hierarchy:research:ah:fields:child:country=France:apply:\d+$/);
  assert.deepEqual(entry.body.assertions.map((a: { fieldId: string; value: unknown }) => [a.fieldId, a.value]), [["country", "France"]]);
  assert.equal(entry.body.assertions[0].evidence, '"Child SAS has its head office in Paris" (https://child.test/about; verified)\n\nSource: account hierarchy research for Top, quotes checked 2026-11-10');
  const fact: any = plain(f.db.rows("facts").find((x) => x.attribute === "country" && x.value === "France"));
  assert.equal(fact.evidence, entry.body.assertions[0].evidence);
  const d = await f.decision(COUNTRY);
  assert.equal(d.decidedBy, "Ada");
  assert.equal(typeof d.appliedAt, "number");

  const entries = f.ledger().length;
  assert.deepEqual(await f.fix(), { status: "unchanged" });
  assert.equal(f.ledger().length, entries);
});

test("an applied fix holds against the next CRM sync, like any person's edit", async () => {
  const f = await fixture();
  await f.fromHubspot("Software");
  assert.deepEqual(await f.fix("ah:fields:child:industry=Luxury goods"), { status: "applied" });
  await f.hubspotIndustry("Retail");
  assert.equal(await f.holds({ industry: "Luxury goods" }), true);
});

test("a fix whose fields changed since the scan, names a field Canon has no edit for, or that the approver's role may not edit, is refused and kept; nothing is written", async () => {
  const changed = await fixture();
  await changed.edit({ country: "Spain" });
  const entries = changed.ledger().length;
  const result = await changed.fix();
  assert.equal(result.status, "invalid");
  assert.equal(await changed.country("Spain"), true);
  assert.equal((await changed.row()).country, "Spain");
  assert.equal(changed.ledger().length, entries);
  assert.equal((await changed.decision(COUNTRY)).applyError, result.message);

  const unknown = await fixture();
  const billing = await unknown.fix("ah:fields:child:BillingCountry=France");
  assert.equal(billing.status, "invalid");
  assert.equal((await unknown.decision("ah:fields:child:BillingCountry=France")).applyError, billing.message);

  const locked = await fixture({ rules: [{ object: "account", fields: [{ apiName: "country", level: "readOnly" }] }] });
  const before = locked.ledger().length;
  const refused = await locked.fix();
  assert.equal(refused.status, "invalid");
  assert.equal(locked.ledger().length, before);
  assert.equal((await locked.decision(COUNTRY)).applyError, refused.message);
});

test("undo puts the scan's value back and clears the decision; once the field changed again, undo is refused", async () => {
  const f = await fixture({ countries: { child: "Italy" } });
  await f.fix();
  await assert.rejects(f.h.decide.handler(f.ctx(), { researchId: "research", itemKey: COUNTRY, decision: "rejected" }));
  assert.deepEqual(await f.undoFix(), { status: "applied" });
  assert.equal(await f.country("Italy"), true);
  assert.equal(await f.decision(COUNTRY), null);

  await f.fix();
  await f.edit({ country: "Spain" });
  assert.equal((await f.undoFix()).status, "invalid");
  assert.equal(await f.country("Spain"), true);
  assert.equal((await f.row()).country, "Spain");
  assert.equal(typeof (await f.decision(COUNTRY)).appliedAt, "number");
});

test("approving a merge merges the duplicate into the company kept, as the approver: its links, deals and the blank fields it fills move; approving again changes nothing", async () => {
  const f = await fixture({ industries: { old: "Lighting" }, fill: { industry: "Lighting" } });
  await f.db.insert("deals", { orgId: "org", companyId: "old", name: "Old renewal", isClosed: false, isWon: false, closeDate: "2026-12-01" });
  assert.deepEqual(await f.merge(), { status: "applied" });
  assert.equal(f.mergedInto("old"), f.streamOf("top"));
  assert.deepEqual(await f.parentOf("child"), ["top"]);
  assert.deepEqual(plain(f.db.rows("deals").map((d) => d.companyId)), ["top"]);
  assert.equal(await files["canon.ts"].recordHolds.handler(f.ctx(), { orgId: "org", object: "account", recordId: "top", values: { industry: "Lighting" } }), true);
  const d = await f.decision("ah:merge:old");
  assert.equal(d.decidedBy, "Ada");
  assert.equal(typeof d.appliedAt, "number");
  assert.equal(f.db.rows("recordMerges").length, 1);
  assert.equal(f.db.rows("recordMerges")[0].mergedBy, "admin");

  assert.deepEqual(await f.merge(), { status: "unchanged" });
  assert.equal(f.db.rows("recordMerges").length, 1);
});

test("a merge naming a company the approver cannot see, or whose survivor filled the field since the scan, is refused and kept; nothing is merged", async () => {
  const hidden = await fixture({ companies: ["top", "child"] });
  const entries = hidden.db.rows("ledgerEntries").length;
  const result = await hidden.merge();
  assert.equal(result.status, "invalid");
  assert.equal(hidden.db.rows("ledgerEntries").length, entries);
  assert.equal(hidden.db.rows("recordMerges").length, 0);
  assert.equal((await hidden.decision("ah:merge:old")).applyError, result.message);

  const stale = await fixture({ industries: { old: "Lighting" }, fill: { industry: "Lighting" } });
  await stale.edit({ industry: "Retail" }, "top");
  const refused = await stale.merge();
  assert.equal(refused.status, "invalid");
  assert.equal(stale.mergedInto("old"), null);
  assert.equal(stale.db.rows("recordMerges").length, 0);
  assert.equal(await files["canon.ts"].recordHolds.handler(stale.ctx(), { orgId: "org", object: "account", recordId: "top", values: { industry: "Retail" } }), true);
  assert.equal((await stale.decision("ah:merge:old")).applyError, refused.message);
});

test("after a merge, a CRM sync of the merged-away company lands on the company kept; undo puts both back", async () => {
  const f = await fixture();
  await f.fromHubspot("Software", "old");
  await f.merge();
  await f.hubspotIndustry("Retail", "old");
  assert.equal(f.mergedInto("old"), f.streamOf("top"));
  assert.equal(await f.h.group.handler(f.ctx(), { groupId: "group" }).then((g: any) => typeof g.decisions["ah:merge:old"].appliedAt), "number");
  const topHolds = (industry: string) => files["canon.ts"].recordHolds.handler(f.ctx(), { orgId: "org", object: "account", recordId: "top", values: { industry } });
  assert.equal(await topHolds("Retail"), true);
  // A field a person set on the company kept holds against the merged-away record's CRM, as against its own.
  await f.edit({ industry: "Luxury goods" }, "top");
  await f.hubspotIndustry("Wholesale", "old");
  assert.equal(await topHolds("Luxury goods"), true);
  assert.deepEqual(plain(f.db.rows("parentDisagreements").filter((d) => d.association === "field").map((d) => [d.crmRef, d.attribute, d.crmValue])), [["hubspot:account:hs-old", "industry", "Wholesale"]]);

  assert.deepEqual(await f.undoMerge(), { status: "applied" });
  assert.equal(f.mergedInto("old"), null);
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.equal(await f.decision("ah:merge:old"), null);
});
