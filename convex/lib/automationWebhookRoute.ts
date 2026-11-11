import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { MAX_BODY_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./agents/webhook";
import { AUTOMATION_WEBHOOK_PREFIX, handleAutomationWebhook } from "../automations";

/**
 * POST /automations/webhook/<ruleId>: start a webhook rule's run on the record the body names (convex/automations.ts,
 * "On demand"). Signed as event agents' webhooks are (x-canon-timestamp within five minutes, x-canon-signature over
 * `<timestamp>.<body>`); an unknown rule and a bad signature get the same answer. The secret and the body are never logged.
 */
export function registerAutomationWebhookRoutes(http: HttpRouter) {
  http.route({
    pathPrefix: AUTOMATION_WEBHOOK_PREFIX,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
      const ruleId = decodeURIComponent(new URL(request.url).pathname.slice(AUTOMATION_WEBHOOK_PREFIX.length));
      const out = await handleAutomationWebhook(ctx, ruleId, body, { timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER) });
      return Response.json(out.body, { status: out.status });
    }),
  });
}
