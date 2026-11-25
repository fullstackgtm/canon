/**
 * Where a person's browser uploads a module file (docs/modules.md, "Files"): `POST /modules/upload` on the Convex
 * site, with the ticket `uploadUrl` handed that person. The ticket is the capability: unguessable, theirs, good for
 * 30 minutes and once. Canon stores the body itself and records the file on the ticket in one step, so the stored
 * blob's id never reaches a browser before it belongs to its uploader, and no storage id can be claimed.
 * Reached only through scope.ts (ticketOpen, recordUpload); no cookies, so any origin may post.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { FILE_MAX_BYTES } from "../../../modules/kernel/schema.ts";
import { boundedFileBody, fileDigest, sniffVisitorFile, type VisitorFileMetadata } from "../../../modules/kernel/visitorFiles.ts";
import { classifyModuleUpload, MODULE_FILE_ERROR_HEADERS, moduleFileDownloadHeaders, verifyModuleFileToken } from "./fileSecurity";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Canon-Ticket, X-Canon-Secret, X-Canon-Name",
  "Access-Control-Max-Age": "600",
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...CORS } });

export function registerModuleUploadRoute(http: HttpRouter) {
  http.route({ path: "/modules/visitor-upload", method: "POST", handler: httpAction(async (ctx, request) => {
    const headers = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
    const fail = () => Response.json({ error: "This upload could not be stored." }, { status: 403, headers });
    const ticket = request.headers.get("x-canon-ticket") ?? "", secret = request.headers.get("x-canon-secret") ?? "";
    if (!ticket || ticket.length > 200 || !secret || secret.length > 100) return fail();
    let storageId: Id<"_storage"> | undefined;
    try {
      const open: (VisitorFileMetadata & { state: string }) | null = await ctx.runMutation(internal.visits.uploadTicket, { ticket, secret });
      if (!open || open.state !== "reserved") throw new Error("Invalid ticket");
      const bytes = await boundedFileBody(request, open.bytes);
      const sniffed = bytes ? sniffVisitorFile(bytes, open.name) : null;
      if (!bytes || !sniffed || sniffed.type !== open.type || bytes.length !== open.bytes || await fileDigest(bytes) !== open.digest) throw new Error("Invalid file");
      storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes).buffer], { type: "application/octet-stream" }));
      const saved = await ctx.runMutation(internal.visits.finishUpload, { ticket, secret, storageId });
      return Response.json({ id: saved.id, name: saved.name, type: saved.type, bytes: saved.bytes }, { headers });
    } catch {
      await ctx.runMutation(internal.visits.releaseUpload, { ticket, secret, ...(storageId ? { storageId } : {}) });
      return fail();
    }
  }) });
  http.route({ path: "/modules/upload", method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })) });
  http.route({
    path: "/modules/upload",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const ticket = request.headers.get("x-canon-ticket") ?? url.searchParams.get("ticket") ?? "";
      const secret = request.headers.get("x-canon-secret") ?? url.searchParams.get("secret") ?? "";
      const name = (request.headers.get("x-canon-name") ?? url.searchParams.get("name") ?? "file").slice(0, 200);
      if (!ticket || ticket.length > 200 || !secret || secret.length > 100) {
        return reply({ error: "That upload ticket isn't valid, or it is used. Upload the file again." }, 403);
      }
      const declaredHeader = request.headers.get("content-length");
      if (declaredHeader !== null && (!/^\d+$/.test(declaredHeader) || Number(declaredHeader) > FILE_MAX_BYTES)) {
        return reply({ error: `A file is at most ${FILE_MAX_BYTES / 1048576} MB.` }, 413);
      }
      const open: string | null = await ctx.runQuery(internal.modules.uploadTicket, { ticket, secret });
      if (open !== null) return reply({ error: open }, 403);
      if (!request.body) return reply({ error: "Empty files cannot be uploaded." }, 400);
      const bytes = await boundedFileBody(request, FILE_MAX_BYTES);
      if (!bytes) return reply({ error: `A file is at most ${FILE_MAX_BYTES / 1048576} MB.` }, 413);
      const classified = classifyModuleUpload(bytes, name, request.headers.get("content-type"));
      if (!classified.ok) return reply({ error: classified.error }, classified.status);
      // Always store as application/octet-stream so raw storage can never render active content inline.
      const storageId: Id<"_storage"> = await ctx.storage.store(new Blob([new Uint8Array(bytes).buffer], { type: "application/octet-stream" }));
      try {
        return reply(await ctx.runMutation(internal.modules.recordUpload, {
          ticket,
          secret,
          storageId,
          name: classified.name,
          type: classified.type,
          bytes: classified.bytes,
        }));
      } catch (e) {
        await ctx.storage.delete(storageId);
        return reply({ error: e instanceof Error ? e.message : "That upload didn't record. Upload it again." }, 403);
      }
    }),
  });
  http.route({
    path: "/modules/file",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = new URL(request.url).searchParams.get("token") ?? "";
      const verified = await verifyModuleFileToken(token);
      if (!verified) return new Response("Invalid or expired download link.", { status: 403, headers: MODULE_FILE_ERROR_HEADERS });
      const blob = await ctx.storage.get(verified.storageId as Id<"_storage">);
      if (!blob) return new Response("File not found.", { status: 404, headers: MODULE_FILE_ERROR_HEADERS });
      return new Response(blob, {
        status: 200,
        headers: moduleFileDownloadHeaders(verified.name, blob.size),
      });
    }),
  });
}
