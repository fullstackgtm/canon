import type { HttpRouter } from "convex/server";
import { internal } from "../../_generated/api";
import { httpAction } from "../../_generated/server";
import { decryptFromStorage } from "../tokenHelpers";
import {
  MAX_BODY_BYTES, PAYLOAD_KEPT, SIGNATURE_HEADER, TIMESTAMP_HEADER, WEBHOOK_PATH_PREFIX,
  eventKeyOf, subjectOf, verifyWebhook,
} from "./webhook";

/**
 * POST /agents/webhook/<agentId>: an event for an event agent (convex/agentTurns.ts).
 * The signature is checked before anything is recorded; an unknown agent and a
 * bad signature get the same answer. The secret and the body are never logged.
 */
export function registerAgentWebhookRoutes(http: HttpRouter) {
  http.route({
    pathPrefix: WEBHOOK_PATH_PREFIX,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const id = decodeURIComponent(new URL(request.url).pathname.slice(WEBHOOK_PATH_PREFIX.length));
      const stored = await ctx.runQuery(internal.agentTurns.webhookSecret, { agentId: id });
      const verdict = stored
        ? await verifyWebhook({
            secret: await decryptFromStorage(stored.secret), body, nowMs: Date.now(),
            timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER),
          })
        : { ok: false as const, reason: "bad_signature" as const };
      if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return Response.json({ error: "body is not JSON" }, { status: 400 }); }
      const turn = await ctx.runMutation(internal.agentTurns.receive, {
        agentId: stored!.agentId,
        eventKey: await eventKeyOf(payload, body),
        payload: body.slice(0, PAYLOAD_KEPT),
        subject: subjectOf(payload),
      });
      if (!turn) return Response.json({ error: "bad_signature" }, { status: 401 });
      return Response.json({ turnId: turn.turnId, status: turn.status, duplicate: turn.duplicate }, { status: turn.duplicate ? 200 : 202 });
    }),
  });
}
