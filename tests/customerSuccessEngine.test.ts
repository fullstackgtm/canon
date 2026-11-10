import assert from "node:assert/strict";
import { test } from "node:test";
import { ACME_DEALS } from "../convex/lib/sampleAcme.ts";
import { addDays, arrOn, ledger, type Deal } from "../modules/examples/customer-success/engine/contracts.ts";
import { retention } from "../modules/examples/customer-success/engine/retention.ts";
import { dailyUsage, GROW_DEFAULTS, usageSignals } from "../modules/examples/customer-success/engine/usage.ts";
import { webhookItem } from "../convex/lib/connectors/webhook.ts";
import { calls } from "../modules/examples/customer-success/server.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";

// Acme Analytics (docs/module-plans/customer-success.md §12), as Canon's deal reads give it: amounts in cents.
const deals: Deal[] = ACME_DEALS.map((d) => ({
  id: d.key, name: d.name, amount: d.arr * 100, arr: d.arr * 100, closeDate: d.close, dealType: d.type, revenueType: "recurring", contractLengthMonths: 12,
  isClosed: d.status === "won" || d.status === "lost", isWon: d.status === "won", companyId: d.company, companyName: d.company, ownerId: "dana",
}));
const $ = (dollars: number) => dollars * 100;
const ctx = (args: Record<string, unknown>): CallContext => ({ now: Date.parse("2026-10-20T15:00:00Z"), caller: { userId: "lee", role: "manager" }, args });

test("Acme's ARR ledger: renewals replace what they renew, an expansion adds, a lost renewal leaves the old line to end", () => {
  const { lines, skipped } = ledger(deals);
  assert.deepEqual(skipped, []);
  assert.deepEqual(lines.map((l) => [l.deal, l.kind, l.start, l.until, l.renewedArr]), [
    ["initech-2025", "new", "2025-07-01", "2026-07-01", null],
    ["umbrella-2025", "new", "2025-08-01", "2026-08-01", null],
    ["umbrella-renewal", "contraction", "2026-08-01", "2027-08-01", $(80_000)],
    ["northwind-2025", "new", "2025-10-01", "2026-10-01", null],
    ["northwind-renewal", "renewal", "2026-10-01", "2027-10-01", $(120_000)],
    ["globex-2025", "new", "2025-11-15", "2026-11-15", null],
    ["soylent-2025", "new", "2025-12-20", "2026-12-20", null],
    ["hooli-2026", "new", "2026-02-01", "2027-02-01", null],
    ["hooli-seats", "expansion", "2026-05-01", "2027-05-01", null],
  ]);
  assert.deepEqual(Object.fromEntries(arrOn(lines, "2025-12-31")), { initech: $(40_000), umbrella: $(80_000), northwind: $(120_000), globex: $(60_000), soylent: $(30_000) });
  assert.deepEqual(Object.fromEntries(arrOn(lines, "2026-10-31")), { umbrella: $(64_000), northwind: $(132_000), globex: $(60_000), soylent: $(30_000), hooli: $(75_000) });
});

test("Acme's retention, 2026-01-01 to 2026-10-31: NRR 86.67%, GRR 83.03%, Hooli in neither (plan §12)", () => {
  const r = retention(ledger(deals).lines, "2026-01-01", "2026-10-31");
  assert.deepEqual(r.total, {
    start: $(330_000), end: $(286_000), grrNumerator: $(274_000), nrr: 286 / 330, grr: 274 / 330,
    churn: $(40_000), contraction: $(16_000), expansion: $(12_000), accounts: 5,
  });
  assert.deepEqual([(r.total.nrr! * 100).toFixed(2), (r.total.grr! * 100).toFixed(2)], ["86.67", "83.03"]);
  assert.deepEqual(r.newLogos, [{ company: "hooli", arr: $(75_000) }]);
});

test("the contracts job writes each account and its contracts once; Retention reads them, with what was guessed or left out", async () => {
  const messy: Deal[] = [...deals, { id: "x1", name: "Stark no length", amount: $(10_000), closeDate: "2026-03-01", dealType: "new_business", revenueType: "recurring", isWon: true, companyId: "stark", companyName: "stark" },
    { id: "x2", name: "Orphan", amount: $(5_000), arr: $(5_000), closeDate: "2026-04-01", dealType: "new_business", revenueType: "recurring", isWon: true, companyId: null }];
  const keys = ["umbrella", "initech", "northwind", "globex", "soylent", "hooli", "stark"];
  const companies = keys.map((id) => ({ id, name: id === "umbrella" ? "Umbrella" : id }));
  const first = await calls.rebuild(ctx({ keys, company: keys }), { deals: messy, companies, accounts: [], contracts: [] });
  const umbrella = first.byKey!.umbrella;
  assert.deepEqual(umbrella[0], { op: "put", collection: "accounts", key: "umbrella", expect: [{ collection: "accounts", key: "umbrella", version: null }],
    data: { company: "umbrella", arr: $(64_000), contracts: 2, companyName: "Umbrella", renewalOn: "2027-08-01", since: "2025-08-01", lastDeal: "umbrella-renewal", csm: "dana" } });
  assert.deepEqual(umbrella.slice(1).map((i) => i.op === "put" ? [i.key, i.parentKey] : null), [["umbrella-2025", "umbrella"], ["umbrella-renewal", "umbrella"]]);
  assert.equal((first.byKey!.initech[0] as unknown as { data: { arr: number } }).data.arr, 0, "Initech's renewal was lost: an account at $0, no renewal date");

  // Run again over what it wrote: nothing changed, nothing written.
  const doc = (key: string, data: Record<string, unknown>, version = 1): ReadDoc => ({ key, version, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const written = Object.values(first.byKey!).flat().filter((i) => i.op === "put") as Array<{ collection: string; key: string; data: Record<string, unknown> }>;
  const accounts = written.filter((i) => i.collection === "accounts").map((i) => doc(i.key, i.data));
  const contracts = written.filter((i) => i.collection === "contracts").map((i) => doc(i.key, i.data));
  const again = await calls.rebuild(ctx({ keys, company: keys }), { deals: messy, companies, accounts, contracts });
  assert.deepEqual(Object.values(again.byKey!).flat(), []);

  // Retention from the stored contracts: the caller's deals only say what was left out.
  const acme = await calls.retention(ctx({ from: "2026-01-01", to: "2026-10-31" }), { contracts: contracts.filter((c) => c.data.account !== "stark"), accounts, users: [], deals: [] }) as { value: Record<string, unknown> };
  assert.deepEqual([acme.value.start, acme.value.end, acme.value.grrNumerator, acme.value.newLogoArr], [$(330_000), $(286_000), $(274_000), $(75_000)]);
  assert.deepEqual(acme.value.bridge, [{ step: "Churn", amount: -$(40_000) }, { step: "Contraction", amount: -$(16_000) }, { step: "Expansion", amount: $(12_000) }], "330,000 − 40,000 − 16,000 + 12,000 = 286,000");
  const { value } = await calls.retention(ctx({ from: "2026-01-01", to: "2026-12-31" }), { contracts, accounts, users: [], deals: messy }) as { value: Record<string, unknown> };
  assert.deepEqual([value.to, value.end, value.grrNumerator], ["2026-12-31", $(196_000), $(184_000)], "the requested end uses booked contracts; open renewals add no ARR (plan §6)");
  assert.deepEqual(value.notes, [
    { deal: "x1", name: "Stark no length", company: "stark", note: "No ARR on the deal: its amount is used · No contract length: 12 months assumed", kind: "Guessed" },
    { deal: "x2", name: "Orphan", company: "No company", note: "No company on the deal: not counted", kind: "Left out" },
  ]);
});

const usageDoc = (key: string, data: Record<string, unknown>): ReadDoc => ({ key, data, version: 1, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
const usageDay = "2026-10-20";
const usageHistory = (recent: number) => Array.from({ length: 56 }, (_, i) => ({ day: addDays(usageDay, i - 56), metrics: { active_users: i < 28 ? 100 : recent } }));

test("Grow goldens explain decline, renewal, inactivity, seat saturation and sustained growth", () => {
  const declining = usageSignals(usageHistory(70), { renewalOn: "2027-01-18" }, usageDay);
  assert.deepEqual(declining, [
    { kind: "declining", category: "Churn risk", title: "Active users declining", evidence: "Active users/day 100 to 70 (30% down). 2026-08-25–2026-09-21: 28/28 days; 2026-09-22–2026-10-19: 28/28 days. Threshold 30%." },
    { kind: "renewal", category: "Churn risk", title: "Renewal with declining usage", evidence: "Renews 2027-01-18, in 90 days (within 90). Active users/day 100 to 70 (30% down). 2026-08-25–2026-09-21: 28/28 days; 2026-09-22–2026-10-19: 28/28 days. Decline threshold 30%." },
  ]);
  assert.deepEqual(usageSignals([{ day: "2026-10-06", metrics: { active_users: 3 } }], {}, usageDay), [
    { kind: "inactive", category: "Churn risk", title: "No reported usage", evidence: "14 days since positive activity on 2026-10-06; threshold 14. Last activity report 2026-10-06, 14 days ago. Missing reports may indicate a feed outage." },
  ]);
  assert.deepEqual(usageSignals([...usageHistory(125), { day: usageDay, metrics: { seats_used: 18, seats_purchased: 20 } }], {}, usageDay), [
    { kind: "seats", category: "Expansion", title: "Seats near limit", evidence: "18/20 seats used (90%) on 2026-10-20; threshold 90%." },
    { kind: "growth", category: "Expansion", title: "Sustained usage growth", evidence: "Prior 4-week active users/day 100 (28/28 days). Each recent week averages 125, 125, 125, 125 with 7, 7, 7, 7 reported days; each at least 25% above baseline." },
  ]);
});

test("Grow treats missing days as unknown, excludes today from comparisons and honors thresholds", () => {
  assert.deepEqual(usageSignals(usageHistory(50).filter((_, i) => i < 28 || i % 2 === 0), {}, usageDay), []);
  assert.deepEqual(usageSignals(usageHistory(71), { renewalOn: "2026-10-19" }, usageDay), []);
  assert.deepEqual(usageSignals(usageHistory(70), { renewalOn: "2027-01-19" }, usageDay).map((s) => s.kind), ["declining"]);
  assert.deepEqual(usageSignals([...usageHistory(125).map((r, i) => i >= 49 ? { ...r, metrics: { active_users: 100 } } : r), { day: usageDay, metrics: { seats_used: 20, seats_purchased: 0 } }], {}, usageDay), []);
  assert.deepEqual(usageSignals(usageHistory(70), {}, usageDay, { ...GROW_DEFAULTS, declinePercent: 31 }), []);
  assert.deepEqual(usageSignals([{ day: "2026-10-17", metrics: { seats_used: 20, seats_purchased: 20 } }], {}, usageDay), []);
  assert.equal(typeof dailyUsage({ day: "2026-02-30", metrics: { active_users: 1 } }, usageDay), "string");
  assert.equal(typeof dailyUsage({ day: usageDay, metrics: { active_users: -1 } }, usageDay), "string");
});

test("usage feed imports daily aggregates by exact unique customer domain, reviews unknowns, and corrects one account/day", async () => {
  const account = usageDoc("acc_atlas", { company: "acc_atlas", arr: 10_000 });
  const feed = async (id: string, domain: string, metrics: Record<string, number>, at = 1) => {
    const payload = { id, type: "usage.daily", subject: { domain }, data: { day: usageDay, metrics } };
    const item = await webhookItem(payload, JSON.stringify(payload));
    assert.ok(item.ok);
    return { id, seq: at, link: { userId: null }, at, before: null, after: item.data };
  };
  const reads = { accounts: [account], usage: [], companies: [{ id: account.key, domain: "atlas.io" }] };
  const first = await calls.onUsage(ctx({ items: [await feed("atlas/day", "atlas.io", { active_users: 14, seats_used: 18, seats_purchased: 20 }), await feed("unknown", "unknown.io", { active_users: 99 })] }), reads);
  const puts = first.intents!.filter((i) => i.op === "put");
  assert.deepEqual(puts.map((i) => [i.collection, i.data.account ?? i.data.domain, i.data.metrics ?? i.data.reason]), [
    ["usage", "acc_atlas", { active_users: 14, seats_used: 18, seats_purchased: 20 }], ["usageReview", "unknown.io", "No customer account has this domain."],
  ]);
  const saved = puts[0];
  const correction = await calls.onUsage(ctx({ items: [await feed("atlas/day", "atlas.io", { active_users: 12 }, 2)] }), { ...reads, usage: [{ ...usageDoc(saved.key!, saved.data), parentKey: account.key }] });
  assert.equal(correction.intents!.filter((i) => i.op === "put" && i.collection === "usage").length, 1);
  const corrected = correction.intents!.find((i) => i.op === "put" && i.collection === "usage");
  assert.ok(corrected?.op === "put");
  assert.deepEqual(corrected.data.metrics, { active_users: 12 });
  const savedReads = { ...reads, usage: [{ ...usageDoc(saved.key!, saved.data), parentKey: account.key }] };
  const invalid = await calls.onUsage(ctx({ items: [await feed("atlas/day", "atlas.io", { active_users: -1 }, 2)] }), savedReads);
  assert.ok(invalid.intents!.some((i) => i.op === "put" && i.collection === "usageReview"));
  assert.equal(invalid.intents!.some((i) => "collection" in i && i.collection === "usage"), false);
  const deleted = await calls.onUsage(ctx({ items: [{ ...await feed("atlas/day", "atlas.io", {}, 2), before: { type: "usage.daily" }, after: null }] }), savedReads);
  assert.ok(deleted.intents!.some((i) => i.op === "delete" && i.collection === "usage"));
  const ignored = await calls.onUsage(ctx({ items: [{ ...await feed("other", "atlas.io", {}), after: { type: "form.submitted" } }] }), reads);
  assert.deepEqual(ignored.intents, []);
  const ambiguous = await calls.onUsage(ctx({ items: [await feed("ambiguous", "atlas.io", { active_users: 1 })] }), { ...reads, companies: [...reads.companies, ...reads.companies] });
  assert.equal(ambiguous.intents!.some((i) => i.op === "put" && i.collection === "usage"), false);
});
