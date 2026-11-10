import { randomBytes, randomInt } from "node:crypto";

// Where the container finds its public address and setup code when the operator did not set them.

/** The generated setup code, kept in the volume with the other credentials until the operator sets CANON_SETUP_CODE. */
export const SETUP_CODE_FILE = "/data/credentials/setup_code";

/**
 * The public HTTPS origin a hosting platform gives the service, from the variables it sets in every
 * container: Render's RENDER_EXTERNAL_URL and Railway's RAILWAY_PUBLIC_DOMAIN.
 * SITE_URL wins when it is set, so a custom domain only needs SITE_URL.
 */
export function platformSiteUrl(env) {
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

// No 0/O, 1/I/L or U, so a code read from a log is typed back without guessing.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A setup code (src/lib/setupCode.ts): fifteen letters from a 30-letter alphabet, about 73 bits, in groups of five. */
export function newSetupCode() {
  const letters = Array.from({ length: 15 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 5, 10].map((at) => letters.slice(at, at + 5).join("")).join("-");
}

/**
 * The key every install encrypts its stored credentials with (convex/lib/encryption.ts): 32 random bytes, base64.
 * Each setup path generates it once and keeps it; a new key makes every stored credential unreadable.
 */
export function newTokenEncryptionKey() {
  return randomBytes(32).toString("base64");
}
