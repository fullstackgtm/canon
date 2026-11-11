/**
 * LinkedIn connect through Unipile's hosted login (docs/linkedin-cadences.md,
 * slice L1). The user accepts the risk statement, gets a hosted-login link,
 * logs in on Unipile's page, and Unipile calls /linkedin/unipile/notify with
 * the signed state we gave it (convex/http.ts). Canon's Unipile key is read
 * from the environment and goes nowhere but the X-API-KEY header.
 */

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { LinkedinCaller } from "./linkedin";
import { validTimezone } from "./lib/linkedin/limits";
import { appUrl } from "./lib/operatorConfig";
import { RISK_TEXT_VERSION } from "./lib/linkedin/risk";
import { NOTIFY_PATH, STATE_TTL_MS, WEBHOOK_PATH_PREFIX, signState, verifyState, webhookToken } from "./lib/linkedin/state";
import { UnipileError } from "./lib/linkedin/unipile";
import { linkedinClient, linkedinClientOrThrow, unipileEnv } from "./lib/providers/linkedin";

// The web app's origin: APP_URL, NEXT_PUBLIC_SITE_URL, or the known app for this deployment (dev.canoncrm.com).
export const siteUrl = () => appUrl() ?? "http://localhost:3000";
export const convexSiteUrl = () => (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");

/** Start a connect (or a reconnect of the user's account): returns Unipile's hosted login URL. */
export const startConnect = action({
  args: { acceptRisk: v.literal(true), riskTextVersion: v.string(), timezone: v.string() },
  handler: async (ctx, args): Promise<{ url: string | null }> => {
    if (!unipileEnv()) return { url: null };
    const caller: LinkedinCaller | null = await ctx.runQuery(internal.linkedin.caller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (args.riskTextVersion !== RISK_TEXT_VERSION) throw new ConvexError("The risk statement changed. Reload the page and read it again.");
    const { client, apiKey } = linkedinClientOrThrow("linkedin.send");
    const now = Date.now();
    const state = await signState(apiKey, {
      userId: caller.userId,
      orgId: caller.orgId,
      riskAcceptedAt: now,
      riskTextVersion: RISK_TEXT_VERSION,
      timezone: validTimezone(args.timezone) ? args.timezone : "",
      expiresAt: now + STATE_TTL_MS,
    });
    const back = `${siteUrl()}/dashboard/integrations`;
    try {
      const url = await client.hostedLink({
        name: state,
        notifyUrl: `${convexSiteUrl()}${NOTIFY_PATH}`,
        successUrl: `${back}?linkedin=connected`,
        failureUrl: `${back}?linkedin=failed`,
        expiresAt: new Date(now + STATE_TTL_MS),
        ...(caller.reconnectAccountId ? { reconnectAccountId: caller.reconnectAccountId } : {}),
      });
      return { url };
    } catch (cause) {
      if (cause instanceof UnipileError) throw new ConvexError(`Couldn't start the LinkedIn login: ${cause.message}`);
      throw cause;
    }
  },
});

/**
 * The notify callback's work: verify the state, read the account from Unipile
 * (so a forged account id is refused), bind it, and make sure the
 * account-status webhook is registered.
 */
export async function finishConnect(ctx: ActionCtx, event: { accountId: string; name: string }): Promise<boolean> {
  const { client, apiKey } = linkedinClientOrThrow("linkedin.send");
  const state = await verifyState(apiKey, event.name, Date.now());
  if (!state) return false;
  const account = await client.getAccount(event.accountId);
  if (!account) return false;
  const { ok } = await ctx.runMutation(internal.linkedin.connected, {
    userId: state.userId as Id<"users">,
    orgId: state.orgId as Id<"organizations">,
    riskAcceptedAt: state.riskAcceptedAt,
    riskTextVersion: state.riskTextVersion,
    timezone: state.timezone,
    unipileAccountId: account.id,
    status: account.status,
    profileName: account.name,
    publicIdentifier: account.publicIdentifier,
    tier: account.tier,
  });
  if (ok) await ctx.scheduler.runAfter(0, internal.linkedinActions.ensureWebhooks, {});
  return ok;
}

/** Register Canon's webhooks on its Unipile account, once per key and deployment: account status, LinkedIn messages, received mail. */
export const ensureWebhooks = internalAction({
  args: {},
  handler: async () => {
    const { client, apiKey } = linkedinClientOrThrow("linkedin.send");
    // A local stack shares Canon's Unipile account: never point its webhooks at a loopback address.
    if (isLoopback(convexSiteUrl())) return;
    const url = `${convexSiteUrl()}${WEBHOOK_PATH_PREFIX}${await webhookToken(apiKey)}`;
    const existing = await client.listWebhooks();
    if (!existing.some((w) => w.url === url && w.source === "account_status")) {
      await client.createWebhook({ source: "account_status", url, name: "canon-account-status" });
    }
    // Replies reach a deal's play at once (lib/linkedin/inbound.ts) instead of at the replier's next step.
    if (!existing.some((w) => w.url === url && w.source === "messaging")) {
      await client.createWebhook({ source: "messaging", url, name: "canon-messages", events: ["message_received"] });
    }
    if (!existing.some((w) => w.url === url && w.source === "email")) {
      await client.createWebhook({ source: "email", url, name: "canon-mail", events: ["mail_received"] });
    }
    // Sent mail, for conversation intake (docs/conversation-intake.md, CI2): a webhook of its own, so the received-mail one stays as it is.
    if (!existing.some((w) => w.url === url && (w.name === "canon-mail-sent" || w.events.includes("mail_sent")))) {
      await client.createWebhook({ source: "email", url, name: "canon-mail-sent", events: ["mail_sent"] });
    }
  },
});

/** The daily cron's call: registers any missing webhook on a deployment with Unipile configured, and does nothing elsewhere. */
export const ensureWebhooksDaily = internalAction({
  args: {},
  handler: async (ctx) => {
    if (unipileEnv()) await ctx.runAction(internal.linkedinActions.ensureWebhooks, {});
  },
});

export const isLoopback = (url: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return true;
  }
};

/** Remove webhooks a local stack registered on Canon's Unipile account. Run by hand from a local stack. */
export const removeLoopbackWebhooks = internalAction({
  args: {},
  handler: async (): Promise<{ removed: number; remainingSources: string[] }> => {
    const { client } = linkedinClientOrThrow("linkedin.send");
    const all = await client.listWebhooks();
    const local = all.filter((w) => isLoopback(w.url));
    for (const w of local) await client.deleteWebhook(w.id);
    return { removed: local.length, remainingSources: all.filter((w) => !isLoopback(w.url)).map((w) => w.source) };
  },
});

/** Remove a disconnected account from Unipile: its session ends and it stops counting toward billing. */
export const deleteRemote = internalAction({
  args: { unipileAccountId: v.string() },
  handler: async (_ctx, args) => {
    const { client } = linkedinClient("linkedin.send");
    if (!client) return;
    await client.deleteAccount(args.unipileAccountId);
  },
});
