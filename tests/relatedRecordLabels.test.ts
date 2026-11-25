import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";

const user = { _id: "u", orgId: "ws", role: "rep", name: "Rep" };
let access: Access = accessOf({ userId: "u", role: "rep" });
const files = loadConvex(["deals.ts", "explee.ts", "activity.ts", "conversationView.ts", "lib/modules/canonReads.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user }),
  "permissions.ts": (real) => ({ ...real, accessFor: async () => access }),
});
const deal = { _id: "deal", orgId: "ws", name: "Own deal", primaryRepId: "u", accountId: "crm", amount: 100, closeDate: "2026-11-30", stage: "prospecting", createdAt: 1, updatedAt: 1 };
const recent = [{ contactId: "hidden-person", name: "Hidden person", company: "Private company", at: 1 }];
const db = memoryDb({ organizations: [{ _id: "ws" }], users: [user], deals: [deal], crmAccounts: [{ _id: "crm", orgId: "ws", name: "Private company", domain: "private.example" }], integrations: [{ _id: "integration", orgId: "ws", provider: "explee", isActive: true, syncConfig: { recent, imported: 1 } }] });
const ctx = { db };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const policies = [
  { access: accessOf({ userId: "u", role: "rep" }), owners: ["u", "peer", undefined] },
  { access: accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }] }), owners: ["u"] },
  { access: accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: true }] }), owners: ["u", undefined] },
  { access: accessOf({ userId: "u", role: "rep", teams: [{ memberIds: ["u", "peer"], leadId: "manager" }], rules: [{ object: "account", visibility: "team", unowned: false }] }), owners: ["u", "peer", "manager"] },
  { access: accessOf({ userId: "manager", role: "manager", teams: [{ memberIds: ["u", "peer"], leadId: "manager" }], rules: [{ object: "account", visibility: "team", unowned: false }] }), owners: ["u", "peer", "manager"] },
  { access: accessOf({ userId: "u", role: "rep", rules: [{ object: "account", read: false }] }), owners: [] },
  { access: accessOf({ userId: "system", role: "admin" }), owners: ["u", "peer", "manager", "outside", undefined] },
];

test("deal list and context admit legacy company labels by their owner's scope", async () => {
  for (const policy of policies) for (const ownerId of ["u", "peer", "manager", "outside", undefined]) {
    access = policy.access;
    await db.patch("crm", { ownerId });
    const admitted = policy.owners.includes(ownerId);
    // The unrestricted member sees every owner, including owners outside any team.
    const visible = !Object.keys(access.rules).length || admitted;
    for (const name of ["list", "context"]) {
      const result = await files["deals.ts"][name].handler(ctx, {});
      const rows = name === "list" ? result : result.deals;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "Own deal");
      assert.equal(rows[0].accountName, visible ? "Private company" : null);
      assert.equal(rows[0].accountDomain, visible ? "private.example" : null);
    }
  }
});

test("module tool and history reads inherit legacy company owner admission", async () => {
  const read = files["lib/modules/canonReads.ts"].canonRead as unknown as (...args: unknown[]) => Promise<any[]>;
  await db.insert("dealVersionCursors", { orgId: "ws", shard: -1, builtAt: 1 });
  await db.insert("dealVersions", { orgId: "ws", dealId: "deal", validFrom: 0, validTo: 100, fields: { closeDate: deal.closeDate, archived: false } });
  for (const policy of policies) for (const ownerId of ["u", "peer", "manager", "outside", undefined]) {
    access = policy.access;
    await db.patch("crm", { ownerId });
    const visible = !Object.keys(access.rules).length || policy.owners.includes(ownerId);
    for (const [name, args] of [["deals.byIds", { ids: ["deal"] }], ["deals.updatedSince", { since: 0 }], ["deals.asOf", { at: 1, from: "2026-11-01", to: "2026-12-01" }]] as const) {
      const rows = await read(ctx, "ws", access, { reads: { deals: ["companyName"] } }, name, args, 10);
      assert.equal(rows.length, 1);
      assert.deepEqual(plain(rows[0].companyName), visible ? { crm: "Private company" } : null);
    }
  }
});

test("Explee omits workspace-wide recent imports for narrowed readers", async () => {
  for (const rules of [[], [{ object: "account", visibility: "own" as const, unowned: false }], [{ object: "contact", fields: [{ apiName: "title", level: "hidden" as const }] }]]) {
    access = accessOf({ userId: "u", role: "rep", rules });
    const status = await files["explee.ts"].status.handler(ctx, {});
    assert.deepEqual(plain(status.recent), rules.length ? [] : recent);
    assert.equal(status.connected, true);
    assert.equal(status.imported, 1);
  }
});

test("research tray retains readable deal identity and omits invisible deals", async () => {
  const db = memoryDb({ deals: [deal, { ...deal, _id: "peer", primaryRepId: "other", name: "Peer deal" }], dealPlays: ["deal", "peer"].map((dealId) => ({ _id: `play-${dealId}`, orgId: "ws", dealId, streamId: dealId, research: { status: "running", startedAt: Date.now() } })) });
  access = accessOf({ userId: "u", role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] });
  const rows = await files["activity.ts"].background.handler({ db }, {});
  assert.equal(rows.length, 1);
  assert.ok(rows[0].title.includes("Own deal"));
  assert.ok(!JSON.stringify(rows).includes("Peer deal"));
});

test("role administration refuses hiding the identities shown by lists, pages and related links", async () => {
  const admin = { ...user, role: "admin" };
  const permissions = loadConvex(["permissions.ts"], {
    "lib.ts": (real) => ({ ...real, getCurrentUser: async () => admin, requireUser: async () => admin }),
  })["permissions.ts"];
  for (const [object, apiName] of [["account", "name"], ["contact", "fullName"], ["deal", "name"], ["lead", "lastName"], ["task", "subject"]]) {
    await assert.rejects(() => permissions.saveRole.handler(ctx, { role: "rep", rules: [{ object, fields: [{ apiName, level: "hidden" }] }] }), { name: "ConvexError" });
    await permissions.saveRole.handler(ctx, { role: "rep", rules: [{ object, fields: [{ apiName, level: "readOnly" }] }] });
  }
});


test("conversation owners remain workspace directory labels under CRM restrictions", async () => {
  access = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", read: false }] });
  const db = memoryDb({ users: [{ _id: "owner", orgId: "ws", name: "Teammate" }], conversations: [{ _id: "thread", orgId: "ws", ownerUserId: "owner", channel: "email", counterpart: {}, lastMessageAt: 1 }], conversationContacts: [{ _id: "link", orgId: "ws", contactId: "person", conversationId: "thread" }] });
  const rows = await files["conversationView.ts"].listFor.handler({ db }, { people: [{ id: "person", name: "Person" }], admitted: ["person"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ownerName, "Teammate");
});
