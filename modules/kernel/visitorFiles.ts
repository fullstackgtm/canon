import { FILE_MAX_BYTES, fileFits, type FileValidator } from "./schema.ts";

export type VisitorFileMetadata = { name: string; type: string; bytes: number; digest: string };
export const VISITOR_TICKET_MS = 10 * 60_000;

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim().slice(0, 160) || "file";
}

export function sniffVisitorFile(bytes: Uint8Array, name: string): Omit<VisitorFileMetadata, "digest"> | null {
  if (!bytes.length || bytes.length > FILE_MAX_BYTES) return null;
  const starts = (signature: number[]) => signature.every((b, i) => bytes[i] === b);
  const type = starts([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) ? "image/png"
    : starts([0xff, 0xd8, 0xff]) ? "image/jpeg"
    : starts([0x25, 0x50, 0x44, 0x46, 0x2d]) ? "application/pdf" : null;
  const ext = /\.[a-z0-9]+$/i.exec(name)?.[0].toLowerCase();
  if (!type || !(type === "image/png" ? ext === ".png" : type === "image/jpeg" ? ext === ".jpg" || ext === ".jpeg" : ext === ".pdf")) return null;
  return { name: safeFileName(name), type, bytes: bytes.length };
}

export function visitorFileFits(field: FileValidator, info: VisitorFileMetadata): boolean {
  return Number.isSafeInteger(info.bytes) && info.bytes > 0 && info.bytes <= FILE_MAX_BYTES &&
    /^[a-f0-9]{64}$/.test(info.digest) && info.name === safeFileName(info.name) &&
    ["image/png", "image/jpeg", "application/pdf"].includes(info.type) &&
    (info.type === "image/png" ? /\.png$/i : info.type === "image/jpeg" ? /\.jpe?g$/i : /\.pdf$/i).test(info.name) && !fileFits(field, info);
}

export async function fileDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function boundedFileBody(request: Request, max = FILE_MAX_BYTES): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== null && Number(length) !== size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
