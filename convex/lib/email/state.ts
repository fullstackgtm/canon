/**
 * The signed state for linking a Gmail account through Unipile's hosted login
 * (docs/gmail-sending.md). It rides in Unipile's `name` field and comes back
 * on the notify callback: the Canon user and org, and when it expires. Keyed
 * off Canon's Unipile API key under its own purpose, so a LinkedIn state
 * never verifies here, nor the reverse.
 *
 * Pure and runtime-neutral (Web Crypto only).
 */
import { hmacSha256Hex, sha256Hex } from "../publicCrypto.ts";

export const EMAIL_NOTIFY_PATH = "/email/unipile/notify";

/** A link is good for this long; Unipile's hosted page expires sooner on its own. */
export const EMAIL_STATE_TTL_MS = 2 * 60 * 60_000;

export type EmailConnectState = { userId: string; orgId: string; expiresAt: number };

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const key = (apiKey: string) => hmacSha256Hex("canon-email/state", apiKey);

export async function signEmailState(apiKey: string, state: EmailConnectState): Promise<string> {
  const body = b64url(JSON.stringify([state.userId, state.orgId, state.expiresAt]));
  return `${body}.${(await hmacSha256Hex(body, await key(apiKey))).slice(0, 43)}`;
}

/** The state, if Canon signed it for a Gmail link and it has not expired. */
export async function verifyEmailState(apiKey: string, token: string, nowMs: number): Promise<EmailConnectState | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || token.length > 1000) return null;
  const expected = (await hmacSha256Hex(body, await key(apiKey))).slice(0, 43);
  const [x, y] = await Promise.all([sha256Hex(expected), sha256Hex(sig)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  if (diff !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unb64url(body));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [userId, orgId, expiresAt] = parsed;
  if (typeof userId !== "string" || typeof orgId !== "string" || typeof expiresAt !== "number" || expiresAt < nowMs) return null;
  return { userId, orgId, expiresAt };
}
