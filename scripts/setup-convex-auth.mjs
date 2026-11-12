import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseEnv } from "node:util";

const file = process.argv[2];
if (!file || !/^\.env.*\.local$/.test(file)) throw new Error("Usage: node scripts/setup-convex-auth.mjs .env.convex-auth.local");
const source = existsSync(file) ? readFileSync(file, "utf8") : "";
const kept = parseEnv(source);
const pem = kept.JWT_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const jwk = createPublicKey(pem).export({ format: "jwk" });
const values = { CANON_AUTH: "convex", JWT_PRIVATE_KEY: pem.trimEnd(), JWKS: JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256" }] }) };
const entries = Object.entries({ ...kept, ...values }).sort(([a], [b]) => a.localeCompare(b));
if (entries.some(([, value]) => value.includes("'"))) throw new Error("Single quotes are not supported in this dedicated auth env file");
writeFileSync(file, `${entries.map(([key, value]) => `${key}='${value}'`).join("\n")}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Convex Auth keys saved privately to ${file}. Apply this file to your own backend environment; keep it out of version control.`);
