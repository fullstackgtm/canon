/**
 * Connector links and their feeds' health (shared gap P5, docs/connector-feeds.md): the Feeds page in Settings, the
 * signed webhook's links and its receiving end. Every write of a feed goes through lib/connectors/feeds.ts.
 */
import { sealedV } from "./lib/sealed";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentClientOf, getCurrentUser, requireCap, requireUser } from "./lib";
import { can } from "./lib/capabilities";
import { encryptForStorage } from "./lib/tokenHelpers";
import { newSecret } from "./lib/recordWebhooks";
import { CONNECTORS, connectorOf } from "./lib/connectors/registry";
import { linkError, putFeedItem } from "./lib/connectors/feeds";
import { CONNECTOR_WEBHOOK_PREFIX, WEBHOOK_FEED, webhook } from "./lib/connectors/webhook";
import { feedGrant } from "./lib/connectors/grants";
import { installedModule, isEnabled, manifestOf } from "./lib/modules/packages";
import { restartConnectorLinkBackfill } from "./lib/modules/jobs";

const DAY_MS = 24 * 60 * 60_000;
const LINKS_SHOWN = 200;
/** Feed changes counted per link for "in the last 24 hours"; past it the page says "1,000+". */
const COUNT_MAX = 1000;
const MAX_WEBHOOKS = 20;

const siteUrl = () => (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
const webhookUrl = (id: Id<"connectorLinks">) => `${siteUrl()}${CONNECTOR_WEBHOOK_PREFIX}${id}`;

type Health = "ok" | "error" | "expired" | "revoked";
/** A link's state as the page shows it: an item refused since the last one it took is an error until the next. */
function healthOf(l: Doc<"connectorLinks">): Health {
  if (l.status !== "ok") return l.status;
  return l.lastErrorAt !== undefined && l.lastErrorAt > (l.lastItemAt ?? 0) ? "error" : "ok";
}

async function personalFeeds(ctx: QueryCtx, user: Doc<"users">) {
  const packages = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId).eq("status", "installed")).take(50);
  const out = [];
  for (const c of Object.values(CONNECTORS)) {
    if (c.scope !== "member") continue;
    const links = await ctx.db.query("connectorLinks").withIndex("by_orgId_and_connector_and_userId", (q) => q.eq("orgId", user.orgId).eq("connector", c.id).eq("userId", user._id)).take(LINKS_SHOWN);
    for (const link of links) {
      if (link.status === "revoked") continue;
      const modules = [];
      for (const pkg of packages) {
        const m = manifestOf(pkg);
        const feeds = Object.values(m.feeds ?? {}).filter((f) => Object.hasOwn(c.feeds, f.feed)).map((f) => ({ label: c.feeds[f.feed].label, fields: f.fields.map((name) => c.feeds[f.feed].fields[name]?.label ?? name) }));
        if (!feeds.length) continue;
        const grant = await feedGrant(ctx, user.orgId, link._id, pkg.moduleId);
        modules.push({ id: pkg.moduleId, title: m.title, enabled: await isEnabled(ctx, user.orgId, pkg.moduleId), granted: grant?.granted ?? true, feeds });
      }
      out.push({ id: link._id, label: link.label ?? c.label, connector: c.label, modules });
    }
  }
  return out;
}

/** Workspace health for integration managers, plus only the caller's personal read grants for every member. */
export const health = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user?.isActive) return null;
    const canManage = can(user, "integrations.manage");
    const personal = await personalFeeds(ctx, user);
    const since = Date.now() - DAY_MS;
    const rows = [];
    for (const c of canManage ? Object.values(CONNECTORS) : []) {
      const links = await ctx.db.query("connectorLinks").withIndex("by_orgId_and_connector_and_userId", (q) => q.eq("orgId", user.orgId).eq("connector", c.id)).take(LINKS_SHOWN);
      for (const l of links) {
        if (l.status === "revoked") continue;
        const recent = await ctx.db.query("feedLog").withIndex("by_linkId_and_at", (q) => q.eq("linkId", l._id).gte("at", since)).take(COUNT_MAX + 1);
        const member = l.userId ? await ctx.db.get(l.userId) : null;
        rows.push({
          id: l._id, connector: c.id, connectorLabel: c.label, label: l.label ?? null, member: member ? (member.name ?? member.email) : null,
          status: healthOf(l), lastItemAt: l.lastItemAt ?? null, items24h: Math.min(recent.length, COUNT_MAX), more: recent.length > COUNT_MAX,
          lastError: l.lastError ?? null, lastErrorAt: l.lastErrorAt ?? null, url: c.id === webhook.id ? webhookUrl(l._id) : null, createdAt: l.createdAt,
        });
      }
    }
    const connectors = (canManage ? Object.values(CONNECTORS) : []).map((c) => ({
      id: c.id, label: c.label, scope: c.scope, feeds: Object.entries(c.feeds).map(([name, f]) => ({ name, label: f.label, fields: Object.values(f.fields).map((x) => x.label) })),
      missing: c.env.filter((k) => !process.env[k]),
    }));
    return { links: rows, connectors, personal, canManage };
  },
});

/** Only the signed-in human owner changes their link's module read preference. This never grants an action. */
export const setFeedGrant = mutation({
  args: { linkId: v.id("connectorLinks"), moduleId: v.string(), granted: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!user.isActive || await agentClientOf(ctx)) throw new ConvexError("Only the signed-in account owner changes feed access");
    const link = await ctx.db.get(args.linkId);
    if (!link || link.orgId !== user.orgId || link.userId !== user._id || link.status === "revoked" || connectorOf(link.connector)?.scope !== "member") throw new ConvexError("Personal link not found");
    const pkg = await installedModule(ctx, user.orgId, args.moduleId);
    if (!pkg) throw new ConvexError("Module not found");
    const m = manifestOf(pkg);
    const connector = connectorOf(link.connector)!;
    if (!Object.values(m.feeds ?? {}).some((f) => Object.hasOwn(connector.feeds, f.feed))) throw new ConvexError("This module does not read this connector's feeds");
    const previous = await feedGrant(ctx, user.orgId, link._id, pkg.moduleId);
    if ((previous?.granted ?? true) === args.granted) return null;
    const now = Date.now();
    const data = { granted: args.granted, revision: (previous?.revision ?? 0) + 1, changedBy: user._id, changedAt: now };
    if (previous) await ctx.db.patch(previous._id, data);
    else await ctx.db.insert("connectorFeedGrants", { orgId: user.orgId, linkId: link._id, moduleId: pkg.moduleId, ...data });
    if (args.granted) await restartConnectorLinkBackfill(ctx, user.orgId, pkg.moduleId, m, link.connector, link._id, data.revision);
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "connector_feed.grant", status: "applied", details: { linkId: link._id, moduleId: pkg.moduleId, granted: args.granted }, createdAt: now });
    await ctx.scheduler.runAfter(0, internal.moduleJobs.feedItems, { orgId: user.orgId });
    return null;
  },
});

async function ownLink(ctx: MutationCtx, id: Id<"connectorLinks">) {
  const user = await requireCap(ctx, "integrations.manage");
  const link = await ctx.db.get(id);
  if (!link || link.orgId !== user.orgId || link.status === "revoked") throw new ConvexError("Link not found");
  return { user, link };
}

/** Add a signed webhook. Its secret comes back once, here, and is stored encrypted. */
export const createWebhook = action({
  args: { label: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<"connectorLinks">; url: string; secret: string }> => {
    const secret = newSecret();
    const id: Id<"connectorLinks"> = await ctx.runMutation(internal.connectors.insertWebhook, { label: args.label, secret: await encryptForStorage(secret) });
    return { id, url: webhookUrl(id), secret };
  },
});

export const insertWebhook = internalMutation({
  args: { label: v.string(), secret: sealedV },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "integrations.manage");
    const label = args.label.trim().slice(0, 100);
    if (!label) throw new ConvexError("Name the webhook");
    const existing = await ctx.db.query("connectorLinks").withIndex("by_orgId_and_connector_and_userId", (q) => q.eq("orgId", user.orgId).eq("connector", webhook.id)).take(MAX_WEBHOOKS + 1);
    if (existing.filter((l) => l.status !== "revoked").length >= MAX_WEBHOOKS) throw new ConvexError(`A workspace can have ${MAX_WEBHOOKS} signed webhooks`);
    const now = Date.now();
    const id = await ctx.db.insert("connectorLinks", { orgId: user.orgId, connector: webhook.id, label, status: "ok", secret: args.secret, createdBy: user._id, createdAt: now });
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "connector_link.create", status: "applied", details: { connector: webhook.id, label }, createdAt: now });
    return id;
  },
});

/** A new signing secret for a signed webhook: the old one stops working at once. */
export const rotateWebhook = action({
  args: { id: v.id("connectorLinks") },
  handler: async (ctx, args): Promise<{ secret: string }> => {
    const secret = newSecret();
    await ctx.runMutation(internal.connectors.setSecret, { id: args.id, secret: await encryptForStorage(secret) });
    return { secret };
  },
});

export const setSecret = internalMutation({
  args: { id: v.id("connectorLinks"), secret: sealedV },
  handler: async (ctx, args) => {
    const { user, link } = await ownLink(ctx, args.id);
    if (link.connector !== webhook.id) throw new ConvexError("Only a signed webhook has a secret to rotate");
    await ctx.db.patch(link._id, { secret: args.secret });
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "connector_link.rotate", status: "applied", details: { connector: link.connector, linkId: link._id }, createdAt: Date.now() });
    return null;
  },
});

/** Remove a link: it takes no more items, and its feed's items stay as they were. */
export const removeLink = mutation({
  args: { id: v.id("connectorLinks") },
  handler: async (ctx, args) => {
    const { user, link } = await ownLink(ctx, args.id);
    if (connectorOf(link.connector)?.scope !== "workspace") throw new ConvexError("A member's link is removed where they connected it");
    await ctx.db.patch(link._id, { status: "revoked", secret: undefined });
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "connector_link.remove", status: "applied", details: { connector: link.connector, linkId: link._id }, createdAt: Date.now() });
    return null;
  },
});

// ── The signed webhook's receiving end (lib/connectors/webhookRoute.ts) ──

/** A live signed webhook's encrypted secret, or null for anything else: the route answers both the same. */
export const webhookSecret = internalQuery({
  args: { linkId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("connectorLinks", args.linkId);
    const link = id ? await ctx.db.get(id) : null;
    return link && link.connector === webhook.id && link.status === "ok" && link.secret ? { linkId: link._id, secret: link.secret } : null;
  },
});

/** One verified delivery: the item written, or why it was refused (on the link, for the Feeds page). */
export const receiveWebhook = internalMutation({
  args: { linkId: v.id("connectorLinks"), item: v.union(v.object({ id: v.string(), version: v.optional(v.number()), data: v.any() }), v.object({ error: v.string() })) },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.status !== "ok") return { status: "refused" as const, error: "This link was removed." };
    if ("error" in args.item) {
      await linkError(ctx, link._id, args.item.error);
      return { status: "refused" as const, error: args.item.error };
    }
    // A sender's ids are its own: two webhooks in one workspace may both send evt_1.
    return putFeedItem(ctx, link, WEBHOOK_FEED, { ...args.item, id: `${link._id}:${args.item.id}` });
  },
});
