import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  chownRecursive,
  convexCliEnv,
  finalizeStartup,
  nextEnv,
  recordServiceEnv,
  resolveInternalUrl,
  workerdEnv,
} from "../scripts/selfhost/entrypoint.mjs";
import { checkHealth } from "../scripts/selfhost/health.mjs";
import { backendEnv } from "../scripts/selfhost/platform.mjs";
import { requiresClerkPublishableKey } from "../scripts/start-standalone.mjs";

const FULL_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/canon",
  NODE_ENV: "production",
  SITE_URL: "https://crm.example.com",
  APP_URL: "https://crm.example.com",
  NEXT_PUBLIC_SITE_URL: "https://crm.example.com",
  NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
  CONVEX_CLOUD_ORIGIN: "https://crm.example.com/convex",
  CONVEX_SITE_ORIGIN: "https://crm.example.com/convex-site",
  CANON_AUTH: "local",
  CANON_SETUP_CODE: "ABCDE-FGHIJ-KLMNO",
  CANON_SERVICE_JWT_PRIVATE_KEY: `-----BEGIN ${"PRIVATE"} KEY-----\nsecret\n-----END ${"PRIVATE"} KEY-----`,
  CANON_SERVICE_JWT_ISSUER: "https://crm.example.com/service",
  CANON_SERVICE_JWT_KID: "canon-selfhost-1",
  CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
  CONVEX_SELF_HOSTED_ADMIN_KEY: "admin-key-secret",
  INSTANCE_NAME: "canoncrm-selfhost",
  INSTANCE_SECRET: "instance-secret",
  TOKEN_ENCRYPTION_KEY: "token-encryption-key-secret",
  RECORD_SERVICE_TOKEN: "record-service-token-secret",
  RECIPE_RUNTIME_SECRET: "recipe-runtime-secret",
  CLERK_SECRET_KEY: "sk_test_clerk",
  BACKUP_S3_BUCKET: "canon-backups",
  BACKUP_S3_ENDPOINT: "https://r2.example.com",
  BACKUP_S3_ACCESS_KEY_ID: "r2-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "r2-secret",
  DATA_DIR: "/data/convex",
  CREDENTIALS_DIR: "/data/credentials",
  OPENAI_API_KEY: "sk-openai-secret",
  RELEASE_GIT_SHA: "abcdef1234567890",
};

test("per-process env allowlists isolate secrets across record-service, Next, workerd, Convex, and Convex CLI", () => {
  const records = recordServiceEnv(FULL_ENV);
  assert.equal(records.RECORD_SERVICE_TOKEN, FULL_ENV.RECORD_SERVICE_TOKEN);
  assert.equal(records.BACKUP_S3_BUCKET, "canon-backups");
  assert.equal(records.DATA_DIR, "/data/records");
  assert.equal(records.PORT, "8787");
  assert.equal(records.HOST, "127.0.0.1");
  assert.equal(records.GIT_SHA, FULL_ENV.RELEASE_GIT_SHA);
  for (const forbidden of [
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "INSTANCE_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "CANON_SERVICE_JWT_PRIVATE_KEY",
    "RECIPE_RUNTIME_SECRET",
    "CANON_SETUP_CODE",
    "CLERK_SECRET_KEY",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(forbidden in records, false, `record-service must not receive ${forbidden}`);
  }

  const next = nextEnv(FULL_ENV, { port: "10000", setupCode: "SETUP-CODE1-TEST2" });
  assert.equal(next.PORT, "10000");
  assert.equal(next.CANON_INTERNAL_URL, "http://127.0.0.1:10000");
  assert.equal(next.CANON_SETUP_CODE, "SETUP-CODE1-TEST2");
  assert.equal(next.CANON_SERVICE_JWT_PRIVATE_KEY, FULL_ENV.CANON_SERVICE_JWT_PRIVATE_KEY);
  for (const forbidden of [
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "INSTANCE_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "RECORD_SERVICE_TOKEN",
    "RECIPE_RUNTIME_SECRET",
    "BACKUP_S3_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(forbidden in next, false, `Next must not receive ${forbidden}`);
  }

  assert.equal(resolveInternalUrl({}, "8080"), "http://127.0.0.1:8080");
  assert.equal(resolveInternalUrl({ CANON_INTERNAL_URL: "http://127.0.0.1:3000" }, "10000"), "http://127.0.0.1:10000");
  assert.equal(resolveInternalUrl({ CANON_INTERNAL_URL: "http://127.0.0.1:9999" }, "10000"), "http://127.0.0.1:9999");

  const workerd = workerdEnv(FULL_ENV);
  assert.deepEqual(Object.keys(workerd).sort(), ["PATH", "RECIPE_RUNTIME_SECRET"]);

  const convex = backendEnv(FULL_ENV, { backend: "http://127.0.0.1:3210", backendSite: "http://127.0.0.1:3211" });
  assert.equal(convex.INSTANCE_SECRET, FULL_ENV.INSTANCE_SECRET);
  assert.equal(convex.CANON_INTERNAL_CONVEX_URL, "http://127.0.0.1:3210");
  for (const forbidden of [
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "TOKEN_ENCRYPTION_KEY",
    "CANON_SERVICE_JWT_PRIVATE_KEY",
    "RECORD_SERVICE_TOKEN",
    "RECIPE_RUNTIME_SECRET",
    "CANON_SETUP_CODE",
    "CLERK_SECRET_KEY",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(forbidden in convex, false, `Convex backend process must not receive ${forbidden}`);
  }

  const cli = convexCliEnv(FULL_ENV);
  assert.equal(cli.CONVEX_SELF_HOSTED_URL, "http://127.0.0.1:3210");
  assert.equal(cli.CONVEX_SELF_HOSTED_ADMIN_KEY, FULL_ENV.CONVEX_SELF_HOSTED_ADMIN_KEY);
  for (const forbidden of [
    "INSTANCE_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "CANON_SERVICE_JWT_PRIVATE_KEY",
    "RECORD_SERVICE_TOKEN",
    "RECIPE_RUNTIME_SECRET",
  ]) {
    assert.equal(forbidden in cli, false, `Convex CLI must not receive ${forbidden}`);
  }

  const entrypointSource = readFileSync("scripts/selfhost/entrypoint.mjs", "utf8");
  assert.doesNotMatch(entrypointSource, /--env-file/, "Convex CLI receives credentials via env, not a temp file");
  const dockerfile = readFileSync("Dockerfile.selfhost", "utf8");
  assert.match(dockerfile, /^EXPOSE 3000$/m, "only the public app port is exposed");
  assert.doesNotMatch(dockerfile, /CANON_INTERNAL_URL=/, "CANON_INTERNAL_URL is derived dynamically from PORT");
});

test("finalizeStartup runs migrations before writing the ready marker and fails startup if a migration throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-entrypoint-epoch-"));
  try {
    const readyFile = join(dir, "ready");
    const contract = { epoch: 2, minEpoch: 1, migrations: [{ epoch: 2, run: "migrations:two" }] };
    writeFileSync(join(dir, "data-epoch"), "1\n");

    const order: string[] = [];
    await assert.rejects(
      finalizeStartup({
        dataDir: dir,
        contract,
        fromEpoch: 1,
        readyFile,
        runMigration: async (m: { run: string }) => {
          order.push(`migrate:${m.run}`);
          throw new Error("boom");
        },
        markReady: async () => {
          order.push("ready");
          writeFileSync(readyFile, "ready\n");
        },
      }),
      /Migration migrations:two failed/,
    );
    assert.deepEqual(order, ["migrate:migrations:two"]);
    assert.equal(existsSync(readyFile), false, "failed migration must not mark container ready");
    assert.equal(readFileSync(join(dir, "data-epoch"), "utf8"), "1\n");

    order.length = 0;
    const result = await finalizeStartup({
      dataDir: dir,
      contract,
      fromEpoch: 1,
      readyFile,
      runMigration: async (m: { run: string }) => {
        order.push(`migrate:${m.run}`);
        assert.equal(existsSync(readyFile), false, "ready marker must not exist while migration runs");
      },
      markReady: async () => {
        order.push("ready");
        writeFileSync(readyFile, "ready\n");
      },
    });
    assert.deepEqual(result, { epoch: 2 });
    assert.deepEqual(order, ["migrate:migrations:two", "ready"]);
    assert.equal(existsSync(readyFile), true);
    assert.equal(readFileSync(join(dir, "data-epoch"), "utf8"), "2\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chownRecursive traverses nested files and directories and uses lchown on symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-chown-"));
  try {
    const nested = join(dir, "convex");
    mkdirSync(nested, { recursive: true });
    const file = join(nested, "db.sqlite3");
    writeFileSync(file, "data");
    const link = join(dir, "link");
    symlinkSync(file, link);

    const chowned: string[] = [];
    const lchowned: string[] = [];
    const { lstat, readdir } = await import("node:fs/promises");
    await chownRecursive(dir, 1001, 1001, {
      lstat,
      readdir,
      chown: async (target: string, uid: number, gid: number) => {
        assert.equal(uid, 1001);
        assert.equal(gid, 1001);
        chowned.push(target);
      },
      lchown: async (target: string, uid: number, gid: number) => {
        assert.equal(uid, 1001);
        assert.equal(gid, 1001);
        lchowned.push(target);
      },
    });
    assert.deepEqual(lchowned, [link]);
    assert.ok(chowned.includes(dir) && chowned.includes(nested) && chowned.includes(file));
    assert.equal(chowned.includes(link), false, "symlinks must never be followed by chown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health check probes built-in workerd when RECIPE_RUNTIME_URL is unset and skips it when external", async () => {
  const probed: string[] = [];
  const fakeFetch = (async (url: string) => {
    probed.push(url);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  let runtimeCalls = 0;
  await checkHealth({
    env: { PORT: "8080", RECIPE_RUNTIME_URL: "" },
    fetchImpl: fakeFetch,
    checkReady: async () => {},
    checkRuntime: async (url: string) => {
      runtimeCalls += 1;
      assert.equal(url, "http://127.0.0.1:8790");
      return true;
    },
  });
  assert.equal(runtimeCalls, 1);
  assert.ok(probed.includes("http://127.0.0.1:8080/api/public/version"));

  await assert.rejects(
    checkHealth({
      env: {},
      fetchImpl: fakeFetch,
      checkReady: async () => {},
      checkRuntime: async () => false,
    }),
    /8790/,
  );

  runtimeCalls = 0;
  await checkHealth({
    env: { RECIPE_RUNTIME_URL: "https://runtime.example.com" },
    fetchImpl: fakeFetch,
    checkReady: async () => {},
    checkRuntime: async () => {
      runtimeCalls += 1;
      return false;
    },
  });
  assert.equal(runtimeCalls, 0);
});

test("start-standalone exempts CANON_AUTH=convex and CANON_AUTH=local from requiring Clerk publishable key", () => {
  assert.equal(requiresClerkPublishableKey({ CANON_AUTH: "convex" }), false);
  assert.equal(requiresClerkPublishableKey({ CANON_AUTH: "local" }), false);
  assert.equal(requiresClerkPublishableKey({ CANON_AUTH: "clerk" }), true);
  assert.equal(requiresClerkPublishableKey({}), true);
  assert.equal(requiresClerkPublishableKey({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_123" }), false);

  const dir = mkdtempSync(join(tmpdir(), "start-standalone-test-"));
  try {
    mkdirSync(join(dir, ".next/standalone"), { recursive: true });
    writeFileSync(join(dir, ".next/standalone/server.js"), 'console.log("standalone-started:" + process.env.CANON_AUTH);\n');
    const script = resolve("scripts/start-standalone.mjs");
    const convexRun = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "production", CANON_AUTH: "convex" },
    });
    assert.equal(convexRun.status, 0, convexRun.stderr);
    assert.match(convexRun.stdout, /standalone-started:convex/);

    const missingClerk = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "production" },
    });
    assert.notEqual(missingClerk.status, 0);
    assert.match(missingClerk.stderr, /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
