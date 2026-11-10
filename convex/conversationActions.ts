/**
 * Conversation intake's Unipile reads (docs/conversation-intake.md): matching a LinkedIn chat's (CI1) or an email
 * thread's (CI2) counterpart to a contact, and the 90-day backfill and daily reconcile of an account. The webhook
 * route (lib/linkedin/routes.ts) stores live LinkedIn messages through the same `ingestLinkedinChat`, and live mail
 * through `ingestEmail`.
 *
 * The LinkedIn backfill reads a few chats per step and waits a random 45-180 s between steps, the cadence worker's
 * gap, so reading never bursts on the account. A chat longer than a step's pages is read on from its own cursor at
 * the next step. LinkedIn's pushback (HTTP 429, or a hold on the account) pauses it. The mail backfill reads a page of
 * mail per step a few seconds apart.
 */
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { BackfillStep, EmailIntakeAccount, IntakeAccount } from "./conversations";
import { unipileEnv } from "./linkedinActions";
import { principalClient } from "./records";
import { teamOf, type Team } from "./lib/calls/suggestions";
import { intakeMailOf, mailVerdict, type IntakeMail, type MailPerson } from "./lib/conversations/email";
import { contactBySlug, slugOf } from "./lib/conversations/intake";
import { MESSAGE_TEXT_MAX } from "./lib/linkedin/inbound";
import { createUnipileClient, UnipileError, type UnipileClient } from "./lib/linkedin/unipile";

const CHATS_PER_STEP = 5;
/** Pages of 100 messages read per chat in one step; a longer chat is read on at the next step. */
const MESSAGE_PAGES = 3;
const MAILS_PER_STEP = 50;
/** Addresses on one thread matched to contacts, at most. */
const MATCH_MAX = 50;
const HOUR_MS = 3_600_000;

export type IntakeChat = {
  chatId: string;
  counterpart: { providerId: string; name?: string; publicIdentifier?: string; profileUrl?: string };
  messages: Array<{ messageId: string; direction: "in" | "out"; at: number; from: string; text: string }>;
};

/**
 * The contact a counterpart is: one a cadence of this sender enrolled under their provider id, else the one contact
 * whose LinkedIn URL names their profile, read as the account's owner (CP14), so no one they can't see is matched.
 */
async function matchContact(ctx: ActionCtx, account: IntakeAccount, who: IntakeChat["counterpart"]): Promise<string | null> {
  const enrolled = await ctx.runQuery(internal.conversations.contactForProviderId, { accountId: account.accountId, providerId: who.providerId });
  if (enrolled) return enrolled;
  const slug = slugOf(who.publicIdentifier, who.profileUrl);
  if (!slug) return null;
  const owner = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: account.orgId, userId: account.userId });
  if (!owner) return null;
  const { rows } = await principalClient(ctx, account.orgId, [owner.access]).listRegister(account.orgId, "contact", {
    filter: [{ field: "linkedinUrl", op: "contains", value: `/in/${slug}` }], limit: 5,
  });
  return contactBySlug(slug, rows);
}

/** Match a chat's counterpart and store its messages. Returns how many were new. */
export async function ingestLinkedinChat(ctx: ActionCtx, account: IntakeAccount, chat: IntakeChat): Promise<number> {
  const contactId = await matchContact(ctx, account, chat.counterpart);
  return ctx.runMutation(internal.conversations.storeLinkedin, { accountId: account.accountId, ...chat, ...(contactId ? { contactId } : {}) });
}

const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== null && x !== undefined)) as { [K in keyof T]?: NonNullable<T[K]> };

/**
 * Read up to a step's pages of one chat from `from` and store them. Returns where the chat's next read starts (null
 * when it is read to its end) and whether it held any message since the pass began.
 */
async function readChat(ctx: ActionCtx, client: UnipileClient, account: IntakeAccount, since: number, chat: { id: string; who: { providerId: string; name: string | null; publicIdentifier: string | null; profileUrl: string | null } }, from: string | null): Promise<{ cursor: string | null; read: boolean }> {
  const { messages, cursor } = await client.chatMessages(chat.id, since, MESSAGE_PAGES, from);
  if (messages.length) {
    await ingestLinkedinChat(ctx, account, {
      chatId: chat.id,
      counterpart: { providerId: chat.who.providerId, ...defined({ name: chat.who.name, publicIdentifier: chat.who.publicIdentifier, profileUrl: chat.who.profileUrl }) },
      messages: messages.map((m) => ({ messageId: m.id, direction: m.out ? "out" : "in", at: m.at, from: m.from, text: m.text.slice(0, MESSAGE_TEXT_MAX) })),
    });
  }
  return { cursor, read: messages.length > 0 };
}

/** A failure as the tray's job shows it to the account's owner: short, one sentence. */
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "unknown error").replace(/\.$/, "").slice(0, 200);


/** A Unipile failure as the next step's wait: an hour for pushback, a quarter for Unipile down, none (stop) otherwise. */
const retryOf = (cause: unknown) => {
  const status = cause instanceof UnipileError ? cause.status : 0;
  return status === 429 ? HOUR_MS : status >= 500 ? HOUR_MS / 4 : undefined;
};

/**
 * One step of a LinkedIn account's read: the rest of a chat a step left part-read, or a page of chats active since
 * the pass began, from the first one not yet done. Then the next step is scheduled.
 */
export const backfillLinkedin = internalAction({
  args: { accountId: v.id("linkedinAccounts") },
  handler: async (ctx, args) => {
    const state: BackfillStep = await ctx.runQuery(internal.conversations.backfillState, args);
    const env = unipileEnv();
    if (!state.run || state.channel !== "linkedin" || !env) {
      await ctx.runMutation(internal.conversations.backfillAdvance, { accountId: args.accountId, since: 0, cursor: null, stop: true, ...(env ? {} : { error: "LinkedIn isn't set up on this deployment." }) });
      return;
    }
    const step = { accountId: args.accountId, since: state.since };
    if (state.holdUntil) {
      await ctx.runMutation(internal.conversations.backfillAdvance, { ...step, cursor: state.cursor, retryInMs: state.holdUntil - Date.now() });
      return;
    }
    const client = createUnipileClient(env);
    // What this step read, for the tray: chats with messages since the pass began, and the oldest one's last activity.
    const seen: { read: number; reachedAt?: number } = { read: 0 };
    const saw = (read: boolean, at: number | null) => {
      if (read) seen.read += 1;
      if (at !== null) seen.reachedAt = Math.min(seen.reachedAt ?? at, at);
    };
    const stopAt = (resume: { next: number; chat?: { id: string; providerId: string; cursor: string } }) =>
      ctx.runMutation(internal.conversations.backfillAdvance, { ...step, ...seen, cursor: state.cursor, resume });
    try {
      const part = state.resume?.chat;
      if (part) {
        const attendees = await client.chatAttendees(part.id);
        const who = attendees.find((a) => a.providerId === part.providerId) ?? { providerId: part.providerId, name: null, publicIdentifier: null, profileUrl: null };
        const { cursor } = await readChat(ctx, client, state.account, state.since, { id: part.id, who }, part.cursor);
        await stopAt({ next: state.resume!.next, ...(cursor ? { chat: { ...part, cursor } } : {}) });
        return;
      }
      const page = await client.listChats(state.unipileAccountId, { afterMs: state.since, limit: CHATS_PER_STEP, ...(state.cursor ? { cursor: state.cursor } : {}) });
      for (let i = state.resume?.next ?? 0; i < page.items.length; i++) {
        const chat = page.items[i];
        if (!chat.oneToOne || chat.skip) continue;
        const attendees = await client.chatAttendees(chat.id);
        const others = attendees.filter((a) => !a.self);
        const who = attendees.find((a) => a.providerId === chat.attendeeProviderId) ?? (others.length === 1 ? others[0] : null);
        if (!who) continue;
        const { cursor, read } = await readChat(ctx, client, state.account, state.since, { id: chat.id, who: { ...who, name: who.name ?? chat.name } }, null);
        saw(read, chat.at);
        if (cursor) {
          await stopAt({ next: i + 1, chat: { id: chat.id, providerId: who.providerId, cursor } });
          return;
        }
      }
      await ctx.runMutation(internal.conversations.backfillAdvance, { ...step, ...seen, cursor: page.cursor });
    } catch (cause) {
      // Anything but pushback or Unipile down stops the pass where it is, and the daily reconcile resumes it.
      const retryInMs = retryOf(cause);
      await ctx.runMutation(internal.conversations.backfillAdvance, { ...step, ...seen, cursor: state.cursor, ...(retryInMs ? { retryInMs } : { stop: true, error: `LinkedIn reading stopped: ${errorText(cause)}.` }) });
      if (!retryInMs) console.warn(`LinkedIn intake backfill stopped: ${errorText(cause)}`);
    }
  },
});

// ───────────────────────────── Email (CI2) ─────────────────────────────

async function teamOfOrg(ctx: ActionCtx, orgId: Id<"organizations">): Promise<Team> {
  const { memberEmails, ourTeam } = await ctx.runQuery(internal.conversations.emailTeam, { orgId });
  return teamOf(memberEmails, ourTeam);
}

/** The contacts these addresses are, read as the inbox's owner (CP14): an address with one contact the owner sees, none for several. */
export async function contactsByEmail(ctx: ActionCtx, account: Pick<EmailIntakeAccount, "orgId" | "userId">, emails: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emails.length) return out;
  const owner = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: account.orgId, userId: account.userId });
  if (!owner) return out;
  const { rows } = await principalClient(ctx, account.orgId, [owner.access]).listRegister(account.orgId, "contact", {
    filter: [{ field: "email", op: "in", value: emails.slice(0, MATCH_MAX) }], limit: MATCH_MAX,
  });
  const hits = new Map<string, string[]>();
  for (const r of rows) {
    const email = typeof r.values.email === "string" ? r.values.email.trim().toLowerCase() : null;
    if (email) hits.set(email, [...(hits.get(email) ?? []), r.id]);
  }
  for (const [email, ids] of hits) if (ids.length === 1) out.set(email, ids[0]);
  return out;
}

const addresses = (people: readonly MailPerson[]) => people.map((p) => p.email).join(", ");

/**
 * Store emails intake keeps, one thread at a time: each is checked (lib/conversations/email.ts mailVerdict), its
 * thread's people outside the team are matched to contacts, and the unmatched are kept for suggestions. `live` is a
 * webhook's delivery. Returns how many were new.
 */
export async function ingestMails(ctx: ActionCtx, account: EmailIntakeAccount, team: Team, mails: readonly IntakeMail[], live: boolean): Promise<number> {
  const threads = new Map<string, Array<{ mail: IntakeMail; counterpart: MailPerson & { domain?: string }; participants: MailPerson[] }>>();
  for (const mail of mails) {
    const verdict = mailVerdict(mail, account.address, team);
    if (!verdict.keep) continue;
    const key = mail.threadId ?? `msg:${mail.messageId}`;
    threads.set(key, [...(threads.get(key) ?? []), { mail, counterpart: verdict.counterpart, participants: verdict.participants }]);
  }
  let stored = 0;
  for (const kept of threads.values()) {
    kept.sort((a, b) => a.mail.at - b.mail.at);
    const participants = [...new Map(kept.flatMap((k) => k.participants).map((p) => [p.email, p])).values()];
    const contacts = await contactsByEmail(ctx, account, participants.map((p) => p.email));
    const first = kept[0];
    stored += await ctx.runMutation(internal.conversations.storeEmail, {
      accountId: account.accountId,
      threadId: first.mail.threadId,
      subject: first.mail.subject,
      counterpart: first.counterpart,
      participants,
      contacts: participants.flatMap((p) => { const contactId = contacts.get(p.email); return contactId ? [{ email: p.email, contactId }] : []; }),
      live,
      messages: kept.map(({ mail }) => ({
        messageId: mail.messageId, ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}), direction: mail.direction, at: mail.at,
        from: mail.from.email, to: addresses(mail.recipients), subject: mail.subject, text: mail.text, viaCanon: mail.viaCanon,
      })),
    });
  }
  return stored;
}

/** A mail webhook (`mail_received`, `mail_sent`) for an inbox reading its mail: read the email in full, for its thread and headers, and store it. */
export const ingestEmail = internalAction({
  args: { unipileAccountId: v.string(), emailId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const account = await ctx.runQuery(internal.conversations.emailIntakeAccount, { unipileAccountId: args.unipileAccountId });
    const env = unipileEnv();
    if (!account || !env || account.unipileAccountId.startsWith("local-")) return 0;
    try {
      const raw = await createUnipileClient(env).getEmail(account.unipileAccountId, args.emailId);
      const mail = raw ? intakeMailOf(raw, account.address) : null;
      return mail ? await ingestMails(ctx, account, await teamOfOrg(ctx, account.orgId), [mail], true) : 0;
    } catch (cause) {
      console.warn(`Email intake failed for one email; the daily reconcile reads it again: ${cause instanceof Error ? cause.message : "unknown error"}`);
      return 0;
    }
  },
});

/** One step of an inbox's read: a page of its mail since the pass began, then the next step is scheduled. */
export const backfillEmail = internalAction({
  args: { accountId: v.id("emailAccounts") },
  handler: async (ctx, args) => {
    const state: BackfillStep = await ctx.runQuery(internal.conversations.backfillState, args);
    const env = unipileEnv();
    // The seeded local stand-in has no mailbox to read.
    if (!state.run || state.channel !== "email" || !env || state.unipileAccountId.startsWith("local-")) {
      const error = !env ? "Gmail isn't set up on this deployment." : state.run && state.unipileAccountId.startsWith("local-") ? "This local stand-in inbox has no mail to read." : undefined;
      await ctx.runMutation(internal.conversations.backfillAdvance, { accountId: args.accountId, since: 0, cursor: null, stop: true, ...(error ? { error } : {}) });
      return;
    }
    const step = { accountId: args.accountId, since: state.since };
    try {
      const page = await createUnipileClient(env).listEmails(state.unipileAccountId, { afterMs: state.since, limit: MAILS_PER_STEP, ...(state.cursor ? { cursor: state.cursor } : {}) });
      const mails = page.items.flatMap((raw) => intakeMailOf(raw, state.account.address) ?? []);
      const read = await ingestMails(ctx, state.account, await teamOfOrg(ctx, state.account.orgId), mails, false);
      const reachedAt = mails.length ? Math.min(...mails.map((m) => m.at)) : undefined;
      await ctx.runMutation(internal.conversations.backfillAdvance, { ...step, read, ...(reachedAt === undefined ? {} : { reachedAt }), cursor: page.cursor });
    } catch (cause) {
      const retryInMs = retryOf(cause);
      await ctx.runMutation(internal.conversations.backfillAdvance, { ...step, cursor: state.cursor, ...(retryInMs ? { retryInMs } : { stop: true, error: `Reading this inbox stopped: ${errorText(cause)}.` }) });
      if (!retryInMs) console.warn(`Email intake backfill stopped: ${errorText(cause)}`);
    }
  },
});
