import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { creditMonth, MICRO } from "../convex/lib/creditPacks.ts";

const user = { _id: "user", orgId: "org", role: "admin" };
const spec = { market: { industries: ["software development"], countries: [], employeeBands: [] }, persona: { titles: ["Django developer"], levels: [], departments: [] }, exclude: { industries: [], countries: [], titles: [] } };
const modules = loadConvex(["researchSessions.ts", "tamInvestigations.ts", "marketSources.ts", "credits.ts", "tamInvestigationWorker.ts"], {
  "lib.ts": (real) => ({ ...real, requireUser: async () => user, requireCap: async () => user, getCurrentUser: async () => user, agentClientOf: async () => null }),
  "permissions.ts": (real) => ({ ...real, accessFor: async () => ({ role: "admin", rules: {} }) }),
  "lib/access.ts": (real) => ({ ...real, refuseNarrowed: () => undefined }),
  "lib/treg.ts": (real) => ({ ...real, paidCallsAllowed: () => false }),
  "records.ts": (real) => ({ ...real, clientFor: () => ({ list: async () => ({ rows: [{ name: "Django shop", domain: "shop.example" }] }) }) }),
  "moduleDefaults.ts": (real) => ({ ...real, applyStartingPlan: async () => undefined }),
});

function fixture(existing = false, noIcp = false) {
  const now = Date.now();
  const db = memoryDb({
    organizations: [{ _id: "org", createdAt: existing ? 0 : now, startingPlan: {}, creditUnit: "credits", creditBalanceMicro: 1000 * MICRO }],
    researchSessions: ["first", "second"].map((id) => ({ _id: id, token: id, status: "ready", domain: "vendor.example", createdAt: now - 1000, invitedEmail: "ryan@vendor.example", events: [] })),
    icps: noIcp ? [] : [{ _id: "icp", orgId: "org", name: "Django developers", active: true, source: "research", sourceDomain: "vendor.example", spec }],
  });
  const scheduled: { ref: string; args: Record<string, string> }[] = [];
  const ctx = { db, auth: { getUserIdentity: async () => ({ email: "ryan@vendor.example", emailVerified: true }) }, scheduler: { runAfter: async (_delay: number, ref: unknown, args: Record<string, string>) => { scheduled.push({ ref: String(ref), args }); } } };
  return { modules, db, scheduled, ctx };
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("claim schedules exactly one signup investigation after import, including second claims and completion retries", async () => {
  const { modules: m, ctx, db, scheduled } = fixture();
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].claim.handler(ctx, { token: "second" });
  assert.deepEqual(plain((await db.get("org"))!.signupInvestigation), { state: "pending", sessionId: "first" });
  assert.equal(db.rows("tamInvestigations").length, 0);
  await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
  assert.equal(db.rows("tamInvestigations").length, 0);
  for (const sessionId of ["first", "first", "second"]) {
    await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId, importStatus: "done", importedAccounts: 2 });
    await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId });
  }
  assert.equal(scheduled.filter((s) => s.ref === "internal.tamInvestigations.afterImport").length, 2);
  assert.equal(scheduled.filter((s) => s.ref === "internal.tamInvestigationWorker.signupSearch").length, 1);
  const runs = db.rows("tamInvestigations");
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].trigger, runs[0].status, runs[0].capCredits, runs[0].freeOnly], ["signup", "planning", 500, true]);
  assert.deepEqual(plain((await db.get("org"))!.signupInvestigation), { state: "started", sessionId: "first", investigationId: runs[0]._id });
});

test("existing workspaces are excluded and a missing ICP records one event without a run", async () => {
  for (const existing of [true, false]) {
    const { modules: m, ctx, db } = fixture(existing, true);
    await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
    await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
    await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
    await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
    assert.equal(db.rows("tamInvestigations").length, 0);
    const events = (await db.get("first"))!.events as { text: string }[];
    assert.equal(events.length, existing ? 0 : 1);
    if (!existing) assert.equal(events[0].text, "Market mapping was not started because this workspace has no ICP.");
  }
});

test("free-only holds refuse bought credits and signup pauses until explicit continuation", async () => {
  const { modules: m, ctx, db } = fixture();
  await db.patch("org", { freeCreditsMonth: creditMonth(Date.now()), freeCreditsUsedMicro: 1000 * MICRO });
  const hold = { orgId: "org", ref: "free-only", amountMicro: MICRO, note: "signup", freeOnly: true };
  assert.deepEqual(plain(await m["credits.ts"].hold.handler(ctx, hold)), { ok: false, reason: "balance" });
  assert.equal(db.rows("creditLedger").length, 0);
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
  const id = await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
  await m["tamInvestigations.ts"].planned.handler(ctx, { investigationId: id, sources: [{ kind: "people_phrase", ref: "Django developer", label: "Developers", estimatedCompanies: 100 }], note: "No directories found." });
  assert.equal((await db.get(id))!.status, "paused_at_cap");
  assert.equal((await db.get("org"))!.creditBalanceMicro, 1000 * MICRO);
  await m["tamInvestigations.ts"].start.handler(ctx, { investigationId: id });
  assert.deepEqual([(await db.get(id))!.status, (await db.get(id))!.freeOnly, (await db.get("org"))!.creditBalanceMicro], ["running", false, 900 * MICRO]);
});

test("signup starts without a click, reserves remaining free balance and never exceeds its cap", async () => {
  const { modules: m, ctx, db } = fixture();
  await db.patch("org", { freeCreditsMonth: creditMonth(Date.now()), freeCreditsUsedMicro: 999 * MICRO });
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
  const id = await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
  const sources = [{ kind: "people_phrase", ref: "Django developer", label: "Developers", estimatedCompanies: 1000 }];
  await m["tamInvestigations.ts"].planned.handler(ctx, { investigationId: id, sources, note: "No directories found." });
  await m["tamInvestigations.ts"].planned.handler(ctx, { investigationId: id, sources, note: "Retry" });
  assert.equal((await db.get(id))!.status, "running");
  assert.equal(db.rows("creditLedger").length, 1);
  assert.deepEqual([db.rows("creditLedger")[0].amountMicro, db.rows("creditLedger")[0].freeMicro], [-MICRO, MICRO]);
  const candidateId = await db.insert("tamCandidates", { investigationId: id, orgId: "org", name: "Django shop", state: "found", keys: {}, sources: [] });
  const resolving = { ...ctx, runMutation: async () => null };
  await m["tamInvestigations.ts"].resolved.handler(resolving, { investigationId: id, candidateId, step: 0, domain: "shop.example" });
  const other = await db.insert("tamCandidates", { investigationId: id, orgId: "org", name: "Other shop", state: "found", keys: {}, sources: [] });
  await m["tamInvestigations.ts"].resolved.handler(resolving, { investigationId: id, candidateId: other, step: 1, domain: "other.example" });
  assert.deepEqual([(await db.get(id))!.status, (await db.get(id))!.spentCredits, (await db.get("org"))!.creditBalanceMicro], ["paused_at_cap", 1, 1000 * MICRO]);
});

test("refused and empty directory searches schedule planning once, pinned to the signup run", async () => {
  for (const refused of [true, false]) {
    const { modules: m, ctx, db, scheduled } = fixture();
    await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
    await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
    const id = await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
    const args = { orgId: "org", startedBy: "user", investigationId: id, seeds: [], ...(refused ? { reason: "Paid calls off" } : {}) };
    const runId = await m["marketSources.ts"].begin.handler(ctx, args);
    assert.equal(await m["marketSources.ts"].begin.handler(ctx, args), runId);
    if (!refused) {
      await m["marketSources.ts"].finish.handler(ctx, { runId, status: "done" });
      await m["marketSources.ts"].finish.handler(ctx, { runId, status: "done" });
    }
    assert.equal((await db.get(id))!.searchId, runId);
    assert.equal(db.rows("marketSourceSearches").length, 1);
    assert.equal(scheduled.filter((s) => s.ref === "internal.tamInvestigationWorker.makePlan").length, 1);
  }
});

test("paid calls off still plans people phrases and automatically starts from the post-import entry point", async () => {
  const { modules: m, ctx, db } = fixture();
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
  const id = await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
  const actions = {
    ...ctx,
    runQuery: async (_ref: unknown, args: unknown) => m["tamInvestigations.ts"].load.handler(ctx, args),
    runMutation: async (ref: unknown, args: unknown) => {
      if (String(ref) === "internal.marketSources.begin") return m["marketSources.ts"].begin.handler(ctx, args);
      if (String(ref) === "internal.tamInvestigations.planned") return m["tamInvestigations.ts"].planned.handler(ctx, args);
      throw new Error(`Unexpected call ${String(ref)}`);
    },
  };
  await m["tamInvestigationWorker.ts"].signupSearch.handler(actions, { investigationId: id });
  await m["tamInvestigationWorker.ts"].makePlan.handler(actions, { investigationId: id });
  assert.equal(db.rows("marketSourceSearches")[0].status, "refused");
  assert.deepEqual(plain(db.rows("marketSourceSearches")[0].seeds), [{ name: "Django shop", domain: "shop.example" }]);
  assert.equal((await db.get(id))!.status, "running");
  assert.deepEqual(plain((await db.get(id))!.plan), { sources: [{ kind: "people_phrase", ref: "Django developer", label: 'People with "Django developer" in their title', estimatedCompanies: 100 }] });
});

test("a signup estimate above 500 reserves only the automatic cap and Stop returns it", async () => {
  const { modules: m, ctx, db } = fixture();
  await m["researchSessions.ts"].claim.handler(ctx, { token: "first" });
  await m["researchSessions.ts"].patchImport.handler(ctx, { sessionId: "first", importStatus: "done" });
  const id = await m["tamInvestigations.ts"].afterImport.handler(ctx, { sessionId: "first" });
  await m["tamInvestigations.ts"].planned.handler(ctx, { investigationId: id, sources: [{ kind: "people_phrase", ref: "Django developer", label: "Developers", estimatedCompanies: 1000 }], note: "Large estimate" });
  assert.deepEqual([db.rows("creditLedger")[0].amountMicro, db.rows("creditLedger")[0].freeMicro], [-500 * MICRO, 500 * MICRO]);
  await m["tamInvestigations.ts"].stop.handler(ctx, { investigationId: id });
  assert.deepEqual([(await db.get(id))!.status, (await db.get("org"))!.freeCreditsUsedMicro, (await db.get("org"))!.creditBalanceMicro], ["done", 0, 1000 * MICRO]);
});
