import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

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
update(appFile, { CANON_AUTH: "local", NEXT_PUBLIC_SITE_URL: site.origin, CANON_SERVICE_JWT_PRIVATE_KEY: pem, CANON_SERVICE_JWT_ISSUER: issuer, CANON_SERVICE_JWT_KID: kid });
update(convexFile, { CANON_AUTH: "local", FSGTM_ENABLE_DEMO_DATA: "false", CANON_SERVICE_JWT_ISSUER: issuer, CANON_SERVICE_JWKS: jwks });
console.log(`Local auth configured in ${appFile}. Apply ${convexFile} to your own Convex backend before deploying functions. No private key is included in the backend file.`);
