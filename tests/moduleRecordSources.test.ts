/** RP2: every Canon object as a module report source (docs/modules.md, "Reports and charts"). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessOf, hiddenFields } from "../convex/lib/access.ts";
import { ListRequestError } from "../convex/lib/objects/listSpec.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow, ContactRow } from "../convex/lib/recordContract.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { reportSource, canonSourceFields, grantsSource, expandSources, standardRecordFields } from "../modules/kernel/reports.ts";
import { canonReportRequest, standardListDef, recordReportFields } from "../convex/lib/modules/recordReportFields.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";

const account = (id: string, industry: string, employees: number, ownerId: string) =>
  ({ id, domain: `${id}.example`, name: id, industry, employees, ownerId, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1 }) as AccountRow;
const person = (id: string, accountId: string) => ({ id, accountId, fullName: id, status: "new", updatedAt: 1 }) as ContactRow;

test("a module's companies and people reports count what Canon's own report counts", async () => {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", [account("atlas", "Software", 120, "u1"), account("boreal", "Software", 30, "u2"), account("cove", "Retail", 8, "u1")]);
  await store.putContacts("ws", [person("ana", "atlas"), person("ben", "boreal"), person("cy", "cove"), person("di", "atlas")]);
  const client = createFakeRecordClient({ store });
  const companies = { filter: [], groupBy: [{ field: "industry" }], measures: [{ fn: "count" as const }, { fn: "sum" as const, field: "employees" }] };
  const fromModule = await client.aggregate("ws", "account", canonReportRequest(companies, standardRecordFields("account")!, "Companies"));
  // convex/reports.ts run: the spec as Canon's builder sends it.
  const canon = await client.aggregate("ws", "account", companies);
  assert.deepEqual(fromModule.groups, [{ keys: ["Retail"], values: [1, 8] }, { keys: ["Software"], values: [2, 150] }]);
  assert.deepEqual([fromModule.groups, fromModule.total], [canon.groups, canon.total]);
  // A person's company's industry: grouped through the lookup, as Canon's builder follows it.
  const people = await client.aggregate("ws", "contact", canonReportRequest({ filter: [], groupBy: [{ field: "accountId.industry" }], measures: [{ fn: "count" }] }, standardRecordFields("contact")!, "People"));
  assert.deepEqual(people.groups, (await client.aggregate("ws", "contact", { groupBy: [{ field: "industry", via: "accountId" }], measures: [{ fn: "count" }] })).groups);
  assert.deepEqual(people.groups, [{ keys: ["Retail"], values: [1] }, { keys: ["Software"], values: [3] }]);
  const legacy = canonReportRequest({ filter: [], groupBy: [{ field: "industry", via: "accountId" }], measures: [{ fn: "count" }] }, standardRecordFields("contact")!, "People");
  assert.deepEqual((await client.aggregate("ws", "contact", legacy)).groups, people.groups);
});

test("a field the caller's role hides is neither offered nor accepted, on the object or through a lookup", () => {
  const rep = accessOf({ userId: "u1", role: "rep", rules: [{ object: "account", fields: [{ apiName: "industry", level: "hidden" }] }] });
  const hidden = (o: string) => new Set(hiddenFields(rep, o));
  const companies = recordReportFields("account", standardListDef("account")!, standardListDef, hidden);
  const people = recordReportFields("contact", standardListDef("contact")!, standardListDef, hidden);
  assert.deepEqual([companies.some((f) => f.name === "industry"), people.some((f) => f.name === "accountId.industry"), people.some((f) => f.name === "accountId.country")], [false, false, true]);
  assert.throws(() => canonReportRequest({ filter: [], groupBy: [{ field: "industry" }], measures: [{ fn: "count" }] }, companies, "Companies"), ListRequestError);
  // A related record's field groups; it doesn't filter.
  assert.throws(() => canonReportRequest({ filter: [{ field: "accountId.country", op: "eq", value: "US" }], groupBy: [], measures: [{ fn: "count" }] }, people, "People"), ListRequestError);
});

test("reads.records grants Canon sources: unread ones are refused, canon.* needs it, and an upgrade approves it", () => {
  // The Reports module with only its builder page, the page these grants are for (its Pacing page reads deals itself).
  const shipped = JSON.parse(readFileSync("modules/examples/reports/module.json", "utf8"));
  delete shipped.reports; delete shipped.dashboards;
  const page = shipped.pages.find((p: { body: { c: string }[] }) => p.body.some((n) => n.c === "report"));
  const reports = { ...shipped, nav: { ...shipped.nav, landing: page.path }, pages: [page] };
  const builder = (m: typeof reports) => m.pages[0].body.find((n: { c: string }) => n.c === "report");
  const withSources = (records: string[] | undefined, sources: string[]) => {
    const m = structuredClone(reports);
    if (records) m.reads.records = records; else delete m.reads.records;
    builder(m).sources = sources;
    return parseModuleManifest(m);
  };
  const errors = (out: ReturnType<typeof parseModuleManifest>) => (out.ok ? [] : out.errors);
  assert.deepEqual(errors(withSources(["companies"], ["canon.companies", "canon.members"])), []);
  assert.equal(errors(withSources(["companies"], ["canon.people"])).length, 1);
  assert.equal(errors(withSources(undefined, ["canon.*"])).length, 1);
  assert.equal(errors(withSources(["bogus"], ["canon.members"])).length, 1);
  const parsed = withSources(["*"], ["canon.*"]);
  assert.ok(parsed.ok);
  const older = structuredClone(reports);
  delete older.reads.records;
  older.version = "0.1.0";
  builder(older).sources = ["canon.members"];
  const from = parseModuleManifest(older);
  assert.ok(from.ok);
  assert.deepEqual(planUpgrade(from.manifest, defaultSlots(from.manifest), parsed.manifest).newReads, ["reports on every record type"]);
});


test("stage history has an explicit field grant, participates in canon.*, and validates declared reports", () => {
  const reports = JSON.parse(readFileSync("modules/examples/reports/module.json", "utf8"));
  const fields = canonSourceFields(reports, "canon.stageHistory");
  assert.deepEqual(fields.map((f) => [f.name, f.type]), [["deal", "text"], ["stage", "picklist"], ["fromStage", "picklist"], ["changedAt", "datetime"], ["leftAt", "datetime"], ["daysInStage", "number"], ["daysSoFar", "number"], ["current", "checkbox"], ["ownerId", "user"]]);
  assert.ok(expandSources(["canon.*"], ["canon.stageHistory", "canon.deals"]).includes("canon.stageHistory"));
  assert.equal(grantsSource({ collections: {}, reads: { records: ["*"] } }, "canon.stageHistory"), false);
  const old = structuredClone(reports);
  old.pages = old.pages.filter((p: { path: string }) => p.path !== "stages");
  delete old.reads.stageHistory;
  const from = parseModuleManifest(old), to = parseModuleManifest(reports);
  assert.ok(from.ok && to.ok);
  assert.equal(planUpgrade(from.manifest, defaultSlots(from.manifest), to.manifest).newReads.length, fields.length);
  delete reports.reads.stageHistory;
  assert.equal(parseModuleManifest(reports).ok, false);
});


test("legacy report objects map to their RP2 sources without changing field names", () => {
  assert.deepEqual(["deal", "account", "contact", "lead", "activity", "task", "call", "meeting", "note", "product", "custom_projects", "canon.deals", "unknown"].map(reportSource),
    ["canon.deals", "canon.companies", "canon.people", "canon.leads", "canon.activities", "canon.tasks", "canon.calls", "canon.meetings", "canon.notes", "canon.products", "canon.custom_projects", "canon.deals", null]);
});
