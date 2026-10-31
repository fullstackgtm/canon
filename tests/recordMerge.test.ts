import assert from "node:assert/strict";
import test from "node:test";
import { defaultPicks, mergeParties, unmergeParties, type MergeStores, type MergeUndo } from "../convex/lib/canon/partyMerge.ts";
import { ensureEntity, type FieldStateRow, type LedgerStore, type StoredFact } from "../convex/lib/canon/ledger.ts";
import { accountExternalIds } from "../convex/lib/canon/identity.ts";
import { writeParty, type PartyObject } from "../convex/lib/canon/partyLedger.ts";
import { applyEdgeCommand, type EdgeRow } from "../convex/lib/objects/associations.ts";
import { project, type FoldState } from "../convex/lib/objects/fold.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { StoredEntry } from "../convex/lib/objects/write.ts";

const ORG = "org1";

/** In-memory stores with the semantics of convex/recordMerges.ts mergeStores: identity lookups follow mergedInto. */
function memory() {
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const entities = new Map<string, { orgId: string; entityType: string; projectionId: string; mergedInto?: string }>();
  const ext: Array<{ orgId: string; entityId: string; provider: string; externalId: string }> = [];
  const raw = (provider: string, externalId: string) => ext.find((x) => x.provider === provider && x.externalId === externalId)?.entityId ?? null;
  const survivor = (e: string | null): string | null => {
    let cur = e;
    while (cur && entities.get(cur)?.mergedInto) cur = entities.get(cur)!.mergedInto!;
    return cur;
  };
  const facts: StoredFact[] = [];
  const fieldState = new Map<string, FieldStateRow>();
  const entries: StoredEntry[] = [];
  const hot = new Map<string, FoldState>();
  const edges = new Map<string, EdgeRow>();
  const deals = new Map<string, string>([["deal_a", "acc_a"], ["deal_b", "acc_b"]]);
  const facts_: LedgerStore = {
    async findEntityByExternalId(_o, provider, externalId) { return survivor(raw(provider, externalId)); },
    async findEntityByProjection(_o, projectionId) { return survivor([...entities].find(([, e]) => e.projectionId === projectionId)?.[0] ?? null); },
    async createEntity(e) { const _id = id("ent"); entities.set(_id, { orgId: e.orgId, entityType: e.entityType, projectionId: e.projectionId }); return _id; },
    async addExternalId(e) { ext.push(e); },
    async hasStream(entityId) { return entries.some((e) => e.streamId === entityId); },
    async latestBySourceRef(_o, sourceRef) { return facts.filter((f) => f.sourceRef === sourceRef).at(-1) ?? null; },
    async insertFact(f) { const _id = id("fact"); facts.push({ ...f, _id }); return _id; },
    async confirmFact() {},
    async getFact(factId) { return facts.find((f) => f._id === factId) ?? null; },
    async decideFact() {},
    async setLedgerFactId() {},
    async factsFor(entityId, attribute) { return facts.filter((f) => f.entityId === entityId && f.attribute === attribute).reverse(); },
    async upsertFieldState(row) { fieldState.set(`${row.entityId}:${row.attribute}`, row); },
    async recordShadowOutbound() {},
  };
  const s: MergeStores = {
    facts: facts_,
    objects: {
      async getStream(streamId) { const e = entities.get(streamId); return e ? { orgId: e.orgId, object: e.entityType } : null; },
      async getHotRow(streamId) { return hot.get(streamId) ?? null; },
      async readEntries(streamId, after, limit) { return entries.filter((e) => e.streamId === streamId && e.version > after).slice(0, limit); },
      async createStream(orgId, object) { const _id = id("edge"); entities.set(_id, { orgId, entityType: object, projectionId: _id }); return _id; },
      async findByExternalId(_o, provider, externalId) { return raw(provider, externalId); },
      async addExternalId(orgId, entityId, provider, externalId) { ext.push({ orgId, entityId, provider, externalId }); },
      async removeExternalId(_o, entityId, provider, externalId) {
        const i = ext.findIndex((x) => x.entityId === entityId && x.provider === provider && x.externalId === externalId);
        if (i >= 0) ext.splice(i, 1);
      },
      async externalIdsOf(entityId) { return ext.filter((x) => x.entityId === entityId); },
      async nextSeq() { return entries.length + 1; },
      async appendEntry(_o, e) { entries.push(e); },
      async putHotRow(_o, _d, state) { hot.set(state.streamId, state); },
      async addProposal() {},
      async removeProposal() {},
      async survivorOf(streamId) { return entities.get(streamId)?.mergedInto ?? null; },
    },
    async factAttributes() { return []; },
    async defWith(_o, object) { return resolveObjectDef(STANDARD_OBJECTS[object]); },
    async ownership() { return []; },
    edges: undefined as never,
    async setMergedInto(entityId, into) {
      const e = entities.get(entityId)!;
      if (into) e.mergedInto = into;
      else delete e.mergedInto;
    },
    async dealsOfCompany(_o, companyId) { return [...deals].filter(([, c]) => c === companyId).map(([d]) => d); },
    async setDealCompany(dealId, from, to) { if (deals.get(dealId) === from) deals.set(dealId, to); },
    async supersedeFact(factId) { facts.find((f) => f._id === factId)!.status = "superseded"; },
  };
  const range = (pick: (e: EdgeRow) => boolean, limit: number) => [...edges.values()].filter(pick).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  s.edges = {
    ...s.objects,
    async findEdge(_o, association, fromId, toId) { return [...edges.values()].find((e) => e.association === association && e.fromId === fromId && e.toId === toId) ?? null; },
    async edgesFrom(_o, association, fromId, limit) { return range((e) => e.association === association && e.fromId === fromId, limit); },
    async edgesTo(_o, association, toId, limit) { return range((e) => e.association === association && e.toId === toId, limit); },
    async putEdge(_o, row) { edges.set(row.streamId, row); },
  };
  const account = resolveObjectDef(STANDARD_OBJECTS.account);
  /** What a person sees: each company's values and lifecycle, the active edges with their primary flags, the deals' companies. */
  const view = (streams: readonly string[]) => ({
    records: streams.map((st) => {
      const row = project(account, hot.get(st)!);
      return { values: row.values, deletedAt: row.deletedAt === null ? null : "deleted" };
    }),
    edges: [...edges.values()].filter((e) => e.active).map((e) => `${e.association}:${e.fromId}->${e.toId}${e.primary ? "*" : ""}`).sort(),
    deals: Object.fromEntries(deals),
    fieldState: [...fieldState.values()].filter((r) => r.attribute === "name").map((r) => [r.entityId, r.value]).sort(),
  });
  return { s, view, entities, edges };
}

const user = (now: number) => ({ orgId: ORG, source: { kind: "user" as const, ref: "user:u1" }, actor: { kind: "user" as const, id: "u1" }, now });
const snapshot = (id: string, domain: string, name: string, industry: string) => ({ id, domain, name, industry, updatedAt: 100 });
const merge = (m: ReturnType<typeof memory>, object: PartyObject = "account") => mergeParties(m.s, {
  orgId: ORG, object, userId: "u1", now: 1_000, mergeId: "m1",
  survivor: { recordId: "acc_a", snapshot: snapshot("acc_a", "acme.com", "Acme", "Software") },
  losers: [{ recordId: "acc_b", snapshot: { ...snapshot("acc_b", "acme.io", "Acme Inc.", "Computer Software"), country: "united states" } }],
  picks: { name: "acc_b", industry: "acc_a", country: "acc_b" },
  // con_2 at the loser was never worked: the register lists acc_b as its company.
  seeds: [{ contactId: "con_2", accountId: "acc_b" }],
  activityIds: [],
});

test("a merge moves people, child companies, activities and deals to the survivor, and undo puts both companies back exactly", async () => {
  const m = memory();
  // Before: con_1 works at acc_a (worked) and at acc_b as its primary; acc_child's parent is acc_b; a note is about acc_b.
  await applyEdgeCommand(m.s.edges, user(10), { op: "link", fromId: "con_1", toId: "acc_b" });
  await applyEdgeCommand(m.s.edges, user(11), { op: "link", fromId: "con_1", toId: "acc_a" });
  await applyEdgeCommand(m.s.edges, user(12), { op: "setParent", accountId: "acc_child", parentId: "acc_b" });
  await applyEdgeCommand(m.s.edges, user(13), { op: "target", activityId: "note_1", toIds: ["acc_b"] });
  // The survivor is already on the ledger (a person named it); the loser is an unworked TAM row, promoted by the merge.
  const a = await ensureEntity(m.s.facts, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "acc_a", externalIds: accountExternalIds({ domain: "acme.com", recordId: "acc_a" }) });
  await writeParty(m.s, { orgId: ORG, object: "account", streamId: a, now: 50, values: { name: "Acme", domain: "acme.com", industry: "Software" }, source: { kind: "user", userId: "u1", key: "k0" } });

  const before = m.view([a]);

  const undo: MergeUndo = await merge(m);
  const [sa, sb] = [undo.survivor.streamId, undo.losers[0].streamId];
  assert.equal(sa, a);
  const merged = m.view([sa, sb]);
  assert.deepEqual([merged.records[0].values.name, merged.records[0].values.domain, merged.records[0].values.industry], ["Acme Inc.", "acme.com", "Software"]);
  assert.equal(merged.records[1].deletedAt, "deleted");
  assert.deepEqual(merged.edges, [
    "account_parent:acc_child->acc_a",
    "activity_target:note_1->acc_a",
    "activity_target:note_1->acc_b",
    "contact_account:con_1->acc_a*",
    "contact_account:con_1->acc_b",
    "contact_account:con_2->acc_a*",
    "contact_account:con_2->acc_b",
  ]);
  assert.deepEqual(merged.deals, { deal_a: "acc_a", deal_b: "acc_a" });
  // The loser's values stay in the survivor's history, with their sources.
  const absorb = (await m.s.objects.readEntries(sa, 0, 50)).map((e) => e.body).find((b) => b.kind === "lifecycle" && b.op === "absorb");
  assert.deepEqual(absorb?.kind === "lifecycle" && absorb.op === "absorb" && absorb.from[0].values.find((x) => x.fieldId === "name"), { fieldId: "name", value: "Acme Inc.", sourceKind: "import" });

  await unmergeParties(m.s, { orgId: ORG, userId: "u1", now: 2_000, mergeId: "m1", undo });
  const after = m.view([sa, sb]);
  // The survivor reads exactly as before, in the projection and in the facts mirror; the loser is live with its own values.
  assert.deepEqual(after.records[0], before.records[0]);
  // A field the survivor had no value for is empty again as a resolved value, so the register clears what the merge wrote there.
  assert.equal(merged.records[0].values.country, "united states");
  assert.notEqual(project(resolveObjectDef(STANDARD_OBJECTS.account), (await m.s.objects.getHotRow(sa))!).meta.country.factId, null);
  assert.deepEqual(after.fieldState.find(([e]) => e === sa), before.fieldState.find(([e]) => e === sa));
  assert.deepEqual([after.records[1].values.name, after.records[1].values.domain, after.records[1].deletedAt], ["Acme Inc.", "acme.io", null]);
  // Every edge is back as it was. con_2, never worked, keeps its register company as a seeded edge.
  assert.deepEqual(after.edges, [...before.edges, "contact_account:con_2->acc_b*"].sort());
  assert.deepEqual(after.deals, before.deals);
});

test("after a merge the loser's domain routes to the survivor, whose own domain a later import never changes", async () => {
  const m = memory();
  const undo = await merge(m);
  const [sa, sb] = [undo.survivor.streamId, undo.losers[0].streamId];
  // A CSV row or CRM sync with the loser's domain finds its record by identity, as convex/canon.ts saveParty does.
  const found = await ensureEntity(m.s.facts, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "csv:1:2", externalIds: accountExternalIds({ domain: "ACME.io" }) });
  assert.equal(found, sa);
  const out = await writeParty(m.s, { orgId: ORG, object: "account", streamId: found, now: 1_500, values: { name: "Acme Inc.", domain: "acme.io", employees: 120 }, source: { kind: "import", ref: "csv:1:2", actorId: "u1" } });
  assert.deepEqual(out.rejected, []);
  const row = project(resolveObjectDef(STANDARD_OBJECTS.account), (await m.s.objects.getHotRow(sa))!);
  assert.deepEqual([row.values.domain, row.values.employees], ["acme.com", 120]);

  await unmergeParties(m.s, { orgId: ORG, userId: "u1", now: 2_000, mergeId: "m1", undo });
  // Undone, the domain is the loser's own again.
  assert.equal(await ensureEntity(m.s.facts, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "csv:1:3", externalIds: accountExternalIds({ domain: "acme.io" }) }), sb);
});

test("undo keeps a contact's companies as someone changed them after the merge, never with two primaries", async () => {
  const m = memory();
  await applyEdgeCommand(m.s.edges, user(10), { op: "link", fromId: "con_1", toId: "acc_b" });
  const undo = await merge(m);
  // After the merge, con_1 is at acc_a (primary) and acc_b; then a person makes a third company its primary.
  await applyEdgeCommand(m.s.edges, user(1_500), { op: "link", fromId: "con_1", toId: "acc_c", primary: true });
  await unmergeParties(m.s, { orgId: ORG, userId: "u1", now: 2_000, mergeId: "m1", undo });
  const con1 = m.view([]).edges.filter((e) => e.startsWith("contact_account:con_1"));
  assert.deepEqual(con1, ["contact_account:con_1->acc_a", "contact_account:con_1->acc_b", "contact_account:con_1->acc_c*"]);
});

test("each field keeps its most recent value by default, but never an agent's over a person's, a CRM's or an import's", () => {
  const cell = (value: string | null, sourceKind: string, at: number) => ({ value, sourceKind, at });
  assert.deepEqual(defaultPicks(["name", "industry", "title"], [
    { id: "a", cells: { name: cell("Acme", "hubspot", 10), industry: cell("Software", "import", 10), title: cell(null, "import", 10) } },
    { id: "b", cells: { name: cell("Acme Inc.", "user", 20), industry: cell("SaaS", "agent_run", 30), title: cell("CTO", "agent_run", 5) } },
  ]), { name: "b", industry: "a", title: "b" });
});
