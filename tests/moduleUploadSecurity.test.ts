import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex } from "./convexHandlers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

function loadUploadRoutes() {
  const loaded = loadConvex(["lib/modules/uploadRoute.ts", "lib/modules/fileSecurity.ts"]);
  const routes: Array<{ path: string; method: string; handler: (ctx: any, request: Request) => Promise<Response> }> = [];
  (loaded["lib/modules/uploadRoute.ts"].registerModuleUploadRoute as unknown as (router: unknown) => void)({
    route: (r: (typeof routes)[number]) => routes.push(r),
  });
  return {
    routes,
    fileSecurity: loaded["lib/modules/fileSecurity.ts"] as unknown as {
      signedModuleFileUrl: (storageId: string, name: string, now?: number) => Promise<string | null>;
      mintModuleFileToken: (input: { storageId: string; name: string; now?: number }) => Promise<string | null>;
      verifyModuleFileToken: (token: string, now?: number) => Promise<{ storageId: string; name: string } | null>;
    },
  };
}

test("POST /modules/upload rejects active HTML/SVG/XML/script uploads and forces octet-stream storage", async () => {
  const { routes } = loadUploadRoutes();
  const uploadRoute = routes.find((r) => r.path === "/modules/upload" && r.method === "POST")!;
  const storedBlobs: Blob[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const ctx = {
    storage: {
      store: async (blob: Blob) => {
        storedBlobs.push(blob);
        return `storage:${storedBlobs.length}`;
      },
      delete: async () => {},
    },
    runQuery: async (_fn: unknown, args: { ticket: string; secret: string }) =>
      args.ticket === "t1" && args.secret === "s1" ? null : "Invalid ticket",
    runMutation: async (_fn: unknown, args: Record<string, unknown>) => {
      recorded.push(args);
      return { id: "file:1", name: args.name, type: args.type, bytes: args.bytes };
    },
  };

  const activeCases: Array<{ label: string; name: string; contentType: string; body: Uint8Array }> = [
    { label: "html mime + body", name: "poc.html", contentType: "text/html", body: new TextEncoder().encode("<script>fetch('/api/local-auth')</script>") },
    { label: "svg mime + body", name: "icon.svg", contentType: "image/svg+xml", body: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>") },
    { label: "spoofed image/png holding svg", name: "avatar.png", contentType: "image/png", body: new TextEncoder().encode("<svg onload=alert(1)>") },
    { label: "spoofed text/plain holding commented html", name: "notes.txt", contentType: "text/plain", body: new TextEncoder().encode("<!-- ok --><!DOCTYPE html><html><script>alert(1)</script></html>") },
    { label: "valid png bytes with active html mime", name: "photo.png", contentType: "text/html; charset=utf-8", body: PNG },
    { label: "valid pdf bytes with .svg extension", name: "doc.svg", contentType: "application/pdf", body: PDF },
    { label: "javascript mime", name: "script.txt", contentType: "application/javascript", body: new TextEncoder().encode("alert(1)") },
  ];

  for (const c of activeCases) {
    const req = new Request(`https://site.test/modules/upload?name=${encodeURIComponent(c.name)}`, {
      method: "POST",
      headers: {
        "Content-Type": c.contentType,
        "X-Canon-Ticket": "t1",
        "X-Canon-Secret": "s1",
      },
      body: new Uint8Array(c.body).buffer,
    });
    const res = await uploadRoute.handler(ctx, req);
    assert.equal(res.status, 415, `${c.label} should be rejected`);
  }
  assert.equal(storedBlobs.length, 0, "no active upload may reach Convex storage");
  assert.equal(recorded.length, 0);

  // Valid PNG sent via header credentials stores as application/octet-stream while recording sniffed metadata type.
  const okPng = await uploadRoute.handler(
    ctx,
    new Request("https://site.test/modules/upload?name=site.png", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-Canon-Ticket": "t1", "X-Canon-Secret": "s1" },
      body: new Uint8Array(PNG).buffer,
    }),
  );
  assert.equal(okPng.status, 200);
  assert.equal(okPng.headers.get("x-content-type-options"), "nosniff");
  assert.equal(storedBlobs[0].type, "application/octet-stream");
  assert.equal(recorded[0].type, "image/png");

  // Query-parameter credentials remain backwards-compatible for existing callers, and invalid secrets are refused.
  const okCsv = await uploadRoute.handler(
    ctx,
    new Request("https://site.test/modules/upload?ticket=t1&secret=s1&name=plan.csv", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: "deal,amount\nAcme,100\n",
    }),
  );
  assert.equal(okCsv.status, 200);
  assert.equal(storedBlobs[1].type, "application/octet-stream");
  assert.equal(recorded[1].type, "text/csv");

  const badSecret = await uploadRoute.handler(
    ctx,
    new Request("https://site.test/modules/upload?ticket=t1&secret=wrong&name=plan.csv", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: "a,b\n1,2\n",
    }),
  );
  assert.equal(badSecret.status, 403);
});

test("GET /modules/file serves signed downloads with attachment and sandbox hardening headers and rejects invalid tokens", async (t) => {
  const priorKey = process.env.TOKEN_ENCRYPTION_KEY;
  const priorSite = process.env.CONVEX_SITE_URL;
  process.env.TOKEN_ENCRYPTION_KEY = "unit-test-module-file-key";
  process.env.CONVEX_SITE_URL = "https://site.test";
  t.after(() => {
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
    if (priorSite === undefined) delete process.env.CONVEX_SITE_URL; else process.env.CONVEX_SITE_URL = priorSite;
  });

  const { routes, fileSecurity } = loadUploadRoutes();
  const downloadRoute = routes.find((r) => r.path === "/modules/file" && r.method === "GET")!;

  const blobs = new Map<string, Blob>([
    // Simulate a legacy pre-fix blob stored with text/html to prove the download route still neutralizes it.
    ["storage:legacy", new Blob(["<html><script>alert(1)</script></html>"], { type: "text/html" })],
  ]);
  const ctx = { storage: { get: async (id: string) => blobs.get(id) ?? null } };

  const signedUrl = await fileSecurity.signedModuleFileUrl("storage:legacy", '../evil"\r\nreport.pdf');
  assert.ok(signedUrl && signedUrl.startsWith("https://site.test/modules/file?token="));

  const res = await downloadRoute.handler(ctx, new Request(signedUrl, { method: "GET" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="_evil___report.pdf"');
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(await res.text(), "<html><script>alert(1)</script></html>");

  // Tampered, missing, and expired tokens are refused with hardened error headers.
  const tampered = await downloadRoute.handler(ctx, new Request(`${signedUrl}0`, { method: "GET" }));
  assert.equal(tampered.status, 403);
  assert.equal(tampered.headers.get("x-content-type-options"), "nosniff");
  assert.equal(tampered.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'");

  const expiredToken = await fileSecurity.mintModuleFileToken({ storageId: "storage:legacy", name: "report.pdf", now: Date.now() - 20 * 60_000 });
  const expired = await downloadRoute.handler(ctx, new Request(`https://site.test/modules/file?token=${encodeURIComponent(expiredToken!)}`, { method: "GET" }));
  assert.equal(expired.status, 403);

  const missingUrl = await fileSecurity.signedModuleFileUrl("storage:gone", "missing.pdf");
  const missing = await downloadRoute.handler(ctx, new Request(missingUrl!, { method: "GET" }));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'");
});
