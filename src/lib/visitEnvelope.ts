import { createHash, createPrivateKey, createSign, randomBytes } from "node:crypto";
import type { ServiceJwtConfig } from "./canonServiceJwt.ts";
import { canonicalJson } from "../../modules/kernel/integrity.ts";
import type { VisitArgs, VisitFunction } from "../../modules/kernel/visit.ts";

export const visitHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const visitSecret = () => randomBytes(32).toString("base64url");

export function visitRequestIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const name = env.CANON_CLIENT_IP_HEADER?.toLowerCase();
  if (!name) return "unknown";
  const raw = headers.get(name);
  const ip = (name === "x-forwarded-for" ? raw?.split(",").at(-1) : raw)?.trim();
  return ip && /^[0-9a-fA-F:.]{2,64}$/.test(ip) ? ip : "unknown";
}

export function signVisitEnvelope(config: ServiceJwtConfig, fn: VisitFunction, args: VisitArgs, seen: { ip: string; ua: string }, now = Math.floor(Date.now() / 1000)): string {
  const claims = {
    iss: config.issuer, aud: "canon-visit", iat: now, exp: now + 120, fn,
    args: visitHash(canonicalJson(args)),
    ...("tokenHash" in args ? { tok: args.tokenHash } : { sid: args.sessionHash }),
    ip: seen.ip, ua: seen.ua.slice(0, 400), nonce: randomBytes(16).toString("base64url"),
  };
  const input = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: config.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(createPrivateKey(config.privateKeyPem)).toString("base64url")}`;
}
