export function appUrl(): string | null {
  const value =
    process.env.SITE_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    undefined;
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || local ? url.origin : null;
  } catch {
    return null;
  }
}

/** This deployment's own HTTP-action origin (set by Convex). */
export function convexSiteUrl(): string | null {
  const value = process.env.CONVEX_SITE_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

/**
 * A purpose-bound key derived from TOKEN_ENCRYPTION_KEY, so BugDrop and agent
 * grants need no extra shared secrets. Distinct labels give independent keys.
 */
export async function derivedSecret(purpose: "bugdrop-token" | "bugdrop-provenance" | "agent-grant" | "module-grant" | "outbound-mailbox-grant.v1" | "outbound-unsubscribe.v1"): Promise<string | null> {
  const root = process.env.TOKEN_ENCRYPTION_KEY;
  if (!root) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(root), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`canoncrm:${purpose}:v1`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

