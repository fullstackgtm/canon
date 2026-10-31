import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { verifyDeployment } from "../scripts/selfhost/verify.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { deploy, parseArgs, selectTarget } from "../scripts/selfhost-deploy.ts";

test("target selection confines credentials and rejects non-prod keys and applies the private worktree policy when installed", () => {
  const env = { CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:43210", CONVEX_SELF_HOSTED_ADMIN_KEY: "local-secret", CONVEX_DEPLOY_KEY: "prod:user-owned-123|cloud-test" };
  assert.deepEqual(selectTarget("self-hosted", env, true).credentials, { CONVEX_SELF_HOSTED_URL: env.CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY: env.CONVEX_SELF_HOSTED_ADMIN_KEY });
  assert.deepEqual(selectTarget("convex-cloud", env, false).credentials, { CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY });
  if (existsSync(new URL("../scripts/selfhost-deploy.private.json", import.meta.url))) {
    assert.throws(() => selectTarget("convex-cloud", env, true));
  } else {
    assert.equal(selectTarget("convex-cloud", env, true).url, "https://user-owned-123.convex.cloud");
  }
  for (const key of [undefined, "dev:user-owned-123|secret", "preview:team:project|secret", "project:team:project|secret", "malformed"]) assert.throws(() => selectTarget("convex-cloud", { CONVEX_DEPLOY_KEY: key }, false));
  assert.throws(() => parseArgs(["--target", "self-hosted", "--admin-key", "secret"]));
});

test("a failed deploy resumes with the same signing key and no credentials in frontend or argv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "canon-deploy-resume-"));
  try {
    mkdirSync(join(cwd, "scripts"));
    copyFileSync("scripts/setup-local-auth.mjs", join(cwd, "scripts/setup-local-auth.mjs"));
    mkdirSync(join(cwd, "node_modules/convex/bin"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/convex/bin/main.js"), `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const path = args[args.indexOf('--env-file') + 1];
      const target = fs.readFileSync(path, 'utf8');
      if (target.includes('cloud-test') || process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_DEPLOYMENT) process.exit(9);
      if (args.some(a => a.includes('local-secret'))) process.exit(10);
      if (args[0] === 'env') {
        const backend = fs.readFileSync(args[args.indexOf('--from-file') + 1], 'utf8');
        if (!backend.includes('FSGTM_ENABLE_DEMO_DATA="false"') || backend.includes('PRIVATE_KEY')) process.exit(11);
      }
      if (args[0] === 'deploy' && !fs.existsSync('.attempted')) { fs.writeFileSync('.attempted', ''); process.exit(1); }
    `);
    const options = parseArgs(["--target", "self-hosted"]);
    const env = { PATH: process.env.PATH, CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:43210", CONVEX_SELF_HOSTED_ADMIN_KEY: "local-secret", CONVEX_DEPLOY_KEY: "prod:user-owned-123|cloud-test", CONVEX_DEPLOYMENT: "dev:irrelevant", SITE_URL: "http://localhost:43211" };
    assert.throws(() => deploy(options, env, cwd));
    const appFile = join(cwd, options.appEnv);
    const first = parseEnv(readFileSync(appFile, "utf8"));
    assert.ok(first.CANON_SERVICE_JWT_PRIVATE_KEY?.includes("BEGIN PRIVATE KEY"));
    deploy(options, env, cwd);
    const second = parseEnv(readFileSync(appFile, "utf8"));
    assert.equal(first.CANON_SERVICE_JWT_PRIVATE_KEY, second.CANON_SERVICE_JWT_PRIVATE_KEY);
    assert.equal(second.NEXT_PUBLIC_CONVEX_URL, env.CONVEX_SELF_HOSTED_URL);
    assert.equal(second.CANON_AUTH, "local");
    assert.equal(statSync(appFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(appFile, "utf8").includes("local-secret"), false);
    assert.equal(readFileSync(appFile, "utf8").includes("cloud-test"), false);
    assert.throws(() => deploy(options, { ...env, SITE_URL: "https://different.example.com" }, cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("dry runs validate the complete plan without writing files or invoking Convex", () => {
  const cwd = mkdtempSync(join(tmpdir(), "canon-deploy-test-"));
  try {
    const env = { CONVEX_DEPLOY_KEY: "prod:user-owned-123|secret", SITE_URL: "https://crm.example.com" };
    deploy(parseArgs(["--target", "convex-cloud", "--dry-run"]), env, cwd);
    assert.deepEqual(readdirSync(cwd), []);
    assert.throws(() => deploy(parseArgs(["--target", "convex-cloud", "--dry-run"]), { ...env, SITE_URL: "http://example.com" }, cwd));
    const input = join(cwd, ".env.input");
    writeFileSync(input, 'CONVEX_SELF_HOSTED_URL="http://127.0.0.1:43210"\nCONVEX_SELF_HOSTED_ADMIN_KEY="do-not-print"\nSITE_URL="http://localhost:43211"\n');
    const before = readFileSync(input, "utf8");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/selfhost-deploy.ts"), "--target", "self-hosted", "--dry-run", "--env-file", input], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes("do-not-print"), false);
    assert.equal(readFileSync(input, "utf8"), before);
    assert.deepEqual(readdirSync(cwd), [".env.input"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("verification creates and reads CRM records, checks restart persistence, and rejects demo access", async () => {
  const requests: string[] = [];
  let registered = false;
  let demo = false;
  let company: Record<string, unknown> | null = null;
  let person: Record<string, unknown> | null = null;
  let deal: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(`${request.url}:${body.kind ?? body.path ?? ""}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/public/version") return response.end('{"environment":"selfhost"}');
    if (request.url === "/sign-in") {
      response.setHeader("Content-Type", "text/html");
      return response.end("<html><body>Sign in</body></html>");
    }
    if (request.url === "/api/local-auth") {
      if (request.method === "GET") {
        assert.equal(request.headers.cookie, "session=test");
        return response.end('{"token":"signed-test-token"}');
      }
      assert.equal(request.headers.origin, site);
      if (body.kind === "sign-in" && !registered) { response.statusCode = 401; return response.end('{}'); }
      if (body.kind === "register") registered = true;
      response.setHeader("Set-Cookie", "session=test; HttpOnly; Path=/");
      return response.end('{"ok":true}');
    }
    if (["/api/query", "/api/action"].includes(request.url ?? "")) {
      const authenticated = request.headers.authorization === "Bearer signed-test-token";
      const result = (value: unknown) => response.end(JSON.stringify({ status: "success", value }));
      if (body.path === "users:me") return result(authenticated || demo ? { _id: "owner1", email: "owner@example.test", role: "admin" } : null);
      assert.equal(authenticated, true);
      if (body.path === "records:upsert") {
        if (body.args.object === "account") {
          company = { id: "company1", ...body.args.accounts[0] };
          return result({ upserted: 1, ids: ["company1"] });
        }
        person = { id: "person1", ...body.args.contacts[0] };
        return result({ upserted: 1, ids: ["person1"] });
      }
      if (body.path === "records:get") return result(company ? { account: company, contacts: person ? [person] : [] } : null);
      if (body.path === "pipelines:list") return result([{ id: null, stages: [{ value: "qualified" }] }]);
      if (body.path === "deals:createScoped") {
        deal = { _id: "deal1", ...body.args };
        return result({ dealId: "deal1" });
      }
      assert.equal(body.path, "deals:get");
      return result(deal);
    }
    assert.equal(request.url, "/dashboard");
    assert.equal(request.headers.cookie, "session=test");
    response.end("CanonCRM dashboard");
  });
  server.on("upgrade", (request, socket) => {
    assert.equal(request.url, "/api/1.31.7/sync");
    const key = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    socket.on("data", () => socket.end(Buffer.from([0x88, 0])));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}`;
  const env = { SELFHOST_SMOKE_EMAIL: "owner@example.test", SELFHOST_SMOKE_PASSWORD: "test-owner-password" };
  try {
    let restarts = 0;
    await verifyDeployment(site, site, true, env, { restart: async () => { restarts++; } });
    assert.equal(restarts, 1);
    assert.ok(company && person && deal);
    assert.equal(requests.filter((path) => path === "/api/local-auth:register").length, 1);
    assert.equal(requests.at(-1), "/api/local-auth:sign-out");
    await verifyDeployment(site, site, false, env);
    assert.equal(requests.filter((path) => path === "/api/local-auth:register").length, 1);
    await assert.rejects(verifyDeployment(site, site, false, env, { restart: async () => { company = null; } }));
    demo = true;
    await assert.rejects(verifyDeployment(site, site, false, env));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
