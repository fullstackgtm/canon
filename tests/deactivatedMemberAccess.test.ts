/**
 * A member turned off in a workspace can't act in it by any credential: a session (Clerk or self-hosted), a paired CLI
 * token on every path that takes one, an export key or a logging address. Turning them off revokes what Canon issued
 * them there, so turning them back on doesn't bring those back: they sign in and pair again. A member of two
 * workspaces turned off in one keeps the other.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FILES = [
  // First, so the import cycle canonGateActions reaches it through loads in an order Convex's bundler would.
  "researchAgents.ts",
  "users.ts", "cliAuth.ts", "cliAuthActions.ts", "cliIntegrationActions.ts", "canonGateActions.ts", "cliRunsActions.ts",
  "cliPatchPlanActions.ts", "cliArtifactActions.ts", "acquisitionCheckpointActions.ts", "agentIdentity.ts",
  "agentIdentityData.ts", "permissions.ts", "hubspot.ts", "localAuth.ts", "emailLog.ts", "lib.ts",
] as const;
/** Calls a fake reaches only after the token authenticated. */
class Reached extends Error {}
const M = loadConvex(FILES, {}, { fetch: async () => { throw new Reached("fetch"); } });

const T = { boAcme: "fsgtm_bo_acme", boBeta: "fsgtm_bo_beta", ada: "fsgtm_ada_acme" };

function workspace() {
  return memoryDb({
    organizations: [{ _id: "acme", name: "Acme", clerkOrgId: "org_acme" }, { _id: "beta", name: "Beta", clerkOrgId: "org_beta" }],
    users: [
      { _id: "ada", orgId: "acme", clerkUserId: "user_ada", email: "ada@acme.test", name: "Ada", role: "admin", isActive: true },
      // Bo's home is Acme; Bo is also an admin of Beta.
      { _id: "bo", orgId: "acme", clerkUserId: "user_bo", email: "bo@acme.test", name: "Bo", role: "manager", isActive: true },
      { _id: "cy", orgId: "acme", clerkUserId: "user_cy", email: "cy@acme.test", name: "Cy", role: "rep", isActive: true },
    ],
    orgMemberships: [
      { _id: "m-ada", userId: "ada", orgId: "acme", role: "admin", isActive: true },
      { _id: "m-bo", userId: "bo", orgId: "acme", role: "manager", isActive: true },
      { _id: "m-bo-beta", userId: "bo", orgId: "beta", role: "admin", isActive: true },
      { _id: "m-cy", userId: "cy", orgId: "acme", role: "rep", isActive: true },
    ],
    cliTokens: [
      { _id: "tok-bo-acme", orgId: "acme", userId: "bo", tokenHash: sha(T.boAcme), createdAt: 0, expiresAt: Date.now() + 86_400_000 },
      { _id: "tok-bo-beta", orgId: "beta", userId: "bo", tokenHash: sha(T.boBeta), createdAt: 0, expiresAt: Date.now() + 86_400_000 },
      { _id: "tok-ada", orgId: "acme", userId: "ada", tokenHash: sha(T.ada), createdAt: 0, expiresAt: Date.now() + 86_400_000 },
    ],
    emailLogAddresses: [{ _id: "log-bo", orgId: "acme", userId: "bo", token: "bologtoken", createdAt: 0 }],
  });
}

type Db = ReturnType<typeof workspace>;
/** A Convex ctx signed in as `who` (a Clerk user id and optional active org), or signed out. */
function ctxOf(db: Db, who?: { subject: string; org?: string; issuer?: string }) {
  const identity = who ? { subject: who.subject, tokenIdentifier: `${who.issuer ?? "clerk"}|${who.subject}`, issuer: who.issuer ?? "clerk", ...(who.org ? { org_id: who.org } : {}) } : null;
  const ctx: any = { db, auth: { getUserIdentity: async () => identity } };
  const real = new Set(["cliAuth", "agentIdentityData", "permissions"]);
  const dispatch = (kind: string) => async (ref: unknown, args: unknown) => {
    const [, file, name] = String(ref).split(".");
    if (real.has(file!)) return M[`${file}.ts` as (typeof FILES)[number]]![name!]!.handler(ctx, args);
    // The provider token mint: a fake, never a real provider.
    if (kind === "action" && /getOrgAccessToken$/.test(String(ref))) return { accessToken: `fake-${file}-token`, instanceUrl: "https://fake.test", fieldMappings: null };
    throw new Reached(String(ref));
  };
  ctx.runQuery = dispatch("query");
  ctx.runMutation = dispatch("mutation");
  ctx.runAction = dispatch("action");
  return ctx;
}
const call = (db: Db, who: Parameters<typeof ctxOf>[1], ref: string, args: Record<string, unknown> = {}) => {
  const [file, name] = ref.split(".");
  return M[`${file}.ts` as (typeof FILES)[number]]![name!]!.handler(ctxOf(db, who), args);
};
const ADA = { subject: "user_ada" };
const setActive = (db: Db, userId: string, isActive: boolean) => call(db, ADA, "users.update", { userId, isActive });

/** Every action that takes a paired CLI token, with arguments that get it past validation. */
const CLI_PATHS: Array<[string, (token: string) => Record<string, unknown>]> = [
  ["cliAuthActions.mintProviderToken", (t) => ({ cliToken: t, provider: "hubspot" })],
  ["cliIntegrationActions.connectFromCli", (t) => ({ cliToken: t, provider: "hubspot", token: "pat-fake" })],
  ["canonGateActions.status", (t) => ({ cliToken: t, patchPlanId: "plan" })],
  ["cliRunsActions.recordRun", (t) => ({ cliToken: t, command: "audit", startedAt: 0, finishedAt: 1, durationMs: 1 })],
  ["cliPatchPlanActions.get", (t) => ({ cliToken: t, externalPlanId: "plan" })],
  ["cliArtifactActions.get", (t) => ({ cliToken: t, kind: "icp", key: "k" })],
  ["acquisitionCheckpointActions.get", (t) => ({ cliToken: t, key: "k" })],
];
/** "authenticated" when the token got the caller past its check (to the workspace's data or the provider), else the refusal. */
async function outcome(db: Db, ref: string, args: Record<string, unknown>): Promise<string> {
  try {
    const out = await call(db, undefined, ref, args);
    if (ref === "agentIdentity.resolveCliToken") return out ? "authenticated" : "refused";
    return "authenticated";
  } catch (e) {
    return e instanceof Reached ? "authenticated" : "refused";
  }
}

test("a member turned off on the Team page can't use their paired token on any path", async () => {
  const db = workspace();
  // Before: every path accepts Bo's token, and the provider mint hands over the workspace's CRM token.
  assert.equal((await call(db, undefined, "cliAuthActions.mintProviderToken", { cliToken: T.boAcme, provider: "hubspot" })).accessToken, "fake-hubspotActions-token");
  await setActive(db, "bo", false);
  for (const [ref, args] of [...CLI_PATHS, ["agentIdentity.resolveCliToken", (t: string) => ({ cliToken: t })] as const]) {
    assert.equal(await outcome(db, ref, args(T.boAcme)), "refused", ref);
    // Ada, still active, keeps working on the same path.
    assert.equal(await outcome(db, ref, args(T.ada)), "authenticated", `${ref} (active member)`);
  }
  // Bo's token paired in Beta, where Bo is still an admin, keeps working.
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boBeta, provider: "salesforce" }), "authenticated");
  assert.equal(await outcome(db, "agentIdentity.resolveCliToken", { cliToken: T.boBeta }), "authenticated");
});

test("turning a member off revokes what Canon issued them there, and turning them back on doesn't restore it", async () => {
  const db = workspace();
  await setActive(db, "bo", false);
  assert.ok((await db.get("tok-bo-acme"))!.revokedAt, "the Acme token is revoked, so Settings lists it as revoked");
  assert.equal((await db.get("tok-bo-beta"))!.revokedAt, undefined, "the Beta token is untouched");
  assert.ok((await db.get("log-bo"))!.revokedAt, "the Acme logging address is revoked");
  assert.equal((await db.get("m-bo"))!.isActive, false, "the home membership row agrees with the member row");
  await setActive(db, "bo", true);
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boAcme, provider: "hubspot" }), "refused");
  // A token Bo pairs after coming back works.
  await db.insert("cliTokens", { orgId: "acme", userId: "bo", tokenHash: sha("fsgtm_bo_new"), createdAt: 1, expiresAt: Date.now() + 86_400_000 });
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: "fsgtm_bo_new", provider: "hubspot" }), "authenticated");
});

test("a hosted session of a member turned off in a workspace can't act in it, and keeps their other workspace", async () => {
  const db = workspace();
  const me = (who: Parameters<typeof ctxOf>[1]) => call(db, who, "users.me");
  const viaAction = (who: { subject: string; org?: string }) => call(db, ADA, "hubspot.getUserByClerkId", { clerkUserId: who.subject, activeClerkOrgId: who.org });
  assert.equal((await me({ subject: "user_bo" }))?._id, "bo");
  await setActive(db, "bo", false);
  assert.equal(await me({ subject: "user_bo" }), null, "home workspace, no active-org claim");
  assert.equal(await me({ subject: "user_bo", org: "org_acme" }), null, "home workspace, claimed");
  assert.equal(await viaAction({ subject: "user_bo" }), null, "actions resolve the session the same way");
  const beta = await me({ subject: "user_bo", org: "org_beta" });
  assert.equal(beta?.orgId, "beta");
  assert.equal(beta?.role, "admin");
  // What reads the signed-in member's role there (sequences, mailboxes) still finds it.
  const { roleIn } = M["permissions.ts"] as unknown as { roleIn: (ctx: unknown, user: unknown, orgId: string) => Promise<string | null> };
  assert.equal(await roleIn(ctxOf(db), beta, "beta"), "admin");
  assert.equal((await me(ADA))?._id, "ada", "an active member keeps their session");
});

test("a member removed from their only workspace in Clerk can't act in it from a session that names no workspace", async () => {
  const db = workspace();
  await call(db, undefined, "users.removeMembershipFromClerk", { clerkUserId: "user_cy", clerkOrgId: "org_acme" });
  assert.equal(await call(db, { subject: "user_cy" }, "users.me"), null);
  // Removed from Acme in Clerk, Bo's home moves to Beta and Bo keeps it.
  await call(db, undefined, "users.removeMembershipFromClerk", { clerkUserId: "user_bo", clerkOrgId: "org_acme" });
  assert.equal((await call(db, { subject: "user_bo" }, "users.me"))?.orgId, "beta");
  assert.equal(await call(db, { subject: "user_bo", org: "org_acme" }, "users.me"), null);
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boAcme, provider: "hubspot" }), "refused");
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boBeta, provider: "hubspot" }), "authenticated");
});

test("an agent or rule acting as a member turned off on the Team page no longer resolves to them", async () => {
  const db = workspace();
  const principal = () => call(db, undefined, "permissions.requireUnrestrictedPrincipal", { orgId: "acme", userId: "bo", what: "this" });
  assert.equal(await principal(), null);
  await setActive(db, "bo", false);
  await assert.rejects(principal(), /no longer a member/);
});

test("a paired token works while its member could still pair one: a member moved to a role without it can't mint", async () => {
  const db = workspace();
  await call(db, ADA, "users.update", { userId: "bo", role: "rep" });
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boAcme, provider: "hubspot" }), "refused");
  assert.equal(await outcome(db, "cliAuthActions.mintProviderToken", { cliToken: T.boBeta, provider: "hubspot" }), "authenticated");
});

test("self-hosted: turning a member off ends their sessions, and turning them back on doesn't revive the cookies", async () => {
  const prior = { auth: process.env.CANON_AUTH, issuer: process.env.CANON_SERVICE_JWT_ISSUER };
  process.env.CANON_AUTH = "local";
  process.env.CANON_SERVICE_JWT_ISSUER = "canon-local";
  try {
    const db = memoryDb({
      organizations: [{ _id: "home", name: "Home", clerkOrgId: "local" }],
      users: [
        { _id: "ada", orgId: "home", clerkUserId: "local_00000000-0000-0000-0000-00000000000a", email: "ada@home.test", name: "Ada", role: "admin", isActive: true },
        { _id: "bo", orgId: "home", clerkUserId: "local_00000000-0000-0000-0000-00000000000b", email: "bo@home.test", name: "Bo", role: "rep", isActive: true },
        // Added on the Team page; never signed in.
        { _id: "di", orgId: "home", clerkUserId: "member:home:di@home.test", email: "di@home.test", name: "Di", role: "rep", isActive: true },
      ],
      orgMemberships: [
        { _id: "m-ada", userId: "ada", orgId: "home", role: "admin", isActive: true },
        { _id: "m-bo", userId: "bo", orgId: "home", role: "rep", isActive: true },
      ],
      localSessions: [{ _id: "s-bo", tokenHash: "bo-cookie", userId: "bo", expiresAt: Date.now() + 86_400_000 }],
    });
    const broker = { subject: "local_auth_server", issuer: "canon-local" };
    const session = (tokenHash: string) => call(db, broker, "localAuth.session", { tokenHash });
    const admin = { subject: "local_00000000-0000-0000-0000-00000000000a", issuer: "canon-local" };
    assert.equal((await session("bo-cookie"))?.user._id, "bo");
    await call(db, admin, "users.update", { userId: "bo", isActive: false });
    assert.equal(await session("bo-cookie"), null);
    await call(db, admin, "users.update", { userId: "bo", isActive: true });
    assert.equal(await session("bo-cookie"), null, "the old cookie stays dead; Bo signs in again");
    // A member who never signed in still takes their invitation.
    await call(db, admin, "localAuth.invite", { userId: "di", tokenHash: "di-invite" });
    await call(db, broker, "localAuth.register", { email: "di@home.test", name: "Di", passwordHash: "x", subject: "local_00000000-0000-0000-0000-00000000000d", tokenHash: "di-cookie", expiresAt: Date.now() + 86_400_000, inviteHash: "di-invite" });
    assert.equal((await session("di-cookie"))?.user._id, "di");
  } finally {
    process.env.CANON_AUTH = prior.auth;
    process.env.CANON_SERVICE_JWT_ISSUER = prior.issuer;
    if (prior.auth === undefined) delete process.env.CANON_AUTH;
    if (prior.issuer === undefined) delete process.env.CANON_SERVICE_JWT_ISSUER;
  }
});
