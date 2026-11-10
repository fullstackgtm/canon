/**
 * Logging email by BCC or forward (docs/email-logging.md). Each member has a private address, `log+<token>@` the
 * deployment's EMAIL_LOG_DOMAIN, shown on Settings → Email logging (`mine`, `regenerate`). Mail delivered to it
 * (lib/emailLog/routes.ts, one adapter per delivery format) is logged as the token's member's: stored as an email
 * conversation they own (convex/conversations.ts storeLogged), so it reaches the timeline and Conversations of the
 * people and companies it was with under intake's visibility rules, and nothing it names is created, only suggested.
 * Logging never sends, enrolls or schedules anything.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { credentialMember } from "./lib/membership";
import { integrationEnabled } from "./lib/integrationsAvailable";
import { rateLimitHit } from "./lib/rateLimit";
import { planSuggestions, teamOf } from "./lib/calls/suggestions";
import { domainOfEmail } from "./lib/calls/granola";
import { FREE_EMAIL_DOMAINS } from "../engine/src/freeEmailDomains";
import { addressOf, attributed, participantsOf, tokenOf, newToken, type HoldReason } from "./lib/emailLog/attribute";
import type { ParsedMail } from "./lib/emailLog/mime";
import { contactsByEmail } from "./conversationActions";
import { clientFor } from "./records";

/** Deliveries one address accepts an hour. */
const RATE = { limit: 120, windowMs: 3_600_000 };
/** Mail an address did not log that Settings lists, newest first. */
const HELD_MAX = 10;
const ADDRESSES_MAX = 20;
const INBOXES_MAX = 20;

/** The deployment's logging domain, or null when email logging is off (EMAIL_LOG_DOMAIN or EMAIL_LOG_SECRET unset). */
export const loggingDomain = () => (integrationEnabled("emailLog") ? process.env.EMAIL_LOG_DOMAIN!.trim().toLowerCase() : null);

/** The active member a token names, or null for a revoked or unknown one, or a member who left. */
export async function loggingMember(ctx: QueryCtx, token: string) {
  const row = await ctx.db.query("emailLogAddresses").withIndex("by_token", (q) => q.eq("token", token)).first();
  if (!row || row.revokedAt !== undefined) return null;
  const user = await credentialMember(ctx, await ctx.db.get(row.userId), row.orgId);
  if (!user || user.orgId !== row.orgId) return null;
  return { row, user, orgId: row.orgId, userId: row.userId };
}

const activeRows = async (ctx: QueryCtx, userId: Id<"users">) =>
  // Newest first: `regenerate` revokes every active row, so the one active row is among the latest.
  (await ctx.db.query("emailLogAddresses").withIndex("by_userId", (q) => q.eq("userId", userId)).order("desc").take(ADDRESSES_MAX)).filter((r) => r.revokedAt === undefined);

/** The signed-in member's logging address and the mail it lately held; null when email logging is off. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const domain = loggingDomain();
    const user = domain ? await getCurrentUser(ctx) : null;
    if (!domain || !user) return null;
    const [row] = await activeRows(ctx, user._id);
    return { address: row && row.orgId === user.orgId ? addressOf(row.token, domain) : null, createdAt: row?.createdAt ?? null, held: row?.held ?? [] };
  },
});

/** Make the signed-in member's logging address, or replace it: mail to the old one is refused from now on. */
export const regenerate = mutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const domain = loggingDomain();
    if (!domain) throw new ConvexError("Email logging isn't set up on this deployment");
    const user = await requireUser(ctx);
    const now = Date.now();
    for (const row of await activeRows(ctx, user._id)) await ctx.db.patch(row._id, { revokedAt: now });
    const token = newToken();
    await ctx.db.insert("emailLogAddresses", { orgId: user.orgId, userId: user._id, token, createdAt: now });
    return addressOf(token, domain);
  },
});

type Admitted = { status: "unknown_address" } | { status: "rate_limited" } | { status: "ok"; orgId: Id<"organizations">; userId: Id<"users">; addresses: string[] };

/**
 * Admit one delivery to a token's address: its member, with their own addresses (their sign-in email and the Gmail
 * inboxes they linked), unless the address is unknown, revoked, or over its hourly allowance.
 */
export const admit = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Admitted> => {
    const member = await loggingMember(ctx, args.token);
    if (!member) return { status: "unknown_address" };
    const bucket = member.row.windowStart === undefined ? null : { windowStart: member.row.windowStart, count: member.row.count ?? 0 };
    const { allowed, next } = rateLimitHit(bucket, Date.now(), RATE);
    if (!allowed) return { status: "rate_limited" };
    await ctx.db.patch(member.row._id, next);
    const inboxes = (await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", member.userId)).take(INBOXES_MAX)).filter((a) => a.orgId === member.orgId);
    return { status: "ok", orgId: member.orgId, userId: member.userId, addresses: [...new Set([member.user.email, ...inboxes.map((a) => a.address)].map((a) => a.toLowerCase()))] };
  },
});

const HOLD_TEXT: Record<HoldReason, string> = {
  not_member: "It was not sent from your own address",
  unreadable_forward: "Canon couldn't tell who the forwarded email was from",
};

/** Note mail the address did not log, for its member's Settings: who it said it was from, its subject, and why. */
export const hold = internalMutation({
  args: { token: v.string(), from: v.string(), subject: v.string(), reason: v.union(v.literal("not_member"), v.literal("unreadable_forward")) },
  handler: async (ctx, args) => {
    const member = await loggingMember(ctx, args.token);
    if (!member) return;
    const entry = { at: Date.now(), from: args.from.slice(0, 200), subject: args.subject.slice(0, 200), reason: HOLD_TEXT[args.reason] };
    await ctx.db.patch(member.row._id, { held: [entry, ...(member.row.held ?? [])].slice(0, HELD_MAX) });
  },
});

export type Delivery = { mail: ParsedMail; recipients: readonly string[]; envelopeFrom?: string | null };
export type Outcome = { status: number; body: { status: string; reason?: string; matched?: number; suggested?: number } };

const people = (list: ReadonlyArray<{ email: string; name?: string }>) =>
  list.map((p) => (!p.name ? p.email : /[,;:"<>@()]/.test(p.name) ? `"${p.name.replace(/"/g, "")}" <${p.email}>` : `${p.name} <${p.email}>`)).join(", ");

/**
 * Log one delivered message: find the address it was sent to, admit it, check it is the member's own mail
 * (lib/emailLog/attribute.ts), match the people outside the team on it to contacts as the member sees them, store
 * it once per workspace, and suggest the people and companies it names that the CRM does not have.
 */
export async function logInbound(ctx: ActionCtx, delivery: Delivery): Promise<Outcome> {
  const domain = loggingDomain();
  if (!domain) return { status: 404, body: { status: "off" } };
  const { mail } = delivery;
  const token = tokenOf([...delivery.recipients, mail.headers.get("delivered-to") ?? "", mail.headers.get("x-original-to") ?? "", ...[...mail.to, ...mail.cc].map((p) => p.email)], domain);
  const admitted: Admitted = token ? await ctx.runMutation(internal.emailLog.admit, { token }) : { status: "unknown_address" };
  if (admitted.status === "unknown_address") return { status: 403, body: { status: "unknown_address" } };
  if (admitted.status === "rate_limited") return { status: 429, body: { status: "rate_limited" } };
  const { orgId, userId } = admitted;
  const { memberEmails, ourTeam } = await ctx.runQuery(internal.conversations.emailTeam, { orgId });
  const team = teamOf(memberEmails, ourTeam);
  const verdict = attributed(mail, { addresses: new Set(admitted.addresses), envelopeFrom: delivery.envelopeFrom }, team, domain, Date.now());
  if ("hold" in verdict) {
    await ctx.runMutation(internal.emailLog.hold, { token: token!, from: mail.from?.email ?? "", subject: mail.subject, reason: verdict.hold });
    return { status: 202, body: { status: "held", reason: verdict.hold } };
  }
  const log = verdict.log;
  const who = participantsOf(log, team, domain);
  if (!who.keep) return { status: 200, body: { status: "skipped", reason: who.reason } };
  const contacts = await contactsByEmail(ctx, { orgId, userId }, who.participants.map((p) => p.email));
  const stored = await ctx.runMutation(internal.conversations.storeLogged, {
    token: token!, fingerprint: log.fingerprint, byFingerprint: !log.ownId, subject: log.subject, counterpart: who.counterpart, participants: who.participants,
    contacts: who.participants.flatMap((p) => { const contactId = contacts.get(p.email); return contactId ? [{ email: p.email, contactId }] : []; }),
    message: {
      messageId: log.messageId, direction: log.direction, at: log.at, from: log.from.email, to: people([...log.to, ...log.cc]), text: log.text,
      logged: log.kind, ...(log.inReplyTo ? { inReplyTo: log.inReplyTo } : {}), references: log.references,
    },
  });
  if (stored.status !== "logged") return { status: stored.status === "duplicate" ? 200 : 403, body: { status: stored.status } };
  const suggested = await suggestUnknown(ctx, { orgId, userId, conversationId: stored.conversationId }, who.participants, contacts);
  return { status: 200, body: { status: "logged", matched: new Set(contacts.values()).size, suggested } };
}

/**
 * The people on a logged email the CRM has no record of, and their companies, as suggestions for the member, the
 * way a meeting's unknown attendees are (lib/calls/suggestions.ts planSuggestions). Someone the member's role hides
 * is in the CRM, so is not suggested.
 */
async function suggestUnknown(ctx: ActionCtx, to: { orgId: Id<"organizations">; userId: Id<"users">; conversationId: Id<"conversations"> }, participants: ReadonlyArray<{ email: string; name?: string }>, matched: ReadonlyMap<string, string>): Promise<number> {
  const unmatched = participants.filter((p) => !matched.has(p.email));
  if (!unmatched.length) return 0;
  const register = clientFor(ctx);
  const emails = unmatched.map((p) => p.email);
  const known = new Set((await register.listRegister(to.orgId, "contact", { filter: [{ field: "email", op: "in", value: emails }], limit: emails.length * 2 })).rows
    .flatMap((r) => (typeof r.values.email === "string" ? [r.values.email.trim().toLowerCase()] : [])));
  const domains = [...new Set(participants.map((p) => domainOfEmail(p.email)).filter((d) => !FREE_EMAIL_DOMAINS.has(d)))];
  const knownDomains = new Set(domains.length ? (await register.listRegister(to.orgId, "account", { filter: [{ field: "domain", op: "in", value: domains }], limit: domains.length * 2 })).rows
    .flatMap((r) => (typeof r.values.domain === "string" ? [r.values.domain.trim().toLowerCase()] : [])) : []);
  const planned = planSuggestions({
    callKey: to.conversationId, attendees: participants.map((p) => ({ email: p.email, name: p.name ?? null })),
    knownEmails: new Set([...matched.keys(), ...known]), knownDomains, meetingDomains: domains, hasDeal: true, recent: true,
    read: { companyNames: {}, titles: {}, opportunity: null },
  });
  return planned.length ? ctx.runMutation(internal.callSuggestions.record, { ...to, suggestions: planned, reason: "suggested" }) : 0;
}
