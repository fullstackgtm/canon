import assert from "node:assert/strict";
import test from "node:test";
import { convexAuthError } from "../src/lib/convexAuthError.ts";
import { ConvexError } from "convex/values";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const env = { CANON_AUTH: "convex", CANON_SETUP_CODE: "setup-code-123456", CANON_SERVICE_JWT_ISSUER: "https://canon.test/service", FSGTM_ENABLE_DEMO_DATA: "true" };
let loginTime: number | undefined;
const modules = loadConvex(["convexAuthUsers.ts", "lib.ts", "cliAuth.ts", "agentIdentityData.ts"], {}, { process: { env }, Date: { now: () => loginTime ?? Date.now() } });
const create = modules["convexAuthUsers.ts"].createOrUpdateUser as unknown as (ctx: unknown, args: unknown) => Promise<string>;
const current = modules["lib.ts"].getCurrentUser as unknown as (ctx: unknown) => Promise<any>;
const args = (email: string, extra = {}) => ({ existingUserId: null, type: "oauth", provider: { id: "google", type: "oauth" }, profile: { email, emailVerified: true }, ...extra });

test("verified email links an invite or migrated member without duplicating the workspace", async () => {
  for (const clerkUserId of ["member:ada", "user_clerk_ada"]) {
    const db = memoryDb({ organizations: [{ _id: "org" }], users: [{ _id: "ada", email: "ada@example.com", clerkUserId, invitedAt: 1, orgId: "org", role: "rep", isActive: true }] });
    assert.equal(await create({ db }, args("ada@example.com")), "ada");
    assert.equal(await create({ db }, args("ada@example.com", { existingUserId: "ada" })), "ada");
    assert.equal(db.rows("users").length, 1);
    assert.equal(db.rows("organizations").length, 1);
    assert.equal(db.rows("users")[0].role, "rep");
    assert.equal(db.rows("users")[0].clerkUserId, clerkUserId === "member:ada" ? "convex_ada" : clerkUserId);
  }
});

test("password creates one workspace with defaults; unverified email cannot claim another member", async () => {
  const db = memoryDb({});
  const input = args("New@Example.com", { type: "credentials", profile: { email: "New@Example.com", setupCode: env.CANON_SETUP_CODE } });
  const ctx = { db, scheduler: { runAfter: async () => "scheduled" } };
  const id = await create(ctx, input);
  assert.equal(await create(ctx, { ...input, existingUserId: id }), id);
  const user = await db.get(id);
  assert.equal(user?.email, "new@example.com");
  assert.equal(user?.clerkUserId, `convex_${id}`);
  assert.equal(user?.role, "admin");
  assert.equal(db.rows("organizations").length, 1);
  assert.equal(db.rows("orgMemberships").length, 1);
  assert.ok(db.rows("recipeEnablements").length > 0);
  // The sign-in form explains this refusal by matching its reason, so the two must stay in step.
  await assert.rejects(create(ctx, input), (error) => {
    assert.match(String((error as { data?: unknown }).data), /Verify this email/);
    assert.match(convexAuthError(error, "signUp", true, false), /Use Google with the same email address/);
    return true;
  });
  await db.insert("authAccounts", { userId: id, provider: "password", providerAccountId: user?.email });
  await assert.rejects(create(ctx, args("new@example.com")), /Sign in with your password or reset/);
});

test("Convex sessions scope to stored active org, reject inactive members, and paired CLI JWTs keep their org", async () => {
  const db = memoryDb({
    organizations: [{ _id: "home", clerkOrgId: "convex_home" }, { _id: "other", clerkOrgId: "convex_other" }],
    users: [{ _id: "ada", clerkUserId: "convex_ada", orgId: "home", activeOrgId: "other", email: "ada@example.com", role: "admin", isActive: true }],
    orgMemberships: [{ _id: "membership", userId: "ada", orgId: "other", role: "rep", isActive: true }],
  });
  let identity: any = { subject: "ada|session", issuer: "http://convex.test", org_id: "untrusted" };
  const ctx = { db, auth: { getUserIdentity: async () => identity } };
  assert.equal((await current(ctx))?.orgId, "other");
  assert.equal((await current(ctx))?.role, "rep");
  await db.patch("membership", { isActive: false });
  assert.equal(await current(ctx), null);
  await db.patch("membership", { isActive: true });
  await db.patch("ada", { isActive: false });
  assert.equal(await current(ctx), null);
  await db.patch("ada", { isActive: true });
  identity = { subject: "convex_ada", issuer: env.CANON_SERVICE_JWT_ISSUER, org_id: "convex_home" };
  assert.equal((await current(ctx))?.orgId, "home");
  identity = null;
  assert.equal(await current(ctx), null, "convex mode never admits the demo bypass");
});

test("new sessions update last login without changing creation time", async () => {
  loginTime = 200;
  const beforeSession = modules["convexAuthUsers.ts"].beforeSessionCreation as unknown as (ctx: unknown, args: unknown) => Promise<void>;
  const db = memoryDb({ users: [{ _id: "ada", createdAt: 100, lastLoginAt: 100 }] });
  await beforeSession({ db }, { userId: "ada" });
  assert.equal((await db.get("ada"))?.lastLoginAt, 200);
  loginTime = 300;
  await beforeSession({ db }, { userId: "ada" });
  assert.equal((await db.get("ada"))?.lastLoginAt, 300);
  assert.equal((await db.get("ada"))?.createdAt, 100);
  loginTime = undefined;
});

test("member sign-up guidance offers only configured verification methods; password errors stay generic", () => {
  const error = new ConvexError("Verify this email before linking an existing member. Use email sign-in or Google.");
  for (const google of [false, true]) for (const email of [false, true]) {
    const message = convexAuthError(error, "signUp", google, email);
    assert.equal(message.includes("Google"), google);
    assert.equal(message.includes("emailed code"), email);
    assert.equal(message.includes("Ask your workspace admin"), !google && !email);
    assert.equal(convexAuthError(error, "signIn", google, email), convexAuthError(new Error("Invalid credentials"), "signIn", google, email));
  }
  const passwordError = new ConvexError("Sign in with your password or reset it before linking another sign-in method.");
  assert.equal(convexAuthError(passwordError, "signUp", false, true).includes("reset it"), true);
  assert.equal(convexAuthError(passwordError, "signUp", false, false).includes("reset it"), false);
  assert.match(convexAuthError(new ConvexError("Multiple members use this email. Ask an administrator to resolve them."), "signUp", false, false), /workspace admin/);
  assert.equal(convexAuthError(new Error("Invalid credentials"), "signUp", true, true).includes("workspace member"), false);
});
