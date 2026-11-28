// Signal watches (docs/signal-automations.md, S1): a starter makes a weekly yes-or-no account AI field whose field is
// registered at once, and a paused rule on it that tasks the owner when the answer turns yes.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { hiringSalesFinding, isSalesRole } from "../convex/lib/signals/hiring.ts";

const admin = { _id: "users:ada", orgId: "organizations:org", role: "admin", isActive: true, name: "Ada", email: "ada@acme.test" };
const rep = { ...admin, _id: "users:rex", role: "rep", name: "Rex", email: "rex@acme.test" };
let signedIn: Record<string, unknown> = admin;
const { "signalWatches.ts": watches, "researchAgents.ts": research } = loadConvex(["signalWatches.ts", "researchAgents.ts", "automations.ts", "canon.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => signedIn, requireCap: async () => signedIn }),
});

test("watching a starter makes a registered weekly field and a paused owner-task rule; a second watch and a rep are refused", async () => {
  const db = memoryDb({ organizations: [{ _id: "organizations:org" }], users: [admin, rep] });
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } };

  const made = await watches.watch.handler(ctx, { key: "new_sales_leader" });
  const field = db.rows("researchAgents")[0];
  assert.deepEqual([field.label, field.kind, field.answerType, field.judgment, field.refreshCadence], ["Signal: New sales leader", "qa", "boolean", true, "weekly"]);
  assert.equal(made.attribute, `custom.${field.slug}`);

  const def = db.rows("objectDefs").find((d) => d.apiName === "account");
  assert.ok((def?.customFields as Array<{ apiName: string }>).some((f) => f.apiName === made.attribute), "the field exists before any answer");

  const rule = db.rows("automationRules")[0];
  assert.equal(rule.status, "paused");
  assert.deepEqual(JSON.parse(JSON.stringify(rule.trigger)), { kind: "updated", field: made.attribute, to: [true] });
  assert.equal((rule.actions as Array<{ kind: string }>)[0].kind, "create_task");

  const listed = await watches.catalog.handler(ctx, {});
  const leader = listed.templates.find((t: { key: string }) => t.key === "new_sales_leader");
  assert.equal(leader.watching.slug, field.slug);
  assert.equal(leader.watching.ruleId, rule._id, "the Signals section links each watch to its rule");
  assert.equal(listed.templates.filter((t: { suggested: boolean }) => t.suggested).map((t: { key: string }) => t.key).join(), "hiring_sales,new_sales_leader,raised_funding");

  await assert.rejects(watches.watch.handler(ctx, { key: "new_sales_leader" }), /already watches/);
  await watches.watch.handler(ctx, { label: "Opened a Denver office", question: "Has this company opened an office in Denver in the last 90 days?" });
  assert.equal(db.rows("researchAgents").length, 2);

  // A scoped watch keeps its accounts and starts on the next due check; setScope changes or clears it.
  const scoped = await watches.watch.handler(ctx, { key: "raised_funding", filter: { icpId: "icp1" } });
  const watched = () => db.rows("researchAgents").find((f) => f.slug === scoped.slug)!;
  assert.deepEqual(JSON.parse(JSON.stringify(watched().watchFilter)), { icpId: "icp1" });
  assert.ok((watched().refreshNextAt as number) <= Date.now());
  await watches.setScope.handler(ctx, { slug: scoped.slug, filter: null });
  assert.equal(watched().watchFilter, undefined);

  // "Hiring sales reps" answers from job boards: no judgment, and the daily job-board check is turned on.
  const hiring = await watches.watch.handler(ctx, { key: "hiring_sales" });
  const jobsField = db.rows("researchAgents").find((f) => f.slug === hiring.slug)!;
  assert.equal(jobsField.answerSource, "job_boards");
  assert.ok(!jobsField.judgment, "a count of postings is not a judgment");
  assert.ok((db.rows("signalWatch")[0].nextRunAt as number) <= Date.now());

  signedIn = rep;
  await assert.rejects(watches.watch.handler(ctx, { key: "raised_funding" }));
  signedIn = admin;
});

test("a scoped refresh re-asks an answer older than its staleBefore and skips a fresher one", async () => {
  const db = memoryDb({ organizations: [{ _id: "organizations:org" }], users: [admin] });
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } };
  const agentId = await db.insert("researchAgents", { orgId: "organizations:org", slug: "signal_x", label: "Signal: X", entityType: "account", kind: "qa", question: "q", createdBy: admin._id, createdAt: 0, updatedAt: 0 });
  const entityId = await db.insert("canonEntities", { orgId: "organizations:org" });
  const observedAt = Date.now() - 10 * 86_400_000;
  await db.insert("facts", { orgId: "organizations:org", entityId, attribute: "custom.signal_x", status: "accepted", observedAt });
  const skipped = async (staleBefore?: number) => (await research.skippedEntities.handler(ctx, { agentId, entityIds: [entityId], attribute: "custom.signal_x", ...(staleBefore ? { staleBefore } : {}) })).length;
  assert.deepEqual(await skipped(), 1, "a manual run skips any answer");
  assert.deepEqual(await skipped(observedAt - 1), 1, "an answer since staleBefore is fresh");
  assert.deepEqual(await skipped(observedAt + 1), 0, "an older answer is asked again");
});

test("a capped scoped refresh keeps its place for the next one; reaching the end of the scope starts over", async () => {
  const db = memoryDb({ organizations: [{ _id: "organizations:org" }], users: [admin] });
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } };
  const agentId = await db.insert("researchAgents", { orgId: "organizations:org", slug: "signal_y", label: "Signal: Y", entityType: "account", kind: "qa", question: "q", watchFilter: { icpId: "icp1" }, createdBy: admin._id, createdAt: 0, updatedAt: 0 });
  const run = (cursor: string) => db.insert("researchRuns", { orgId: "organizations:org", agentId, trigger: "refresh", scope: { entity: "account", filter: { icpId: "icp1" } }, cursor, status: "running", inScope: 0, planned: 100, done: 0, skipped: 0, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 0, llmCalls: 0, createdBy: admin._id, createdAt: 0, updatedAt: 0 });
  await research.progressRun.handler(ctx, { runId: await run("page3"), set: { status: "done" } });
  assert.equal(db.rows("researchAgents")[0].watchCursor, "page3");
  await research.progressRun.handler(ctx, { runId: await run("page7"), set: { status: "done" }, listEnded: true });
  assert.equal(db.rows("researchAgents")[0].watchCursor, undefined);
});

test("hiring sales reps from job boards: three recent selling roles say yes with cites, fewer say no, no board stays unknown", () => {
  const now = Date.parse("2026-11-28T00:00:00Z");
  const role = (title: string, daysAgo: number) => ({ trigger: `hiring: ${title}`, quote: title, sourceUrl: `https://boards.greenhouse.io/acme/jobs/${title.length}${daysAgo}`, observedAt: now - daysAgo * 86_400_000 });
  const board = { source: "greenhouse", token: "acme", checkedAt: now };
  assert.ok(isSalesRole("Senior Account Executive") && isSalesRole("SDR, EMEA") && !isSalesRole("Sales Operations Manager") && !isSalesRole("Salesforce Developer"));

  const yes = hiringSalesFinding(board, [role("Account Executive", 3), role("BDR", 10), role("Head of Sales", 20), role("Backend Engineer", 1)], now);
  assert.equal(yes.status === "answered" && yes.value, true);
  assert.equal(yes.status === "answered" && yes.cites?.length, 3);

  const no = hiringSalesFinding(board, [role("Account Executive", 3), role("BDR", 45)], now);
  assert.equal(no.status === "answered" && no.value, false);
  assert.equal(no.status === "answered" && no.sourceUrl, "https://boards.greenhouse.io/acme/jobs/173");

  // Three openings under one title are one stored row with openings: 3, and count as three.
  const three = hiringSalesFinding(board, [{ ...role("Account Executive", 2), openings: 3 }], now);
  assert.equal(three.status === "answered" && three.value, true);

  assert.equal(hiringSalesFinding(null, [], now).status, "unknown");
});
