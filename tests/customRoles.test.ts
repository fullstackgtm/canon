import assert from "node:assert/strict";
import { test } from "node:test";
import { can } from "../convex/lib/capabilities.ts";
import { defineRole, GRANTABLE } from "../convex/lib/roles.ts";
import { ownerRuleOf } from "../convex/lib/agents/standing.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("a workspace role holds only the grantable capabilities it was given, never an admin's, and fails closed unloaded", () => {
  const sdr = defineRole({ name: "  SDR  lead ", base: "rep", capabilities: ["imports.run", "strategy.edit"] }, []);
  assert.deepEqual(sdr, { key: "role_sdr_lead", name: "SDR lead", base: "rep", capabilities: ["imports.run", "strategy.edit"] });
  const member = { role: sdr.key, capabilities: sdr.capabilities };
  assert.deepEqual([can(member, "imports.run"), can(member, "targets.set"), can({ role: sdr.key }, "imports.run")], [true, false, false]);
  assert.equal(can({ role: sdr.key, capabilities: ["billing.manage"] }, "billing.manage"), false, "a stored adminOnly capability is never honoured");
  assert.ok(!GRANTABLE.includes("billing.manage" as never));
  assert.throws(() => defineRole({ name: "Ops", base: "rep", capabilities: ["permissions.manage"] }, []), /can't hold permissions.manage/);
  assert.throws(() => defineRole({ name: "Managers", base: "rep", capabilities: [] }, []), /already a role named Managers/);
  assert.throws(() => defineRole({ name: "sdr lead", base: "rep", capabilities: [] }, [sdr]), /already a role named sdr lead/);
  assert.equal(defineRole({ name: "SDR lead", base: "manager", capabilities: [] }, [sdr], sdr.key).key, sdr.key, "an edit keeps its key and name");
  assert.equal(defineRole({ name: "SDR-lead", base: "rep", capabilities: [] }, [sdr]).key, "role_sdr_lead_2");
});

test("a workspace role counts as its base for agent ownership", () => {
  const facts = (base: string) => ({ orgId: "o" as never, user: { orgId: "o" as never, role: "role_lead", isActive: true, clerkUserId: "u" }, membership: null, bases: { role_lead: base } });
  assert.deepEqual(ownerRuleOf(facts("manager")), { ok: true, role: "manager" });
  assert.equal(ownerRuleOf(facts("other")).ok, false);
});

test("no capability check rebuilds a member from their role alone, which would drop a workspace role's capabilities", () => {
  const offenders = readdirSync("convex", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_generated"))
    .filter((f) => /can\(\{\s*role\b/.test(readFileSync(join("convex", f), "utf8")));
  assert.deepEqual(offenders, []);
});

test("a role can't be deleted while a deactivated member still holds it", async () => {
  const admin = { _id: "ada", orgId: "org", role: "admin", isActive: true, name: "Ada" };
  const { "permissions.ts": permissions } = loadConvex(["permissions.ts"], { "lib.ts": (r) => ({ ...r, requireUser: async () => admin }) });
  const db = memoryDb({
    orgRoles: [{ _id: "r1", orgId: "org", key: "role_sdr", name: "SDR", base: "rep", capabilities: [] }],
    users: [admin, { _id: "sam", orgId: "org", role: "role_sdr", isActive: false, name: "Sam" }],
    orgMemberships: [],
  });
  await assert.rejects(permissions.removeWorkspaceRole.handler({ db }, { key: "role_sdr" }), /Give Sam another role first/);
});
