import { createHash } from "node:crypto";

// Every push stores a new 8 MB module bundle in the volume, even when nothing changed, so the
// container pushes only when what a push reads differs from the last successful push: the image's
// source, the backend's version, or the environment, which auth.config.ts reads at push time.

/** What the last push depended on. Null when the image does not say what source it carries: then every boot pushes. */
export function functionsDigest({ source, backend, env }) {
  if (!source?.trim()) return null;
  const vars = [...env].map(({ name, value }) => [name, value ?? null]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ source: source.trim(), backend: backend.trim(), vars })).digest("hex");
}

/** `recorded` is the digest saved after the last successful push, or null. */
export const mustPush = (digest, recorded) => digest === null || digest !== recorded;
