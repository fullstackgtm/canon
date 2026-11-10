import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedFileBody, fileDigest, sniffVisitorFile, visitorFileFits } from "../modules/kernel/visitorFiles.ts";
import { handleVisitFile, handleVisitUpload } from "../src/lib/visitHttp.ts";
import { visitHash } from "../src/lib/visitEnvelope.ts";
import { loadConvex } from "./convexHandlers.ts";
import type { VisitUploadArgs } from "../modules/kernel/visit.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const env = { NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://canon.test" };
const publicId = "abcdefghijklmnopqrstuv", session = "a".repeat(43);
const target = { kind: "op" as const, op: "customerPhotos.post", field: "photo" };
const headers = { origin: env.NEXT_PUBLIC_SITE_URL, cookie: `__Host-canon_visit_${publicId}=${session}` };
const binary = (body = png, extra: Record<string, string> = {}) => new Request("https://canon.test/api/visit/upload", { method: "POST", headers: {
  ...headers, "content-type": "application/octet-stream", "x-canon-upload": encodeURIComponent(JSON.stringify({ publicId, target, name: "visit.png" })), ...extra,
}, body: new Uint8Array(body).buffer });
const fileRequest = (extra: Record<string, string> = {}, body: unknown = { publicId, file: "file-1" }) => new Request("https://canon.test/api/visit/file", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

test("the real visitor proxy admits only named file routes and preserves download sandbox headers", async () => {
  const loaded = loadConvex(["../src/proxy.ts"])["../src/proxy.ts"];
  const proxy = loaded.proxy as unknown as (request: { nextUrl: URL; headers: Headers }) => Promise<Response>;
  const request = (path: string) => ({ nextUrl: new URL(path, "https://canon.test"), headers: new Headers() });
  const download = await proxy(request("/api/visit/file"));
  assert.equal(download.headers.get("x-middleware-next"), "1");
  assert.equal(download.headers.get("content-security-policy"), "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal((await proxy(request("/api/visit/upload"))).headers.get("x-middleware-next"), "1");
  for (const path of ["/api/visit/file/extra", "/api/visit/upload/extra"]) assert.equal((await proxy(request(path))).status, 404);
});

test("visitor files use magic bytes, matching extensions, bounded bytes and field accept rules", async () => {
  assert.deepEqual(sniffVisitorFile(png, "site.png"), { name: "site.png", type: "image/png", bytes: 12 });
  assert.deepEqual(sniffVisitorFile(new Uint8Array([255, 216, 255, 224]), "site.jpeg"), { name: "site.jpeg", type: "image/jpeg", bytes: 4 });
  assert.deepEqual(sniffVisitorFile(new TextEncoder().encode("%PDF-1.7\n"), "report.pdf"), { name: "report.pdf", type: "application/pdf", bytes: 9 });
  for (const [bytes, name] of [[png, "photo.pdf"], [png, "photo.svg"], [new TextEncoder().encode("<svg></svg>"), "photo.png"], [new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"), "report.pdf"], [new Uint8Array([77, 90, 0, 0]), "photo.jpg"], [new Uint8Array([1, 2, 3]), "photo.png"]] as const) assert.equal(sniffVisitorFile(bytes, name), null);
  const file = { ...sniffVisitorFile(png, "site.png")!, digest: await fileDigest(png) };
  assert.equal(await fileDigest(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(visitorFileFits({ type: "file", accept: ["image/*"], maxBytes: 12 }, file), true);
  assert.equal(visitorFileFits({ type: "file", accept: [".pdf"] }, file), false);
  assert.equal(visitorFileFits({ type: "file", maxBytes: 11 }, file), false);
  assert.equal(visitorFileFits({ type: "file" }, { ...file, bytes: 19 * 1048576 + 1 }), false);
  assert.equal(await boundedFileBody(binary(png, { "content-length": "11" }), 12), null);
  assert.equal(await boundedFileBody(binary(png, { "content-length": "13" }), 12), null);
  assert.equal(await boundedFileBody(binary(png), 11), null);
  assert.deepEqual(await boundedFileBody(binary(png), 12), png);
});

test("upload proxy binds the cookie and measured file and never returns ticket or storage authority", async () => {
  let seen: VisitUploadArgs | undefined, forwarded: RequestInit | undefined, calls = 0;
  const deps = { env, upload: async (args: VisitUploadArgs) => {
    calls++; seen = args;
    return { ok: true as const, value: { ticket: "private-ticket", secret: "private-secret", url: "https://convex.test/modules/visitor-upload" } };
  }, fetch: (async (_url, init) => {
    forwarded = init;
    return Response.json({ id: "file-1", name: "visit.png", type: "image/png", bytes: 12, storageId: "private-blob", url: "private-url" });
  }) as typeof fetch };
  for (const extra of [{ origin: "" }, { origin: "https://other.test" }, { cookie: "" }, { cookie: `${headers.cookie}; ${headers.cookie}` }, { "content-type": "multipart/form-data" }, { "content-length": "99999999" }, { "x-canon-upload": "x".repeat(4097) }, { "x-canon-upload": encodeURIComponent(JSON.stringify({ publicId, target, name: "visit.png", sessionHash: "forged" })) }] as Array<Record<string, string>>) {
    assert.equal((await handleVisitUpload(binary(png, extra), deps)).status, 403);
  }
  assert.equal((await handleVisitUpload(binary(new TextEncoder().encode("<svg/>")), deps)).status, 403);
  assert.equal(calls, 0);
  const response = await handleVisitUpload(binary(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "file-1", name: "visit.png", type: "image/png", bytes: 12 });
  assert.equal(seen!.sessionHash, visitHash(session));
  assert.deepEqual(seen!.target, target);
  assert.equal(seen!.file.type, "image/png");
  assert.equal(seen!.file.bytes, 12);
  assert.equal(new Headers(forwarded!.headers).get("x-canon-secret"), "private-secret");
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("download proxy refuses cookie/origin overrides and streams an attachment with restrictive headers", async () => {
  let calls = 0;
  const deps = { env, file: async (args: { publicId: string; sessionHash: string; file: string }) => {
    calls++;
    assert.deepEqual(args, { publicId, sessionHash: visitHash(session), file: "file-1" });
    return { ok: true as const, value: { name: '../photo"\r\n.svg', type: "image/svg+xml", bytes: 12, url: "https://storage.test/private-signed-url" } };
  }, fetch: (async (_url, init) => { assert.equal(init?.redirect, "error"); return new Response(new Uint8Array(png).buffer); }) as typeof fetch };
  for (const extra of [{ origin: "" }, { origin: "https://other.test" }, { cookie: "" }, { cookie: `${headers.cookie}; ${headers.cookie}` }] as Array<Record<string, string>>) assert.equal((await handleVisitFile(fileRequest(extra), deps)).status, 403);
  assert.equal((await handleVisitFile(fileRequest({}, { publicId, file: "file-1", storageId: "blob" }), deps)).status, 403);
  assert.equal(calls, 0);
  const response = await handleVisitFile(fileRequest(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="_photo___.svg"');
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("visitor storage deletes losing blobs, releases failures and rejects member tickets and digest changes", async () => {
  const routes: Array<{ path: string; method: string; handler: (ctx: any, request: Request) => Promise<Response> }> = [];
  const loaded = loadConvex(["lib/modules/uploadRoute.ts"])["lib/modules/uploadRoute.ts"];
  (loaded.registerModuleUploadRoute as unknown as (router: unknown) => void)({ route: (r: typeof routes[number]) => routes.push(r) });
  const route = routes.find((r) => r.path === "/modules/visitor-upload")!;
  const removed: string[] = [], released: string[] = [];
  let mode = "ok", stored = 0;
  const ctx = { storage: { store: async () => { stored++; return "blob"; }, delete: async (id: string) => { removed.push(id); } },
    runMutation: async (fn: unknown, args: any) => {
      if (String(fn).endsWith("uploadTicket")) return mode === "member" ? null : { name: "visit.png", type: "image/png", bytes: 12, digest: mode === "digest" ? "f".repeat(64) : await fileDigest(png), state: "reserved" };
      if (String(fn).endsWith("releaseUpload")) { released.push(args.ticket); if (args.storageId) await ctx.storage.delete(args.storageId); return null; }
      if (mode === "race") throw new Error("Another blob won");
      return { id: "file-1", name: "visit.png", type: "image/png", bytes: 12 };
    } };
  const request = () => binary(png, { "x-canon-ticket": "ticket", "x-canon-secret": "secret" });
  assert.deepEqual(await (await route.handler(ctx, request())).json(), { id: "file-1", name: "visit.png", type: "image/png", bytes: 12 });
  mode = "member"; assert.equal((await route.handler(ctx, request())).status, 403);
  mode = "digest"; assert.equal((await route.handler(ctx, request())).status, 403);
  assert.equal(stored, 1);
  mode = "race"; assert.equal((await route.handler(ctx, request())).status, 403);
  assert.deepEqual(removed, ["blob"]);
  assert.deepEqual(released, ["ticket", "ticket", "ticket"]);
});
