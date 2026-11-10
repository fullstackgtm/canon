/**
 * Signed tokens for the LinkedIn connect flow (docs/linkedin-cadences.md).
 *
 * - The connect state rides in Unipile's `name` field and comes back on the
 *   notify callback. It names the Canon user and org, when they accepted the
 *   risk statement and which version, and expires. Only Canon can sign it.
 * - The webhook path token makes `/linkedin/unipile/webhook/<token>`
 *   unguessable: Unipile calls the URL we register and signs nothing itself.
 *
 * Both are keyed off Canon's Unipile API key, so there is no second secret to
 * manage; rotating the key invalidates pending links and the webhook URL (the
 * next connect re-registers it).
 *
 * Pure and runtime-neutral (Web Crypto only).
 */
import { hmacSha256Hex, sha256Hex } from "../publicCrypto.ts";

/** A connect link is good for this long; Unipile's hosted page expires sooner on its own. */
export const STATE_TTL_MS = 2 * 60 * 60_000;

export type ConnectState = {
  userId: string;
  orgId: string;
  riskAcceptedAt: number;
  riskTextVersion: string;
  timezone: string;
  expiresAt: number;
};

const SEP = ".";
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

const keyFor = (apiKey: string, purpose: string) => hmacSha256Hex(`canon-linkedin/${purpose}`, apiKey);

export async function signState(apiKey: string, state: ConnectState): Promise<string> {
  const body = b64url(JSON.stringify([state.userId, state.orgId, state.riskAcceptedAt, state.riskTextVersion, state.timezone, state.expiresAt]));
  const sig = (await hmacSha256Hex(body, await keyFor(apiKey, "state"))).slice(0, 43);
  return `${body}${SEP}${sig}`;
}

async function sameHex(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** The state, if Canon signed it and it has not expired. */
export async function verifyState(apiKey: string, token: string, nowMs: number): Promise<ConnectState | null> {
  const [body, sig, extra] = token.split(SEP);
  if (!body || !sig || extra !== undefined || token.length > 1000) return null;
  const expected = (await hmacSha256Hex(body, await keyFor(apiKey, "state"))).slice(0, 43);
  if (!(await sameHex(expected, sig))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unb64url(body));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 6) return null;
  const [userId, orgId, riskAcceptedAt, riskTextVersion, timezone, expiresAt] = parsed;
  if (typeof userId !== "string" || typeof orgId !== "string" || typeof riskTextVersion !== "string" || typeof timezone !== "string") return null;
  if (typeof riskAcceptedAt !== "number" || typeof expiresAt !== "number" || expiresAt < nowMs) return null;
  return { userId, orgId, riskAcceptedAt, riskTextVersion, timezone, expiresAt };
}

export const WEBHOOK_PATH_PREFIX = "/linkedin/unipile/webhook/";
export const NOTIFY_PATH = "/linkedin/unipile/notify";

export async function webhookToken(apiKey: string): Promise<string> {
  return (await keyFor(apiKey, "webhook")).slice(0, 40);
}

export async function webhookTokenMatches(apiKey: string, supplied: string): Promise<boolean> {
  return sameHex(await webhookToken(apiKey), supplied);
}
