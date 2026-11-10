import assert from "node:assert/strict";
import test from "node:test";
import { MICRO, creditsPerRecord, packFromSession, paidBalanceMicro, splitSpend } from "../convex/lib/creditPacks.ts";
import { addCredits, ensureAccount, metronome } from "../convex/lib/metronome.ts";
import { recordsAffordable } from "../convex/lib/research/runPlan.ts";

test("a credits session grants its pack only when Stripe charged that pack's price", () => {
  assert.deepEqual(packFromSession({ metadata: { pack: "100" }, amount_subtotal: 10_000 }), { price: 100, credits: 12_000 });
  assert.equal(packFromSession({ metadata: { pack: "100" }, amount_subtotal: 2_500 }), null, "price changed in flight");
  assert.equal(packFromSession({ metadata: { pack: "7" }, amount_subtotal: 700 }), null, "not a pack we sell");
  assert.deepEqual(packFromSession({ lookupKey: "canoncrm_credits_500" }), { price: 500, credits: 50_000 }, "a session opened before code-priced packs gets its dollars at the per-use price");
  assert.equal(packFromSession({ lookupKey: "canoncrm_starter_monthly" }), null);
  assert.equal(packFromSession({}), null);
});

test("Metronome: an existing account is reused and a repeated commit is not an error", async () => {
  process.env.METRONOME_API_KEY = "test";
  const calls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(path);
    if (path.startsWith("/v1/customers?ingest_alias=org1")) return Response.json({ data: [{ id: "cust1" }] });
    if (path === "/v2/contracts/list") return Response.json({ data: [{ id: "con1" }] });
    if (path === "/v2/contracts/edit") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.uniqueness_key, "cs_1");
      assert.equal(body.add_commits[0].access_schedule.schedule_items[0].amount, 2500, "cents");
      return new Response('{"message":"duplicate"}', { status: 409 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  const m = metronome(fake)!;
  assert.deepEqual(await ensureAccount(m, { orgId: "org1", name: "Acme" }), { customerId: "cust1", contractId: "con1" });
  await addCredits(m, { customerId: "cust1", contractId: "con1", productId: "p", cents: 2500, key: "cs_1", name: "Credits $25", at: Date.UTC(2026, 9, 9) });
  assert.ok(!calls.some((c) => c === "/v1/customers" || c === "/v1/contracts/create"), "nothing created twice");
  delete process.env.METRONOME_API_KEY;
});

test("credits: paid contacts priced at three times cost, free allowance spent first, old dollar balances converted", () => {
  assert.equal(creditsPerRecord(0.00038), 1, "Icypeas: the floor of one credit");
  assert.equal(creditsPerRecord(0.009), 3, "Crustdata: $0.027 at three times cost");
  assert.deepEqual(splitSpend(100, 30), { freeMicro: 30, paidMicro: 70 });
  assert.deepEqual(splitSpend(100, 500), { freeMicro: 100, paidMicro: 0 });
  assert.equal(paidBalanceMicro({ creditBalanceMicro: 25 * MICRO }), 2_500 * MICRO, "$25 becomes 2,500 credits");
  assert.equal(paidBalanceMicro({ creditBalanceMicro: 2_500 * MICRO, creditUnit: "credits" }), 2_500 * MICRO);
});

test("a research run's cap pays for whole records only", () => {
  assert.equal(recordsAffordable(20 * MICRO, 0), 20);
  assert.equal(recordsAffordable(20 * MICRO, 19.5 * MICRO), 0, "half a credit left is less than one record");
  assert.equal(recordsAffordable(10 * MICRO, 15 * MICRO), 0);
});
