import assert from "node:assert/strict";
import test from "node:test";
import { previewReveal, runReveal, type RevealTarget } from "../src/lib/bulkReveal.ts";
import { categorizeProviderCalls, isPaidEmailHit, utcMonthWindow } from "../convex/lib/usage.ts";

const contact = (id: string, extra: Partial<RevealTarget> = {}): RevealTarget => ({ id, accountId: `a${id}`, ...extra });

test("preview counts what a run would look up and caps paid hits at the allowance", () => {
  const selected = [contact("1"), contact("2"), contact("3"), contact("4", { email: "x@y.com" }), contact("5", { emailStatus: "not_found" })];
  const preview = previewReveal(selected, 2);
  assert.deepEqual(preview.lookups.map((c) => c.id), ["1", "2", "3"]);
  assert.equal(preview.alreadyHaveEmail, 1);
  assert.equal(preview.recentlyLookedUp, 1);
  assert.equal(preview.maxPaidHits, 2);
  assert.equal(preview.overAllowance, 1);
});

test("a bulk run never spends more paid hits than the allowance, even with concurrent lookups", async () => {
  const targets = Array.from({ length: 20 }, (_, i) => contact(String(i)));
  let paid = 0;
  let inFlight = 0;
  let peak = 0;
  const report = await runReveal(targets, {
    allowance: 5,
    concurrency: 4,
    find: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      paid += 1;
      return { status: "found", paid: true };
    },
  });
  assert.equal(paid, 5);
  assert.equal(report.paidHits, 5);
  assert.equal(report.found, 5);
  assert.equal(report.skipped, 15);
  assert.equal(report.stoppedBy, "allowance");
  assert.ok(peak > 1 && peak <= 4);
});

test("free hits do not use the allowance, and a server limit stops the run", async () => {
  const targets = Array.from({ length: 6 }, (_, i) => contact(String(i)));
  const report = await runReveal(targets, {
    allowance: 1,
    concurrency: 1,
    find: async (t) => (t.id === "4" ? { status: "limit_reached" } : t.id === "1" ? { status: "not_found" } : { status: "found", paid: false }),
  });
  assert.equal(report.found, 3);
  assert.equal(report.notFound, 1);
  assert.equal(report.paidHits, 0);
  assert.equal(report.stoppedBy, "limit");
  assert.equal(report.skipped, 2);
});

test("usage groups provider spend by feature and counts only Hunter hits against the allowance", () => {
  const at = Date.UTC(2026, 9, 15);
  const calls = [
    { endpoint: "hunter.people.email.find", feature: "find_email", costMicro: 200_000, outcome: "hit" as const, at },
    { endpoint: "hunter.people.email.find", feature: "find_email", costMicro: 0, outcome: "miss" as const, at },
    { endpoint: "getleadsio.people.enrich.from_person", feature: "find_email", costMicro: 0, outcome: "hit" as const, at },
    { endpoint: "x", feature: "populate", costMicro: 0, outcome: "hit" as const, at },
  ];
  assert.equal(calls.filter(isPaidEmailHit).length, 1);
  const [top, ...rest] = categorizeProviderCalls(calls);
  assert.deepEqual([top.label, top.calls, top.hits, top.costMicro], ["Email reveals", 3, 2, 200_000]);
  assert.equal(rest.length, 1);
  const window = utcMonthWindow(at);
  assert.equal(window.start, Date.UTC(2026, 9, 1));
  assert.equal(window.resetsAt, Date.UTC(2026, 10, 1));
  assert.equal(utcMonthWindow(Date.UTC(2026, 11, 31)).resetsAt, Date.UTC(2027, 0, 1));
});
