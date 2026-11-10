/**
 * The inbound endpoint for email logging (convex/emailLog.ts), one route per delivery format, authenticated by
 * EMAIL_LOG_SECRET (as `Authorization: Bearer <secret>`, or as the password of HTTP basic auth, which webhook
 * providers send from credentials in their URL), compared in constant time. The secret says the adapter may deliver;
 * only the token in the recipient address says whose mail it is.
 *
 * - `/email-log/raw`: the raw RFC 822 message as the body (a Cloudflare Email Worker, a Postfix pipe, curl). The
 *   envelope recipient and sender go in `?to=` and `?from=` (a BCC recipient is in no header).
 * - `/email-log/postmark`: Postmark's inbound webhook JSON (docs/email-logging.md).
 */
import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../../_generated/server";
import { logInbound, loggingDomain, type Delivery } from "../../emailLog";
import { bearerMatches } from "../objects/tail";
import { parseMime } from "./mime";
import { postmarkDelivery } from "./postmark";

export const EMAIL_LOG_RAW_PATH = "/email-log/raw";
export const EMAIL_LOG_POSTMARK_PATH = "/email-log/postmark";
/** Convex accepts 20 MB; a message this large is mostly attachments, which are not kept. */
const BODY_MAX = 15_000_000;

async function authorized(request: Request): Promise<boolean> {
  const secret = process.env.EMAIL_LOG_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (!basic) return bearerMatches(header, secret);
  let decoded: string;
  try {
    decoded = atob(basic[1]);
  } catch {
    return false;
  }
  return bearerMatches(`Bearer ${decoded.slice(decoded.indexOf(":") + 1)}`, secret);
}

function route(http: HttpRouter, path: string, read: (bytes: Uint8Array, url: URL) => Delivery | null) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!loggingDomain()) return Response.json({ status: "off" }, { status: 404 });
      if (!(await authorized(request))) return Response.json({ status: "unauthorized" }, { status: 401 });
      if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return Response.json({ status: "too_large" }, { status: 413 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > BODY_MAX) return Response.json({ status: "too_large" }, { status: 413 });
      const delivery = read(bytes, new URL(request.url));
      if (!delivery) return Response.json({ status: "unreadable" }, { status: 400 });
      const { status, body } = await logInbound(ctx as ActionCtx, delivery);
      return Response.json(body, { status });
    }),
  });
}

export function registerEmailLogRoutes(http: HttpRouter) {
  route(http, EMAIL_LOG_RAW_PATH, (bytes, url) => ({
    mail: parseMime(bytes),
    recipients: url.searchParams.getAll("to"),
    envelopeFrom: url.searchParams.get("from"),
  }));
  route(http, EMAIL_LOG_POSTMARK_PATH, (bytes) => {
    try {
      return postmarkDelivery(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return null;
    }
  });
}
