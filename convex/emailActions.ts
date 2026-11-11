/**
 * Gmail and Outlook through Unipile (docs/gmail-sending.md): link an account on
 * Unipile's hosted Google or Microsoft login, and send one email to a contact from it. Canon's
 * Unipile key goes nowhere but the X-API-KEY header (lib/linkedin/unipile.ts).
 *
 * A local stack shares Canon's Unipile key, so it never sends real email: it
 * sends only from the seeded `local-` account (devSeed.seedGmailAccount), and
 * that send never leaves Canon.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { readReceived } from "./lib/email/replies";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { bodyHtml, composeProblem } from "./lib/email/compose";
import { EMAIL_NOTIFY_PATH, EMAIL_STATE_TTL_MS, signEmailState, verifyEmailState } from "./lib/email/state";
import { createUnipileClient, UnipileError, type UnipileClient } from "./lib/linkedin/unipile";
import { convexSiteUrl, isLoopback, siteUrl } from "./linkedinActions";
import { DSN_SHAPE, unipileEnv } from "./lib/providers/linkedin";
import { callerClient, principalClient, requireCaller } from "./records";

function clientOrThrow(): { client: UnipileClient; apiKey: string } {
  const env = unipileEnv();
  if (!env) throw new ConvexError("Email isn't set up on this deployment yet (UNIPILE_API_KEY and UNIPILE_DSN).");
  if (!DSN_SHAPE.test(env.dsn)) throw new ConvexError("UNIPILE_DSN must be the host and port from Unipile's dashboard, like api8.unipile.com:13851.");
  return { client: createUnipileClient(env), apiKey: env.apiKey };
}

/** A local stack: its Convex site is a loopback address. */
const isLocalStack = () => isLoopback(convexSiteUrl());

/** Unipile's hosted-login provider for each mailbox Canon links (developer.unipile.com/reference/hostedcontroller_requestlink). */
const HOSTED_PROVIDER = { google: "GOOGLE", microsoft: "OUTLOOK" } as const;
const PROVIDER_NAME = { google: "Google", microsoft: "Microsoft" } as const;

/** Start linking a Gmail or Outlook account: returns Unipile's hosted Google or Microsoft login URL. */
export const startConnect = action({
  args: { provider: v.optional(v.union(v.literal("google"), v.literal("microsoft"))) },
  handler: async (ctx, args): Promise<{ url: string | null }> => {
    const provider = args.provider ?? "google";
    if (!integrationEnabled("unipile")) return { url: null };
    const caller: { orgId: Id<"organizations">; userId: Id<"users"> } | null = await ctx.runQuery(internal.emailAccounts.caller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (isLocalStack()) throw new ConvexError("Local stacks never link a real mailbox. Run devSeed:seedGmailAccount for a stand-in.");
    const { client, apiKey } = clientOrThrow();
    const now = Date.now();
    const state = await signEmailState(apiKey, { userId: caller.userId, orgId: caller.orgId, expiresAt: now + EMAIL_STATE_TTL_MS });
    const back = `${siteUrl()}/dashboard/integrations`;
    try {
      const url = await client.hostedLink({
        name: state,
        provider: HOSTED_PROVIDER[provider],
        notifyUrl: `${convexSiteUrl()}${EMAIL_NOTIFY_PATH}`,
        successUrl: `${back}?gmail=connected`,
        failureUrl: `${back}?gmail=failed`,
        expiresAt: new Date(now + EMAIL_STATE_TTL_MS),
      });
      return { url };
    } catch (cause) {
      if (cause instanceof UnipileError) throw new ConvexError(`Couldn't start the ${PROVIDER_NAME[provider]} login: ${cause.message}`);
      throw cause;
    }
  },
});

/**
 * The notify callback's work: verify the state, read the account back from
 * Unipile (so a forged id, or a non-Google account, is refused), bind it, and
 * make sure the account-status webhook is registered.
 */
export async function finishEmailConnect(ctx: ActionCtx, event: { accountId: string; name: string }): Promise<boolean> {
  const { client, apiKey } = clientOrThrow();
  const state = await verifyEmailState(apiKey, event.name, Date.now());
  if (!state) return false;
  const account = await client.getMailAccount(event.accountId);
  if (!account) return false;
  const { ok } = await ctx.runMutation(internal.emailAccounts.connected, {
    userId: state.userId as Id<"users">,
    orgId: state.orgId as Id<"organizations">,
    unipileAccountId: account.id,
    provider: account.provider,
    address: account.address,
    displayName: account.name,
    status: account.status,
  });
  if (ok) await ctx.scheduler.runAfter(0, internal.linkedinActions.ensureWebhooks, {});
  return ok;
}

/** Why Unipile refused a send, in words for the user. Never the response body. */
function sendError(cause: unknown): string {
  if (!(cause instanceof UnipileError)) return "Couldn't reach your mailbox. Nothing was sent; try again.";
  if (cause.status === 401 || cause.status === 403) return "Your mailbox refused the send. Link the account again on the Integrations page.";
  if (cause.status === 429) return "Your mailbox is rate limiting this account. Try again later.";
  if (cause.status === 422) return `Your mailbox rejected the email (${cause.type ?? "invalid"}).`;
  return cause.message;
}

/** Send one email to a contact from one of the caller's linked Gmail or Outlook accounts. The contact's address is read from Canon, not taken from the client. */
export const sendToContact = action({
  args: { accountId: v.id("emailAccounts"), contactId: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await requireCaller(ctx);
    const contact = await callerClient(ctx, caller).getContact(caller.orgId, args.contactId);
    if (!contact) throw new ConvexError("Contact not found");
    const to = contact.email?.trim().toLowerCase() ?? null;
    const subject = args.subject.trim();
    const problem = composeProblem({ to, subject, body: args.body });
    if (problem || !to) throw new ConvexError(problem ?? "This contact has no email address.");

    const { sendId, account } = await ctx.runMutation(internal.emailAccounts.claimSend, {
      userId: caller.userId as Id<"users">,
      orgId: caller.orgId as Id<"organizations">,
      accountId: args.accountId,
      contactId: args.contactId,
      to,
      subject,
    });
    const body = args.body.replace(/\r\n?/g, "\n").trim();
    let providerId: string | null = null;
    try {
      if (account.unipileAccountId.startsWith("local-")) {
        // The seeded stand-in: a local stack records the send and nothing leaves Canon.
        if (!isLocalStack()) throw new ConvexError("A stand-in account can't send from a deployed site.");
        providerId = `local-${sendId}`;
      } else {
        if (isLocalStack()) throw new ConvexError("Local stacks never send real email.");
        ({ providerId } = await clientOrThrow().client.sendEmail(account.unipileAccountId, {
          to: { address: to, ...(contact.fullName ? { name: contact.fullName } : {}) },
          subject,
          html: bodyHtml(body),
          idempotencyKey: sendId,
        }));
      }
    } catch (cause) {
      const error = cause instanceof ConvexError ? String(cause.data) : sendError(cause);
      await ctx.runMutation(internal.emailAccounts.finishSend, { sendId, ok: false, error, body });
      throw new ConvexError(error);
    }
    await ctx.runMutation(internal.emailAccounts.finishSend, { sendId, ok: true, body, ...(providerId ? { providerId } : {}) });
    return { ok: true };
  },
});

/**
 * Save one email to the contact as a draft in the user's linked Gmail, to finish and send from Gmail. Nothing is
 * sent and nothing goes on the timeline: Canon sees the email only if it's sent from Canon.
 */
export const draftToContact = action({
  args: { accountId: v.id("emailAccounts"), contactId: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; address: string }> => {
    const caller = await requireCaller(ctx);
    const contact = await callerClient(ctx, caller).getContact(caller.orgId, args.contactId);
    if (!contact) throw new ConvexError("Contact not found");
    const to = contact.email?.trim().toLowerCase() ?? null;
    const subject = args.subject.trim();
    const problem = composeProblem({ to, subject, body: args.body });
    if (problem || !to) throw new ConvexError(problem ?? "This contact has no email address.");
    const account = await ctx.runQuery(internal.emailAccounts.draftAccount, {
      userId: caller.userId as Id<"users">, orgId: caller.orgId as Id<"organizations">, accountId: args.accountId,
    });
    if (account.unipileAccountId.startsWith("local-")) {
      // The seeded stand-in: a local stack pretends the draft was saved and nothing leaves Canon.
      if (!isLocalStack()) throw new ConvexError("A stand-in account can't save drafts from a deployed site.");
      return { ok: true, address: account.address };
    }
    if (isLocalStack()) throw new ConvexError("Local stacks never write to a real mailbox.");
    try {
      await clientOrThrow().client.createDraft(account.unipileAccountId, {
        to: { address: to, ...(contact.fullName ? { name: contact.fullName } : {}) },
        subject,
        html: bodyHtml(args.body.replace(/\r\n?/g, "\n").trim()),
      });
    } catch (cause) {
      throw new ConvexError(cause instanceof ConvexError ? String(cause.data) : sendError(cause));
    }
    return { ok: true, address: account.address };
  },
});

/**
 * An email received in a linked inbox (Unipile webhook, DP4; G2 in docs/gmail-sending.md): a reply, an auto-reply or a
 * bounce notice (lib/email/replies.ts). It is logged, without its text, on the one contact the inbox's owner can see
 * whose address sent it, or for a bounce the address that bounced. A reply the words can't place goes to the owner's
 * ChatGPT plan; a deal's play reads a real reply. Anyone else's mail is ignored here; conversation intake
 * (conversationActions.ingestEmail) reads it, with its text, for an inbox whose owner opted in.
 */
export const receive = internalAction({
  args: {
    unipileAccountId: v.string(), from: v.string(), subject: v.string(), body: v.optional(v.string()), inReplyTo: v.optional(v.string()),
    messageId: v.string(), at: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const inbox = await ctx.runQuery(internal.emailAccounts.byUnipileId, { unipileAccountId: args.unipileAccountId });
    if (!inbox) return false;
    const owner = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: inbox.orgId, userId: inbox.userId });
    if (!owner) return false;
    const read = readReceived({ from: args.from, subject: args.subject, body: args.body ?? "", inbox: inbox.address, now: Date.now() });
    const address = read.kind === "bounce" ? read.bounce.recipient : args.from;
    if (!address) return false;
    // Read as the inbox's owner (CP14): mail about someone they can't see stays unlogged.
    const rows = (await principalClient(ctx, inbox.orgId, [owner.access]).listRegister(inbox.orgId, "contact", {
      filter: [{ field: "email", op: "eq", value: address }], limit: 2,
    })).rows;
    if (rows.length !== 1) return false;
    const cls = read.kind !== "reply" ? null
      : read.askModel ? await ctx.runAction(internal.emailReplyActions.classify, { userId: inbox.userId, subject: args.subject, body: read.body }).catch(() => null) : read.class;
    return ctx.runMutation(internal.emailAccounts.logReceived, {
      orgId: inbox.orgId, userId: inbox.userId, contactId: rows[0].id, from: args.from, to: inbox.address,
      subject: args.subject, messageId: args.messageId, at: args.at ?? Date.now(),
      reply: read.kind,
      ...(cls ? { class: cls } : {}), ...(read.kind === "auto_reply" ? { returnOn: read.auto.returnOn } : {}),
      ...(read.kind === "bounce" ? { hardBounce: read.bounce.hard, ...(read.bounce.status ? { bounceStatus: read.bounce.status } : {}) } : {}),
      ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
    });
  },
});
