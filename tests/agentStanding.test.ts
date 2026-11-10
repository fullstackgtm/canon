import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { ownerRuleOf, standingMessage, standingOf, type OwnerFacts } from "../convex/lib/agents/standing.ts";

const HOME = "org_home" as Id<"organizations">;
const OTHER = "org_other" as Id<"organizations">;
const person = { orgId: HOME, role: "manager" as const, isActive: true, clerkUserId: "user_2abc" };
const facts = (over: Partial<OwnerFacts> = {}): OwnerFacts => ({ orgId: HOME, user: person, membership: { role: "manager", isActive: true }, ...over });

test("ownerRuleOf: home org with an active membership row uses the user's role", () => {
  assert.deepEqual(ownerRuleOf(facts()), { ok: true, role: "manager" });
});

test("ownerRuleOf: a home-org user with no membership row still counts (dev seed, pre-backfill rows)", () => {
  assert.deepEqual(ownerRuleOf(facts({ membership: null })), { ok: true, role: "manager" });
});

test("ownerRuleOf: another org takes the membership's role and requires the row", () => {
  assert.deepEqual(ownerRuleOf(facts({ orgId: OTHER, membership: { role: "admin", isActive: true } })), { ok: true, role: "admin" });
  assert.deepEqual(ownerRuleOf(facts({ orgId: OTHER, membership: null })), { ok: false, reason: "owner_not_member" });
  assert.deepEqual(ownerRuleOf(facts({ orgId: OTHER, membership: { role: "manager", isActive: false } })), { ok: false, reason: "owner_not_member" });
});

test("ownerRuleOf: a removed home-org membership means the owner left", () => {
  assert.deepEqual(ownerRuleOf(facts({ membership: { role: "manager", isActive: false } })), { ok: false, reason: "owner_not_member" });
});

test("ownerRuleOf: missing and deactivated users", () => {
  assert.deepEqual(ownerRuleOf(facts({ user: null })), { ok: false, reason: "owner_missing" });
  assert.deepEqual(ownerRuleOf(facts({ user: { ...person, isActive: false } })), { ok: false, reason: "owner_inactive" });
});

test("ownerRuleOf: the floor admits rep (Clerk demotes every non-admin to rep) and refuses other", () => {
  assert.deepEqual(ownerRuleOf(facts({ user: { ...person, role: "rep" } })), { ok: true, role: "rep" });
  assert.deepEqual(ownerRuleOf(facts({ user: { ...person, role: "other" } })), { ok: false, reason: "owner_role" });
  assert.deepEqual(ownerRuleOf(facts({ orgId: OTHER, membership: { role: "other", isActive: true } })), { ok: false, reason: "owner_role" });
});

test("ownerRuleOf: a CRM placeholder with an active backfilled membership row can't own", () => {
  const placeholder = { ...person, role: "rep" as const, clerkUserId: "hubspot:org_home:12345" };
  assert.deepEqual(ownerRuleOf(facts({ user: placeholder, membership: { role: "rep", isActive: true } })), { ok: false, reason: "owner_placeholder" });
  assert.deepEqual(ownerRuleOf(facts({ user: { ...placeholder, clerkUserId: "salesforce:org_home:005xx" } })), { ok: false, reason: "owner_placeholder" });
});

test("standingOf: active, derived owner problem, and its message", () => {
  assert.deepEqual(standingOf({}, facts()), { status: "active" });
  const left = standingOf({}, facts({ membership: { role: "manager", isActive: false } }));
  assert.deepEqual(left, { status: "paused", reason: "owner_not_member" });
  assert.equal(standingMessage(left), "Paused: owner left the workspace");
  assert.equal(standingMessage({ status: "active" }), null);
});

test("standingOf: a stored pause latches, even after the owner is eligible again", () => {
  const latched = { pause: { reason: "owner_inactive" as const, at: 1 } };
  assert.deepEqual(standingOf(latched, facts()), { status: "paused", reason: "owner_inactive" });
});

test("standingOf: a stored pause beats a derived owner problem", () => {
  const byHand = { pause: { reason: "paused_by_user" as const, at: 1 } };
  assert.deepEqual(standingOf(byHand, facts({ user: null })), { status: "paused", reason: "paused_by_user" });
});

test("standingOf: archived beats everything", () => {
  const s = standingOf({ archivedAt: 5, pause: { reason: "paused_by_user", at: 1 } }, facts({ user: null }));
  assert.deepEqual(s, { status: "archived" });
  assert.equal(standingMessage(s), "Archived: its field was deleted");
});
