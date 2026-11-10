/**
 * Evidence of where a person ran a transition (docs/modules.md, "Evidence"): their IP address and browser, as Canon's
 * web server saw the request. Convex sees neither on a dashboard write, so the page sends such a transition through
 * the app's route (src/app/api/modules/transition/route.ts), which reads them from the request and signs them, with
 * the transition they are for, as a short-lived RS256 token under Canon's service key (src/lib/canonServiceJwt.ts).
 * Convex checks the token against that key's public JWKS (CANON_SERVICE_JWKS, the one convex/auth.config.ts trusts),
 * so neither the browser nor module code can put evidence on a doc. Web Crypto only: the default runtime runs it.
 */
import { ConvexError } from "convex/values";

export const EVIDENCE_AUDIENCE = "canon-evidence";
/** How long a signed token stays good: the route signs it and calls Convex at once. */
export const EVIDENCE_TTL_SECONDS = 120;

/** The transition a token is for: it can't be replayed onto another doc, version or transition. */
export type EvidenceAct = { module: string; machine: string; name: string; key: string; expect: number };
export const evidenceActText = (a: EvidenceAct) => JSON.stringify([a.module, a.machine, a.name, a.key, a.expect]);

const refuse = (why: string): never => { throw new ConvexError(`This transition's evidence didn't check: ${why}. Run it again from Canon.`); };
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

/** The public keys Convex trusts for Canon's service tokens: CANON_SERVICE_JWKS, a data: URI or plain JSON. */
function jwks(): Array<Record<string, string>> {
  const raw = process.env.CANON_SERVICE_JWKS;
  if (!raw) return refuse("this deployment has no service key (CANON_SERVICE_JWKS)");
  const json = raw.startsWith("data:") ? atob(raw.slice(raw.indexOf(",") + 1)) : raw;
  const parsed = JSON.parse(json) as { keys?: Array<Record<string, string>> };
  return parsed.keys ?? [];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const evidenceActHash = (a: EvidenceAct) => sha256Hex(evidenceActText(a));

/**
 * The IP address and browser a signed token carries, once it checks: signed by Canon's service key, for this
 * transition, not expired, and for this person (`subject`, their identity's subject, when they have one).
 */
export async function verifyEvidence(token: string, act: EvidenceAct, subject: string | null, now = Date.now()): Promise<{ ip?: string; userAgent?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) refuse("it isn't a signed token");
  const [h, p, sig] = parts;
  let header: Record<string, unknown>, payload: Record<string, unknown>;
  try { header = b64urlJson(h); payload = b64urlJson(p); } catch { return refuse("it isn't a signed token"); }
  if (header.alg !== "RS256") refuse("it isn't signed with Canon's key");
  const keys = jwks().filter((k) => k.kty === "RSA" && (header.kid === undefined || k.kid === header.kid));
  let ok = false;
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`))) { ok = true; break; }
  }
  if (!ok) refuse("it isn't signed with Canon's key");
  if (payload.aud !== EVIDENCE_AUDIENCE) refuse("it is for something else");
  const issuer = process.env.CANON_SERVICE_JWT_ISSUER;
  if (issuer && payload.iss !== issuer) refuse("another server signed it");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now) refuse("it expired");
  if (payload.act !== (await evidenceActHash(act))) refuse("it is for another transition");
  if (subject !== null && payload.sub !== undefined && payload.sub !== subject) refuse("it is for another person");
  const text = (x: unknown, max: number) => (typeof x === "string" && x ? x.slice(0, max) : undefined);
  return { ...(text(payload.ip, 64) ? { ip: text(payload.ip, 64) } : {}), ...(text(payload.ua, 400) ? { userAgent: text(payload.ua, 400) } : {}) };
}
