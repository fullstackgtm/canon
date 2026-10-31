/**
 * Evidence of where a person ran a module transition (docs/modules.md, "Evidence"): their IP address and browser, as
 * this server saw the request, signed under Canon's service key for the one transition they are for. Convex checks the
 * token against the key's public JWKS (convex/lib/modules/evidence.ts), so only this server's word goes on a doc.
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceJwtConfig, type ServiceJwtConfig } from "./canonServiceJwt.ts";

export const EVIDENCE_AUDIENCE = "canon-evidence";
const TTL_SECONDS = 120;
const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export type EvidenceAct = { module: string; machine: string; name: string; key: string; expect: number };
/** What a token is for, as Convex hashes it too: the module, machine, transition, doc and the version it expects. */
export const evidenceActHash = (a: EvidenceAct) => createHash("sha256").update(JSON.stringify([a.module, a.machine, a.name, a.key, a.expect])).digest("hex");

/**
 * The service key this server signs with. A local stack's Next has no CANON_SERVICE_JWT_PRIVATE_KEY: there (and only
 * with the demo auth bypass on) it signs with the stack's own throwaway key in .devstack, whose JWKS the local
 * Convex trusts, under the issuer the stack gave Convex.
 */
export function evidenceSigner(env: Record<string, string | undefined> = process.env): ServiceJwtConfig | null {
  const config = serviceJwtConfig(env);
  if (config) return config;
  const local = env.NODE_ENV !== "production" && !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!local || !env.NEXT_PUBLIC_SITE_URL) return null;
  try {
    return { privateKeyPem: readFileSync(join(process.cwd(), ".devstack", "canon-service-local.key"), "utf8"), issuer: `${env.NEXT_PUBLIC_SITE_URL}/service`, kid: "canon-local-1" };
  } catch {
    return null;
  }
}

/** The request's IP address as Canon's edge reports it: Cloudflare's, else the first X-Forwarded-For hop, else X-Real-IP. */
export function requestIp(headers: Headers): string | null {
  const first = headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip");
  const ip = first?.trim();
  return ip && /^[0-9a-fA-F:.]{2,64}$/.test(ip) ? ip : null;
}

/** A token carrying `ip` and `userAgent` for one transition, for `subject` (the person's Clerk id) when known. */
export function signEvidence(config: ServiceJwtConfig, act: EvidenceAct, seen: { ip: string | null; userAgent: string | null }, subject: string | null, now = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT", kid: config.kid };
  const payload = {
    iss: config.issuer, aud: EVIDENCE_AUDIENCE, iat: now, exp: now + TTL_SECONDS, act: evidenceActHash(act),
    ...(subject ? { sub: subject } : {}), ...(seen.ip ? { ip: seen.ip } : {}), ...(seen.userAgent ? { ua: seen.userAgent.slice(0, 400) } : {}),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(createSign("RSA-SHA256").update(input).sign(createPrivateKey(config.privateKeyPem)))}`;
}
