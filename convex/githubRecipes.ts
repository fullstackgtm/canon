/**
 * A workspace's connections to Canon's GitHub App, for installing recipes from private repos (docs/recipes.md, R5b).
 * An admin or manager starts "Connect GitHub", which issues a one-time state and sends them to the App's install
 * page. GitHub returns them to /api/recipes/github/setup with the state and a sign-in code, and `completeSetup`
 * connects only the installations that person's GitHub account can reach: GitHub's installation_id parameter is
 * forgeable on its own. Connecting and disconnecting are human-only (src/lib/gtm-human-only-mutations.ts).
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { GithubAppError, appConfig, authorizeUrl, installUrl, installationAccount, installationRepos, requireAppConfig, userInstallations } from "./lib/githubApp";
import { isDevAuthBypassEnabled } from "./lib";
import { callerOf, mayDecide, requireDecider } from "./recipes";

const STATE_TTL_MS = 10 * 60_000;
const CONNECTIONS_SHOWN = 20;
const INSTALLATIONS_MAX = 10;
const STALE_STATE = "This GitHub connect request expired or was started by someone else. Connect GitHub again from the Customization page.";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const refuse = (message: string): never => { throw new ConvexError(message); };

export const connections = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const rows = await ctx.db.query("githubRecipeConnections").withIndex("by_orgId_and_status", (q) => q.eq("orgId", caller.user.orgId).eq("status", "connected")).take(CONNECTIONS_SHOWN);
    return {
      configured: appConfig() !== null,
      canEdit: mayDecide(caller),
      connections: await Promise.all(rows.map(async (r) => ({
        installationId: r.installationId, account: r.account, connectedAt: r.connectedAt, connectedBy: (await ctx.db.get(r.connectedBy))?.name ?? "Someone",
      }))),
    };
  },
});

/** Start "Connect GitHub": a one-time state for this person and workspace, and the App's install page to send them to. */
export const startConnect = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    requireAppConfig();
    const state = hex(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.runMutation(internal.githubRecipes.storeState, { stateHash: await sha256(state) });
    return { url: installUrl(state) };
  },
});

export const storeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    for (const old of await ctx.db.query("githubRecipeSetupStates").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(20)) await ctx.db.delete(old._id);
    await ctx.db.insert("githubRecipeSetupStates", { stateHash: args.stateHash, orgId: user.orgId, userId: user._id, expiresAt: Date.now() + STATE_TTL_MS });
    return null;
  },
});

/** The caller's own unexpired state row, else a refusal. Consuming deletes it, so a state works once. */
async function ownState(ctx: MutationCtx, stateHash: string, consume: boolean) {
  const user = await requireDecider(ctx);
  const row = await ctx.db.query("githubRecipeSetupStates").withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash)).unique();
  if (!row || row.userId !== user._id || row.orgId !== user.orgId || row.expiresAt <= Date.now()) return refuse(STALE_STATE);
  if (consume) await ctx.db.delete(row._id);
  return null;
}

export const checkState = internalMutation({ args: { stateHash: v.string() }, handler: (ctx, args) => ownState(ctx, args.stateHash, false) });
export const consumeState = internalMutation({ args: { stateHash: v.string() }, handler: (ctx, args) => ownState(ctx, args.stateHash, true) });

/**
 * GitHub's return from the App's install page. Without a sign-in code (GitHub skips it when an existing install is
 * only updated), the person is sent to sign in with the App under the same state. With one, the state is spent and
 * the workspace connects the installations their GitHub account reaches: the one GitHub named, or every one.
 */
export const completeSetup = action({
  args: { state: v.string(), code: v.optional(v.string()), installationId: v.optional(v.number()), redirectUri: v.string() },
  handler: async (ctx, args): Promise<{ authorize: string } | { connected: string[] }> => {
    const stateHash = await sha256(args.state);
    // A local stack (FSGTM_ENABLE_DEMO_DATA, where sign-in itself is bypassed) can't get GitHub's redirect, so an
    // admin pastes it by hand; the installation is checked with the App's JWT alone.
    if (isDevAuthBypassEnabled() && args.installationId !== undefined) {
      await ctx.runMutation(internal.githubRecipes.consumeState, { stateHash });
      const repos = (await installationRepos(args.installationId).catch(asConvexError)).map((r) => r.fullName);
      const installations = [{ installationId: args.installationId, account: await installationAccount(args.installationId).catch(asConvexError), repos }];
      await ctx.runMutation(internal.githubRecipes.storeConnections, { installations });
      return { connected: installations.map((i) => i.account.login) };
    }
    if (!args.code) {
      await ctx.runMutation(internal.githubRecipes.checkState, { stateHash });
      return { authorize: authorizeUrl(args.state, args.redirectUri) };
    }
    await ctx.runMutation(internal.githubRecipes.consumeState, { stateHash });
    const reachable = await userInstallations(args.code).catch(asConvexError);
    const picked = args.installationId === undefined ? reachable.slice(0, INSTALLATIONS_MAX)
      : reachable.filter((i) => i.id === args.installationId);
    if (args.installationId !== undefined && !picked.length) refuse("Your GitHub account can't reach that installation of Canon's App. Connect GitHub again from the Customization page.");
    if (!picked.length) refuse("Your GitHub account can't reach an installation of Canon's App. Install it on your GitHub organization first.");
    const installations = await Promise.all(picked.map(async (i) => ({ installationId: i.id, account: await installationAccount(i.id).catch(asConvexError), repos: i.repos })));
    await ctx.runMutation(internal.githubRecipes.storeConnections, { installations });
    return { connected: installations.map((i) => i.account.login) };
  },
});

const asConvexError = (e: unknown): never => {
  if (e instanceof GithubAppError) throw new ConvexError(e.status === 401 ? "GitHub refused Canon's App credentials." : `${e.message}. Connect GitHub again from the Customization page.`);
  throw e;
};

export const storeConnections = internalMutation({
  args: { installations: v.array(v.object({ installationId: v.number(), account: v.object({ login: v.string(), type: v.string() }), repos: v.array(v.string()) })) },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    for (const { installationId, account, repos } of args.installations) {
      const fields = { account, repos, connectedBy: user._id, connectedAt: Date.now(), status: "connected" as const };
      const row = await ctx.db.query("githubRecipeConnections").withIndex("by_orgId_and_installationId", (q) => q.eq("orgId", user.orgId).eq("installationId", installationId)).unique();
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("githubRecipeConnections", { orgId: user.orgId, installationId, ...fields });
      // A reinstall of the App gets a new installation id: packages from this account's repos move onto it.
      const seen = new Set(repos.map((r) => r.toLowerCase()));
      for (const pkg of await ctx.db.query("recipePackages").withIndex("by_orgId_and_recipeId", (q) => q.eq("orgId", user.orgId)).take(200)) {
        const s = pkg.source;
        if (s.kind === "github-app" && s.installationId !== installationId && seen.has(`${s.owner}/${s.repo}`.toLowerCase())) await ctx.db.patch(pkg._id, { source: { ...s, installationId } });
      }
    }
    return null;
  },
});

/**
 * Stop reading this GitHub account's repos. Packages installed from it stay installed and keep running their pinned
 * code; checking them for updates fails until someone reconnects. The App stays installed on GitHub until its owner
 * uninstalls it there.
 */
export const disconnect = mutation({
  args: { installationId: v.number() },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const row = await ctx.db.query("githubRecipeConnections").withIndex("by_orgId_and_installationId", (q) => q.eq("orgId", user.orgId).eq("installationId", args.installationId)).unique();
    if (row?.status !== "connected") throw new ConvexError("That GitHub account isn't connected.");
    await ctx.db.patch(row._id, { status: "disconnected" });
    return null;
  },
});

export const connectedAccount = internalQuery({
  args: { installationId: v.number() },
  handler: async (ctx, args): Promise<{ login: string; repos: string[] }> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const row = await ctx.db.query("githubRecipeConnections").withIndex("by_orgId_and_installationId", (q) => q.eq("orgId", caller.user.orgId).eq("installationId", args.installationId)).unique();
    if (row?.status !== "connected") throw new ConvexError("That GitHub account isn't connected to this workspace.");
    return { login: row.account.login, repos: row.repos };
  },
});

/** The repos a connection can read: those GitHub lists for the App now that the person who connected it could see. */
export const repositories = action({
  args: { installationId: v.number() },
  handler: async (ctx, args): Promise<Array<{ fullName: string; private: boolean }>> => {
    const { login, repos }: { login: string; repos: string[] } = await ctx.runQuery(internal.githubRecipes.connectedAccount, { installationId: args.installationId });
    const seen = new Set(repos.map((r) => r.toLowerCase()));
    try {
      return (await installationRepos(args.installationId)).filter((r) => seen.has(r.fullName.toLowerCase()));
    } catch (e) {
      if (e instanceof GithubAppError) throw new ConvexError(e.status === 401 ? "GitHub refused Canon's App credentials." : `Canon's GitHub App no longer has access to ${login}; reconnect GitHub on the Customization page.`);
      throw e;
    }
  },
});
