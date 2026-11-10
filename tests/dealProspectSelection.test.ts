import assert from "node:assert/strict";
import { test } from "node:test";
import { draftSelected, rankBuyers, rankingInput, selectProspects, visibleProspects } from "../convex/lib/plays/prospectSelection.ts";
import type { Prospect } from "../convex/lib/plays/model.ts";

const people: Prospect[] = Array.from({ length: 8 }, (_, i) => ({
  key: String(i), contactId: i === 7 ? null : String(i), itemId: null, name: `Buyer ${i}`, title: "Revenue Operations",
  source: "company", role: null, buyer: i !== 6, researched: false, why: null, reached: null, suggested: false, center: null, capability: null,
}));

test("search intersects the default ICP filter; bulk picks retain hidden contacts without duplicates", () => {
  assert.equal(visibleProspects(people, "").length, 7);
  assert.deepEqual(visibleProspects(people, "  BUYER 6 "), []);
  assert.deepEqual(visibleProspects(people, "buyer 6", false).map((p) => p.key), ["6"]);
  assert.equal(visibleProspects(people, "revenue buyer").length, 7);
  assert.deepEqual(selectProspects(["6", "0"], people), ["6", "0", "1", "2", "3", "4", "5"]);
});

test("more than five picks draft in bounded batches and stop on a partial failure", async () => {
  const batches: string[][] = [];
  await draftSelected(["0", "1", "2", "3", "4", "5", "6", "0"], async (ids) => { batches.push(ids); return { error: null }; });
  assert.deepEqual(batches, [["0", "1", "2", "3", "4"], ["5", "6"]]);
  let calls = 0;
  await assert.rejects(draftSelected(people.map((p) => p.key), async () => { calls++; return { error: "Draft failed." }; }), { message: "Draft failed." });
  assert.equal(calls, 2, "a failed batch does not stop the rest");
});

test("pairwise comparisons rank only ICP buyers, keep ties stable, and invalidate on product or evidence changes", async () => {
  const keys = await rankBuyers(people, async (a, b) => {
    assert.ok(a.buyer && b.buyer);
    return Number(a.key) >= Number(b.key);
  });
  assert.deepEqual(keys, ["7", "5", "4", "3", "2", "1", "0"]);
  assert.deepEqual(await rankBuyers(people, async () => true), people.filter((p) => p.buyer).map((p) => p.key));
  assert.notEqual(rankingInput(people, "A"), rankingInput(people, "B"));
  assert.notEqual(rankingInput(people, "A"), rankingInput(people.map((p) => ({ ...p, why: "New evidence" })), "A"));
  await assert.rejects(rankBuyers(people, async () => { throw new Error("Unavailable"); }));
});
