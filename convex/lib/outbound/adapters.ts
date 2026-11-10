/**
 * How an outbox row leaves Canon, one adapter per channel (docs/modules.md, "Outbound"). A local stack or CI never
 * sends for real: `deliveryMode()` is "live" only on a deployment whose Convex site is a public https address (the
 * test `emailActions.sendToContact` and agentSlack apply), and every adapter reads it itself, so no caller can ask a
 * sink to send. In the sink, Slack and webhook posts reach loopback receivers only, email goes nowhere, and every row
 * lands `sent` with providerId "local". Free of database and Node-only imports.
 */
import { integrationEnabled } from "../integrationsAvailable.ts";

import { postToSlack, webhookUrlProblem } from "../agents/slack.ts";
import { signWebhook } from "../agents/webhook.ts";
import { bodyHtml } from "../email/compose.ts";
import { RECEIVER_TIMEOUT_MS, destinationProblem, publicAddresses, resolvesPrivate } from "../recordWebhooks.ts";

export type Delivery =
  | { ok: true; providerId: string }
  /** `retry`: safe to send again (the receiver dedupes, or nothing arrived). `unknown`: it may have gone; never again. */
  | { ok: false; error: string; retry: boolean; unknown?: true };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };
const loopback = (url: string) => LOOPBACK.has(hostOf(url));

/** "live" only on a deployment: its Convex site is an https address that isn't loopback. Everything else is a sink. */
export function deliveryMode(): "live" | "sink" {
  const site = process.env.CONVEX_SITE_URL ?? "";
  try {
    const url = new URL(site);
    return url.protocol === "https:" && !LOOPBACK.has(url.hostname) ? "live" : "sink";
  } catch {
    return "sink";
  }
}

/** Canon's transactional sender (Postmark): its server token and From address, both needed to send. */
export const postmarkEnv = () => integrationEnabled("email")
  ? { token: process.env.POSTMARK_SERVER_TOKEN!.trim(), from: process.env.POSTMARK_FROM_ADDRESS!.trim() }
  : { token: null, from: null };

/** Whether a channel can deliver here: a sink always can; on a deployment, email needs Postmark's token and From address. */
export function providerReady(channel: "email" | "slack" | "webhook"): boolean {
  if (channel !== "email" || deliveryMode() === "sink") return true;
  const env = postmarkEnv();
  return Boolean(env.token && env.from);
}

/** A Slack post. Slack takes no idempotency key, so a timeout may have posted: it lands unknown and is never retried. */
export async function sendSlack(url: string, text: string, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  const mode = deliveryMode();
  if (mode === "sink" && !loopback(url)) return { ok: true, providerId: "local" };
  if (mode === "live" && webhookUrlProblem(url, false)) return { ok: false, error: "The mapped URL isn't a Slack incoming webhook.", retry: false };
  const r = await postToSlack(url, text, fetchImpl);
  if (r.ok) return { ok: true, providerId: mode === "sink" ? "local" : "slack" };
  if (r.error === "timeout") return { ok: false, error: "Slack didn't answer in time, so it may have posted.", retry: false, unknown: true };
  return { ok: false, error: r.httpStatus ? `Slack answered ${r.httpStatus}${r.error ? ` (${r.error})` : ""}.` : "Couldn't reach Slack.", retry: false };
}

/** The signature header a webhook carries: `t=<ms>,v1=<hex HMAC-SHA256(secret, "<ms>.<body>")>`. */
export const canonSignature = async (secret: string, ms: number, body: string) => `t=${ms},${await signWebhook(secret, ms, body)}`;

/**
 * A signed webhook POST. `id` (the outbox row's) goes out as Canon-Event-Id, so a receiver that saw it already drops a
 * retry: a timeout or a 5xx is sent again. https only and never a private address on a deployment.
 */
export async function sendWebhook(a: { url: string; secret: string; id: string; body: string }, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  const mode = deliveryMode();
  if (mode === "sink" && !loopback(a.url)) return { ok: true, providerId: "local" };
  if (mode === "live") {
    const problem = destinationProblem(a.url, false);
    if (problem) return { ok: false, error: problem, retry: false };
    try {
      if (resolvesPrivate(await publicAddresses(hostOf(a.url)))) return { ok: false, error: "The hostname points to a private address.", retry: false };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : "Couldn't check where the hostname points.", retry: true };
    }
  }
  const ms = Date.now();
  try {
    const res = await fetchImpl(a.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS), body: a.body,
      headers: { "content-type": "application/json", "user-agent": "Canon-Outbound/1", "canon-event-id": a.id, "canon-signature": await canonSignature(a.secret, ms, a.body) },
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, providerId: mode === "sink" ? "local" : `http-${res.status}` };
    return { ok: false, error: `The endpoint answered ${res.status}.`, retry: res.status === 429 || res.status >= 500 };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error && cause.name === "TimeoutError" ? "The endpoint didn't answer in time." : "Couldn't reach the endpoint.", retry: true };
  }
}

/**
 * A workspace email through Postmark. Postmark takes no idempotency key, so an unconfirmed send lands unknown; a refusal it
 * answers (429, 5xx) is sent again. Inert without its token: nothing is sent and the row says why.
 */
export async function sendPostmark(a: { to: string; subject: string; text: string }, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  if (deliveryMode() === "sink") return { ok: true, providerId: "local" };
  const env = postmarkEnv();
  if (!env.token || !env.from) return { ok: false, error: "Email isn't set up on this deployment (POSTMARK_SERVER_TOKEN and POSTMARK_FROM_ADDRESS).", retry: false };
  try {
    const res = await fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST", signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
      headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": env.token },
      body: JSON.stringify({ From: env.from, To: a.to, Subject: a.subject, TextBody: a.text, HtmlBody: bodyHtml(a.text), MessageStream: "outbound" }),
    });
    const body = (await res.json()) as { ErrorCode?: number; Message?: string; MessageID?: string };
    if (res.ok && !body.ErrorCode && typeof body.MessageID === "string" && body.MessageID) return { ok: true, providerId: body.MessageID };
    if (res.ok && !body.ErrorCode) return { ok: false, error: "Postmark did not confirm whether it sent.", retry: false, unknown: true };
    return { ok: false, error: `Postmark refused it (${body.ErrorCode ?? res.status}${body.Message ? `: ${body.Message.slice(0, 120)}` : ""}).`, retry: res.status === 429 || res.status >= 500 };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") return { ok: false, error: "Postmark didn't answer in time, so it may have sent.", retry: false, unknown: true };
    return { ok: false, error: "Postmark did not confirm whether it sent.", retry: false, unknown: true };
  }
}
