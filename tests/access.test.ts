import assert from "node:assert/strict";
import test from "node:test";
import { accessOf, canSeeRecord, may, ownerScope, permissionOf, refuseHiddenUse, refuseLockedWrite, withoutHidden, type ObjectRule } from "../convex/lib/access.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";

const rules: ObjectRule[] = [
  { object: "deal", visibility: "own", unowned: false },
  { object: "account", visibility: "team", unowned: true },
  { object: "lead", read: false },
  { object: "task", edit: false },
];
const teams = [{ memberIds: ["avery", "jordan"], leadId: "morgan" }, { memberIds: ["sam"] }];
const rep = accessOf({ userId: "avery", role: "rep", rules, teams });

test("the check: who sees which owner's record, and what each role may do", () => {
  const rows: Array<[string, string, string | null, boolean]> = [
    // [who, object, owner, sees]
    ["rep", "deal", "avery", true],
    ["rep", "deal", "jordan", false],
    ["rep", "deal", null, false],
    ["rep", "account", "jordan", true], // same team
    ["rep", "account", "morgan", true], // the team's lead
    ["rep", "account", "sam", false], // another team
    ["rep", "account", null, true], // unowned admitted
    ["rep", "lead", "avery", false], // no read: none, even their own
    ["rep", "contact", "sam", true], // no rule: today's access
    ["rep", "product", null, true],
    ["admin", "deal", "jordan", true], // admins are never restricted, whatever is stored
    ["unconfigured", "deal", "jordan", true], // no stored policy: everyone sees everything
  ];
  const who = {
    rep,
    admin: accessOf({ userId: "riley", role: "admin", rules, teams }),
    unconfigured: accessOf({ userId: "avery", role: "rep", teams }),
  } as const;
  for (const [name, object, owner, sees] of rows) {
    assert.equal(canSeeRecord(who[name as keyof typeof who], object, object !== "product", owner), sees, `${name} ${object} owned by ${owner}`);
  }
  assert.deepEqual(ownerScope(rep, "deal", true), { field: "ownerId", owners: ["avery"], unowned: false });
  assert.deepEqual([...ownerScope(rep, "account", true)!.owners].sort(), ["avery", "jordan", "morgan"]);
  assert.equal(ownerScope(rep, "contact", true), null);
  assert.deepEqual([may(rep, "task", "edit"), may(rep, "task", "create"), may(rep, "lead", "read")], [false, true, false]);
  assert.equal(permissionOf(rep, "deal").edit, true);
  // A preview reads as the member and never writes, even where the member could.
  const preview = accessOf({ userId: "avery", role: "rep", rules, teams, preview: { adminId: "riley", asUserId: "avery", asName: "Avery" } });
  assert.deepEqual([may(preview, "deal", "read"), may(preview, "deal", "edit"), canSeeRecord(preview, "deal", true, "jordan")], [true, false, false]);
});

test("a hidden record stays hidden on every read the record client serves: lists, legacy lists, search and reports", async () => {
  const store = createMemoryRecordStore();
  const row = (id: string, name: string, ownerId?: string): AccountRow =>
    ({ id, domain: `${id}.example`, name, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ...(ownerId ? { ownerId } : {}) }) as AccountRow;
  await store.putAccounts("ws", [row("atlas", "Atlas One", "avery"), row("boreal", "Atlas Two", "sam"), row("cove", "Atlas Three")]);
  const client = createFakeRecordClient({ store });
  const scope = ownerScope(rep, "account", true)!; // avery's team, unowned too: never sam's

  const listed = await client.listRegister("ws", "account", { scope });
  assert.deepEqual([listed.rows.map((r) => r.title).sort(), listed.total], [["Atlas One", "Atlas Three"], 2]);
  const legacy = await client.list("ws", { filter: { scope: { ...scope, field: "ownerId", owners: [...scope.owners] } } });
  assert.deepEqual(legacy.rows.map((r) => r.name).sort(), ["Atlas One", "Atlas Three"]);
  const found = await client.searchObjects("ws", { q: "atlas", objects: ["account"], scopes: { account: scope } });
  assert.deepEqual(found.hits.map((h) => h.title).sort(), ["Atlas One", "Atlas Three"]);
  const counted = await client.aggregate("ws", "account", { measures: [{ fn: "count" }], scope });
  assert.deepEqual(counted.total, [2]);
});

test("a hidden field leaves the values a read returns and cannot be filtered on; a read-only one cannot be written", () => {
  const fields: ObjectRule[] = [{ object: "deal", fields: [{ apiName: "amount", level: "hidden" }, { apiName: "stage", level: "readOnly" }] }];
  const limited = accessOf({ userId: "avery", role: "rep", rules: fields });
  const admin = accessOf({ userId: "riley", role: "admin", rules: fields });
  const deal = { name: "Atlas expansion", amount: 145_000_00, stage: "proposal" };
  assert.deepEqual(withoutHidden(limited, "deal", deal), { name: "Atlas expansion", stage: "proposal" });
  assert.deepEqual(withoutHidden(admin, "deal", deal), deal);
  assert.throws(() => refuseHiddenUse(limited, "deal", ["stage", "amount"]), /amount is hidden/);
  assert.doesNotThrow(() => refuseHiddenUse(limited, "deal", ["stage", undefined]));
  assert.throws(() => refuseLockedWrite(limited, "deal", ["name", "stage"]), /stage is read-only/);
  assert.throws(() => refuseLockedWrite(limited, "deal", ["amount"]), /amount is hidden/);
  assert.doesNotThrow(() => refuseLockedWrite(limited, "deal", ["name"]));
  assert.doesNotThrow(() => refuseLockedWrite(admin, "deal", ["stage", "amount"]));
});
