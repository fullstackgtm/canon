import type { HttpRouter } from "convex/server";
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { unsubscribeTokenShape, verifyUnsubscribeToken } from "./unsubscribe";

const PATH = "/outbound/unsubscribe";
const BODY_MAX = 8192;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
const received = () => new Response("Your unsubscribe request has been received.", { status: 200, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
const only = (params: URLSearchParams, keys: string[]) => [...params.keys()].every((key) => keys.includes(key) && params.getAll(key).length === 1);

async function boundedForm(request: Request): Promise<URLSearchParams | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_MAX)) return null;
  const type = request.headers.get("content-type") ?? "";
  const mediaType = type.split(";")[0].trim().toLowerCase();
  if (!["application/x-www-form-urlencoded", "multipart/form-data"].includes(mediaType) || !request.body) return null;
  const reader = request.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_MAX) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (mediaType === "application/x-www-form-urlencoded") return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
    const params = new URLSearchParams();
    for (const [key, value] of form) {
      if (typeof value !== "string") return null;
      params.append(key, value);
    }
    return params;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function registerUnsubscribeRoute(http: HttpRouter) {
  http.route({ path: PATH, method: "GET", handler: httpAction(async (_ctx, request) => {
    const params = new URL(request.url).searchParams;
    const candidate = request.url.length <= BODY_MAX && only(params, ["token"]) ? params.get("token") ?? "" : "";
    const token = unsubscribeTokenShape(candidate) ? candidate : "";

    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubscribe</title><body><h1>Unsubscribe</h1><p>Confirm that you want to stop automated outreach to this email address.</p><form method="post" action="${PATH}"><input type="hidden" name="token" value="${token}"><button name="confirm" value="unsubscribe">Unsubscribe</button></form></body></html>`,
      { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }) });
  http.route({ path: PATH, method: "POST", handler: httpAction(async (ctx, request) => {
    if (request.url.length > BODY_MAX) return received();
    const query = new URL(request.url).searchParams;
    if (!only(query, ["token"])) return received();
    const form = await boundedForm(request);
    if (!form) return received();
    let token: string | null = null;
    if (only(form, ["List-Unsubscribe"]) && form.get("List-Unsubscribe") === "One-Click") token = query.get("token");
    else if ([...query.keys()].length === 0 && only(form, ["token", "confirm"]) && form.get("confirm") === "unsubscribe") token = form.get("token");
    if (token && await verifyUnsubscribeToken(token)) await ctx.runMutation(internal.outboundUnsubscribe.consume, { token });
    return received();
  }) });
}
