import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseEnv } from "node:util";
import { newSetupCode, newTokenEncryptionKey } from "./selfhost/platform.mjs";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--app-env", "--convex-env", "--site-url"].includes(args[i]) || !args[i + 1]) throw new Error("Usage: node scripts/setup-local-auth.mjs --site-url https://crm.example.com [--app-env .env.local] [--convex-env .env.local-auth.local]");
  options[args[i]] = args[i + 1];
}
const appFile = options["--app-env"] ?? ".env.local";
const convexFile = options["--convex-env"] ?? ".env.local-auth.local";
if (appFile === convexFile) throw new Error("Use separate app and Convex env files. The private key belongs only to Next.");
if (existsSync(appFile)) process.loadEnvFile(appFile);
const site = new URL(options["--site-url"] ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
if (site.protocol !== "https:" && !(site.protocol === "http:" && ["localhost", "127.0.0.1"].includes(site.hostname))) throw new Error("Use HTTPS except on localhost");
const pem = process.env.CANON_SERVICE_JWT_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const kid = process.env.CANON_SERVICE_JWT_KID ?? "canon-local-1";
const issuer = process.env.CANON_SERVICE_JWT_ISSUER ?? `${site.origin}/service`;
const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
const jwks = `data:text/plain;charset=utf-8;base64,${Buffer.from(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] })).toString("base64")}`;
function update(file, values) {
  const keys = new Set(Object.keys(values));
  const lines = (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []).filter((line) => !keys.has(line.split("=", 1)[0]));
  const additions = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  writeFileSync(file, `${lines.join("\n").trimEnd()}\n${additions.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
// The code the first owner enters at /sign-in (src/lib/setupCode.ts), kept across reruns.
const setupCode = process.env.CANON_SETUP_CODE ?? newSetupCode();
// The backend's credential key, kept across reruns: a new one would make every stored credential unreadable.
const keptKey = existsSync(convexFile) ? parseEnv(readFileSync(convexFile, "utf8")).TOKEN_ENCRYPTION_KEY : undefined;
const givenKey = process.env.TOKEN_ENCRYPTION_KEY?.trim() || undefined;
if (keptKey && givenKey && keptKey !== givenKey) throw new Error(`TOKEN_ENCRYPTION_KEY differs from the one in ${convexFile}. Keep the key your backend already has: a new one makes every stored credential unreadable.`);
const tokenKey = keptKey || givenKey || newTokenEncryptionKey();
update(appFile, { CANON_AUTH: "local", NEXT_PUBLIC_SITE_URL: site.origin, CANON_SERVICE_JWT_PRIVATE_KEY: pem, CANON_SERVICE_JWT_ISSUER: issuer, CANON_SERVICE_JWT_KID: kid, CANON_SETUP_CODE: setupCode });
update(convexFile, { CANON_AUTH: "local", FSGTM_ENABLE_DEMO_DATA: "false", CANON_SERVICE_JWT_ISSUER: issuer, CANON_SERVICE_JWKS: jwks, TOKEN_ENCRYPTION_KEY: tokenKey });
console.log(`Local auth configured in ${appFile}. Apply ${convexFile} to your own Convex backend before deploying functions. The signing key stays out of the backend file. That file holds TOKEN_ENCRYPTION_KEY, which encrypts stored credentials: keep it and back it up with your database. The first owner enters CANON_SETUP_CODE from ${appFile} at /sign-in.`);
