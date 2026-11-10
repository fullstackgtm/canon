import assert from "node:assert/strict";
import test from "node:test";
import type { FoldState } from "../convex/lib/objects/fold.ts";
import { applyEdgeCommand, seedDealRoles, type EdgeContext, type EdgeRow, type EdgeStore } from "../convex/lib/objects/associations.ts";
import type { StoredEntry } from "../convex/lib/objects/write.ts";

/** In-memory EdgeStore with the semantics of convex/associations.ts edgeStore. */
function memoryStore() {
  let ids = 0;
  let clock = 0;
  const streams = new Map<string, { orgId: string; object: string }>();
  const entries: StoredEntry[] = [];
  const hot = new Map<string, FoldState>();
  const edges = new Map<string, EdgeRow>();
  const range = (pick: (e: EdgeRow) => boolean, limit: number) => [...edges.values()].filter(pick).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  const store: EdgeStore = {
    async getStream(id) { return streams.get(id) ?? null; },
    async getHotRow(id) { return hot.get(id) ?? null; },
    async readEntries(id, after, limit) { return entries.filter((e) => e.streamId === id && e.version > after).slice(0, limit); },
    async createStream(orgId, object) { const id = `s${++ids}`; streams.set(id, { orgId, object }); return id; },
    async findByExternalId() { return null; },
    async addExternalId() {},
    async removeExternalId() {},
    async externalIdsOf() { return []; },
    async nextSeq() { return entries.length + 1; },
    async appendEntry(_orgId, e) { entries.push(e); },
    async putHotRow(_orgId, _def, state) { hot.set(state.streamId, state); },
    async addProposal() {},
    async removeProposal() {},
    async findEdge(_o, association, fromId, toId) {
      return [...edges.values()].find((e) => e.association === association && e.fromId === fromId && e.toId === toId) ?? null;
    },
    async edgesFrom(_o, association, fromId, limit) { return range((e) => e.association === association && e.fromId === fromId, limit); },
    async edgesTo(_o, association, toId, limit) { return range((e) => e.association === association && e.toId === toId, limit); },
    async putEdge(_o, row) { edges.set(row.streamId, row); },
    async lastEntry(id, match) { return entries.filter((e) => e.streamId === id).reverse().find(match) ?? null; },
  };
  const ctx = (): EdgeContext => ({ orgId: "org1", source: { kind: "user", ref: "user:u1" }, actor: { kind: "user", id: "u1" }, now: ++clock });
  const view = () => [...edges.values()].filter((e) => e.active).map((e) => `${e.association}:${e.fromId}->${e.toId}${e.primary ? "*" : ""}`).sort();
  return { store, ctx, view, entries, edgeRows: () => [...edges.values()] };
}

test("a contact's first change seeds its register company, and making another primary flips both edges in one command", async () => {
  const m = memoryStore();
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "link", fromId: "con_1", toId: "acc_b" }, "acc_a"), { status: "applied" });
  assert.deepEqual(m.view(), ["contact_account:con_1->acc_a*", "contact_account:con_1->acc_b"]);
  // The seeded edge came from the register row, not the person.
  assert.equal(m.entries[0].source.ref, "record:contact:con_1");

  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "makePrimary", fromId: "con_1", toId: "acc_b" }, "acc_a"), { status: "applied" });
  assert.deepEqual(m.view(), ["contact_account:con_1->acc_a", "contact_account:con_1->acc_b*"]);
  // The register's company seeds only a contact with no edges yet.
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "makePrimary", fromId: "con_1", toId: "acc_b" }, "acc_z"), { status: "unchanged" });
  assert.equal(m.view().length, 2);
});

test("removing the primary company makes the oldest remaining one primary, and re-adding reuses the edge's stream", async () => {
  const m = memoryStore();
  for (const toId of ["acc_a", "acc_b", "acc_c"]) await applyEdgeCommand(m.store, m.ctx(), { op: "link", fromId: "con_1", toId });
  await applyEdgeCommand(m.store, m.ctx(), { op: "makePrimary", fromId: "con_1", toId: "acc_c" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "unlink", fromId: "con_1", toId: "acc_c" });
  assert.deepEqual(m.view(), ["contact_account:con_1->acc_a*", "contact_account:con_1->acc_b"]);

  const streamsBefore = new Set(m.entries.map((e) => e.streamId)).size;
  await applyEdgeCommand(m.store, m.ctx(), { op: "link", fromId: "con_1", toId: "acc_c" });
  assert.deepEqual(m.view(), ["contact_account:con_1->acc_a*", "contact_account:con_1->acc_b", "contact_account:con_1->acc_c"]);
  assert.equal(new Set(m.entries.map((e) => e.streamId)).size, streamsBefore);
  assert.deepEqual(m.entries.at(-1)?.body, { kind: "lifecycle", op: "restore" });
});

test("a company's parent is replaced, and a parent below it is refused", async () => {
  const m = memoryStore();
  await applyEdgeCommand(m.store, m.ctx(), { op: "setParent", accountId: "acc_child", parentId: "acc_p1" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "setParent", accountId: "acc_child", parentId: "acc_p2" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "setParent", accountId: "acc_grandchild", parentId: "acc_child" });
  assert.deepEqual(m.view(), ["account_parent:acc_child->acc_p2", "account_parent:acc_grandchild->acc_child"]);

  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "setParent", accountId: "acc_p2", parentId: "acc_grandchild" }),
    { status: "invalid", message: "That company is already below this one" });
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "setParent", accountId: "acc_child", parentId: null }), { status: "applied" });
  assert.deepEqual(m.view(), ["account_parent:acc_grandchild->acc_child"]);
});

const roles = (m: ReturnType<typeof memoryStore>) =>
  m.edgeRows().filter((e) => e.active && e.association === "deal_contact").map((e) => (e.reason ? `${e.toId}:${e.label} (${e.reason})` : `${e.toId}:${e.label}`)).sort();

test("a deal's roles: a single-holder role moves its holder to involved, a role change clears Canon's reason, and re-adding reuses the edge", async () => {
  const m = memoryStore();
  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_ceo", role: "executive", reason: "Most senior title at the company" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_vp", role: "champion" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_cfo", role: "executive" });
  assert.deepEqual(roles(m), ["con_ceo:involved", "con_cfo:executive", "con_vp:champion"]);

  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_ceo", role: "executive", reason: "Most senior title at the company" });
  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_ceo", role: "signer" });
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "removeFromDeal", dealId: "deal_1", contactId: "con_vp" }), { status: "applied" });
  assert.deepEqual(roles(m), ["con_ceo:signer", "con_cfo:involved"]);

  const streamsBefore = new Set(m.entries.map((e) => e.streamId)).size;
  await applyEdgeCommand(m.store, m.ctx(), { op: "setRole", dealId: "deal_1", contactId: "con_vp", role: "user" });
  assert.deepEqual(roles(m), ["con_ceo:signer", "con_cfo:involved", "con_vp:user"]);
  assert.equal(new Set(m.entries.map((e) => e.streamId)).size, streamsBefore);
});

test("legacy committee rows seed a deal's edges once, dated and attributed as set, and never over a deal that has edges", async () => {
  const m = memoryStore();
  const legacy = [
    { contactId: "con_vp", role: "champion" as const, reason: null, setBy: "u2", at: 200 },
    { contactId: "con_ceo", role: "executive" as const, reason: "Most senior title at the company", setBy: "u1", at: 100 },
  ];
  assert.equal(await seedDealRoles(m.store, "org1", "deal_1", legacy), true);
  assert.deepEqual(roles(m), ["con_ceo:executive (Most senior title at the company)", "con_vp:champion"]);
  assert.deepEqual(m.entries.map((e) => [e.source.ref, e.observedAt]), [["user:u1", 100], ["user:u2", 200]]);

  await applyEdgeCommand(m.store, m.ctx(), { op: "removeFromDeal", dealId: "deal_1", contactId: "con_vp" });
  assert.equal(await seedDealRoles(m.store, "org1", "deal_1", legacy), false);
  assert.deepEqual(roles(m), ["con_ceo:executive (Most senior title at the company)"]);
});

test("an activity is about each record it targets once, and more than the cap is refused", async () => {
  const m = memoryStore();
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "target", activityId: "call_1", toIds: ["deal_1", "acc_a", "con_1", "acc_a"] }), { status: "applied" });
  assert.deepEqual(m.view(), ["activity_target:call_1->acc_a", "activity_target:call_1->con_1", "activity_target:call_1->deal_1"]);
  assert.deepEqual(await applyEdgeCommand(m.store, m.ctx(), { op: "target", activityId: "call_1", toIds: ["acc_a"] }), { status: "unchanged" });
  const nine = Array.from({ length: 9 }, (_, i) => `acc_${i}`);
  assert.equal((await applyEdgeCommand(m.store, m.ctx(), { op: "target", activityId: "call_2", toIds: nine })).status, "invalid");
});

test("a re-import removes the targets it made that its source no longer names, and keeps a person's", async () => {
  const m = memoryStore();
  const crm: EdgeContext = { orgId: "org1", source: { kind: "salesforce", ref: "salesforce:00T1" }, actor: { kind: "integration", id: "salesforce" }, now: 1 };
  await applyEdgeCommand(m.store, crm, { op: "target", activityId: "task_1", toIds: ["con_1", "deal_1"] });
  await applyEdgeCommand(m.store, m.ctx(), { op: "target", activityId: "task_1", toIds: ["acc_a"] });
  await applyEdgeCommand(m.store, crm, { op: "target", activityId: "task_1", toIds: ["deal_2"] });
  await applyEdgeCommand(m.store, crm, { op: "keepOnly", association: "activity_target", fromId: "task_1", toIds: ["deal_2"] });
  assert.deepEqual(m.view(), ["activity_target:task_1->acc_a", "activity_target:task_1->deal_2"]);
});
