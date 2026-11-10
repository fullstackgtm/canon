/**
 * Telnyx webhook signatures (docs/dialer.md): Ed25519 over
 * `<telnyx-timestamp>|<raw body>`, base64 in `telnyx-signature-ed25519`,
 * checked against the account's public key (Mission Control → Keys &
 * Credentials → Public Key). A timestamp more than five minutes from now is
 * refused, so a captured webhook can't be replayed later.
 *
 * Pure and runtime-neutral (Web Crypto only).
 */

export const TOLERANCE_S = 300;

export type Verdict = "ok" | "unsigned" | "stale" | "bad_signature";

const bytes = (b64: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const raw = atob(b64.trim());
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** The raw 32-byte key, from either the raw base64 key or its DER (SPKI) wrapping. */
function rawKey(publicKey: string): Uint8Array<ArrayBuffer> | null {
  const key = bytes(publicKey);
  if (!key) return null;
  if (key.length === 32) return key;
  if (key.length === 44) return key.slice(12);
  return null;
}

export async function verifyTelnyxSignature(input: {
  publicKey: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  nowMs: number;
}): Promise<Verdict> {
  if (!input.timestamp || !input.signature) return "unsigned";
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs(input.nowMs / 1000 - ts) > TOLERANCE_S) return "stale";
  const key = rawKey(input.publicKey);
  const sig = bytes(input.signature);
  if (!key || !sig || sig.length !== 64) return "bad_signature";
  try {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, imported, sig, new TextEncoder().encode(`${input.timestamp}|${input.body}`));
    return ok ? "ok" : "bad_signature";
  } catch {
    return "bad_signature";
  }
}
