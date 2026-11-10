// Editing an AI field (#509): wording changes, the ledger identity doesn't; options are added, never removed.
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const manager = { _id: "mgr", orgId: "org", role: "manager", name: "Mo" };
const { "researchAgents.ts": research } = loadConvex(["researchAgents.ts"], {
  "lib.ts": (real) => ({ ...real, requireCap: async () => manager }),
});

test("an edit rewords a field in place, starts it over only on askAgain, and can't drop an option or land mid-run", async () => {
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [manager] });
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } };
  const options = [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];
  const { slug } = await research.create.handler(ctx, { label: "Buyer", kind: "classify", question: "Is this person the buyer?", options, entityType: "contact" });
  const field = () => db.rows("researchAgents")[0];

  await research.update.handler(ctx, { slug, label: "Approver", question: "Does this person approve the purchase?", options: [{ key: "yes", label: "Approves" }, ...options.slice(1), { key: "maybe", label: "Maybe" }] });
  assert.deepEqual([field().slug, field().label, field().question, (field().options as { key: string }[]).map((o) => o.key), field().questionSince],
    [slug, "Approver", "Does this person approve the purchase?", ["yes", "no", "maybe"], undefined]);
  assert.equal(db.rows("agents")[0].label, "Approver");

  await research.update.handler(ctx, { slug, label: "Approver", question: field().question, askAgain: true });
  assert.equal(typeof field().questionSince, "number");
  assert.equal((field().options as unknown[]).length, 3, "options left out stay as they are");

  await assert.rejects(research.update.handler(ctx, { slug, label: "Approver", question: field().question, options }), /can't be removed/);
  await db.insert("researchRuns", { agentId: field()._id, status: "running", createdAt: Date.now(), updatedAt: Date.now() });
  await assert.rejects(research.update.handler(ctx, { slug, label: "Other", question: field().question }), /Stop the run/);
});
