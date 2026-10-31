/**
 * Short-lived Convex identities for agent requests (hosted MCP, canon CLI).
 *
 * Agents authenticate to the app with a Clerk OAuth access token (MCP clients,
 * `canon login`) or a paired CLI token. The app verifies that credential, then
 * signs a 5-minute RS256 JWT for the same user. Convex trusts it as a second
 * auth provider (convex/auth.config.ts), so every existing query and mutation
 * applies its normal user, role and org checks; nothing is special-cased.
 *
 * Claims mirror what getCurrentUser reads from a Clerk session JWT: `sub` is
 * the Clerk user id and `org_id` the active Clerk organization.
 */
import { createPrivateKey, createPublicKey, createSign, type KeyObject } from "node:crypto";

export const SERVICE_JWT_AUDIENCE = "canon-service";
const TTL_SECONDS = 300;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export type ServiceJwtConfig = { privateKeyPem: string; issuer: string; kid: string };

export function serviceJwtConfig(env: Record<string, string | undefined> = process.env): ServiceJwtConfig | null {
  const pem = env.CANON_SERVICE_JWT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const issuer = env.CANON_SERVICE_JWT_ISSUER;
  if (!pem || !issuer) return null;
  return { privateKeyPem: pem, issuer, kid: env.CANON_SERVICE_JWT_KID ?? "canon-1" };
}

export function signServiceJwt(
  config: ServiceJwtConfig,
  claims: { clerkUserId: string; clerkOrgId?: string | null; clientId?: string; localSession?: true },
  now = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT", kid: config.kid };
  const payload = {
    iss: config.issuer,
    aud: SERVICE_JWT_AUDIENCE,
    sub: claims.clerkUserId,
    iat: now,
    exp: now + TTL_SECONDS,
    ...(claims.clerkOrgId ? { org_id: claims.clerkOrgId } : {}),
    ...(claims.clientId ? { azp: claims.clientId } : {}),
    ...(claims.localSession ? { canon_session: "local" } : {}),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(createPrivateKey(config.privateKeyPem));
  return `${input}.${b64url(signature)}`;
}

/** The public JWKS for a private key (what Convex is configured with). */
export function jwksFor(privateKeyPem: string, kid: string): { keys: Array<Record<string, string>> } {
  const pub: KeyObject = createPublicKey(createPrivateKey(privateKeyPem));
  const jwk = pub.export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}
