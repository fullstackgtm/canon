import type { Id } from "../../_generated/dataModel";
import { hmacHex } from "../agents/grants";
import { derivedSecret } from "../operatorConfig";
import { normalizeSuppression } from "../suppressions/domain";

const DOMAIN = "canon.outbound.unsubscribe.v1";
const MAX_AGE = 90 * 86_400_000;
export const UNSUBSCRIBE_TOKEN_MAX = 2048;
export type UnsubscribeTerms = { version: 1; orgId: string; address: string; issuedAt: number; expiresAt: number };
export type RecipientUnsubscribeProof = { kind: "rfc8058"; tokenDigest: string; issuedAt: number; expiresAt: number };
type MintResult = { ok: true; token: string; validUntil: number } | { ok: false; code: "unavailable" | "invalid_terms" };

const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tuple = (t: UnsubscribeTerms) => JSON.stringify([DOMAIN, t.version, t.orgId, t.address, t.issuedAt, t.expiresAt]);
export const unsubscribeTokenShape = (token: string) => token.length <= UNSUBSCRIBE_TOKEN_MAX && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token);
function validTerms(t: UnsubscribeTerms, now: number) {
  return t.version === 1 && typeof t.orgId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(t.orgId)
    && typeof t.address === "string" && normalizeSuppression("email", t.address) === t.address
    && Number.isSafeInteger(now) && Number.isSafeInteger(t.issuedAt) && t.issuedAt >= 0 && t.issuedAt <= now
    && Number.isSafeInteger(t.expiresAt) && t.expiresAt > now && t.expiresAt > t.issuedAt && t.expiresAt - t.issuedAt <= MAX_AGE;
}

export async function mintUnsubscribeToken(input: { orgId: Id<"organizations">; address: string; expiresAt: number }): Promise<MintResult> {
  const key = await derivedSecret("outbound-unsubscribe.v1");
  if (!key) return { ok: false, code: "unavailable" };
  if (!input || Object.keys(input).some((key) => !["orgId", "address", "expiresAt"].includes(key))) return { ok: false, code: "invalid_terms" };
  const terms: UnsubscribeTerms = { version: 1, orgId: input.orgId, address: input.address, issuedAt: Date.now(), expiresAt: input.expiresAt };
  if (!validTerms(terms, terms.issuedAt)) return { ok: false, code: "invalid_terms" };
  return { ok: true, token: `${encode(tuple(terms))}.${await hmacHex(key, tuple(terms))}`, validUntil: terms.expiresAt };
}

export async function verifyUnsubscribeToken(token: string): Promise<{ terms: UnsubscribeTerms; proof: RecipientUnsubscribeProof } | null> {
  if (typeof token !== "string" || !unsubscribeTokenShape(token)) return null;
  let terms: UnsubscribeTerms;
  try {
    const payload = token.split(".")[0];
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== DOMAIN) return null;
    terms = { version: parsed[1], orgId: parsed[2], address: parsed[3], issuedAt: parsed[4], expiresAt: parsed[5] };
    if (!validTerms(terms, Date.now()) || tuple(terms) !== text || encode(text) !== payload) return null;
  } catch { return null; }
  const key = await derivedSecret("outbound-unsubscribe.v1");
  if (!key) return null;
  const expected = await hmacHex(key, tuple(terms));
  const signature = token.split(".")[1];
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (difference !== 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { terms, proof: { kind: "rfc8058", tokenDigest, issuedAt: terms.issuedAt, expiresAt: terms.expiresAt } };
}
