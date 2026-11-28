// Signal watches (docs/signal-automations.md, S1): a starter makes a weekly yes-or-no account AI field whose field is
// registered at once, and a paused rule on it that tasks the owner when the answer turns yes.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const admin = { _id: "users:ada", orgId: "organizations:org", role: "admin", isActive: true, name: "Ada", email: "ada@acme.test" };
const rep = { ...admin, _id: "users:rex", role: "rep", name: "Rex", email: "rex@acme.test" };
let signedIn: Record<string, unknown> = admin;
const { "signalWatches.ts": watches } = loadConvex(["signalWatches.ts", "researchAgents.ts", "automations.ts", "canon.ts"], {
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

  signedIn = rep;
  await assert.rejects(watches.watch.handler(ctx, { key: "raised_funding" }));
  signedIn = admin;
});
