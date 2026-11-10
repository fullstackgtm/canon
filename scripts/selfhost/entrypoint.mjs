import { spawn } from "node:child_process";
import { randomBytes, generateKeyPairSync, createPublicKey } from "node:crypto";
import { chown, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { INTEGRATIONS_AVAILABLE, integrationEnabled, integrationNeeds } from "../../convex/lib/integrationsAvailable.ts";
import { functionsDigest, mustPush } from "./functions.mjs";
import { advanceDataEpoch, checkDataEpoch, imageContract } from "./dataEpoch.mjs";
import { newSetupCode, newTokenEncryptionKey, platformSiteUrl, SETUP_CODE_FILE } from "./platform.mjs";

// How the processes in this container reach each other. SITE_URL and its port are the browser's
// address: the published port can differ from the container's, and a public domain may not
// resolve from inside, so no process calls another through it.
const BACKEND = "http://127.0.0.1:3210";
const BACKEND_SITE = "http://127.0.0.1:3211";
const RECORDS = "http://127.0.0.1:8787";
const PUSHED = "/data/convex/pushed-functions.json";

process.umask(0o077);
const children = new Set();
let stopping = false;

async function stop(code) {
  if (stopping) return;
  stopping = true;
  await rm("/tmp/canoncrm-ready", { force: true });
  const deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code || 1);
  }, 30_000);
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once("close", resolve);
    child.kill("SIGTERM");
  })));
  clearTimeout(deadline);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop(0));

function start(name, command, args, env, cwd = "/app", capture = false) {
  if (stopping) throw new Error("Container is stopping");
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  children.add(child);
  let output = "";
  if (capture) child.stdout.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${name} exited with code ${code}`));
    });
  });
  done.catch(() => {});
  return { child, done };
}

function daemon(name, command, args, env, cwd) {
  const running = start(name, command, args, env, cwd);
  running.done.then(() => {
    if (!stopping) { console.error(`${name} stopped`); void stop(1); }
  }, (error) => { console.error(error.message); void stop(1); });
}

async function persisted(file, generate) {
  try { return (await readFile(file, "utf8")).trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const value = await generate();
  await writeFile(`${file}.tmp`, value, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return value;
}

function origin(value, name) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP or HTTPS origin`);
  }
  return url.origin;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (stopping) throw new Error("Container is stopping");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready at ${url}`);
}

async function convexEnvNames(dir) {
  const keys = new Set();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "_generated") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const key of await convexEnvNames(path)) keys.add(key);
    else if (entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/(?:process\.env\.|(?:setting|requiredEnv|requiredEnvironment)\(["'])([A-Z][A-Z0-9_]*)/g)) keys.add(match[1]);
    }
  }
  return keys;
}

async function main() {
  if (process.getuid() === 0) {
    await chown("/data", 1001, 1001);
    process.setgroups([]);
    process.setgid(1001);
    process.setuid(1001);
  }
  await rm("/tmp/canoncrm-ready", { force: true });
  const port = process.env.PORT || "3000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || [3210, 3211, 8787].includes(Number(port))) {
    throw new Error("PORT must be an available TCP port other than 3210, 3211, or 8787");
  }
  const site = origin(process.env.SITE_URL || platformSiteUrl(process.env) || "http://localhost:3000", "SITE_URL");
  const publicBackend = process.env.CONVEX_PUBLIC_URL ? origin(process.env.CONVEX_PUBLIC_URL, "CONVEX_PUBLIC_URL") : `${site}/convex`;
  const publicActions = process.env.CONVEX_PUBLIC_SITE_URL ? origin(process.env.CONVEX_PUBLIC_SITE_URL, "CONVEX_PUBLIC_SITE_URL") : `${site}/convex-site`;
  const contract = imageContract();
  const epoch = checkDataEpoch("/data", contract);
  if (!epoch.ok) throw new Error(epoch.reason);
  if (epoch.fresh) await advanceDataEpoch("/data", contract, contract.epoch, async () => {});
  const credentials = "/data/credentials";
  await mkdir(credentials, { recursive: true });
  await mkdir("/data/convex", { recursive: true });
  await mkdir("/data/records", { recursive: true });
  const env = { ...process.env };
  for (const key of ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"]) delete env[key];
  Object.assign(env, {
    SITE_URL: site, APP_URL: site, NEXT_PUBLIC_SITE_URL: site,
    NEXT_PUBLIC_CONVEX_URL: BACKEND, NEXT_PUBLIC_CONVEX_SITE_URL: publicActions,
    CONVEX_SELF_HOSTED_URL: BACKEND,
    DATA_DIR: "/data/convex", CREDENTIALS_DIR: credentials,
    CONVEX_CLOUD_ORIGIN: publicBackend, CONVEX_SITE_ORIGIN: publicActions,
    DISABLE_BEACON: "true", DISABLE_METRICS_ENDPOINT: "true",
    INSTANCE_NAME: "canoncrm-selfhost",
  });
  // A push loads every module to analyze it (4 s by default) and evaluates the schema under the query and
  // mutation limit (1 s). On a slow host both ran out: at 0.2 CPU the push failed and the container restarted
  // 12 times in 17 minutes. With these it was healthy in 7 minutes. An operator's own values win.
  env.ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS ||= "60";
  env.DATABASE_UDF_USER_TIMEOUT_SECONDS ||= "30";
  env.INSTANCE_SECRET = await persisted(`${credentials}/instance_secret`, () => randomBytes(32).toString("hex"));
  env.CONVEX_SELF_HOSTED_ADMIN_KEY = await persisted(`${credentials}/admin_key`, () =>
    start("admin key generation", "/convex/generate_admin_key.sh", [], env, "/convex", true).done);
  env.RECORD_SERVICE_TOKEN = await persisted(`${credentials}/record_service_token`, () => randomBytes(32).toString("hex"));
  env.TOKEN_ENCRYPTION_KEY = await persisted(`${credentials}/token_encryption_key`, newTokenEncryptionKey);
  env.CANON_SERVICE_JWT_PRIVATE_KEY = await persisted(`${credentials}/service_jwt_private.pem`, () =>
    generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
  env.CANON_SERVICE_JWT_ISSUER = `${site}/service`;
  env.CANON_SERVICE_JWT_KID = "canon-selfhost-1";
  const jwk = createPublicKey(env.CANON_SERVICE_JWT_PRIVATE_KEY).export({ format: "jwk" });
  env.CANON_SERVICE_JWKS = `data:application/json;base64,${Buffer.from(JSON.stringify({ keys: [{ ...jwk, kid: env.CANON_SERVICE_JWT_KID, alg: "RS256", use: "sig" }] })).toString("base64")}`;
  // Only Next reads the setup code, so it is not in the env the backend and record service get.
  const setupCode = process.env.CANON_SETUP_CODE?.trim() || await persisted(SETUP_CODE_FILE, newSetupCode);
  delete env.CANON_SETUP_CODE;
  env.CLERK_JWT_ISSUER_DOMAIN ||= "https://unconfigured.invalid";
  env.RECORD_SERVICE_URL = RECORDS;
  // The backend's scratch directory (run_backend.sh puts it in the volume) holds one unpacked
  // function runtime and socket per backend process, which it never removes. Nothing runs yet.
  await rm("/data/convex/tmp", { recursive: true, force: true });
  daemon("Convex", "/convex/run_backend.sh", [], env, "/convex");
  await waitFor(`${BACKEND}/version`);
  const changes = [];
  const names = await convexEnvNames("/app/convex");
  for (const [feature, definition] of Object.entries(INTEGRATIONS_AVAILABLE)) {
    for (const key of definition.keys) names.add(key);
    if ("flag" in definition) names.add(definition.flag);
    console.log(`${definition.label}: ${integrationEnabled(feature, env) ? "on" : `off (${integrationNeeds(feature)})`}`);
  }
  for (const name of names) {
    if (name === "CONVEX_CLOUD_URL" || name === "CONVEX_SITE_URL") continue;
    changes.push({ name, ...(env[name] === undefined ? {} : { value: env[name] }) });
  }
  const updated = await fetch(`${BACKEND}/api/update_environment_variables`, {
    method: "POST", headers: { Authorization: `Convex ${env.CONVEX_SELF_HOSTED_ADMIN_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ changes }),
  });
  if (!updated.ok) throw new Error(`Setting backend environment failed (${updated.status})`);
  const cliEnvFile = "/tmp/canoncrm-convex.env";
  await writeFile(cliEnvFile, `CONVEX_SELF_HOSTED_URL=${BACKEND}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY}\n`, { mode: 0o600 });
  const cli = async (args) => start("Convex CLI", process.execPath, ["node_modules/convex/bin/main.js", ...args, "--env-file", cliEnvFile], env).done;
  const digest = functionsDigest({
    source: await readFile("/app/.source-sha256", "utf8").catch(() => null),
    backend: await (await fetch(`${BACKEND}/version`)).text(),
    env: changes,
  });
  const recorded = await readFile(PUSHED, "utf8").then((text) => JSON.parse(text).digest, () => null);
  if (mustPush(digest, recorded)) {
    // Forget the last push first, so a push cut off part way is retried on the next boot.
    await rm(PUSHED, { force: true });
    console.log("Pushing functions to the in-container Convex backend");
    await cli(["deploy", "--yes", "--typecheck", "disable", "--codegen", "disable"]);
    if (digest) {
      await writeFile(`${PUSHED}.tmp`, JSON.stringify({ digest, at: new Date().toISOString() }));
      await rename(`${PUSHED}.tmp`, PUSHED);
    }
  } else console.log("Functions match the last push; not pushing them again");
  // Convex names its public site URL as the ledger source in every nudge; this pins the address beside it.
  daemon("Record service", process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"],
    { ...env, DATA_DIR: "/data/records", PORT: "8787", HOST: "127.0.0.1", PROJECTOR_SOURCE_URL: BACKEND_SITE }, "/app/services/record-service");
  await waitFor(`${RECORDS}/healthz`);
  if (env.FSGTM_ENABLE_DEMO_DATA === "true") {
    await cli(["run", "devSeed:ensureWorkspace"]);
    await cli(["run", "devSeed:provisionRecords"]);
  }
  // Next fetches the URLs Convex hands back (storage, upload routes), which carry the browser's address; these map them back inside.
  daemon("Next", process.execPath, [".next/standalone/server.js"],
    { ...env, HOSTNAME: "0.0.0.0", PORT: port, CANON_SETUP_CODE: setupCode, CANON_INTERNAL_CONVEX_URL: BACKEND, CANON_INTERNAL_CONVEX_SITE_URL: BACKEND_SITE });
  await waitFor(`http://127.0.0.1:${port}/api/public/version`);
  await writeFile("/tmp/canoncrm-ready", "ready\n");
  const advanced = await advanceDataEpoch("/data", contract, epoch.epoch, async (m) => {
    console.log(`Running migration ${m.run}`);
    await cli(["run", m.run]);
  });
  if (advanced.failed) console.log(`Migration ${advanced.failed.run} failed (${advanced.failed.error}). The volume stays at data epoch ${epoch.epoch}; restart this release to run it again (docs/updating.md).`);
  console.log(`CanonCRM ready at ${site}. Recipe runtime is off unless RECIPE_RUNTIME_URL and RECIPE_RUNTIME_SECRET are configured.`);
  const pending = await start("Convex CLI", process.execPath, ["node_modules/convex/bin/main.js", "run", "localAuth:setupPending", "--env-file", cliEnvFile], env, "/app", true)
    .done.then((out) => out.trim() === "true", () => false);
  if (pending && env.CANON_AUTH === "local") {
    const code = process.env.CANON_SETUP_CODE?.trim() ? "the CANON_SETUP_CODE value in this install's settings" : setupCode;
    console.log(`\nNo owner yet. Open ${site}/sign-in and enter setup code: ${code}\nThe first person to enter it owns this install. Back up after setup: see docs/updating.md.\n`);
  }
}

main().catch((error) => { console.error(error.message); void stop(1); });
