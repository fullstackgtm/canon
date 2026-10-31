import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { signServiceJwt, type ServiceJwtConfig } from "./canonServiceJwt.ts";

const scrypt = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});
export const newLocalSecret = () => randomBytes(32).toString("base64url");
export const hashLocalSecret = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt);
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, stored] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !stored || !/^[a-f0-9]{128}$/.test(stored)) return false;
  const hash = await scrypt(password, salt);
  return timingSafeEqual(hash, Buffer.from(stored, "hex"));
}

export function signLocalSessionToken(config: ServiceJwtConfig, subject: string, org: string, now?: number) {
  if (!/^local_[a-f0-9-]{36}$/.test(subject) || org !== "local") throw new Error("Invalid local session identity");
  return signServiceJwt(config, { clerkUserId: subject, clerkOrgId: org, localSession: true }, now);
}
