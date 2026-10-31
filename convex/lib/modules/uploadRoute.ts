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

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...CORS } });

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
      storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes).buffer], { type: open.type }));
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
      const ticket = url.searchParams.get("ticket") ?? "", secret = url.searchParams.get("secret") ?? "";
      const name = (url.searchParams.get("name") ?? "file").slice(0, 200);
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > FILE_MAX_BYTES) return reply({ error: `A file is at most ${FILE_MAX_BYTES / 1048576} MB.` }, 413);
      const open: string | null = await ctx.runQuery(internal.modules.uploadTicket, { ticket, secret });
      if (open !== null) return reply({ error: open }, 403);
      const blob = await request.blob();
      if (blob.size > FILE_MAX_BYTES) return reply({ error: `A file is at most ${FILE_MAX_BYTES / 1048576} MB.` }, 413);
      const type = (request.headers.get("content-type") ?? blob.type ?? "application/octet-stream").split(";")[0].slice(0, 100) || "application/octet-stream";
      const storageId: Id<"_storage"> = await ctx.storage.store(blob);
      try {
        return reply(await ctx.runMutation(internal.modules.recordUpload, { ticket, secret, storageId, name, type, bytes: blob.size }));
      } catch (e) {
        await ctx.storage.delete(storageId);
        return reply({ error: e instanceof Error ? e.message : "That upload didn't record. Upload it again." }, 403);
      }
    }),
  });
}
