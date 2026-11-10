/**
 * The outbox as people see it (docs/modules.md, "Outbound"): a module's `outbox` component, Settings > Outbound
 * (which channels each module may use, the Slack channel names and webhook endpoints they lead to, and every row),
 * and how each member wants a module's notices emailed. Sending is convex/outboundDispatch.ts's; queueing is
 * lib/outbound/queue.ts's. A URL or secret an admin enters is stored encrypted and never returned, but a new
 * endpoint's secret is returned once.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { webhookUrlProblem } from "./lib/agents/slack";
import { enabledModules } from "./lib/modules/packages";
import { moduleScope } from "./lib/modules/scope";
import { deliveryMode, providerReady } from "./lib/outbound/adapters";
import { queueWorkspaceEmail, wake } from "./lib/outbound/queue";
import { approveOwnerEmail } from "./lib/outbound/mailboxQueue";
import { boundMailboxRow, isMailboxRow } from "./lib/outbound/mailboxBinding";
import { visibleMailboxRows } from "./lib/outbound/mailboxVisibility";
import { destinationProblem, newSecret } from "./lib/recordWebhooks";
import { encryptForStorage } from "./lib/tokenHelpers";
import { accessFor, roleIn, workspaceMembers } from "./permissions";
import { OUTBOUND_CHANNELS, OUTBOX_ACTIONS, OUTBOX_STATES, type OutboxAction } from "../modules/kernel/outbound.ts";

const ROWS_READ = 200;
const ROWS_SHOWN = 100;
const MAX_TARGETS = 20;
const channelV = v.union(v.literal("email"), v.literal("slack"), v.literal("webhook"));
const stateV = v.union(...OUTBOX_STATES.map((s) => v.literal(s)));

type Row = Doc<"outboundMessages">;
type Viewer = { userId: string; admin: boolean; preview: boolean; human: boolean; owners: ReadonlySet<string> };

/** Who sees a row: an admin every one; a member those they caused (a manager, their team's too), and notices to them. */
async function viewerOf(ctx: QueryCtx, user: Doc<"users"> & { capabilities?: readonly string[] }): Promise<Viewer> {
  const access = await accessFor(ctx, user);
  const admin = access.role === "admin" && !access.preview;
  return { userId: access.userId, admin, preview: Boolean(access.preview), human: !(await agentClientOf(ctx)), owners: new Set(access.role === "manager" ? [...access.teamOwners, access.userId] : [access.userId]) };
}
const owns = (w: Viewer, r: Row) => w.admin || (r.fromUserId !== undefined && w.owners.has(r.fromUserId))
  || !!(r.mailbox?.prepared?.sender?.ownerId && w.owners.has(r.mailbox.prepared.sender.ownerId))
  || !!(r.mailboxRefusal?.sender?.ownerId && w.owners.has(r.mailboxRefusal.sender.ownerId));
const sees = (w: Viewer, r: Row) => owns(w, r) || ("member" in r.to && r.to.member === w.userId);
const mailboxAction = (r: Row, a: OutboxAction, w: Viewer) => {
  if (!isMailboxRow(r)) return true;
  if (!w.human || w.preview || r.claimedAt !== undefined || (r.attempts ?? 0) !== 0 || r.mailbox?.attempt) return false;
  if (a === "cancel") return true;
  return a === "approve" && r.mailbox?.kind === "owner.exact-email.v1" && r.mailbox.prepared.sender.ownerId === w.userId
    && r.mailbox.prepared.validUntil > Date.now();
};

/** A row as a page shows it: who it went to in words, what it says, where it stands and what the reader may do. */
function rowView(r: Row, w: Viewer, names: ReadonlyMap<string, string>, endpoints: ReadonlyMap<string, string>) {
  const to = "slack" in r.to ? `#${r.to.slack}` : "event" in r.to ? `${r.to.event} → ${r.to.endpoint ? endpoints.get(r.to.endpoint) ?? "a removed endpoint" : "no endpoint"}`
    : "member" in r.to ? names.get(r.to.member) ?? "A former member" : r.to.address;
  const may = owns(w, r);
  const actions = Object.fromEntries((Object.keys(OUTBOX_ACTIONS) as OutboxAction[]).map((a) => [a, may && (!isMailboxRow(r) || !w.preview) && mailboxAction(r, a, w) && (OUTBOX_ACTIONS[a] as readonly string[]).includes(r.state)])) as Record<OutboxAction, boolean>;
  return {
    id: r._id, at: r.at, module: r.module ?? null, about: r.about ?? null, template: r.template ?? null, channel: r.channel, kind: r.kind, to,
    subject: r.rendered.subject ?? null, text: r.rendered.text, state: r.state, reason: r.reason ?? null, error: r.error ?? null,
    ownerReview: r.mailbox?.kind === "owner.exact-email.v1" ? { bindingHash: r.mailbox.prepared.bindingHash, purpose: r.mailbox.prepared.purpose,
      senderName: r.mailbox.prepared.sender.name, senderAddress: r.mailbox.prepared.sender.address, recipientAddress: r.mailbox.prepared.recipient.address } : null,
    providerId: r.providerId ?? null, attempts: r.attempts ?? 0, notBefore: r.notBefore, actions,
  };
}

async function labels(ctx: QueryCtx, orgId: Id<"organizations">) {
  const names = new Map((await workspaceMembers(ctx, orgId)).map((u) => [u.id as string, u.name]));
  const endpoints = new Map((await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", orgId).eq("channel", "webhook")).take(MAX_TARGETS)).map((t) => [t._id as string, t.name]));
  return { names, endpoints };
}

/**
 * A module's outbox component: its rows the caller sees, newest first, every one or those a doc caused
 * (`about`: "<collection>/<key>"), in `states`. Null when the module isn't one they can open.
 */
export const outbox = query({
  args: { module: v.string(), about: v.optional(v.string()), states: v.optional(v.array(stateV)) },
  handler: async (ctx, args) => {
    const scope = await moduleScope(ctx, args.module);
    const user = await getCurrentUser(ctx);
    if (!scope || !user) return null;
    const w = await viewerOf(ctx, user);
    const rows = args.about !== undefined
      ? await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_about_and_at", (q) => q.eq("orgId", scope.orgId).eq("module", scope.moduleId).eq("about", args.about)).order("desc").take(ROWS_READ)
      : await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_at", (q) => q.eq("orgId", scope.orgId).eq("module", scope.moduleId)).order("desc").take(ROWS_READ);
    const { names, endpoints } = await labels(ctx, scope.orgId);
    return (await visibleMailboxRows(ctx, rows.filter((r) => sees(w, r) && (!args.states || args.states.includes(r.state)))))
      .slice(0, ROWS_SHOWN).map((r) => rowView(r, w, names, endpoints));
  },
});

/**
 * Approve a row waiting for a person (it queues, and the gate judges it again when it goes), cancel one that hasn't
 * gone, or send a held one now (the gate still decides). Its owner, their manager or an admin.
 */
export const act = mutation({
  args: { id: v.id("outboundMessages"), expectedBindingHash: v.optional(v.string()), action: v.union(v.literal("approve"), v.literal("cancel"), v.literal("sendNow")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("That message isn't in this workspace.");
    const viewer = await viewerOf(ctx, user);
    if (!owns(viewer, row)) throw new ConvexError("Only its sender, their manager or an admin can do that.");
    const mailbox = boundMailboxRow(row);
    if (args.action === "approve" && mailbox?.kind === "owner.exact-email.v1") {
      if (!user.isActive || user.isHidden || await roleIn(ctx, user, row.orgId) === null || viewer.preview || !viewer.human
        || user._id !== mailbox.prepared.sender.ownerId || !args.expectedBindingHash || (await visibleMailboxRows(ctx, [row])).length !== 1) {
        throw new ConvexError("Only the current mailbox owner may approve the exact visible email outside preview.");
      }
      const result = await approveOwnerEmail(ctx, row, user._id, args.expectedBindingHash);
      if (result.state === "refused" || result.state === "suppressed") throw new ConvexError("The exact email changed or is no longer eligible. It was not approved.");
      return null;
    }
    if (args.expectedBindingHash !== undefined) throw new ConvexError("A binding comparison applies only to exact owner approval.");
    if (isMailboxRow(row) && (args.action !== "cancel" || viewer.preview || !viewer.human || !mailboxAction(row, args.action, viewer))) throw new ConvexError("This mailbox row only permits cancellation before its first claim.");
    if (!(OUTBOX_ACTIONS[args.action] as readonly string[]).includes(row.state)) throw new ConvexError(`It is ${row.state.replace("_", " ")}: it can't be ${args.action === "sendNow" ? "sent now" : `${args.action}d`}.`);
    const now = Date.now();
    if (args.action === "cancel") return void (await ctx.db.patch(row._id, { state: "cancelled", decidedBy: user._id }));
    await ctx.db.patch(row._id, { state: "queued", notBefore: now, reason: undefined, ...(args.action === "approve" ? { decidedBy: user._id } : { sendNow: true as const }) });
    await wake(ctx);
  },
});

async function manager(ctx: QueryCtx) {
  const user = await getCurrentUser(ctx);
  return user && can(user, "outbound.manage") ? user : null;
}
async function requireManager(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!can(user, "outbound.manage")) throw new ConvexError(refusal("outbound.manage"));
  return user;
}
const hintOf = (url: string) => { try { const u = new URL(url); return `${u.host}/…${u.pathname.slice(-4)}`; } catch { return "a URL"; } };

/** Settings > Outbound: each module's declared channels and whether they are on, where Slack names and events lead, and the rows. */
export const settings = query({
  args: { module: v.optional(v.string()), state: v.optional(stateV) },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    if (!user) return null;
    const on = new Set((await ctx.db.query("outboundChannels").withIndex("by_orgId_and_moduleId_and_channel", (q) => q.eq("orgId", user.orgId)).take(200)).map((r) => `${r.moduleId}|${r.channel}`));
    const modules = (await enabledModules(ctx, user.orgId)).filter(({ manifest }) => manifest.outbound).map(({ pkg, manifest: m }) => ({
      moduleId: pkg.moduleId, title: m.title,
      channels: OUTBOUND_CHANNELS.filter((c) => m.outbound![c]).map((c) => ({
        channel: c, on: on.has(`${pkg.moduleId}|${c}`),
        names: c === "slack" ? [...m.outbound!.slack!.channels] : c === "webhook" ? [...m.outbound!.webhook!.events] : m.outbound!.email!.kinds.map((k) => `${k} email`),
      })),
    }));
    const targets = (channel: "slack" | "webhook") => ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", user.orgId).eq("channel", channel)).take(MAX_TARGETS);
    const rows = args.module !== undefined
      ? await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_at", (q) => q.eq("orgId", user.orgId).eq("module", args.module)).order("desc").take(ROWS_READ)
      : await ctx.db.query("outboundMessages").withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId)).order("desc").take(ROWS_READ);
    const w = await viewerOf(ctx, user);
    const { names, endpoints } = await labels(ctx, user.orgId);
    return {
      local: deliveryMode() === "sink", emailReady: providerReady("email"), modules,
      slack: (await targets("slack")).map((t) => ({ id: t._id, name: t.name, hint: t.hint })),
      webhooks: (await targets("webhook")).map((t) => ({ id: t._id, name: t.name, events: t.events ?? [], hint: t.hint })),
      rows: (await visibleMailboxRows(ctx, rows.filter((r) => !args.state || r.state === args.state)))
        .slice(0, ROWS_SHOWN).map((r) => rowView(r, w, names, endpoints)),
    };
  },
});

/** Turn a module's channel on or off. Off, its sends are refused when they queue and when they would go. */
export const setChannel = mutation({
  args: { moduleId: v.string(), channel: channelV, on: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireManager(ctx);
    const row = await ctx.db.query("outboundChannels").withIndex("by_orgId_and_moduleId_and_channel", (q) => q.eq("orgId", user.orgId).eq("moduleId", args.moduleId).eq("channel", args.channel)).first();
    if (args.on && !row) await ctx.db.insert("outboundChannels", { orgId: user.orgId, moduleId: args.moduleId, channel: args.channel, enabledBy: user._id, enabledAt: Date.now() });
    if (!args.on && row) await ctx.db.delete(row._id);
  },
});

/** Map a Slack channel name modules post to (`cs-alerts`) to an incoming-webhook URL. A local stack takes a loopback receiver. */
export const mapSlack = mutation({
  args: { name: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const user = await requireManager(ctx);
    const name = args.name.trim().replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(name)) throw new ConvexError("Name it as the module does: lower-case letters, digits, . _ and -.");
    const problem = webhookUrlProblem(args.url, deliveryMode() === "sink");
    if (problem) throw new ConvexError(problem);
    const existing = await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", user.orgId).eq("channel", "slack").eq("name", name)).first();
    const fields = { url: await encryptForStorage(args.url.trim()), hint: hintOf(args.url.trim()) };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("outboundTargets", { orgId: user.orgId, channel: "slack", name, ...fields, createdBy: user._id, createdAt: Date.now() });
  },
});

/** Add a webhook endpoint for module events. Its signing secret comes back once, here, and is stored encrypted. */
export const addWebhook = mutation({
  args: { name: v.string(), url: v.string(), events: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ id: Id<"outboundTargets">; secret: string }> => {
    const user = await requireManager(ctx);
    const problem = destinationProblem(args.url.trim(), deliveryMode() === "sink");
    if (problem) throw new ConvexError(problem);
    const events = [...new Set(args.events.map((e) => e.trim()).filter(Boolean))];
    if (!events.length || events.length > 20 || !events.every((e) => /^[a-z0-9][a-z0-9._-]{0,59}$/.test(e))) throw new ConvexError("Pick 1 to 20 events, named as the modules name them.");
    const name = args.name.trim().slice(0, 60) || hintOf(args.url);
    const secret = newSecret();
    const id = await ctx.db.insert("outboundTargets", {
      orgId: user.orgId, channel: "webhook", name, events, url: await encryptForStorage(args.url.trim()), secret: await encryptForStorage(secret), hint: hintOf(args.url.trim()), createdBy: user._id, createdAt: Date.now(),
    });
    return { id, secret };
  },
});

/** Remove a Slack mapping or a webhook endpoint: what would go there next is refused. */
export const removeTarget = mutation({
  args: { id: v.id("outboundTargets") },
  handler: async (ctx, args) => {
    const user = await requireManager(ctx);
    const t = await ctx.db.get(args.id);
    if (t && t.orgId === user.orgId) await ctx.db.delete(t._id);
  },
});

/** The modules that email their notices, and how the caller wants each: as it happens, a daily digest, or not at all. */
export const emailChoices = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const out = [];
    for (const { pkg, manifest } of await enabledModules(ctx, user.orgId)) {
      if (!manifest.outbound?.email?.kinds.includes("notice")) continue;
      const row = await ctx.db.query("notificationEmail").withIndex("by_orgId_and_userId_and_moduleId", (q) => q.eq("orgId", user.orgId).eq("userId", user._id).eq("moduleId", pkg.moduleId)).first();
      out.push({ moduleId: pkg.moduleId, title: manifest.title, mode: row?.mode ?? "instant" });
    }
    return out;
  },
});

export const setEmailChoice = mutation({
  args: { moduleId: v.string(), mode: v.union(v.literal("instant"), v.literal("digest"), v.literal("off")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.query("notificationEmail").withIndex("by_orgId_and_userId_and_moduleId", (q) => q.eq("orgId", user.orgId).eq("userId", user._id).eq("moduleId", args.moduleId)).first();
    if (row) await ctx.db.patch(row._id, { mode: args.mode, at: Date.now() });
    else await ctx.db.insert("notificationEmail", { orgId: user.orgId, userId: user._id, moduleId: args.moduleId, mode: args.mode, at: Date.now() });
  },
});

/**
 * Canon's own workspace email, for Canon features rather than modules (a deal room's verification code): one notice
 * to a member or an address through the outbox, its gate and its sink. Same `cause` and recipient: queued once.
 */
export const sendWorkspaceEmail = internalMutation({
  args: { orgId: v.id("organizations"), to: v.union(v.object({ member: v.id("users") }), v.object({ address: v.string() })), subject: v.string(), body: v.string(), cause: v.string() },
  handler: async (ctx, args) => {
    const out = await queueWorkspaceEmail(ctx, args);
    return { id: out.id, state: out.state };
  },
});
