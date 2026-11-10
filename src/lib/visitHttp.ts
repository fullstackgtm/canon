import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { evidenceSigner } from "./moduleEvidence.ts";
import { signVisitEnvelope, visitHash, visitRequestIp, visitSecret } from "./visitEnvelope.ts";
import { visitHeaders, visitFileHeaders } from "./visitHeaders.ts";
import { internalUrl } from "./internalUrl.ts";
import { PUBLIC_GRANT, VISIT_DEAD, VISIT_SECRET, type VisitOpenArgs, type VisitPageArgs, type VisitOpArgs, type VisitTransitionArgs, type VisitResult, type VisitFailure, type VisitUploadArgs, type VisitUploadTicket, type VisitFileArgs, type VisitorUploadTarget } from "../../modules/kernel/visit.ts";
import { boundedFileBody, fileDigest, safeFileName, sniffVisitorFile } from "../../modules/kernel/visitorFiles.ts";
import type { FileInfo } from "../../convex/lib/modules/scope.ts";
import type { SharePayload } from "../../convex/lib/modules/shares.ts";
import type { VisitRequestCodeArgs, VisitVerifyCodeArgs } from "../../modules/kernel/visit.ts";

type Opened = { publicId: string; expiresAt: number; reused: boolean };
type Dependencies = {
  env: Record<string, string | undefined>;
  open(args: VisitOpenArgs): Promise<VisitResult<Opened>>;
  page(args: VisitPageArgs): Promise<VisitResult<SharePayload>>;
  op(args: VisitOpArgs): Promise<{ ok: true } | VisitFailure>;
  transition(args: VisitTransitionArgs): Promise<{ ok: true } | VisitFailure>;
  upload(args: VisitUploadArgs): Promise<VisitResult<VisitUploadTicket>>;
  file(args: VisitFileArgs): Promise<VisitResult<FileInfo & { url: string }>>;
  requestCode(args: VisitRequestCodeArgs): Promise<{ ok: true } | VisitFailure>;
  verifyCode(args: VisitVerifyCodeArgs): Promise<{ ok: true } | VisitFailure>;
  fetch: typeof fetch;
};
const response = (value: unknown, status: number) => Response.json(value, { status, headers: visitHeaders() });
const unavailable = (status = 403) => response({ error: VISIT_DEAD }, status);

function defaults(request: Request): Dependencies {
  const env = process.env;
  const send = () => {
    const signer = evidenceSigner(env);
    if (!signer || !env.NEXT_PUBLIC_CONVEX_URL) throw new Error("Visitor service unavailable");
    return { signer, client: new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL), seen: { ip: visitRequestIp(request.headers, env), ua: request.headers.get("user-agent") ?? "" } };
  };
  return { env, async open(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitOpen, { ...args, envelope: signVisitEnvelope(signer, "visits:visitOpen", args, seen) });
  }, async page(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitPage, { ...args, envelope: signVisitEnvelope(signer, "visits:visitPage", args, seen) });
  }, async op(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitOp, { ...args, envelope: signVisitEnvelope(signer, "visits:visitOp", args, seen) });
  }, async transition(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitTransition, { ...args, envelope: signVisitEnvelope(signer, "visits:visitTransition", args, seen) });
  }, async upload(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitUpload, { ...args, envelope: signVisitEnvelope(signer, "visits:visitUpload", args, seen) });
  }, async file(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitFile, { ...args, envelope: signVisitEnvelope(signer, "visits:visitFile", args, seen) });
  }, async requestCode(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitRequestCode, { ...args, envelope: signVisitEnvelope(signer, "visits:visitRequestCode", args, seen) });
  }, async verifyCode(args) {
    const { signer, client, seen } = send();
    return client.mutation(api.visits.visitVerifyCode, { ...args, envelope: signVisitEnvelope(signer, "visits:visitVerifyCode", args, seen) });
  }, fetch };
}

function localHttp(env: Dependencies["env"]): boolean {
  if (env.NODE_ENV === "production" || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.NEXT_PUBLIC_SITE_URL) return false;
  const url = new URL(env.NEXT_PUBLIC_SITE_URL);
  return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
}

async function bodyOf(request: Request, env: Dependencies["env"]): Promise<Record<string, unknown> | null> {
  if (!env.NEXT_PUBLIC_SITE_URL || request.headers.get("origin") !== env.NEXT_PUBLIC_SITE_URL || request.headers.get("content-type") !== "application/json") return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function sessionsOf(request: Request, env: Dependencies["env"]): Map<string, string> | null {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16384) return null;
  const local = localHttp(env), prefix = local ? "canon_visit_" : "__Host-canon_visit_", sessions = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim(), secret = part.slice(eq + 1).trim();
    const relevant = name.startsWith("canon_visit_") || name.startsWith("__Host-canon_visit_");
    if (!relevant) continue;
    const publicId = name.replace(/^(?:__Host-)?canon_visit_/, "");
    if (seen.has(publicId) || !PUBLIC_GRANT.test(publicId) || !VISIT_SECRET.test(secret)) return null;
    seen.add(publicId);
    if (name.startsWith(prefix)) sessions.set(publicId, secret);
  }
  return seen.size > 100 ? null : sessions;
}

export async function handleVisitOpen(request: Request, deps: Pick<Dependencies, "env" | "open"> = defaults(request)): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || Object.keys(body).some((k) => !["token", "name", "email"].includes(k)) || typeof body.token !== "string" || !VISIT_SECRET.test(body.token) || body.name !== undefined && (typeof body.name !== "string" || body.name.length > 200) || body.email !== undefined && (typeof body.email !== "string" || body.email.length > 320)) return unavailable();
    const fresh = visitSecret();
    const result = await deps.open({ tokenHash: visitHash(body.token), newSessionHash: visitHash(fresh), sessions: [...sessions].map(([publicId, secret]) => ({ publicId, sessionHash: visitHash(secret) })), ...(typeof body.name === "string" ? { name: body.name } : {}), ...(typeof body.email === "string" ? { email: body.email } : {}) });
    if (!result.ok) return result.identityRequired ? response({ identityRequired: true }, 403) : unavailable(result.status);
    const { publicId, expiresAt, reused } = result.value;
    const secret = reused ? sessions.get(publicId) : fresh;
    if (!secret || !PUBLIC_GRANT.test(publicId)) return unavailable();
    const local = localHttp(deps.env), cookie = `${local ? "" : "__Host-"}canon_visit_${publicId}=${secret}; HttpOnly; ${local ? "" : "Secure; "}Path=/; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`;
    return new Response(null, { status: 303, headers: { ...visitHeaders(), Location: `/r/v/${publicId}`, "Set-Cookie": cookie } });
  } catch { return unavailable(503); }
}

export async function handleVisitPage(request: Request, deps: Pick<Dependencies, "env" | "page"> = defaults(request)): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || Object.keys(body).some((k) => !["publicId", "path"].includes(k)) || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId) || body.path !== undefined && (typeof body.path !== "string" || body.path.length > 500)) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const result = await deps.page({ publicId: body.publicId, sessionHash: visitHash(secret), ...(typeof body.path === "string" ? { path: body.path } : {}) });
    return result.ok ? response(result.value, 200) : result.verificationRequired ? response({ verificationRequired: true }, 403) : unavailable(result.status);
  } catch { return unavailable(503); }
}

export const visitMethodNotAllowed = () => unavailable(405);

export async function handleVisitRequestCode(request: Request, deps: Pick<Dependencies, "env" | "requestCode"> = defaults(request)): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || Object.keys(body).some((k) => !["publicId", "email"].includes(k)) || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId) || typeof body.email !== "string" || body.email.length > 320) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const result = await deps.requestCode({ publicId: body.publicId, sessionHash: visitHash(secret), email: body.email });
    return result.ok ? response({ ok: true }, 200) : unavailable(result.status);
  } catch { return unavailable(503); }
}

export async function handleVisitVerifyCode(request: Request, deps: Pick<Dependencies, "env" | "verifyCode"> = defaults(request)): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || Object.keys(body).some((k) => !["publicId", "code"].includes(k)) || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId) || typeof body.code !== "string" || body.code.length > 6) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const result = await deps.verifyCode({ publicId: body.publicId, sessionHash: visitHash(secret), code: body.code });
    return result.ok ? response({ ok: true }, 200) : unavailable(result.status);
  } catch { return unavailable(503); }
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const name = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v);
const key = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 500;
const version = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

async function handleVisitWrite(request: Request, kind: "op" | "transition", deps: Pick<Dependencies, "env" | "op" | "transition">): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId)) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const bound = { publicId: body.publicId, sessionHash: visitHash(secret) };
    if (kind === "op") {
      if (Object.keys(body).some((k) => !["publicId", "op", "key", "expect", "data", "unset"].includes(k)) || !name(body.op) || body.key !== undefined && !key(body.key) || body.expect !== undefined && !version(body.expect) || body.data !== undefined && !record(body.data) || body.unset !== undefined && (!Array.isArray(body.unset) || !body.unset.every(name))) return unavailable();
      const result = await deps.op({ ...bound, op: body.op, ...(typeof body.key === "string" ? { key: body.key } : {}), ...(typeof body.expect === "number" ? { expect: body.expect } : {}), ...(record(body.data) ? { data: body.data } : {}), ...(Array.isArray(body.unset) ? { unset: body.unset as string[] } : {}) });
      return result.ok ? response({ ok: true }, 200) : unavailable(result.status);
    }
    if (Object.keys(body).some((k) => !["publicId", "machine", "transition", "key", "expect", "args"].includes(k)) || !name(body.machine) || !name(body.transition) || !key(body.key) || !version(body.expect) || body.args !== undefined && !record(body.args)) return unavailable();
    const result = await deps.transition({ ...bound, machine: body.machine, transition: body.transition, key: body.key, expect: body.expect, ...(record(body.args) ? { args: body.args } : {}) });
    return result.ok ? response({ ok: true }, 200) : unavailable(result.status);
  } catch { return unavailable(503); }
}

export const handleVisitOp = (request: Request, deps: Pick<Dependencies, "env" | "op" | "transition"> = defaults(request)) => handleVisitWrite(request, "op", deps);
export const handleVisitTransition = (request: Request, deps: Pick<Dependencies, "env" | "op" | "transition"> = defaults(request)) => handleVisitWrite(request, "transition", deps);

function uploadTarget(value: unknown): value is VisitorUploadTarget {
  if (!record(value) || !name(value.field)) return false;
  if (value.kind === "op") return Object.keys(value).every((k) => ["kind", "op", "key", "expect", "field"].includes(k)) && name(value.op) && (value.key === undefined || key(value.key)) && (value.expect === undefined || version(value.expect));
  return value.kind === "transition" && Object.keys(value).every((k) => ["kind", "machine", "transition", "key", "expect", "field"].includes(k)) && name(value.machine) && name(value.transition) && key(value.key) && version(value.expect);
}

export async function handleVisitUpload(request: Request, deps: Pick<Dependencies, "env" | "upload" | "fetch"> = defaults(request)): Promise<Response> {
  try {
    if (!deps.env.NEXT_PUBLIC_SITE_URL || request.headers.get("origin") !== deps.env.NEXT_PUBLIC_SITE_URL || request.headers.get("content-type") !== "application/octet-stream") return unavailable();
    const metadata = request.headers.get("x-canon-upload"), sessions = sessionsOf(request, deps.env);
    if (!metadata || metadata.length > 4096 || !sessions) return unavailable();
    let body: unknown;
    try { body = JSON.parse(decodeURIComponent(metadata)); } catch { return unavailable(); }
    if (!record(body) || Object.keys(body).some((k) => !["publicId", "target", "name"].includes(k)) || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId) || typeof body.name !== "string" || !body.name || body.name.length > 200 || !uploadTarget(body.target)) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const bytes = await boundedFileBody(request), file = bytes ? sniffVisitorFile(bytes, body.name) : null;
    if (!bytes || !file) return unavailable();
    const reserved = await deps.upload({ publicId: body.publicId, sessionHash: visitHash(secret), target: body.target, file: { ...file, digest: await fileDigest(bytes) } });
    if (!reserved.ok) return unavailable(reserved.status);
    const stored = await deps.fetch(internalUrl(reserved.value.url, deps.env), { method: "POST", redirect: "error", headers: { "Content-Type": "application/octet-stream", "x-canon-ticket": reserved.value.ticket, "x-canon-secret": reserved.value.secret }, body: new Uint8Array(bytes).buffer });
    if (!stored.ok) return unavailable();
    const result: unknown = await stored.json();
    if (!record(result) || typeof result.id !== "string" || !result.id || result.id.length > 200 || result.name !== file.name || result.type !== file.type || result.bytes !== file.bytes) return unavailable();
    return response({ id: result.id, ...file }, 200);
  } catch { return unavailable(503); }
}

export async function handleVisitFile(request: Request, deps: Pick<Dependencies, "env" | "file" | "fetch"> = defaults(request)): Promise<Response> {
  try {
    const body = await bodyOf(request, deps.env), sessions = sessionsOf(request, deps.env);
    if (!body || !sessions || Object.keys(body).some((k) => !["publicId", "file"].includes(k)) || typeof body.publicId !== "string" || !PUBLIC_GRANT.test(body.publicId) || !key(body.file)) return unavailable();
    const secret = sessions.get(body.publicId);
    if (!secret) return unavailable();
    const result = await deps.file({ publicId: body.publicId, sessionHash: visitHash(secret), file: body.file });
    if (!result.ok) return unavailable(result.status);
    const stored = await deps.fetch(internalUrl(result.value.url, deps.env), { redirect: "error", cache: "no-store" });
    if (!stored.ok || !stored.body) return unavailable();
    return new Response(stored.body, { headers: { ...visitFileHeaders(),
      "Content-Type": "application/octet-stream", "Content-Length": String(result.value.bytes),
      "Content-Disposition": `attachment; filename="${safeFileName(result.value.name)}"` } });
  } catch { return unavailable(503); }
}
