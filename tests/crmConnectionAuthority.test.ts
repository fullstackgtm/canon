import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const env: Record<string, string> = { CONVEX_SITE_URL: "http://localhost:3001", HUBSPOT_CLIENT_ID: "test", SALESFORCE_CLIENT_ID: "test", NEXT_PUBLIC_APP_URL: "http://localhost:3000", CANON_SERVICE_JWT_ISSUER: "https://service.test" };
const files = ["hubspot.ts", "salesforce.ts", "hubspotActions.ts", "salesforceActions.ts", "users.ts", "hubspotImport.ts", "callProviders.ts", "callProviderActions.ts", "healthSnapshots.ts", "ownership.ts", "stripeActions.ts", "gtm.ts"];
const modules = loadConvex(files, { "lib/tokenHelpers.ts": (real) => ({ ...real, encryptForStorage: async () => "sealed" }) }, { process: { env }, URLSearchParams });
const call = (file: string, name: string, ctx: unknown, args = {}) => modules[file][name].handler(ctx, args);
function context(role = "admin", identity: unknown = { subject: "user", issuer: "https://clerk.test" }) {
  const db = memoryDb({ organizations: [{ _id: "org", clerkOrgId: "org_clerk" }, { _id: "other", clerkOrgId: "other_clerk" }], users: [{ _id: "user", orgId: "org", clerkUserId: "user", email: "a@test.com", role, isActive: true }], orgRoles: [{ _id: "role", orgId: "org", key: "custom", capabilities: ["integrations.manage"] }] });
  const ctx = { db, auth: { getUserIdentity: async () => identity }, scheduler: { runAfter: async () => null },
    runQuery: async (ref: unknown, args: object) => {
      const [, file, name] = String(ref).split(".");
      if (name === "getIntegration" || name === "requireUnrestrictedPrincipal") throw new Error("reached integration");
      return call(`${file}.ts`, name, ctx, args);
    },
    runAction: async () => { throw new Error("reached integration"); },
    runMutation: async (ref: unknown) => { if (String(ref).endsWith(".startSyncRun")) throw new Error("reached integration"); return null; },
  };
  return ctx;
}

test("owner sync preserves members and Canon deactivation while CRM placeholders follow their provider", async () => {
  for (const provider of ["hubspot", "salesforce"]) {
    const db = memoryDb({ users: [
      { _id: "admin", clerkUserId: "login", email: "admin@test", orgId: "org", role: "admin", isActive: true },
      { _id: "off", clerkUserId: `${provider}:org:off`, email: "off@test", orgId: "org", role: "rep", isActive: false, deactivatedBy: "canon" },
      { _id: "invited", clerkUserId: "member:invited", email: "invited@test", orgId: "org", role: "rep", isActive: false },
      { _id: "placeholder", clerkUserId: `${provider}:org:placeholder`, email: "placeholder@test", orgId: "org", role: "rep", isActive: false },
    ] });
    for (const id of ["admin", "off", "invited", "placeholder"]) {
      const result = await call(`${provider}.ts`, "upsertOwners", { db }, { orgId: "org", owners: [{ crmOwnerId: id, email: `${id}@test`, name: id, ...(provider === "salesforce" ? { isActive: id !== "admin" } : {}) }] });
      const row = await db.get(id);
      assert.equal(row?.isActive, !["off", "invited"].includes(id), `${provider} ${id}`);
      assert.equal(row?.crmOwnerId, id);
      assert.equal(result.ownerMap[id], id);
    }
  }
});

test("CRM actions resolve Convex, custom Clerk, paired CLI, built-in and demo callers with workspace scope", async () => {
  for (const mode of ["convex", "custom", "paired", "admin", "manager", "demo"]) {
    env.CANON_AUTH = mode === "convex" || mode === "paired" ? "convex" : "clerk";
    env.FSGTM_ENABLE_DEMO_DATA = mode === "demo" ? "true" : "false";
    const ctx = context(mode === "custom" ? "custom" : mode === "manager" ? "manager" : "admin", mode === "convex" ? { subject: "user|session", issuer: "https://convex.test" } : mode === "paired" ? { subject: "user", issuer: env.CANON_SERVICE_JWT_ISSUER, org_id: "org_clerk" } : mode === "demo" ? null : { subject: "user", issuer: "https://clerk.test", org_id: "org_clerk" });
    if (mode === "demo") await ctx.db.patch("user", { clerkUserId: "dev_user_fullstackgtm" });
    for (const provider of ["hubspot", "salesforce"]) {
      const file = `${provider}Actions.ts`;
      assert.ok((await call(file, "getAuthUrl", ctx)).authUrl);
      await assert.rejects(call(file, "syncAll", ctx), /reached integration/);
      await assert.rejects(call(file, "patchDealNextStep", ctx, { orgId: "org", crmId: "deal", nextStep: "next" }), /reached integration/);
      await assert.rejects(call(file, "patchDealNextStep", ctx, { orgId: "other", crmId: "deal", nextStep: "next" }), /Organization not found/);
    }
    await assert.rejects(call("callProviderActions.ts", "syncProvider", ctx, { provider: "gong" }), /reached integration/);
    await assert.rejects(call("healthSnapshots.ts", "capture", ctx), /reached integration/);
    await assert.rejects(call("ownership.ts", "proposeDealOwnerBackfill", ctx), mode === "custom" ? /Your role can.t do this/ : /reached integration/);
    await assert.rejects(call("stripeActions.ts", "connect", ctx, { secretKey: "invalid" }), /doesn't look like/);
    for (const action of ["backfill.stripe", "hygiene.apply_operations", "deal.assign_owners"]) {
      await assert.rejects(call("gtm.ts", "applyDoInternal", ctx, { action, operations: [{}] }), /reached integration/);
    }
    await ctx.db.patch("user", { isActive: false });
    if (mode !== "demo") await assert.rejects(call("hubspotActions.ts", "getAuthUrl", ctx), /User not found/);
  }
  env.CANON_AUTH = "clerk";
  const ctx = context("admin", { subject: "user", org_id: "other_clerk" });
  await ctx.db.insert("orgMemberships", { userId: "user", orgId: "other", role: "manager", isActive: true });
  await assert.rejects(call("hubspotActions.ts", "patchDealNextStep", ctx, { orgId: "other", crmId: "deal", nextStep: "next" }), /reached integration/);
  await assert.rejects(call("hubspotActions.ts", "patchDealNextStep", ctx, { orgId: "org", crmId: "deal", nextStep: "next" }), /Organization not found/);
});

test("reconnection retains cursors only for a known matching CRM workspace", async () => {
  for (const provider of ["hubspot", "salesforce"]) for (const previous of ["portal", undefined]) for (const next of ["portal", "different", undefined]) {
    const ctx = context();
    await ctx.db.insert("integrations", { _id: "integration", orgId: "org", provider, externalOrgId: previous, syncCursors: { deals: "cursor" }, isActive: false });
    await call(`${provider}.ts`, "storeTokens", ctx, { orgId: "org", userId: "user", accessToken: "test", refreshToken: "", instanceUrl: "https://test.my.salesforce.com", tokenExpiresAt: 100, externalOrgId: next });
    assert.equal(Boolean((await ctx.db.get("integration"))?.syncCursors), Boolean(previous && previous === next), `${provider} ${previous} -> ${next}`);
    if (previous !== next || !next) {
      await ctx.db.insert("integrationSyncRuns", { _id: "old-run", status: "success", startedAt: 1 });
      await call(`${provider}.ts`, "setSyncCursors", ctx, { orgId: "org", syncRunId: "old-run", modifiedSince: 1, fullSyncAt: 1, mappingsKey: "old" });
      assert.equal((await ctx.db.get("integration"))?.syncCursors, undefined, "old sync cannot undo the reconnect reset");
      const connectedAt = (await ctx.db.get("integration"))?.connectedAt;
      await ctx.db.insert("integrationSyncRuns", { _id: "new-run", status: "success", startedAt: connectedAt });
      await call(`${provider}.ts`, "setSyncCursors", ctx, { orgId: "org", syncRunId: "new-run", modifiedSince: connectedAt, fullSyncAt: connectedAt, mappingsKey: "new" });
      assert.equal(((await ctx.db.get("integration"))?.syncCursors as { modifiedSince?: number })?.modifiedSince, connectedAt, "new sync records its cursors");
    }
  }
  for (const externalOrgId of ["portal", "different", undefined]) {
    const ctx = context();
    await ctx.db.insert("integrations", { _id: "integration", orgId: "org", provider: "hubspot", externalOrgId: "portal", syncCursors: { deals: "cursor" }, isActive: true });
    await call("hubspot.ts", "connectFromCli", ctx, { orgId: "org", userId: "user", accessToken: "test", externalOrgId });
    assert.equal(Boolean((await ctx.db.get("integration"))?.syncCursors), externalOrgId === "portal");
  }
});

test("HubSpot token connection requires integration management, including custom roles", async () => {
  env.CANON_AUTH = "clerk";
  for (const caps of [["imports.run"], ["integrations.manage"]]) {
    const ctx = context("custom");
    await ctx.db.patch("role", { capabilities: caps });
    await assert.rejects(call("hubspotActions.ts", "connectWithToken", ctx, { token: "" }), caps.includes("integrations.manage") ? /private-app token is required/ : /Your role can.t do this/);
  }
  for (const role of ["admin", "manager"]) await assert.rejects(call("hubspotActions.ts", "connectWithToken", context(role), { token: "" }), /private-app token is required/);
});
