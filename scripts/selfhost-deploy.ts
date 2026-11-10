import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

type Env = Record<string, string | undefined>;
type Target = { kind: "self-hosted"; url: string; credentials: Env } |
  { kind: "convex-cloud"; url: string; credentials: Env };
type Options = { target: Target["kind"]; dryRun: boolean; appEnv: string; envFile?: string };
const policyFile = new URL("./selfhost-deploy.private.json", import.meta.url);
const privatePolicy = existsSync(policyFile) ? z.object({
  deployments: z.array(z.string().min(1)),
  hostnames: z.array(z.string().min(1)),
}).parse(JSON.parse(readFileSync(policyFile, "utf8"))) : undefined;
const usage = "npm run selfhost:deploy -- --target <self-hosted|convex-cloud> [--env-file <path>] [--app-env <path>] [--dry-run]";

export function parseArgs(args: string[]): Options {
  const options: Options = { target: "self-hosted", dryRun: false, appEnv: ".env.selfhost.local" };
  let target = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (!["--target", "--env-file", "--app-env"].includes(arg) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
    const value = args[++i];
    if (arg === "--target") {
      if (value !== "self-hosted" && value !== "convex-cloud") throw new Error(usage);
      options.target = value;
      target = true;
    } else if (arg === "--env-file") options.envFile = value;
    else options.appEnv = value;
  }
  if (!target) throw new Error(usage);
  return options;
}

function publicUrl(value: string | undefined, name: string): string {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error(`${name} must be a URL`); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error(`${name} must be an HTTPS origin, or HTTP on localhost, without credentials`);
  }
  if (privatePolicy?.deployments.some((name) => url.hostname === `${name}.convex.cloud` || url.hostname === `${name}.convex.site`) ||
      privatePolicy?.hostnames.some((hostname) => url.hostname === hostname || url.hostname.endsWith(`.${hostname}`))) throw new Error("Refusing a CanonCRM-owned URL");
  return url.origin;
}

export function selectTarget(kind: Target["kind"], env: Env, agentWorktree: boolean): Target {
  if (kind === "self-hosted") {
    const url = publicUrl(env.CONVEX_SELF_HOSTED_URL, "CONVEX_SELF_HOSTED_URL");
    if (new URL(url).hostname.endsWith(".convex.cloud") || new URL(url).hostname.endsWith(".convex.site")) throw new Error("Use convex-cloud for a Convex Cloud backend");
    if (!env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim()) throw new Error("Set CONVEX_SELF_HOSTED_ADMIN_KEY in the environment or --env-file");
    return { kind, url, credentials: { CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: env.CONVEX_SELF_HOSTED_ADMIN_KEY } };
  }
  if (privatePolicy?.deployments.some((name) => env.CONVEX_DEPLOY_KEY?.includes(name) || env.CONVEX_DEPLOYMENT?.includes(name))) throw new Error("Refusing a CanonCRM-owned deployment");
  if (privatePolicy && agentWorktree) throw new Error("convex-cloud is forbidden inside a CanonCRM agent worktree, including dry runs. Run from your own checkout.");
  const match = /^prod:([a-z0-9]+(?:-[a-z0-9]+)+)\|[^\s|]+$/.exec(env.CONVEX_DEPLOY_KEY ?? "");
  if (!match) throw new Error("Set CONVEX_DEPLOY_KEY to your own production deploy key in the environment or --env-file");
  return { kind, url: `https://${match[1]}.convex.cloud`, credentials: { CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY } };
}

function readEnv(path: string): Env {
  return parseEnv(readFileSync(path, "utf8"));
}

function writeEnv(path: string, values: Env) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function isAgentWorktree(cwd: string, env: Env): boolean {
  const git = spawnSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8" });
  const paths = git.stdout?.trim().split("\n");
  return Boolean(env.CANONCRM_AGENT_GUARD || env.T3CODE_THREAD_ID || env.CODEX_THREAD_ID ||
    (paths?.length === 2 && resolve(cwd, paths[0]) !== resolve(cwd, paths[1])));
}

export function deploy(options: Options, inherited: Env = process.env, cwd = process.cwd()) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) throw new Error("Node 22.6 or newer is required");
  const env = { ...inherited, ...(options.envFile ? readEnv(resolve(cwd, options.envFile)) : {}) };
  const target = selectTarget(options.target, env, isAgentWorktree(cwd, env));
  const site = publicUrl(env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL, "SITE_URL");
  const appFile = resolve(cwd, options.appEnv);
  if (options.envFile && appFile === resolve(cwd, options.envFile)) throw new Error("Use separate input and frontend env files");
  if (existsSync(appFile)) {
    const previous = readEnv(appFile);
    if ((previous.NEXT_PUBLIC_CONVEX_URL && previous.NEXT_PUBLIC_CONVEX_URL !== target.url) ||
        (previous.NEXT_PUBLIC_SITE_URL && previous.NEXT_PUBLIC_SITE_URL !== site)) throw new Error("Frontend env belongs to a different install. Use a separate --app-env file.");
  }
  console.log(`Target: ${target.kind}. Backend: ${target.url}`);
  console.log(`Plan: preserve or generate local-auth keys; set CANON_AUTH, CANON_SERVICE_JWT_ISSUER, CANON_SERVICE_JWKS, FSGTM_ENABLE_DEMO_DATA=false, SITE_URL; deploy functions; write ${options.appEnv}.`);
  if (options.dryRun) { console.log("Dry run: no files, subprocess deploys, or network requests."); return; }
  if (!existsSync(join(cwd, "node_modules/convex/bin/main.js"))) throw new Error("Run npm ci before deploying");
  const temporary = mkdtempSync(join(tmpdir(), "canon-selfhost-"));
  const sandbox = join(temporary, "home");
  mkdirSync(sandbox, { mode: 0o700 });
  const cliEnv: Env = { ...inherited, HOME: sandbox, CI: "1", CONVEX_DISABLE_TELEMETRY: "1" };
  for (const key of Object.keys(cliEnv)) if (key.startsWith("CONVEX_") || key.startsWith("CANON_SERVICE_")) delete cliEnv[key];
  cliEnv.CONVEX_DISABLE_TELEMETRY = "1";
  const run = (script: string, args: string[], childEnv: Env, label: string) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...childEnv, NODE_ENV: "production" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(`${label} failed. Output suppressed to protect credentials. Fix the target configuration and rerun; the signing key is preserved.`);
    console.log(`${label} complete.`);
  };
  try {
    const backendFile = join(temporary, ".env.backend");
    const selectionFile = join(temporary, ".env.target");
    const saved = existsSync(appFile) ? readEnv(appFile) : {};
    const authEnv = { ...cliEnv, ...saved };
    for (const key of ["CANON_SERVICE_JWT_PRIVATE_KEY", "CANON_SERVICE_JWT_ISSUER", "CANON_SERVICE_JWT_KID", "CANON_SETUP_CODE"]) {
      if (!saved[key] && env[key]) authEnv[key] = env[key];
    }
    run(join(cwd, "scripts/setup-local-auth.mjs"), ["--site-url", site, "--app-env", appFile, "--convex-env", backendFile], authEnv, "Local auth setup");
    const auth = readEnv(appFile);
    writeEnv(appFile, {
      CANON_AUTH: "local", CANON_SERVICE_JWT_PRIVATE_KEY: auth.CANON_SERVICE_JWT_PRIVATE_KEY,
      CANON_SERVICE_JWT_ISSUER: auth.CANON_SERVICE_JWT_ISSUER, CANON_SERVICE_JWT_KID: auth.CANON_SERVICE_JWT_KID, CANON_SETUP_CODE: auth.CANON_SETUP_CODE,
      NEXT_PUBLIC_CONVEX_URL: target.url, NEXT_PUBLIC_SITE_URL: site, SITE_URL: site, APP_ENVIRONMENT: "selfhost", FSGTM_ENABLE_DEMO_DATA: "false",
    });
    writeEnv(backendFile, { ...readEnv(backendFile), SITE_URL: site });
    writeEnv(selectionFile, target.credentials);
    const cli = join(cwd, "node_modules/convex/bin/main.js");
    run(cli, ["env", "set", "--from-file", backendFile, "--force", "--env-file", selectionFile], cliEnv, "Convex environment");
    run(cli, ["deploy", "--yes", "--env-file", selectionFile], cliEnv, "Convex deploy");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  console.log(`Frontend env ready: ${options.appEnv} (0600). Keep and back up this signing key with your database.`);
  console.log("Vercel: import this repository and add every frontend env variable to Production before building.");
  console.log("Railway: connect this repository, add every frontend env variable before building, and use npm run build / npm start.");
  console.log("Do not give the frontend CONVEX_DEPLOY_KEY or CONVEX_SELF_HOSTED_ADMIN_KEY. Rebuild after changing public URLs or auth mode.");
  console.log(`Create the first owner at ${site}/sign-in with the setup code in ${options.appEnv} (CANON_SETUP_CODE).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { deploy(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Deployment failed"); process.exitCode = 1; }
}
