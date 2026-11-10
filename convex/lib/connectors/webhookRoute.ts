import type { HttpRouter } from "convex/server";
import { internal } from "../../_generated/api";
import { httpAction } from "../../_generated/server";
import { decryptFromStorage } from "../tokenHelpers";
import { MAX_BODY_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from "../agents/webhook";
import { CONNECTOR_WEBHOOK_PREFIX, webhookItem } from "./webhook";

/**
 * POST /connectors/webhook/<linkId>: one item for the workspace's `webhook.events` feed (docs/connector-feeds.md).
 * The signature is checked before anything is recorded; an unknown link and a bad signature get the same answer.
 * The secret and the body are never logged.
 */
export function registerConnectorWebhookRoutes(http: HttpRouter) {
  http.route({
    pathPrefix: CONNECTOR_WEBHOOK_PREFIX,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const id = decodeURIComponent(new URL(request.url).pathname.slice(CONNECTOR_WEBHOOK_PREFIX.length));
      const stored = await ctx.runQuery(internal.connectors.webhookSecret, { linkId: id });
      const verdict = stored
        ? await verifyWebhook({
            secret: await decryptFromStorage(stored.secret), body, nowMs: Date.now(),
            timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER),
          })
        : { ok: false as const, reason: "bad_signature" as const };
      if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
      let payload: unknown;
      let parsed: Awaited<ReturnType<typeof webhookItem>>;
      try { payload = JSON.parse(body); parsed = await webhookItem(payload, body); } catch { parsed = { ok: false, error: "The body is not JSON." }; }
      const out = await ctx.runMutation(internal.connectors.receiveWebhook, { linkId: stored!.linkId, item: parsed.ok ? { id: parsed.id, ...(parsed.version !== undefined ? { version: parsed.version } : {}), data: parsed.data } : { error: parsed.error } });
      if (out.status === "refused") return Response.json({ error: out.error }, { status: 422 });
      return Response.json({ status: out.status, ...(out.status === "written" ? { seq: out.seq } : {}) }, { status: out.status === "written" ? 202 : 200 });
    }),
  });
}
