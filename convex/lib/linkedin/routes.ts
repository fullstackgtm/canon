import type { HttpRouter } from "convex/server";
import { internal } from "../../_generated/api";
import { httpAction } from "../../_generated/server";
import { ingestLinkedinChat } from "../../conversationActions";
import { finishEmailConnect } from "../../emailActions";
import { finishConnect } from "../../linkedinActions";
import { unipileEnv } from "../providers/linkedin";
import { mailEventOf } from "../conversations/email";
import { EMAIL_NOTIFY_PATH } from "../email/state";
import { emailReplyOf, linkedinMessageOf, linkedinReplyOf } from "./inbound";
import { NOTIFY_PATH, WEBHOOK_PATH_PREFIX, webhookTokenMatches } from "./state";
import { accountStatusEvent, notifyEvent } from "./unipile";

const MAX_BODY_BYTES = 64_000;

async function jsonBody(request: Request): Promise<unknown | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Unipile's calls into Canon (docs/linkedin-cadences.md):
 * - POST /linkedin/unipile/notify: the hosted login finished. Trusted only
 *   through the signed state in `name` and a read-back of the account.
 * - POST /email/unipile/notify: the same, for a linked Gmail account.
 * - POST /linkedin/unipile/webhook/<token>: account status changes, LinkedIn
 *   messages, and received and sent mail. The token is derived from Canon's
 *   Unipile key; a wrong one gets 404. A message's or an email's text is kept
 *   only for an account whose owner turned on conversation intake
 *   (convex/conversations.ts).
 * Bodies are never logged.
 */
export function registerLinkedinRoutes(http: HttpRouter) {
  http.route({
    path: NOTIFY_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!unipileEnv()) return Response.json({ error: "not configured" }, { status: 503 });
      const event = notifyEvent(await jsonBody(request));
      if (!event) return Response.json({ error: "bad request" }, { status: 400 });
      const ok = await finishConnect(ctx, event);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "refused" }, { status: 403 });
    }),
  });

  // The same callback for a linked Gmail account, trusted the same way (docs/gmail-sending.md).
  http.route({
    path: EMAIL_NOTIFY_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!unipileEnv()) return Response.json({ error: "not configured" }, { status: 503 });
      const event = notifyEvent(await jsonBody(request));
      if (!event) return Response.json({ error: "bad request" }, { status: 400 });
      const ok = await finishEmailConnect(ctx, event);
      return ok ? Response.json({ ok: true }) : Response.json({ error: "refused" }, { status: 403 });
    }),
  });

  http.route({
    pathPrefix: WEBHOOK_PATH_PREFIX,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const env = unipileEnv();
      if (!env) return Response.json({ error: "not configured" }, { status: 503 });
      const token = new URL(request.url).pathname.slice(WEBHOOK_PATH_PREFIX.length);
      if (!(await webhookTokenMatches(env.apiKey, token))) return Response.json({ error: "not found" }, { status: 404 });
      const body = await jsonBody(request);
      const event = accountStatusEvent(body);
      // One webhook URL serves every source on Canon's key: account status, LinkedIn messages and received mail.
      const reply = linkedinReplyOf(body);
      if (reply) {
        await ctx.runMutation(internal.linkedinWorker.inboundReply, {
          unipileAccountId: reply.accountId, senderProviderId: reply.senderProviderId, chatId: reply.chatId, messageId: reply.messageId, ...(reply.at ? { at: reply.at } : {}),
        });
      }
      // Conversation intake, after the reply above, so a cadence reply already on the timeline is not logged twice.
      const message = linkedinMessageOf(body);
      const intake = message && (await ctx.runQuery(internal.conversations.intakeAccount, { unipileAccountId: message.accountId }));
      if (message && intake) {
        const { providerId, name, profileUrl } = message.counterpart;
        await ingestLinkedinChat(ctx, intake, {
          chatId: message.chatId,
          counterpart: { providerId, ...(name ? { name } : {}), ...(profileUrl ? { profileUrl } : {}) },
          messages: [{ messageId: message.messageId, direction: message.direction, at: message.at ?? Date.now(), from: message.from, text: message.text }],
        }).catch(() => console.warn("LinkedIn intake failed for one message; the daily reconcile reads it again."));
      }
      // Email intake (CI2): received and sent mail of an inbox whose owner opted in, read in full by id.
      const mailEvent = mailEventOf(body);
      if (mailEvent && (await ctx.runQuery(internal.conversations.emailIntakeAccount, { unipileAccountId: mailEvent.accountId }))) {
        await ctx.scheduler.runAfter(0, internal.conversationActions.ingestEmail, { unipileAccountId: mailEvent.accountId, emailId: mailEvent.emailId });
      }
      const mail = emailReplyOf(body);
      if (mail) {
        await ctx.scheduler.runAfter(0, internal.emailActions.receive, {
          unipileAccountId: mail.accountId, from: mail.from, subject: mail.subject, body: mail.body, messageId: mail.messageId,
          ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}), ...(mail.at ? { at: mail.at } : {}),
        });
      }
      if (event) {
        await ctx.runMutation(internal.linkedin.applyStatus, { unipileAccountId: event.accountId, message: event.message });
        await ctx.runMutation(internal.emailAccounts.applyStatus, { unipileAccountId: event.accountId, message: event.message });
      }
      return Response.json({ ok: true });
    }),
  });
}
