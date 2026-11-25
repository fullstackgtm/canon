/**
 * Security helpers for member module file uploads and downloads:
 * - Constant-time secret comparison for upload tickets.
 * - Active web content rejection (HTML/SVG/XML/JS by MIME, extension, or leading bytes)
 *   and magic-byte sniffing so attacker-controlled Content-Type never enters storage.
 * - HMAC-signed, short-lived download tokens for `GET /modules/file`, served with
 *   attachment disposition, `nosniff`, and a strict sandbox CSP.
 *
 * Pure Web Crypto: safe in Convex's default runtime and in tests.
 */
import { FILE_MAX_BYTES } from "../../../modules/kernel/schema.ts";
import { safeFileName } from "../../../modules/kernel/visitorFiles.ts";
import { hmacHex } from "../agents/grants.ts";
import { derivedSecret } from "../runtimeConfig.ts";

const DOWNLOAD_DOMAIN = "canon.module-file.v1";
export const MODULE_FILE_DOWNLOAD_TTL_MS = 15 * 60_000;
export const MODULE_FILE_TOKEN_MAX = 2048;

export const MODULE_FILE_SANDBOX_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'";

export const MODULE_FILE_ERROR_HEADERS: Record<string, string> = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": MODULE_FILE_SANDBOX_CSP,
};

export function moduleFileDownloadHeaders(name: string, size?: number): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${safeFileName(name)}"`,
    ...(typeof size === "number" && Number.isFinite(size) && size >= 0 ? { "Content-Length": String(size) } : {}),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": MODULE_FILE_SANDBOX_CSP,
  };
}

/** Constant-time string comparison via SHA-256 digests so length and prefix never leak. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

const ACTIVE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/xsl",
  "application/xslt+xml",
  "multipart/related",
  "message/rfc822",
  "application/x-shockwave-flash",
  "text/cache-manifest",
]);

const ACTIVE_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".xht", ".shtml", ".mht", ".mhtml",
  ".svg", ".svgz",
  ".xml", ".xsl", ".xslt",
  ".js", ".mjs", ".cjs",
  ".swf", ".hta", ".jsp", ".asp", ".aspx", ".php",
]);

const ZIP_EXTENSION_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

const OLE2_EXTENSION_TYPES: Record<string, string> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

const SAFE_TEXT_EXTENSION_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf",
};

const ACTIVE_CONTENT_RE = /(?:^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\b|<\?xml\b|<(?:html|head|body|script|svg|iframe|object|embed|meta|title|style|frameset|base|link|form|math)\b)|<script[\s>/]|<svg[\s>/])/i;

function extensionOf(name: string): string {
  return /\.[a-z0-9]{1,10}$/i.exec(name.trim())?.[0].toLowerCase() ?? "";
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return false;
  return true;
}

function sniffBinaryType(bytes: Uint8Array, ext: string): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (bytes.length >= 12 && startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])) return ZIP_EXTENSION_TYPES[ext] ?? "application/zip";
  if (startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return OLE2_EXTENSION_TYPES[ext] ?? "application/octet-stream";
  return null;
}

function decodeLeadingText(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(sample.subarray(2));
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(sample.subarray(2));
  }
  const start = sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8").decode(sample.subarray(start));
}

function isActiveMime(declaredType: string | null): boolean {
  if (!declaredType) return false;
  const media = declaredType.split(";")[0].trim().toLowerCase();
  if (!media) return false;
  return ACTIVE_MIME_TYPES.has(media) || media.endsWith("+xml") || media.endsWith("+html");
}

export type ClassifiedUpload =
  | { ok: true; name: string; type: string; bytes: number }
  | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Validate and classify a member module upload:
 * - Rejects empty, oversized, and active web content (HTML, SVG, XML, JS) by MIME, extension, or content.
 * - Sniffs magic bytes for binary formats so spoofed `image/*` or active MIME types never pass.
 * - Callers still store the raw bytes in Convex storage as `application/octet-stream`.
 */
export function classifyModuleUpload(bytes: Uint8Array, rawName: string, declaredType: string | null): ClassifiedUpload {
  if (bytes.length === 0) return { ok: false, status: 400, error: "Empty files cannot be uploaded." };
  if (bytes.length > FILE_MAX_BYTES) return { ok: false, status: 413, error: `A file is at most ${FILE_MAX_BYTES / 1048576} MB.` };

  const safeName = safeFileName(rawName);
  const rawExt = extensionOf(rawName);
  const safeExt = extensionOf(safeName);

  if (isActiveMime(declaredType) || ACTIVE_EXTENSIONS.has(rawExt) || ACTIVE_EXTENSIONS.has(safeExt)) {
    return { ok: false, status: 415, error: "Active HTML, SVG, XML, and script files cannot be uploaded." };
  }

  const binaryType = sniffBinaryType(bytes, safeExt);
  if (binaryType) {
    return { ok: true, name: safeName, type: binaryType, bytes: bytes.length };
  }

  const head = decodeLeadingText(bytes);
  if (ACTIVE_CONTENT_RE.test(head)) {
    return { ok: false, status: 415, error: "Active HTML, SVG, XML, and script files cannot be uploaded." };
  }

  const type = SAFE_TEXT_EXTENSION_TYPES[safeExt] ?? "application/octet-stream";
  return { ok: true, name: safeName, type, bytes: bytes.length };
}

const encodeBase64Url = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type ModuleFileDownloadTerms = {
  storageId: string;
  name: string;
  issuedAt: number;
  expiresAt: number;
};

const downloadTuple = (t: ModuleFileDownloadTerms) =>
  JSON.stringify([DOWNLOAD_DOMAIN, 1, t.storageId, t.name, t.issuedAt, t.expiresAt]);

function validDownloadTerms(t: ModuleFileDownloadTerms, now: number): boolean {
  return (
    typeof t.storageId === "string" &&
    t.storageId.length > 0 &&
    t.storageId.length <= 200 &&
    typeof t.name === "string" &&
    t.name.length > 0 &&
    t.name.length <= 160 &&
    t.name === safeFileName(t.name) &&
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(t.issuedAt) &&
    t.issuedAt >= 0 &&
    t.issuedAt <= now + 30_000 &&
    Number.isSafeInteger(t.expiresAt) &&
    t.expiresAt > now &&
    t.expiresAt > t.issuedAt &&
    t.expiresAt - t.issuedAt <= MODULE_FILE_DOWNLOAD_TTL_MS
  );
}

export async function mintModuleFileToken(input: { storageId: string; name: string; now?: number }): Promise<string | null> {
  const key = await derivedSecret("module-file-download.v1");
  if (!key) return null;
  const now = input.now ?? Date.now();
  const terms: ModuleFileDownloadTerms = {
    storageId: input.storageId,
    name: safeFileName(input.name),
    issuedAt: now,
    expiresAt: now + MODULE_FILE_DOWNLOAD_TTL_MS,
  };
  if (!validDownloadTerms(terms, now)) return null;
  const payload = downloadTuple(terms);
  return `${encodeBase64Url(payload)}.${await hmacHex(key, payload)}`;
}

export async function verifyModuleFileToken(token: string, now = Date.now()): Promise<ModuleFileDownloadTerms | null> {
  if (typeof token !== "string" || token.length > MODULE_FILE_TOKEN_MAX || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) {
    return null;
  }
  const [payloadB64, signature] = token.split(".");
  let terms: ModuleFileDownloadTerms;
  let text: string;
  try {
    const binary = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payloadB64.length % 4)) % 4));
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== DOWNLOAD_DOMAIN || parsed[1] !== 1) return null;
    terms = {
      storageId: parsed[2],
      name: parsed[3],
      issuedAt: parsed[4],
      expiresAt: parsed[5],
    };
    if (!validDownloadTerms(terms, now) || downloadTuple(terms) !== text || encodeBase64Url(text) !== payloadB64) {
      return null;
    }
  } catch {
    return null;
  }
  const key = await derivedSecret("module-file-download.v1");
  if (!key) return null;
  const expected = await hmacHex(key, text);
  let diff = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0 ? terms : null;
}

export async function signedModuleFileUrl(storageId: string, name: string, now = Date.now()): Promise<string | null> {
  const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  if (!site) return null;
  const token = await mintModuleFileToken({ storageId, name, now });
  return token ? `${site}/modules/file?token=${encodeURIComponent(token)}` : null;
}
