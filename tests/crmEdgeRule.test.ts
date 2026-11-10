import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { applyEdgeCommand, type EdgeStore } from "../convex/lib/objects/associations.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const files = loadConvex(["associations.ts", "hubspotImport.ts", "salesforceImportCanon.ts", "dealCommittee.ts"]);
const assoc = files["associations.ts"];

/** A workspace with one deal (stream `deal-s`, Salesforce `006A`) and people Salesforce knows by id. */
function world(crmImports: Array<Record<string, unknown>> = []) {
  const db = memoryDb({
    organizations: [{ _id: "org" }],
    users: [{ _id: "admin", orgId: "org", role: "admin", isActive: true }],
    canonEntities: [{ _id: "deal-s", orgId: "org", entityType: "opportunity", projectionTable: "deals", projectionId: "deal-1" }],
    deals: [{ _id: "deal-1", orgId: "org", crmId: "006A", name: "Atlas renewal" }],
    sfImportIds: ["jane", "bob"].map((n) => ({ _id: `sf-${n}`, orgId: "org", sfId: `003${n}`, canonId: `con_${n}` })).concat([{ _id: "sf-deal", orgId: "org", sfId: "006A", canonId: "deal-s" }]),
    crmImports,
  });
  const ctx = (): any => ({ db });
  const person = (command: unknown) => assoc.apply.handler(ctx(), { orgId: "org", userId: "admin", command });
  const personOnDeal = (command: unknown, crm?: string) =>
    files["dealCommittee.ts"].apply.handler(ctx(), { orgId: "org", userId: "admin", streamId: "deal-s", command, ...(crm ? { crm } : {}) });
  const hubspot = (links: unknown[]) => files["hubspotImport.ts"].writeLinks.handler(ctx(), { orgId: "org", userId: "admin", links });
  const hubspotCompanies = (companyIds: string[]) => hubspot([{ kind: "companies", ref: "hs-1", contactId: "con_1", companyIds }]);
  const salesforceRoles = (roles: Array<[string, string]>) =>
    files["salesforceImportCanon.ts"].setDealRoles.handler(ctx(), { orgId: "org", deals: [{ opportunitySfId: "006A", roles: roles.map(([n, role]) => ({ roleSfId: `00K${n}`, contactSfId: `003${n}`, role })) }] });
  const hubspotRoles = (roles: Array<[string, string]>) =>
    hubspot([{ kind: "people", ref: "hs-deal", streamId: "deal-s", members: roles.map(([n, role]) => ({ contactId: `con_${n}`, role })) }]);
  /** A person's companies, the primary starred. */
  const companies = async () =>
    (await assoc.edges.handler(ctx(), { orgId: "org", association: "contact_account", side: "from", id: "con_1" })).active.map((e: any) => `${e.toId}${e.primary ? "*" : ""}`);
  /** The deal's people and their roles. */
  const people = async () =>
    (await assoc.edges.handler(ctx(), { orgId: "org", association: "deal_contact", side: "from", id: "deal-s" })).active.map((e: any) => `${e.toId.slice(4)}:${e.label}`).sort();
  /** What CRMs say that Canon kept against: the far end, starred when it is a primary claim, with a role when it is one. */
  const claims = () => db.rows("parentDisagreements").map((d: any) => `${d.crmParentId}${d.primary ? "*" : ""}${d.crmLabel ? `:${d.crmLabel}` : ""}`).sort();
  const claimId = () => db.rows("parentDisagreements")[0]._id as string;
  return { db, ctx, person, personOnDeal, hubspotCompanies, salesforceRoles, hubspotRoles, companies, people, claims, claimId };
}

test("HubSpot leaves off a company a person took someone off, says so once, and stops when HubSpot drops it", async () => {
  const w = world();
  await w.person({ op: "link", fromId: "con_1", toId: "acc_a" });
  await w.person({ op: "link", fromId: "con_1", toId: "acc_b" });
  await w.person({ op: "unlink", fromId: "con_1", toId: "acc_b" });
  await w.hubspotCompanies(["acc_a", "acc_b"]);
  await w.hubspotCompanies(["acc_a", "acc_b"]);
  assert.deepEqual(await w.companies(), ["acc_a*"]);
  assert.deepEqual(w.claims(), ["acc_b"]);
  await w.hubspotCompanies(["acc_a"]);
  assert.deepEqual(w.claims(), []);
});

test("HubSpot moves a primary company it chose, keeps one a person chose, and says so once until it agrees", async () => {
  const w = world();
  await w.hubspotCompanies(["acc_a", "acc_b"]);
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  assert.deepEqual(await w.companies(), ["acc_a", "acc_b*"]);
  await w.person({ op: "makePrimary", fromId: "con_1", toId: "acc_a" });
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  assert.deepEqual(await w.companies(), ["acc_a*", "acc_b"]);
  assert.deepEqual(w.claims(), ["acc_b*"]);
  await w.hubspotCompanies(["acc_a", "acc_b"]);
  assert.deepEqual(w.claims(), []);
});

test("using HubSpot's primary company writes it and hands the primary back to HubSpot", async () => {
  const w = world();
  await w.person({ op: "link", fromId: "con_1", toId: "acc_a" });
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  assert.deepEqual(w.claims(), ["acc_b*"]);
  assert.equal((await assoc.applyCrm.handler(w.ctx(), { orgId: "org", userId: "admin", id: w.claimId(), toId: "acc_b" })).status, "applied");
  assert.deepEqual([await w.companies(), w.claims()], [["acc_a", "acc_b*"], []]);
  await w.hubspotCompanies(["acc_a", "acc_b"]);
  assert.deepEqual(await w.companies(), ["acc_a*", "acc_b"]);
});

for (const [crm, send] of [["Salesforce", "salesforceRoles"], ["HubSpot", "hubspotRoles"]] as const) {
  test(`${crm} changes a deal role it gave, keeps one a person gave and a person they took off, and says so once`, async () => {
    const w = world();
    await w[send]([["jane", "champion"], ["bob", "user"]]);
    await w[send]([["jane", "champion"], ["bob", "signer"]]);
    assert.deepEqual(await w.people(), ["bob:signer", "jane:champion"]);
    await w.personOnDeal({ op: "setRole", contactId: "con_jane", role: "executive" });
    await w.personOnDeal({ op: "removeFromDeal", contactId: "con_bob" });
    await w[send]([["jane", "champion"], ["bob", "signer"]]);
    await w[send]([["jane", "champion"], ["bob", "signer"]]);
    assert.deepEqual(await w.people(), ["jane:executive"]);
    assert.deepEqual(w.claims(), ["con_bob:signer", "con_jane:champion"]);
    await w[send]([["jane", "executive"], ["bob", "signer"]]);
    assert.deepEqual(w.claims(), ["con_bob:signer"]);
  });
}

test("Salesforce removes a role it gave and no longer has, but not one a person removed and put back", async () => {
  const w = world();
  await w.salesforceRoles([["jane", "champion"], ["bob", "user"]]);
  await w.personOnDeal({ op: "removeFromDeal", contactId: "con_bob" });
  await w.personOnDeal({ op: "setRole", contactId: "con_bob", role: "user" });
  await w.salesforceRoles([["jane", "champion"]]);
  await w.salesforceRoles([]);
  assert.deepEqual(await w.people(), ["bob:user"]);
});

test("using Salesforce's role writes it and hands the role back to Salesforce", async () => {
  const w = world();
  await w.salesforceRoles([["jane", "champion"]]);
  await w.personOnDeal({ op: "setRole", contactId: "con_jane", role: "executive" });
  await w.salesforceRoles([["jane", "champion"]]);
  assert.equal((await w.personOnDeal({ op: "setRole", contactId: "con_jane", role: "champion" }, w.claimId())).status, "applied");
  assert.deepEqual(w.claims(), []);
  await w.salesforceRoles([["jane", "n1"]]);
  assert.deepEqual(await w.people(), ["jane:n1"]);
});

test("a CRM does not put back a record a person took an activity off", async () => {
  const w = world();
  const store = (assoc.edgeStore as unknown as (ctx: unknown) => EdgeStore)(w.ctx());
  const crm = { orgId: "org", source: { kind: "salesforce" as const, ref: "salesforce:00T1" }, actor: { kind: "integration" as const, id: "salesforce" }, now: 1 };
  await applyEdgeCommand(store, crm, { op: "target", activityId: "task-s", toIds: ["con_1", "deal-s"] });
  await applyEdgeCommand(store, { ...crm, source: { kind: "user", ref: "user:admin" }, actor: { kind: "user", id: "admin" } }, { op: "untarget", activityId: "task-s", toIds: ["con_1"] });
  await applyEdgeCommand(store, crm, { op: "target", activityId: "task-s", toIds: ["con_1", "deal-s"] });
  const targets = await assoc.edges.handler(w.ctx(), { orgId: "org", association: "activity_target" as any, side: "from", id: "task-s" });
  assert.deepEqual(targets.active.map((e: any) => e.toId), ["deal-s"]);
});

test("links from before HubSpot imports wrote as HubSpot follow HubSpot; with a run's marker for them, a person's hold", async () => {
  const now = Date.now();
  // A run of the import from between #1189 and this change: it wrote parents as HubSpot and a person's companies as the person.
  const w = world([{ _id: "run", orgId: "org", provider: "hubspot", status: "running", startedBy: "admin", startedAt: now - 1000, heartbeatAt: now, parentLinksAs: "hubspot" }]);
  await w.person({ op: "link", fromId: "con_1", toId: "acc_a" });
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  assert.deepEqual(await w.companies(), ["acc_a", "acc_b*"]);
  w.db.rows("crmImports")[0].linksAs = "hubspot";
  await w.person({ op: "makePrimary", fromId: "con_1", toId: "acc_a" });
  await w.hubspotCompanies(["acc_b", "acc_a"]);
  assert.deepEqual(await w.companies(), ["acc_a*", "acc_b"]);
});

test("a HubSpot parent from before imports wrote as HubSpot follows HubSpot; one the same person set while no such run was going holds", async () => {
  const now = Date.now();
  const w = world([
    { _id: "old", orgId: "org", provider: "hubspot", status: "completed", startedBy: "admin", startedAt: 1, finishedAt: 2, heartbeatAt: 2 },
    { _id: "legacy", orgId: "org", provider: "hubspot", status: "running", startedBy: "admin", startedAt: now - 1000, heartbeatAt: now },
  ]);
  const fromHubspot = (accountId: string, parentId: string) =>
    files["hubspotImport.ts"].writeLinks.handler(w.ctx(), { orgId: "org", userId: "admin", links: [{ kind: "parent", ref: accountId, accountId, parentId }] });
  const parentOf = async (id: string) => (await assoc.edges.handler(w.ctx(), { orgId: "org", association: "account_parent", side: "from", id })).active.map((e: any) => e.toId);

  await w.person({ op: "setParent", accountId: "imported", parentId: "a" });
  await fromHubspot("imported", "b");
  assert.deepEqual(await parentOf("imported"), ["b"]);

  w.db.rows("crmImports").find((r: any) => r._id === "legacy")!.parentLinksAs = "hubspot";
  await w.person({ op: "setParent", accountId: "worked", parentId: "a" });
  await fromHubspot("worked", "b");
  assert.deepEqual(await parentOf("worked"), ["a"]);
  assert.deepEqual(w.db.rows("parentDisagreements").map((d: any) => [d.accountId, d.provider, d.crmParentId]), [["worked", "hubspot", "b"]]);
});

/**
 * Every file that writes links. A person's writes go through applyEdgeCommand with a person as actor; an
 * integration's with an `integration` actor and its CRM record as source, which sends them through the CRM rule
 * (EdgeWriter.crm), so a person's choice wins. `writer` is the edge writer itself; a `port` hands links to an
 * integration writer. A new writer must be added here
 * as one or the other, with a test of its own.
 */
const LINK_WRITERS: Record<string, "person" | "integration" | "writer" | "port"> = {
  "convex/lib/objects/associations.ts": "writer",
  // The Salesforce import engine sends deal roles to salesforceImportCanon.setDealRoles through its Canon port.
  "engine/src/sync/salesforceImport/contracts.ts": "port",
  "engine/src/sync/salesforceImport/engine.ts": "port",
  "convex/lib/canon/partyMerge.ts": "person",
  "convex/associations.ts": "person",
  "convex/accountHierarchy.ts": "person",
  "convex/dealCommittee.ts": "person",
  "convex/csvImports.ts": "person",
  "convex/leadConversion.ts": "person",
  "convex/dealGaps.ts": "person",
  "convex/callSuggestions.ts": "person",
  "convex/activityTargets.ts": "person",
  "convex/salesforceImportCanon.ts": "integration",
  "convex/hubspotImport.ts": "integration",
};

test("every link writer is a person's or goes through the CRM rule as an integration", () => {
  const root = join(import.meta.dirname, "..");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "_generated" || name === "node_modules") continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /\b(applyEdgeCommand|repointEdges|seedDealRoles|applyAsUser|setDealRoles)\(|class EdgeWriter/.test(readFileSync(path, "utf8"))) found.push(relative(root, path));
    }
  };
  for (const dir of ["convex", "src", "engine/src", "modules", "services/record-service/src"]) walk(join(root, dir));
  assert.deepEqual(found.sort(), Object.keys(LINK_WRITERS).sort());
  for (const [file, kind] of Object.entries(LINK_WRITERS)) {
    if (kind !== "integration") continue;
    const source = readFileSync(join(root, file), "utf8");
    assert.match(source, /actor: \{ kind: "integration" as const, id: "(salesforce|hubspot)" \}/, file);
    // An integration never writes links as a person, which would make the CRM's links look like a person's choices.
    assert.doesNotMatch(source, /kind: "user" as const, ref: `user:/, file);
    assert.doesNotMatch(source, /\b(applyAsUser|setDealRoles)\(ctx/, file);
  }
});
