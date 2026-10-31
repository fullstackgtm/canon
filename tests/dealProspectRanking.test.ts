import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { firstPartyRef } from "../recipes/index.ts";

const originalKey = process.env.JEV_API_KEY;
before(() => { process.env.JEV_API_KEY = "test-only"; });
after(() => {
  if (originalKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalKey;
});

const state = {
  orgId: "org", canEdit: true, visible: true, product: "Sales planning", evidence: "Owns planning", title: "VP Sales",
  access: accessOf({ userId: "user", role: "rep" }) as Access,
  calls: 0, fail: false,
};
const handlers = loadConvex(["dealPlays.ts"], {
  "records.ts": (real) => ({ ...real, callerClient: () => ({
    listObjects: async () => ({ rows: state.visible ? [{ title: "Deal", values: { companyId: "company" } }] : [] }),
  }) }),
  "associations.ts": (real) => ({ ...real,
    rowsById: async (_client: unknown, _org: unknown, object: string) => object === "account"
      ? new Map([["company", { title: "Account", values: { icpIds: ["icp"] } }]]) : new Map(),
    peopleOfCompany: async () => [{ id: "a", name: "A", title: state.title }, { id: "b", name: "B", title: "VP Sales" }],
  }),
  "activityTargets.ts": (real) => ({ ...real, activitiesForRecord: async () => ({ activities: [] }) }),
  "lib/segments/jev.ts": (real) => ({ ...real, jevSystemOne: async () => {
    state.calls++;
    if (state.fail) throw new Error("Service unavailable");
    return { answers: { fit: { type: "choice", choice: "right" } } };
  } }),
})["dealPlays.ts"];

function fixture() {
  Object.assign(state, { orgId: "org", canEdit: true, visible: true, product: "Sales planning", evidence: "Owns planning", title: "VP Sales", calls: 0, fail: false,
    access: accessOf({ userId: "user", role: "rep" }) });
  const db = memoryDb({});
  const ctx = {
    db,
    runQuery: async (ref: unknown, args: Record<string, unknown>) => {
      switch (String(ref)) {
        case "internal.records.callerContext": return { orgId: state.orgId, userId: "user", access: state.access };
        case "internal.dealPlays.load": return { recipe: firstPartyRef("fsgtm-enterprise-deal"), page: [], canEdit: state.canEdit, deal: {}, play: { context: state.product }, items: [], steps: [], people: [{ contactId: "a", angle: state.evidence }] };
        case "internal.dealCommittee.dealPeople": return { members: [] };
        case "internal.dealPlays.touchLogs": return {};
        case "internal.icps.pointsOfView": return [{ id: "icp", name: "Sales", pointOfView: "Planning", buyer: { titles: ["sales"], exclude: [], levels: [], departments: [], topics: [] } }];
        case "internal.dealPlays.cachedProspectRanking": return handlers.cachedProspectRanking.handler({ db }, args);
        default: throw new Error(`Unexpected query ${String(ref)}`);
      }
    },
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      assert.equal(String(ref), "internal.dealPlays.storeProspectRanking");
      return handlers.storeProspectRanking.handler({ db }, args);
    },
  };
  return { db, rank: (streamId = "deal") => handlers.rankProspects.handler(ctx, { streamId }) };
}

test("rankings persist and reuse exact inputs, invalidate changed evidence/product/buyers/model, and stay scoped", async () => {
  const { db, rank } = fixture();
  const first = await rank();
  assert.deepEqual(Array.from(first.keys), ["c:b", "c:a"]);
  assert.equal(state.calls, 1);
  assert.deepEqual(await rank(), first);
  assert.equal(state.calls, 1, "a second action reads the durable row");
  for (const change of [() => { state.product = "New product"; }, () => { state.evidence = "New evidence"; }, () => { state.title = "Director Sales"; }]) {
    change();
    const callsBefore: number = state.calls;
    await rank();
    assert.equal(state.calls, callsBefore + 1);
    assert.equal(db.rows("dealProspectRankings").length, 1, "replace the prior fingerprint, not an unbounded history");
  }
  await db.patch(db.rows("dealProspectRankings")[0]._id, { model: "old-model" });
  await rank();
  assert.equal(state.calls, 5);
  await rank("other-deal");
  state.orgId = "other-org";
  await rank();
  assert.equal(state.calls, 7, "different deals and tenants do not share results");
  state.title = "Engineer";
  assert.deepEqual(Array.from((await rank()).keys), ["c:b"], "a buyer leaving the filter invalidates the saved order");
  assert.equal(state.calls, 7, "one buyer requires no comparison");
  state.visible = false;
  await assert.rejects(rank());
  assert.equal(state.calls, 7);
});

test("read-only, non-owner, and preview callers reuse saved rankings but never invoke Jev or write on misses", async () => {
  const { db, rank } = fixture();
  const saved = await rank();
  delete process.env.JEV_API_KEY;
  assert.deepEqual(await rank(), saved, "saved rankings remain readable without a provider key");
  process.env.JEV_API_KEY = "test-only";
  for (const mode of ["read-only", "non-owner", "preview"]) {
    state.canEdit = mode !== "non-owner";
    state.access = accessOf({ userId: "user", role: "rep",
      rules: mode === "read-only" ? [{ object: "deal", edit: false }] : [],
      preview: mode === "preview" ? { adminId: "admin", asUserId: "user", asName: "User" } : undefined });
    assert.deepEqual(await rank(), saved);
    state.product = "Changed product";
    const miss = await rank();
    assert.equal(miss.keys.length, 0);
    assert.ok(miss.note);
    assert.equal(state.calls, 1);
    assert.equal(db.rows("dealProspectRankings")[0].input, saved.input);
    state.product = "Sales planning";
  }
});

test("failed comparisons do not persist fallback results or replace a successful ranking", async () => {
  const { db, rank } = fixture();
  const saved = await rank();
  state.product = "Different product";
  state.fail = true;
  assert.ok((await rank()).note);
  assert.equal(db.rows("dealProspectRankings")[0].input, saved.input);
  state.fail = false;
  assert.equal((await rank()).note, null);
  assert.equal(state.calls, 3);
});
