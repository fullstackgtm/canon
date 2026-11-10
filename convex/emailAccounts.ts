/**
 * Gmail accounts users link through Unipile's hosted login, and the emails
 * they send from them (docs/gmail-sending.md). A user may link several; only
 * the owner sends from an account. Canon stores only Unipile's account id.
 * The Unipile calls are in convex/emailActions.ts.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { callerOutreachPurpose, suppressionFor } from "./lib/suppressions/store";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser, userBelongsToOrg } from "./lib";
import { DAILY_SEND_CAP } from "./lib/email/compose";
import { readMailboxDailyCapacity } from "./lib/outbound/mailboxCapacity";
import { statusFromUnipile } from "./lib/linkedin/unipile";
import { appendObservations } from "./observations";
import { emailMessageKey, emailReceivedKey } from "./lib/conversations/intake";
import { intakeView } from "./lib/conversations/intakeJob";

const ACCOUNTS_MAX = 50;

/** Whether Canon's Unipile key is set on this deployment. */
const configured = () => integrationEnabled("unipile");

async function ownAccounts(ctx: QueryCtx, userId: Id<"users">, orgId: Id<"organizations">) {
  const rows = await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).take(ACCOUNTS_MAX);
  return rows.filter((r) => r.orgId === orgId);
}

/** The caller's linked Gmail accounts in this org. Never the Unipile id. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const rows = (await ownAccounts(ctx, user._id, user.orgId)).filter((r) => r.status !== "disconnected");
    const accounts = await Promise.all(rows.map(async (r) => ({
      _id: r._id,
      address: r.address,
      displayName: r.displayName ?? null,
      status: r.status,
      statusReason: r.statusReason ?? null,
      connectedAt: r.connectedAt,
      sentLastDay: (await readMailboxDailyCapacity(ctx, r._id, now)).count,
      // Conversation intake (convex/conversations.ts): whether Canon reads this inbox, and whether any mail is stored.
      intake: await intakeView(ctx, r),
    })));
    return { configured: configured(), dailyCap: DAILY_SEND_CAP, accounts };
  },
});

export const disconnect = mutation({
  args: { accountId: v.id("emailAccounts") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.accountId);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("Gmail account not found");
    if (row.userId !== user._id && !can(user, "shared.moderate")) throw new ConvexError(refusal("shared.moderate"));
    if (row.status === "disconnected") return;
    await ctx.db.patch(row._id, { status: "disconnected", statusReason: "Unlinked in Canon", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.linkedinActions.deleteRemote, { unipileAccountId: row.unipileAccountId });
  },
});

// ───────────────────────────── Internal ─────────────────────────────

export const caller = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? { orgId: user.orgId, userId: user._id } : null;
  },
});

/**
 * Unipile's notify callback, after verifying Canon's signed state: bind the
 * account to the user who started the link. An account bound to someone else
 * is refused. Linking an address again replaces its old Unipile account,
 * which is then removed from Unipile.
 */
export const connected = internalMutation({
  args: {
    userId: v.id("users"),
    orgId: v.id("organizations"),
    unipileAccountId: v.string(),
    address: v.string(),
    displayName: v.union(v.string(), v.null()),
    status: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || !(await userBelongsToOrg(ctx, user, args.orgId))) return { ok: false };
    const bound = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    if (bound && (bound.userId !== args.userId || bound.orgId !== args.orgId)) return { ok: false };
    const now = Date.now();
    const fresh = {
      unipileAccountId: args.unipileAccountId,
      address: args.address,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      status: statusFromUnipile(args.status, "ok"),
      statusReason: undefined,
      updatedAt: now,
    };
    const existing = bound ?? (await ownAccounts(ctx, args.userId, args.orgId)).find((r) => r.address === args.address);
    if (existing) {
      if (existing.unipileAccountId !== args.unipileAccountId && existing.status !== "disconnected") {
        await ctx.scheduler.runAfter(0, internal.linkedinActions.deleteRemote, { unipileAccountId: existing.unipileAccountId });
      }
      await ctx.db.patch(existing._id, {
        ...fresh,
        // Consent to read the inbox was given before it was unlinked: linking it again asks again.
        ...(existing.status === "disconnected"
          ? { connectedAt: now, ingest: undefined, ingestSince: undefined, ingestBackfillCursor: undefined, ingestBackfilledAt: undefined, ingestSyncedAt: undefined }
          : {}),
      });
      return { ok: true };
    }
    await ctx.db.insert("emailAccounts", { orgId: args.orgId, userId: args.userId, provider: "google", ...fresh, connectedAt: now });
    return { ok: true };
  },
});

/** Unipile's account-status webhook (shared with LinkedIn): pause, resume or ask for a new login. */
export const applyStatus = internalMutation({
  args: { unipileAccountId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    if (!row) return;
    const status = statusFromUnipile(args.message, row.status);
    if (status === row.status) return;
    const reason =
      status === "credentials" ? "Google needs you to sign in again." : status === "paused" ? `Gmail connection stopped (${args.message.toUpperCase()}).` : undefined;
    await ctx.db.patch(row._id, { status, statusReason: reason, updatedAt: Date.now() });
  },
});

/**
 * Claim one send before calling Unipile: the account must be the caller's and
 * connected, and under its daily cap. The claimed row counts toward the cap,
 * so two sends at once can't both pass the last slot.
 */
export const claimSend = internalMutation({
  args: {
    userId: v.id("users"),
    orgId: v.id("organizations"),
    accountId: v.id("emailAccounts"),
    contactId: v.string(),
    to: v.string(),
    subject: v.string(),
  },
  handler: async (ctx, args): Promise<{ sendId: Id<"emailSends">; account: Pick<Doc<"emailAccounts">, "unipileAccountId" | "address"> }> => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId || account.userId !== args.userId || account.status === "disconnected") {
      throw new ConvexError("Pick one of your own linked Gmail accounts.");
    }
    if (account.status !== "ok") throw new ConvexError(account.statusReason ?? `${account.address} can't send right now. Link it again on the Integrations page.`);
    const suppressed = (await suppressionFor(ctx, args.orgId, { email: args.to }, await callerOutreachPurpose(ctx))).email;
    if (suppressed.blocked) throw new ConvexError({ code: suppressed.code, message: suppressed.text });
    const now = Date.now();
    if ((await readMailboxDailyCapacity(ctx, account._id, now)).count >= DAILY_SEND_CAP) {
      throw new ConvexError(`${account.address} has sent ${DAILY_SEND_CAP} emails in the last 24 hours, Canon's cap. Try again later.`);
    }
    const sendId = await ctx.db.insert("emailSends", {
      orgId: args.orgId, accountId: account._id, userId: args.userId, contactId: args.contactId, to: args.to, subject: args.subject, state: "sending", at: now,
    });
    return { sendId, account: { unipileAccountId: account.unipileAccountId, address: account.address } };
  },
});

/** One of the caller's own linked inboxes that can take a draft: the same ownership and status rules as a send, no daily cap. */
export const draftAccount = internalQuery({
  args: { userId: v.id("users"), orgId: v.id("organizations"), accountId: v.id("emailAccounts") },
  handler: async (ctx, args): Promise<Pick<Doc<"emailAccounts">, "unipileAccountId" | "address">> => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== args.orgId || account.userId !== args.userId || account.status === "disconnected") {
      throw new ConvexError("Pick one of your own linked Gmail accounts.");
    }
    if (account.status !== "ok") throw new ConvexError(account.statusReason ?? `${account.address} can't take drafts right now. Link it again on the Integrations page.`);
    return { unipileAccountId: account.unipileAccountId, address: account.address };
  },
});

/** Record how a claimed send ended. A sent email goes on the contact's timeline with its exact text. */
export const finishSend = internalMutation({
  args: {
    sendId: v.id("emailSends"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    providerId: v.optional(v.string()),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const send = await ctx.db.get(args.sendId);
    if (!send || send.state !== "sending" || send.outboxAttempt) return;
    if (!args.ok) {
      await ctx.db.patch(send._id, { state: "failed", error: args.error ?? "Send failed" });
      return;
    }
    await ctx.db.patch(send._id, { state: "sent", ...(args.providerId ? { providerId: args.providerId } : {}) });
    const account = await ctx.db.get(send.accountId);
    await appendObservations(ctx, send.orgId, { object: "contact", contactId: send.contactId }, { kind: "user", ref: send.userId }, [{
      observedAt: Date.now(),
      body: {
        type: "email",
        key: `email:${send._id}`,
        event: { kind: "sent", userId: send.userId, from: account?.address ?? "", to: send.to, subject: send.subject, body: args.body },
      },
    }]);
  },
});

/** The linked inbox a received email landed in, for the inbound webhook (DP4). */
export const byUnipileId = internalQuery({
  args: { unipileAccountId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    return row && row.status !== "disconnected" ? { orgId: row.orgId, userId: row.userId, address: row.address } : null;
  },
});

/**
 * Log an email received in a user's linked inbox on the contact it is about, once per message: a reply (with its
 * class), an auto-reply (with the day they're back) or a bounce notice for their address. An interested reply is a
 * hot lead too; only a real reply wakes the contact's deal plays. No text is kept here (CI2): conversation intake
 * keeps it for an inbox whose owner turned it on, behind the owner's permission check. An email intake already put
 * on the timeline (`email:msg:<id>`) is not logged again; its reply still wakes the plays.
 */
export const logReceived = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), contactId: v.string(), from: v.string(), to: v.string(), subject: v.string(), messageId: v.string(), at: v.number(),
    body: v.optional(v.string()), reply: v.optional(v.union(v.literal("reply"), v.literal("auto_reply"), v.literal("bounce"))),
    class: v.optional(v.union(v.literal("interested"), v.literal("not_now"), v.literal("not_interested"), v.literal("unsubscribe"))),
    returnOn: v.optional(v.string()), bounceStatus: v.optional(v.string()), hardBounce: v.optional(v.boolean()), inReplyTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const logged = (key: string) => ctx.db.query("observations")
      .withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", args.orgId).eq("subject.contactId", args.contactId).eq("body.key", key)).first();
    const key = emailReceivedKey(args.messageId);
    if (await logged(key)) return false;
    const { orgId, userId, contactId, from, to, subject, body: _b, messageId: _m, at, ...detail } = args;
    const occurredAt = Math.min(at, Date.now());
    if (!(await logged(emailMessageKey(args.messageId)))) {
      await appendObservations(ctx, orgId, { object: "contact", contactId }, { kind: "pipeline", ref: "email" }, [
        { observedAt: Date.now(), occurredAt, body: { type: "email", key, event: { kind: "received", userId, from, to, subject, body: "", ...detail } } },
        ...(args.class === "interested" ? [{ observedAt: Date.now(), occurredAt, body: { type: "hot_lead" as const, key: `gmail:${args.messageId}`, provider: "gmail" as const, userId, reply: "" } }] : []),
      ]);
    }
    if ((args.reply ?? "reply") === "reply") await ctx.scheduler.runAfter(0, internal.dealPlayKeeper.onReply, { orgId, contactId });
    return true;
  },
});
