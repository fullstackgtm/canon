import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { accessFor } from "./permissions";
import { enabledModules } from "./lib/modules/packages";
import {
  MAILBOX_GRANT_DAY_MS, MAILBOX_GRANT_MAX_DAYS, MAILBOX_GRANT_MAX_PER_DAY, canonicalManifestTemplate,
  grantTemplates, inspectMailboxGrant, liveMailboxOwner, mailboxGrantKey, mailboxGrantTerms, mailboxLinkHash, signMailboxGrant,
} from "./lib/outbound/mailboxGrants";
import { readSq1TemplateSet } from "./lib/outbound/sq1Templates";

async function ownerSession(ctx: QueryCtx, user: Doc<"users"> | null) {
  if (!user || await agentClientOf(ctx) || (await accessFor(ctx, user)).preview) return null;
  return (await ctx.db.get(user.orgId)) && (await liveMailboxOwner(ctx, user.orgId, user._id)) ? user : null;
}
async function ownMailbox(ctx: QueryCtx, user: Doc<"users">, id: Id<"emailAccounts">) {
  const account = await ctx.db.get(id);
  return account && account.orgId === user.orgId && account.userId === user._id ? account : null;
}

/** Owner-only consent management. Agents, previews and another mailbox's managers have no owner authority. */
export const mine = query({
  args: { scope: v.object({ orgId: v.id("organizations"), userId: v.id("users") }), moduleId: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ownerSession(ctx, await getCurrentUser(ctx));
    if (!user || args.scope?.orgId !== user.orgId || args.scope?.userId !== user._id) return null;
    const accounts = [];
    for (const a of await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(50)) {
      if (a.orgId !== user.orgId) continue;
      const link = await mailboxLinkHash(a);
      if (link) accounts.push({ id: a._id, address: a.address, name: a.displayName || a.address, mailboxLinkHash: link });
    }
    const modules = [];
    for (const { pkg, manifest } of await enabledModules(ctx, user.orgId)) {
      if (args.moduleId !== undefined && args.moduleId !== pkg.moduleId) continue;
      const templates = await grantTemplates(pkg.moduleId, manifest);
      if (templates.length) modules.push({ moduleId: pkg.moduleId, title: manifest.title, templates });
    }
    const moduleId = args.moduleId;
    const rows = moduleId === undefined
      ? ctx.db.query("mailboxSendGrants").withIndex("by_orgId_and_ownerId", (q) => q.eq("orgId", user.orgId).eq("ownerId", user._id))
      : ctx.db.query("mailboxSendGrants").withIndex("by_orgId_and_ownerId_and_moduleId", (q) => q.eq("orgId", user.orgId).eq("ownerId", user._id).eq("moduleId", moduleId));
    const page = await rows.order("desc").paginate({ numItems: 50, cursor: args.cursor ?? null });
    const grants = await Promise.all(page.page.map(async (g) => {
      const account = await ownMailbox(ctx, user, g.senderId);
      return { ...mailboxGrantTerms(g), ...(await inspectMailboxGrant(ctx, g, Date.now())), address: account?.address ?? null,
        revokedAt: g.revokedAt ?? null, canRevoke: !!account && g.revokedAt === undefined };
    }));
    return { owner: { id: user._id, name: user.name }, accounts, modules, grants, nextCursor: page.isDone ? null : page.continueCursor,
      signingReady: (await mailboxGrantKey()) !== null, maxDays: MAILBOX_GRANT_MAX_DAYS, maxPerDay: MAILBOX_GRANT_MAX_PER_DAY };
  },
});

/** Canon recomputes every authority binding; expected hashes only refuse stale consent. */
export const createManifest = mutation({
  args: { senderId: v.id("emailAccounts"), moduleId: v.string(), template: v.string(), maxPerDay: v.number(), expiresAt: v.number(), expectTemplateHash: v.string(), expectMailboxLinkHash: v.string() },
  handler: async (ctx, args) => {
    const user = await ownerSession(ctx, await requireUser(ctx));
    if (!user) throw new ConvexError("Use your own signed-in account outside a preview to manage mailbox grants.");
    const account = await ownMailbox(ctx, user, args.senderId);
    const link = account ? await mailboxLinkHash(account) : null;
    if (!account || !link) throw new ConvexError("Choose one of your own connected mailboxes.");
    if (link !== args.expectMailboxLinkHash) throw new ConvexError("Your mailbox connection changed. Review it again before granting consent.");
    const template = await canonicalManifestTemplate(ctx, user.orgId, args.moduleId, args.template);
    if (!template) throw new ConvexError("This enabled module has no eligible mailbox template with that name.");
    if (template.hash !== args.expectTemplateHash) throw new ConvexError("The template changed. Review it again before granting consent.");
    const now = Date.now();
    if (!Number.isInteger(args.maxPerDay) || args.maxPerDay < 1 || args.maxPerDay > MAILBOX_GRANT_MAX_PER_DAY) throw new ConvexError("Choose a daily cap from 1 to 100.");
    if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now || args.expiresAt - now > MAILBOX_GRANT_MAX_DAYS * MAILBOX_GRANT_DAY_MS) throw new ConvexError("Choose a future expiry within 90 days.");
    const key = await mailboxGrantKey();
    if (!key) throw new ConvexError("Mailbox grants cannot be signed on this deployment yet.");
    const terms = { version: 1 as const, orgId: user.orgId, moduleId: args.moduleId, ownerId: user._id, senderId: account._id, mailboxLinkHash: link,
      template: { kind: "manifest" as const, name: args.template, hash: template.hash }, maxPerDay: args.maxPerDay, expiresAt: args.expiresAt, createdAt: now };

    const grantId = await ctx.db.insert("mailboxSendGrants", { ...terms, signature: "" });
    await ctx.db.patch(grantId, { signature: await signMailboxGrant({ ...terms, grantId }, key) });
    return { grantId };
  },
});

/** Owner-scoped review of the real frozen set; expected hashes at creation are only stale-review checks. */
export const sq1Options = query({
  args: { senderId: v.id("emailAccounts"), launchId: v.id("sequenceLaunches") },
  handler: async (ctx, args) => {
    const user = await ownerSession(ctx, await getCurrentUser(ctx));
    if (!user) return null;
    const account = await ownMailbox(ctx, user, args.senderId), link = account ? await mailboxLinkHash(account) : null;
    const set = await readSq1TemplateSet(ctx, user.orgId, args.launchId, [user._id]);
    if (!account || !link || !set || !set.launch.approvedSenderRefs.includes(account._id)) return null;
    return { senderId: account._id, address: account.address, mailboxLinkHash: link, moduleId: set.launch.moduleId,
      template: { kind: "sq1.template-set.v1" as const, launchId: set.launch._id, hash: set.launch.templateSetHash }, templates: set.preview };
  },
});

export const createSq1Set = mutation({
  args: { senderId: v.id("emailAccounts"), launchId: v.id("sequenceLaunches"), maxPerDay: v.number(), expiresAt: v.number(), expectSetHash: v.string(), expectMailboxLinkHash: v.string() },
  handler: async (ctx, args) => {
    const user = await ownerSession(ctx, await requireUser(ctx));
    if (!user) throw new ConvexError("Use your own signed-in account outside a preview to manage mailbox grants.");
    const account = await ownMailbox(ctx, user, args.senderId), link = account ? await mailboxLinkHash(account) : null;
    const set = await readSq1TemplateSet(ctx, user.orgId, args.launchId, [user._id]);
    if (!account || !link || !set || !set.launch.approvedSenderRefs.includes(account._id)) throw new ConvexError("Choose your own approved connected mailbox and a visible canonical launch.");
    if (link !== args.expectMailboxLinkHash || set.launch.templateSetHash !== args.expectSetHash) throw new ConvexError("The mailbox or canonical template set changed. Review it again.");
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(args.maxPerDay) || args.maxPerDay < 1 || args.maxPerDay > MAILBOX_GRANT_MAX_PER_DAY
      || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now || args.expiresAt - now > MAILBOX_GRANT_MAX_DAYS * MAILBOX_GRANT_DAY_MS) throw new ConvexError("Choose a daily cap from 1 to 100 and a future expiry within 90 days.");
    const key = await mailboxGrantKey();
    if (!key) throw new ConvexError("Mailbox grants cannot be signed on this deployment yet.");
    const terms = { version: 1 as const, orgId: user.orgId, moduleId: set.launch.moduleId, ownerId: user._id, senderId: account._id, mailboxLinkHash: link,
      template: { kind: "sq1.template-set.v1" as const, launchId: set.launch._id, hash: set.launch.templateSetHash }, maxPerDay: args.maxPerDay, expiresAt: args.expiresAt, createdAt: now };
    const grantId = await ctx.db.insert("mailboxSendGrants", { ...terms, signature: "" });
    await ctx.db.patch(grantId, { signature: await signMailboxGrant({ ...terms, grantId }, key) });
    return { grantId };
  },
});

/** Revocation remains available after a connection pauses or a template disappears. Ownership still must match. */
export const revoke = mutation({
  args: { grantId: v.id("mailboxSendGrants") },
  handler: async (ctx, args) => {
    const user = await ownerSession(ctx, await requireUser(ctx));
    if (!user) throw new ConvexError("Use your own signed-in account outside a preview to manage mailbox grants.");
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.orgId !== user.orgId || grant.ownerId !== user._id || !(await ownMailbox(ctx, user, grant.senderId))) throw new ConvexError("Only this mailbox's owner can revoke its grant.");
    if (grant.revokedAt === undefined) await ctx.db.patch(grant._id, { revokedAt: Date.now(), revokedBy: user._id });
    return null;
  },
});
