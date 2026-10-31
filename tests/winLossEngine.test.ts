import assert from "node:assert/strict";
import { test } from "node:test";
import { intakeIntents, reviewData } from "../modules/examples/win-loss/engine.ts";
import type { ReadDoc } from "../modules/kernel/calls.ts";

// Northwind (docs/module-plans/win-loss.md §12): deals closed 2026-07-01..2026-09-30, amounts in cents.
const kite = { id: "d11", name: "Kite Energy", isClosed: true, isWon: false, closeDate: "2026-09-22", amount: 8_000_000, ownerId: "blake", companyId: "c11", dealType: "new_business", createdAt: Date.parse("2026-06-24T00:00:00Z") };
const doc = (key: string, status: string, data: Record<string, unknown> = {}): ReadDoc => ({ key, version: 3, data: { status, ...data }, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });

test("a closed deal opens its review as it closed; reopening and closing again move it, and the rep stays the owner at close", () => {
  assert.deepEqual(reviewData(kite, { employees: 2400 }), {
    deal: "d11", rep: "blake", outcome: "lost", closedOn: "2026-09-22", amount: 8_000_000, dealName: "Kite Energy", dealType: "new_business", segment: "Enterprise", daysToClose: 90,
  });
  const [open] = intakeIntents(kite, { employees: 2400 }, undefined, []);
  assert.deepEqual([open.op, (open as { key: string }).key, open.expect], ["put", "d11", [{ collection: "reviews", key: "d11", version: null }]]);
  assert.deepEqual(intakeIntents(kite, undefined, undefined, ["new_business"]), [], "an excluded deal type opens nothing");

  // Kite, a draft: reopened, then closed again by someone else.
  const reopened = intakeIntents({ ...kite, isClosed: false }, undefined, doc("d11", "draft"), []);
  assert.deepEqual(reopened.map((i) => [i.op, (i as { name?: string }).name]), [["transition", "dealReopened"]]);
  const reclosed = intakeIntents({ ...kite, ownerId: "casey" }, undefined, doc("d11", "reopened", { rep: "blake", outcome: "lost", closedOn: "2026-09-22", amount: 8_000_000, dealName: "Kite Energy", dealType: "new_business", daysToClose: 90 }), []);
  assert.deepEqual(reclosed.map((i) => [i.op, (i as { name?: string }).name]), [["transition", "dealReclosed"]], "nothing else changed: the rep stays Blake");
  // Garnet, approved: reopening keeps the approval and says so on its history.
  const garnet = intakeIntents({ ...kite, id: "d07", isClosed: false }, undefined, doc("d07", "approved"), []);
  assert.deepEqual(garnet.map((i) => [i.op, (i as { note?: string }).note]), [["event", "The deal was reopened. The approved review stands."]]);
  // A backfill opens missing reviews only.
  assert.deepEqual(intakeIntents({ ...kite, amount: 1 }, undefined, doc("d11", "pending"), [], true), []);
});

test("a draft keeps only reasons quoted word for word from the deal's own records (plan §12 evidence goldens)", async () => {
  const { readFileSync } = await import("node:fs");
  const { choiceValues, gateAnswer, outputSchema } = await import("../modules/kernel/ai.ts");
  const manifest = JSON.parse(readFileSync("modules/examples/win-loss/module.json", "utf8"));
  const ai = manifest.calls.draftReview.ai;
  const line = "Honestly the per-seat price was about forty percent over what Acme quoted us.";
  const doc = (key: string) => ({ key, version: 1, data: { label: key }, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const reads = {
    // Birch Health's call, and a note on it; Garnet's call is another deal's, so the plan never reads it here.
    acts: [{ id: "call-birch", dealId: "d02", kind: "call", text: null, transcript: `Customer (Dana): ${line}` }, { id: "note-birch", dealId: "d02", kind: "note", text: "They also asked about the Workday integration roadmap.", transcript: null }],
    reasons: ["price", "integrations", "champion", "ease_of_use"].map(doc), competitors: [doc("acme")],
  };
  const quote = (text: string, id = "call-birch") => ({ text, source: { kind: "call", id, at: "2026-08-14" }, verified: false });
  const raw = {
    summary: "Lost to Acme on price.", competitor: "acme",
    drivers: [
      { reason: "price", direction: "negative", weight: "primary", strength: "strong", by: "person", quotes: [quote("the per-seat price was about forty percent over what Acme quoted us"), quote("THE PER-SEAT PRICE  was about forty percent")] },
      { reason: "integrations", direction: "negative", weight: "contributing", strength: "normal", by: "person", quotes: [quote("asked about the Workday integration roadmap", "note-birch")] },
      { reason: "champion", direction: "negative", weight: "contributing", strength: "normal", by: "person", quotes: [quote("Acme was 40% cheaper"), quote("forty")] },
      { reason: "ease_of_use", direction: "positive", weight: "contributing", strength: "normal", by: "person", quotes: [quote("the per-seat price was about forty percent over what Acme quoted us", "call-garnet")] },
    ],
  };
  const choices = choiceValues(ai, reads);
  const g = gateAnswer(ai, outputSchema(manifest, ai)!, raw, reads, choices);
  const drivers = g.data.drivers as Array<{ reason: string; by: string; quotes: Array<{ verified: boolean }> }>;
  assert.deepEqual(drivers.map((d) => [d.reason, d.by, d.quotes.length, d.quotes.every((q) => q.verified)]), [["price", "ai", 2, true], ["integrations", "ai", 1, true]], "Canon marks what it kept: by AI, each quote verified");
  assert.deepEqual(g.dropped.map((d) => [d.path, d.why]), [
    ["drivers[2].quotes[0].text", "not found word for word in the record it names"], ["drivers[2].quotes[1].text", "shorter than 12 characters"],
    ["drivers[3].quotes[0].text", "names a record it didn't read"], ["drivers[2]", "no quote left"], ["drivers[3]", "no quote left"],
  ]);
});

test("Northwind's trends: win rates over every closed deal, reason shares over approved reviews (plan §12)", async () => {
  const { readFileSync } = await import("node:fs");
  const { reasonShares, winRates } = await import("../modules/examples/win-loss/engine.ts");
  const fx = JSON.parse(readFileSync("tests/fixtures/modules/win-loss/northwind.json", "utf8")) as { reviews: Array<Record<string, any>>; reps: Record<string, { team: string }> };
  // What a report read by a dimension and the outcome gives: count and amount per pair.
  const by = (dim: (r: Record<string, any>) => unknown) => {
    const m = new Map<string, { keys: unknown[]; values: number[] }>();
    for (const r of fx.reviews) {
      const keys = [dim(r) ?? null, r.outcome], k = JSON.stringify(keys);
      const g = m.get(k) ?? { keys, values: [0, 0] };
      g.values[0]++; g.values[1] += r.amount;
      m.set(k, g);
    }
    return [...m.values()] as Parameters<typeof winRates>[0];
  };
  const rate = (dim: (r: Record<string, any>) => unknown) => Object.fromEntries(winRates(by(dim)).map((r) => [String(r.group), [r.won, r.closed, Number(r.rate!.toFixed(3)), r.small]]));
  const [all] = winRates(by(() => "all"));
  assert.deepEqual([all.won, all.closed, all.rate, Number(all.dollarRate!.toFixed(4))], [6, 12, 0.5, 0.5405], "6/12 = 50.0%; $500,000 / $925,000 = 54.05%");
  assert.deepEqual(rate((r) => r.competitor), { acme: [2, 5, 0.4, false], null: [2, 4, 0.5, false], zenith: [2, 3, 0.667, true] }, "Zenith: small sample");
  assert.deepEqual(rate((r) => r.rep), { blake: [2, 5, 0.4, false], casey: [2, 4, 0.5, false], avery: [2, 3, 0.667, true] });
  assert.deepEqual(rate((r) => fx.reps[r.rep].team), { east: [4, 8, 0.5, false], west: [2, 4, 0.5, false] });
  assert.deepEqual(rate((r) => r.segment), { "Mid-market": [4, 7, 0.571, false], Enterprise: [2, 5, 0.4, false] });

  const approved = fx.reviews.filter((r) => r.status === "approved").map((r) => ({ outcome: r.outcome, amount: r.amount, primaryReason: r.primaryReason }));
  assert.deepEqual(reasonShares(approved, "lost").map((r) => [r.reason, r.primary, r.share, r.amount / 100]), [["price", 3, 0.6, 255000], ["integrations", 1, 0.2, 60000], ["no_decision", 1, 0.2, 30000]]);
  assert.deepEqual(reasonShares(approved, "won").map((r) => [r.reason, r.share]), [["fit", 0.6], ["security", 0.2], ["sales_experience", 0.2]]);
  const withKite = [...approved, { outcome: "lost", amount: 8_000_000, primaryReason: "no_decision" }];
  assert.deepEqual(reasonShares(withKite, "lost").map((r) => [r.reason, Number(r.share.toFixed(3))]), [["price", 0.5], ["no_decision", 0.333], ["integrations", 0.167]], "with Kite approved");
});

test("a lost deal's review says the last stage it held open, from the close itself (plan §12 watch golden: Echo Retail)", async () => {
  const { changeKeys } = await import("../modules/examples/win-loss/engine.ts");
  const { calls } = await import("../modules/examples/win-loss/server.ts");
  // One ledger entry moves Echo from Discovery to Closed Lost; win-loss had never seen it open.
  const keys = changeKeys({ id: "d05", before: { isClosed: false, stage: "Discovery" }, after: { isClosed: true, isWon: false, stage: "Closed Lost" } });
  assert.deepEqual(keys, [{ job: "keepStage", key: "d05|446973636f76657279" }], "the stage it left rides on the key");
  const kept = await calls.keepStage({ now: 1, caller: { userId: "system", role: "system" }, args: { keys: keys.map((k) => k.key) } }, { stages: [] });
  assert.deepEqual(kept.byKey!["d05|446973636f76657279"].map((i) => [i.op, (i as { data?: { stage: string } }).data?.stage ?? (i as { job: string }).job]), [["put", "Discovery"], ["dirty", "intake"]]);
  const echo = { id: "d05", name: "Echo Retail", isClosed: true, isWon: false, closeDate: "2026-07-28", amount: 3_000_000, ownerId: "casey", stage: "Closed Lost" };
  const [open] = intakeIntents(echo, undefined, undefined, [], false, false, "Discovery");
  assert.equal((open as { data: Record<string, unknown> }).data.lostAtStage, "Discovery");
  assert.deepEqual(changeKeys({ id: "d05", before: { isClosed: true, ownerId: "a" }, after: { isClosed: true, ownerId: "b" } }), [{ job: "intake", key: "d05" }], "an owner change after close looks at the review at once");
});

test("Northwind's battlecard digest proposes one Acme pricing update, once, and nothing for Zenith (plan §12)", async () => {
  const { readFileSync } = await import("node:fs");
  const { cardDigest } = await import("../modules/examples/win-loss/engine.ts");
  const fx = JSON.parse(readFileSync("tests/fixtures/modules/win-loss/northwind.json", "utf8")) as { reviews: Array<Record<string, any>> };
  const published = fx.reviews.filter((r) => r.status === "approved").map((r) => ({ key: r.key, data: { ...r, drivers: [
    { reason: r.primaryReason, weight: "primary", quotes: [{ text: `What ${r.deal} said about ${r.primaryReason}.`, verified: true, source: { kind: "call", at: r.closedOn } }] },
  ] } }));
  const reasons = new Map([["price", { label: "Price", category: "price" }], ["fit", { label: "Product fit", category: "product" }], ["integrations", { label: "Integrations", category: "product" }]]);
  const now = Date.parse("2026-10-01T00:00:00Z");
  const digest = (competitor: string, name: string, existing: Array<{ data: Record<string, unknown> }> = []) =>
    cardDigest({ competitor, name, now, reasons, existing, published: published.filter((p) => (p.data as Record<string, unknown>).competitor === competitor) });
  const [acme, ...more] = digest("acme", "Acme");
  assert.deepEqual(more, [], "exactly one update");
  assert.deepEqual([acme.section, acme.line, acme.quotes.map((q) => q.review)], ["pricing", "3 of 3 losses to Acme since 2026-07 cite Price", ["d02", "d07", "d09"]]);
  assert.deepEqual(digest("acme", "Acme", [{ data: acme }]), [], "running it again proposes nothing new");
  assert.deepEqual(digest("zenith", "Zenith"), [], "one loss to Zenith proposes nothing");
  // Accepting it adds the line and its quotes to Acme's pricing section (a new section here), and moves the update on.
  const { calls } = await import("../modules/examples/win-loss/server.ts");
  const update = { key: "u1", version: 1, data: { ...acme, status: "proposed" }, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 };
  const out = await calls.applyCardUpdate({ now, caller: { userId: "boss", role: "manager" }, args: { update: "u1" } }, { update, cards: [] });
  assert.deepEqual(out.intents!.map((i) => [i.op, (i as { parentKey?: string }).parentKey ?? (i as { name?: string }).name]), [["put", "acme"], ["transition", "accept"]]);
  const full = { key: "c1", version: 1, data: { section: "pricing", text: "x".repeat(5990) }, owner: null, parentKey: "acme", createdAt: 0, updatedAt: 0 };
  assert.throws(() => calls.applyCardUpdate({ now, caller: { userId: "boss", role: "manager" }, args: { update: "u1" } }, { update, cards: [full] }), /section is full/, "a full section refuses rather than cut the update short");
  assert.match(String((out.intents![0] as unknown as { data: { text: string } }).data.text), /^3 of 3 losses to Acme since 2026-07 cite Price\n"What d02 said about price\." \(call, 2026-07-20\)/);
});

test("a review keeps the CRM's own loss reason, region and lead source as the deal held them at close (M8)", async () => {
  const deal = { id: "d02", name: "Birch Health", isClosed: true, isWon: false, closeDate: "2026-08-14", amount: 12_000_000, ownerId: "avery", custom: { loss_reason: "Price", region: "EMEA", lead_source: ["Webinar"] } };
  const data = reviewData(deal, undefined, null, { lossReasonField: "custom.loss_reason", regionField: "region", sourceField: "lead_source" })!;
  assert.deepEqual([data.crmLossReason, data.region, data.source], ["Price", "EMEA", "Webinar"]);
  assert.equal(reviewData({ ...deal, isWon: true }, undefined, null, { lossReasonField: "loss_reason" })!.crmLossReason, undefined, "a win has no loss reason");
});
