// Signal watches (docs/signal-automations.md, S1): a starter makes a weekly yes-or-no account AI field whose field is
// registered at once, and a paused rule on it that tasks the owner when the answer turns yes.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

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
  assert.equal(listed.templates.find((t: { key: string }) => t.key === "new_sales_leader").watching.slug, field.slug);

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
