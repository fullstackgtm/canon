import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const DAY = 86_400_000;
const loaded = loadConvex(["linkedinWorker.ts"], {
  "linkedinActions.ts": (real) => ({ ...real, convexSiteUrl: () => "http://127.0.0.1:1", unipileEnv: () => null }),
}, { Date: class extends Date { static now() { return NOW; } } });

function harness(opts: { activity?: Array<Record<string, unknown>>; lookupsUsed?: number; activeWithinDays?: number } = {}) {
  const db = memoryDb({
    organizations: [{ _id: "org" }],
    linkedinAccounts: [{ _id: "linkedin", orgId: "org", status: "ok", timezone: "UTC", window: { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }, tier: "premium", rampStep: 5, nextInviteAt: NOW, unipileAccountId: "fake-linkedin" }],
    linkedinCadences: [{ _id: "cadence", orgId: "org", status: "active", steps: [{ kind: "invite", note: "Hi" }], ...(opts.activeWithinDays === undefined ? {} : { activeWithinDays: opts.activeWithinDays }) }],
    linkedinEnrollments: [{ _id: "ada", orgId: "org", cadenceId: "cadence", senderAccountId: "linkedin", contactId: "ada", linkedinUrl: "https://linkedin.com/in/ada", publicIdentifier: "ada", vars: {}, state: "queued", stepIndex: 0, nextAt: NOW, enrolledAt: NOW }],
    linkedinActivity: opts.activity ?? [],
    linkedinSends: Array.from({ length: opts.lookupsUsed ?? 0 }, (_, i) => ({ _id: `s${i}`, orgId: "org", accountId: "linkedin", kind: "lookup", ok: true, at: NOW - 1000 })),
  });
  const ctx = { db, scheduler: { runAfter: async () => {} }, auth: { getUserIdentity: async () => null } };
  const call = (name: string, args: Record<string, unknown>) => loaded["linkedinWorker.ts"][name].handler(ctx, args);
  return { db, call };
}

test("claim asks the invite job to check activity when nothing fresh is stored, and only if the lookups cover it", async () => {
  const h = harness();
  const job = await h.call("claim", { accountId: "linkedin" });
  assert.equal(job.kind, "invite");
  assert.equal(job.activeWithinDays, 90, "unset cadence setting means 90 days");

  const off = await harness({ activeWithinDays: 0 }).call("claim", { accountId: "linkedin" });
  assert.equal(off.activeWithinDays, null);

  // A warmed-up account allows 60 lookups a day; with 58 used, a profile lookup plus two activity calls doesn't fit.
  assert.equal(await harness({ lookupsUsed: 58 }).call("claim", { accountId: "linkedin" }), null);
});

test("a fresh stored check decides at claim: quiet stops without a call, active invites without re-checking", async () => {
  const quiet = harness({ activity: [{ _id: "a", orgId: "org", providerId: "ACoA1", publicIdentifier: "ada", lastActiveAt: NOW - 200 * DAY, checkedAt: NOW - DAY }] });
  assert.equal((await quiet.call("claim", { accountId: "linkedin" })).kind, "skip");
  const ada = await quiet.db.get("ada");
  assert.equal(ada!.state, "stopped");
  assert.match(String(ada!.reason), /90 days/);

  const active = harness({ activity: [{ _id: "a", orgId: "org", providerId: "ACoA1", publicIdentifier: "ada", lastActiveAt: NOW - 3 * DAY, checkedAt: NOW - DAY }] });
  assert.equal((await active.call("claim", { accountId: "linkedin" })).activeWithinDays, null);

  const stale = harness({ activity: [{ _id: "a", orgId: "org", providerId: "ACoA1", publicIdentifier: "ada", lastActiveAt: NOW - 200 * DAY, checkedAt: NOW - 40 * DAY }] });
  assert.equal((await stale.call("claim", { accountId: "linkedin" })).activeWithinDays, 90, "a check older than 30 days is redone");

  const otherOrg = harness({ activity: [{ _id: "a", orgId: "elsewhere", providerId: "ACoA1", publicIdentifier: "ada", lastActiveAt: NOW - 200 * DAY, checkedAt: NOW - DAY }] });
  assert.equal((await otherOrg.call("claim", { accountId: "linkedin" })).kind, "invite", "another org's check is never used");
});

test("finish stores the check per org and stops a dormant contact", async () => {
  const h = harness();
  await h.call("finish", {
    accountId: "linkedin",
    sends: [{ kind: "lookup", ok: true, enrollmentId: "ada" }, { kind: "lookup", ok: true, enrollmentId: "ada" }, { kind: "lookup", ok: true, enrollmentId: "ada" }],
    events: [{ event: "activity", id: "ada", providerId: "ACoA1", lastActiveAt: null }, { event: "dormant", id: "ada", reason: "No recent posts or comments on LinkedIn; not invited" }],
    effect: null,
  });
  const ada = await h.db.get("ada");
  assert.equal(ada!.state, "stopped");
  assert.equal(ada!.providerId, "ACoA1");
  const rows = h.db.rows("linkedinActivity");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orgId, "org");
  assert.equal(rows[0].lastActiveAt, undefined);
  assert.equal(rows[0].checkedAt, NOW);
  assert.equal(h.db.rows("linkedinSends").length, 3, "every activity call counts against the lookup cap");
});
