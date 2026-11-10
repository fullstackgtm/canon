import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const actor = { _id: "ada", orgId: "org", role: "admin", isActive: true, name: "Ada" };
const { "users.ts": users } = loadConvex(["users.ts"], { "lib.ts": (r) => ({ ...r, requireUser: async () => actor }) });

const clerkEvent = (clerkUserId: string, role: "admin" | "rep") => ({ clerkUserId, clerkOrgId: "clerk_org", email: `${clerkUserId}@acme.test`, name: clerkUserId, role });

test("a Clerk membership event keeps a role set in Canon, and Clerk still decides who is an admin", async () => {
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org", name: "Acme" }],
    users: [actor, { _id: "mia", clerkUserId: "mia", orgId: "org", role: "manager", isActive: true }],
    orgMemberships: [{ _id: "m1", userId: "mia", orgId: "org", role: "manager", isActive: true }],
  });
  const roles = () => [db.rows("users").find((u) => u._id === "mia")!.role, db.rows("orgMemberships")[0].role];

  await users.upsertFromClerk.handler({ db }, clerkEvent("mia", "rep"));
  assert.deepEqual(roles(), ["manager", "manager"]);
  await users.upsertFromClerk.handler({ db }, clerkEvent("mia", "admin"));
  assert.deepEqual(roles(), ["admin", "admin"]);
  await users.upsertFromClerk.handler({ db }, clerkEvent("mia", "rep"));
  assert.deepEqual(roles(), ["rep", "rep"], "losing admin in Clerk makes them a rep");
});

test("the last active admin can't be demoted or deactivated, and a role change reaches the membership", async () => {
  const db = memoryDb({
    users: [actor, { _id: "sam", orgId: "org", role: "rep", isActive: true }],
    orgMemberships: [{ _id: "m1", userId: "sam", orgId: "org", role: "rep", isActive: true }],
  });
  await assert.rejects(users.update.handler({ db }, { userId: "ada", role: "manager" }), /another active admin/);
  await assert.rejects(users.update.handler({ db }, { userId: "ada", isActive: false }), /another active admin/);
  await users.update.handler({ db }, { userId: "sam", role: "admin" });
  assert.equal(db.rows("orgMemberships")[0].role, "admin");
  await users.update.handler({ db }, { userId: "ada", role: "manager" });
  assert.equal(db.rows("users").find((u) => u._id === "ada")!.role, "manager");
});

test("a member added with no login owns a record their invite later takes over, and Clerk still decides admin", async () => {
  const db = memoryDb({ organizations: [{ _id: "org", clerkOrgId: "clerk_org", name: "Acme" }], users: [actor] });
  const id = await users.createMember.handler({ db }, { name: "Lee Park", email: "Lee@Acme.test", role: "admin", title: "AE" });
  await assert.rejects(users.createMember.handler({ db }, { name: "Again", email: "lee@acme.test" }), /already has the email/);
  await users.upsertFromClerk.handler({ db }, { ...clerkEvent("user_lee", "rep"), email: "lee@acme.test" });
  const lee = db.rows("users").filter((u) => u.email === "lee@acme.test");
  assert.deepEqual(lee.map((u) => [u._id, u.clerkUserId, u.role, u.title]), [[id, "user_lee", "rep", "AE"]], "the same record, signed in, a rep until Clerk says admin");
});

test("an invited CRM owner signs in as their synced record, keeping its owner id", async () => {
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org", name: "Acme" }],
    users: [actor, { _id: "kim", clerkUserId: "hubspot:org:42", orgId: "org", email: "kim@acme.test", name: "Kim", role: "rep", crmOwnerId: "42", isActive: true }],
  });
  await users.recordInvite.handler({ db }, { userId: "kim" });
  await users.upsertFromClerk.handler({ db }, { ...clerkEvent("user_kim", "rep"), email: "kim@acme.test" });
  const kim = db.rows("users").filter((u) => u.email === "kim@acme.test");
  assert.deepEqual(kim.map((u) => [u._id, u.clerkUserId, u.crmOwnerId, typeof u.invitedAt]), [["kim", "user_kim", "42", "number"]]);
});

test("a manager can't be someone in the member's own reporting line, by hand or by an imported file", async () => {
  const db = memoryDb({
    users: [{ ...actor, email: "ada@acme.test" }, { _id: "mo", orgId: "org", name: "Mo", email: "mo@acme.test", role: "manager", isActive: true, managerId: "ada" },
      { _id: "sam", orgId: "org", name: "Sam", email: "sam@acme.test", role: "manager", isActive: true }],
  });
  await assert.rejects(users.update.handler({ db }, { userId: "ada", managerId: "mo" }), /Mo reports to Ada/);
  const rows = [{ email: "sam@acme.test", managerEmail: "mo@acme.test" }, { email: "mo@acme.test", managerEmail: "sam@acme.test" }, { email: "x@acme.test", managerEmail: "" }];
  const preview = await users.importReportingLines.handler({ db }, { rows, apply: false });
  assert.deepEqual(JSON.parse(JSON.stringify(preview.map((r: { status: string }) => r.status))), ["set", "refused", "refused"], "the second row would close a loop the first opened");
  assert.equal(db.rows("users").find((u) => u._id === "sam")!.managerId, undefined, "a preview writes nothing");
  await users.importReportingLines.handler({ db }, { rows, apply: true });
  assert.deepEqual(db.rows("users").map((u) => [u._id, u.managerId ?? null]), [["ada", null], ["mo", "ada"], ["sam", "mo"]]);
});
