import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessOf, agentPrincipals, mayWriteField, seesRunRecords, type Access, type ObjectRule } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow, ContactRow } from "../convex/lib/recordContract.ts";
import { findAccount } from "../convex/lib/agents/webhook.ts";
import { findContact } from "../convex/lib/agents/routing.ts";
import { askTools, recordAskData } from "../convex/lib/ask/tools.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { registerListDef } from "../convex/lib/objects/listSpec.ts";
import type { OwnerScope } from "../convex/lib/objects/listSpec.ts";
import { inventory } from "../scripts/visibility-inventory.ts";
import { ALLOWLIST } from "../scripts/visibility-allowlist.ts";

// Reps see only their own companies and people (CP14); Avery owns Atlas, Jordan owns Northstar.
const ownOnly: ObjectRule[] = [{ object: "account", visibility: "own", unowned: false }, { object: "contact", visibility: "own", unowned: false }];
const avery = accessOf({ userId: "avery", role: "rep", rules: ownOnly });
const jordan = accessOf({ userId: "jordan", role: "rep", rules: ownOnly });
const riley = accessOf({ userId: "riley", role: "admin", rules: ownOnly });
const averyNoRules = accessOf({ userId: "avery", role: "rep" });

async function workspace() {
  const store = createMemoryRecordStore();
  const account = (id: string, name: string, ownerId: string): AccountRow =>
    ({ id, domain: `${id}.example`, name, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId }) as AccountRow;
  const contact = (id: string, accountId: string, fullName: string, ownerId: string): ContactRow =>
    ({ id, accountId, fullName, email: `${id}@${accountId}.example`, status: "new", updatedAt: 1, ownerId }) as ContactRow;
  await store.putAccounts("ws", [account("atlas", "Atlas Cloud", "avery"), account("northstar", "Northstar Data", "jordan")]);
  await store.putContacts("ws", [contact("sam", "atlas", "Sam Rivera", "avery"), contact("lee", "northstar", "Lee Park", "jordan")]);
  return createFakeRecordClient({ store });
}
const noDeals = async (): Promise<OwnerScope | null> => null;
const asPrincipals = async (accesses: Access[]) => scopedRecordClient(await workspace(), accesses, noDeals);

test("a research run reads only what its owner and its starter both see", async () => {
  // An admin starts a run of Avery's field: it reads as Avery. With no rules saved it reads everything, as before.
  const cases: Array<[string, Access[], string[]]> = [
    ["owner Avery, started by admin Riley", [avery, riley], ["Atlas Cloud"]],
    ["owner admin Riley, started by Avery", [riley, avery], ["Atlas Cloud"]],
    ["owner Avery, started by Jordan", [avery, jordan], []],
    ["no rules saved", [averyNoRules], ["Atlas Cloud", "Northstar Data"]],
  ];
  for (const [name, accesses, names] of cases) {
    const client = await asPrincipals(accesses);
    // The calls a run makes: its scope's count and pages (by fit), a refresh's or probe's re-reads by id, and a contact field's pages.
    const page = await client.list("ws", { filter: {}, sort: { field: "fit", dir: "desc" }, limit: 50 });
    assert.deepEqual(page.rows.map((r) => r.name).sort(), names, name);
    assert.equal((await client.countSegment("ws", {})).total, names.length, name);
    assert.equal((await client.get("ws", "northstar"))?.account.name ?? null, names.includes("Northstar Data") ? "Northstar Data" : null, name);
    assert.equal((await client.getContact("ws", "lee"))?.fullName ?? null, names.includes("Northstar Data") ? "Lee Park" : null, name);
    const people = await client.listRegister("ws", "contact", { limit: 50 });
    assert.equal(people.total, names.length, name);
  }
});

test("an event agent's turn finds only its owner's account and contact", async () => {
  const owner = await asPrincipals([avery]);
  assert.equal((await findAccount(owner, "ws", "northstar.example")), null);
  assert.equal((await findAccount(owner, "ws", "atlas.example"))?.name, "Atlas Cloud");
  assert.equal(await findContact(owner, "ws", "lee@northstar.example"), null);
  assert.equal((await findContact(await asPrincipals([averyNoRules]), "ws", "lee@northstar.example")) !== null, true);
});

test("Ask Canon over an owner's reads: hidden companies, their receipts and hidden fields stay out", async () => {
  const fieldRules: ObjectRule[] = [...ownOnly.slice(1), { object: "account", visibility: "own", unowned: false, fields: [{ apiName: "industry", level: "hidden" }] }];
  const rep = accessOf({ userId: "avery", role: "rep", rules: fieldRules });
  const client = scopedRecordClient(await workspace(), [rep], noDeals);
  const receiptsAsked: string[] = [];
  const data = recordAskData(client, "ws", {
    describe: async (object) => {
      const def = registerListDef(object as "account", resolveObjectDef(STANDARD_OBJECTS.account));
      return { object, label: def.label, fields: def.fields.map((f) => ({ fieldId: f.fieldId, apiName: f.apiName, label: f.label, type: f.type })) };
    },
    facts: async () => [{ attribute: "industry", value: "software", state: "accepted", sourceKind: "agent_run", updatedAt: 1 }, { attribute: "name", value: "Atlas Cloud", state: "accepted", sourceKind: "crm", updatedAt: 1 }],
    receipts: async (_o, id, attribute) => (receiptsAsked.push(`${id}:${attribute}`), { state: null, facts: [] }),
  }, (object) => new Set(object === "account" ? ["industry"] : []));
  const tools = new Map(askTools(data).map((t) => [t.name, t]));
  const seen = new Map();
  const listed = (await tools.get("list_records")!.run({ object: "account" }, seen)) as { total: number; rows: Array<{ title: string }> };
  assert.deepEqual([listed.total, listed.rows.map((r) => r.title)], [1, ["Atlas Cloud"]]);
  assert.deepEqual(await tools.get("get_record")!.run({ object: "account", id: "northstar" }, seen), { error: "No such record in this workspace." });
  assert.deepEqual(await tools.get("get_field_receipts")!.run({ object: "account", id: "northstar", attribute: "name" }, seen), { error: "No such record in this workspace." });
  const mine = (await tools.get("get_record")!.run({ object: "account", id: "atlas" }, seen)) as { facts: Array<{ attribute: string }> };
  assert.deepEqual(mine.facts.map((f) => f.attribute), ["name"]);
  await tools.get("get_field_receipts")!.run({ object: "account", id: "atlas", attribute: "industry" }, seen);
  await tools.get("get_field_receipts")!.run({ object: "account", id: "atlas", attribute: "name" }, seen);
  assert.deepEqual(receiptsAsked, ["atlas:name"]);
});

test("who sees the records a run read, and which fields an agent may write", () => {
  // A run's misses and samples: its principals, and anyone whose role narrows nothing.
  assert.deepEqual([
    seesRunRecords(avery, agentPrincipals({ ownerUserId: "avery", startedBy: "riley" })),
    seesRunRecords(jordan, agentPrincipals({ ownerUserId: "avery", startedBy: "riley" })),
    seesRunRecords(riley, agentPrincipals({ ownerUserId: "avery" })),
    seesRunRecords(accessOf({ userId: "jordan", role: "rep" }), agentPrincipals({ ownerUserId: "avery" })),
  ], [true, false, true, true]);
  // The write gate: a field the principal may only read, or not see, or an object it may not edit, is not the agent's to write.
  const limited = accessOf({ userId: "avery", role: "rep", rules: [
    { object: "account", fields: [{ apiName: "custom.uses_salesforce", level: "readOnly" }, { apiName: "custom.headcount_plan", level: "hidden" }] },
    { object: "contact", edit: false },
  ] });
  assert.deepEqual(
    [["account", "custom.uses_salesforce"], ["account", "custom.headcount_plan"], ["account", "custom.region"], ["contact", "custom.region"]].map(([o, f]) => mayWriteField(limited, o, f)),
    [false, false, true, false],
  );
  assert.equal(mayWriteField(averyNoRules, "account", "custom.uses_salesforce"), true);
  assert.equal(mayWriteField(accessOf({ userId: "riley", role: "admin", rules: Object.values(limited.rules) }), "account", "custom.uses_salesforce"), true);
});

test("an org-owned agent runs as its accountable owner, the admin who created it, never unrestricted", async () => {
  // Created by admin Riley and never reassigned: Riley is its one principal on a schedule or a webhook.
  assert.deepEqual(agentPrincipals({ ownerUserId: "riley" }), ["riley"]);
  assert.deepEqual(agentPrincipals({ ownerUserId: "riley", startedBy: "riley" }), ["riley"]);
  // A rep who runs it by hand reads as both, so it shows them nothing their role hides.
  const client = await asPrincipals([riley, avery]);
  assert.deepEqual((await client.list("ws", { filter: {} })).rows.map((r) => r.name), ["Atlas Cloud"]);
  // A run needs at least one principal: there is no principal-less, unrestricted read.
  assert.throws(() => scopedRecordClient(createFakeRecordClient({ store: createMemoryRecordStore() }), [], noDeals), /at least one principal/);
});

test("the choke point: every public function that can reveal a record is judged in one layer, or allowlisted with its reason", () => {
  // scripts/visibility-inventory.ts lists every public query, mutation and action whose arguments name a record or whose
  // reads return one. Each must call a judge (permissions.ts entitySight and what is built on it, the scoped record
  // client, or a whole-workspace refusal), or be on scripts/visibility-allowlist.ts with the reason it needs none.
  const entries = inventory();
  const allowed = new Set(Object.values(ALLOWLIST).flat());
  assert.deepEqual(entries.filter((e) => !e.judgedBy.length && !allowed.has(e.ref)).map((e) => e.ref), [], "judge these, or allowlist them with a reason");
  const unjudged = new Set(entries.filter((e) => !e.judgedBy.length).map((e) => e.ref));
  assert.deepEqual([...allowed].filter((ref) => !unjudged.has(ref)), [], "stale allowlist entries: judged now, or no longer flagged");
  // Agent runs are internal jobs, outside that inventory: they read as their principals, never through the bare client.
  const src = (f: string) => readFileSync(new URL(`../convex/${f}`, import.meta.url), "utf8");
  for (const f of ["researchAgentActions.ts", "agentTurnActions.ts", "askCanon.ts"]) assert.doesNotMatch(src(f), /\bclientFor\(/, f);
  // The gate takes the ids its caller admitted on every batch (a required argument), so a new writer states what it read.
  assert.match(src("canonGate.ts"), /\n {2}admitted: readonly string\[\];/);
});
