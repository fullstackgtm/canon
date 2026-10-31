/**
 * Telnyx's Call Control webhook (docs/dialer.md). Every event is checked
 * against Telnyx's Ed25519 signature before Canon reads it, and an event
 * whose `client_state` Canon didn't set is acknowledged and ignored. A
 * failure returns 500 so Telnyx retries; the reducer ignores repeats.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { parseEvent } from "./bridge";
import { verifyTelnyxSignature } from "./signature";

export const TELNYX_WEBHOOK_PATH = "/telnyx/webhook";

const BODY_MAX = 256_000;

export function registerDialerRoutes(http: HttpRouter) {
  http.route({
    path: TELNYX_WEBHOOK_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const publicKey = process.env.TELNYX_PUBLIC_KEY;
      if (!publicKey) return new Response("Calling isn't set up", { status: 503 });
      const body = await request.text();
      if (body.length > BODY_MAX) return new Response("Too large", { status: 413 });
      const verdict = await verifyTelnyxSignature({
        publicKey,
        body,
        timestamp: request.headers.get("telnyx-timestamp"),
        signature: request.headers.get("telnyx-signature-ed25519"),
        nowMs: Date.now(),
      });
      if (verdict !== "ok") return new Response(verdict, { status: 401 });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return new Response("Bad body", { status: 400 });
      }
      const event = parseEvent(parsed);
      if (!event || !event.state) return new Response("ignored", { status: 200 });
      await ctx.runMutation(internal.dialer.applyEvent, { ...event, state: event.state });
      return new Response("ok", { status: 200 });
    }),
  });
}
