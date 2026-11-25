import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createHash, generateKeyPairSync } from "node:crypto";
import { POST as startResearch } from "../src/app/api/lead-magnet/start/route.ts";
import { canonJobTools } from "../src/app/mcp/_canonJobTools.ts";
import { startConvexStub } from "./fixtures/convexStub.ts";

import { rateLimit } from "../src/app/api/cli/_lib.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const limit = rateLimit;
test("polling and sign-in have separate flood budgets even without a trusted IP", () => {
  delete process.env.CANON_CLIENT_IP_HEADER;
  const request = new Request("http://localhost/api/cli/auth/poll");
  for (let i = 0; i < 20; i++) assert.equal(limit(request, "/api/cli/auth/poll", 60), true);
  assert.equal(limit(request, "/api/local-auth", 15), true);
  for (let i = 0; i < 10; i++) assert.equal(limit(request, "/api/cli/auth/start", 10), true);
  assert.equal(limit(request, "/api/cli/auth/start", 10), false);
});

const research = loadConvex(["researchSessions.ts"])["researchSessions.ts"]!;
test("research creation is broker-only and the broker delegates to the internal start", async () => {
  const original = process.env.CANON_SERVICE_JWT_ISSUER;
  process.env.CANON_SERVICE_JWT_ISSUER = "https://broker.example";
  let writes = 0;
  const ctx: any = { auth: { getUserIdentity: async () => null }, runMutation: async () => { writes++; return { token: "session", cached: false }; } };
  try {
    assert.ok(research.startFromServer);
    for (const identity of [null, { issuer: "untrusted", subject: "auth_broker_server" }, { issuer: process.env.CANON_SERVICE_JWT_ISSUER, subject: "member" }]) {
      ctx.auth.getUserIdentity = async () => identity;
      await assert.rejects(research.startFromServer.handler(ctx, { domain: "vendor.example", ipHash: "network" }));
    }
    assert.equal(writes, 0);
    ctx.auth.getUserIdentity = async () => ({ issuer: process.env.CANON_SERVICE_JWT_ISSUER, subject: "auth_broker_server" });
    assert.equal((await research.startFromServer.handler(ctx, { domain: "vendor.example", ipHash: "network" })).token, "session");
    assert.equal(writes, 1);
  } finally {
    if (original === undefined) delete process.env.CANON_SERVICE_JWT_ISSUER;
    else process.env.CANON_SERVICE_JWT_ISSUER = original;
  }
});

test("cached example clones consume a domain budget before scheduling record writes", async () => {
  const db = memoryDb({ researchSessions: [{ _id: "cached", domain: "linear.app", token: "cached-token", status: "ready", createdAt: Date.now(), briefStatus: "ready" }], researchRateLimits: [{ _id: "domain-budget", key: "cached-domain:linear.app", count: 297, windowStart: Date.now() }] });
  let scheduled = 0;
  const ctx: any = { db, scheduler: { runAfter: async () => { scheduled++; } } };
  for (let i = 0; i < 3; i++) {
    assert.equal((await research.start.handler(ctx, { domain: "linear.app", ipHash: `network-${i}`, example: true })).cached, true);
  }
  await assert.rejects(research.start.handler(ctx, { domain: "linear.app", ipHash: "other", example: true }));
  assert.equal(scheduled, 3);
  assert.equal(db.rows("researchSessions").length, 4);
});

test("uncached research reserves IP, domain and global budgets and schedules the pipeline", async () => {
  const db = memoryDb({});
  const calls: string[] = [];
  const ctx: any = { db, scheduler: { runAfter: async (_delay: number, ref: unknown) => calls.push(String(ref)) } };
  assert.equal((await research.start.handler(ctx, { domain: "vendor.example", ipHash: "new-network" })).cached, false);
  assert.deepEqual(db.rows("researchRateLimits").map((r) => r.key).sort(), ["domain:vendor.example", "global", "ip:new-network"]);
  assert.deepEqual(calls, ["internal.researchSessionActions.run"]);
});


test("local sign-in keeps account budgets separate when the ingress has no IP", async () => {
  const require = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync("src/app/api/local-auth/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  let signIns = 0;
  const lib = await import("../src/app/api/cli/_lib.ts");
  runInNewContext(source, {
    exports, process: { env: { CANON_AUTH: "local" } }, Response,
    require: (id: string) => {
      if (id.endsWith("_generated/api")) return { api: { localAuth: { credential: "credential", signIn: "signIn" } } };
      if (id === "../cli/_lib") return lib;
      if (id === "@/lib/authMode") return { LOCAL_SESSION_COOKIE: "session" };
      if (id === "@/lib/localAuthOrigin") return { isLocalAuthOriginAllowed: () => true, localAuthCookieSecure: () => false };
      if (id === "@/lib/setupCode") return { setupCodeMatches: () => false };
      if (id === "@/lib/localAuth") return {
        hashLocalSecret: (s: string) => createHash("sha256").update(s).digest("hex"),
        newLocalSecret: () => "session-secret", SESSION_SECONDS: 100,
        verifyPassword: async (p: string) => p === "right-password",
        localAuthBroker: () => ({ query: async () => ({ _id: "credential", passwordHash: "hash" }), mutation: async () => { signIns++; } }),
      };
      return require(id);
    },
  });
  const attempt = (email: string, password = "bad") => exports.POST(new Request("http://localhost/api/local-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "sign-in", email, password }) }));
  for (let i = 0; i < 15; i++) assert.equal((await attempt("flood@example.test")).status, 401);
  assert.equal((await attempt(" FLOOD@example.test ")).status, 429);
  assert.equal((await attempt("other@example.test", "right-password")).status, 200);
  assert.equal(signIns, 1);
});

test("marketing and MCP research start use the server broker with a server-derived IP hash", async () => {
  const saved = { ...process.env };
  const stub = await startConvexStub(() => ({ value: { token: "new-session", cached: true } }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  process.env.CANON_SERVICE_JWT_ISSUER = "https://broker.example";
  process.env.CANON_SERVICE_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  delete process.env.CANON_CLIENT_IP_HEADER;
  const request = new Request("http://localhost/api/lead-magnet/start", { method: "POST", body: JSON.stringify({ domain: "linear.app", example: true, ipHash: "spoofed" }) });
  try {
    const response = await startResearch(request);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie")?.includes("new-session"));
    const tool = canonJobTools.find((t) => t.name === "canon_research")!;
    await tool.run({} as any, { action: "start", args: { domain: "vendor.example" } }, new Request("http://localhost/mcp"));
    assert.equal(stub.calls.length, 2);
    for (const call of stub.calls) {
      assert.equal(call.kind, "action");
      assert.equal(call.path, "researchSessions:startFromServer");
      assert.match(String(call.args.ipHash), /^[a-f0-9]{32}$/);
    }
  } finally {
    await stub.close();
    for (const key of ["NEXT_PUBLIC_CONVEX_URL", "CANON_SERVICE_JWT_ISSUER", "CANON_SERVICE_JWT_PRIVATE_KEY", "CANON_CLIENT_IP_HEADER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});


test("cached research also refuses exhausted IP and global budgets without cloning", async () => {
  for (const [key, count] of [["ip:network", 5], ["cached-global", 300]] as const) {
    const db = memoryDb({
      researchSessions: [{ _id: "cached", domain: "notion.so", token: "cached-token", status: "ready", createdAt: Date.now() }],
      researchRateLimits: [{ _id: "budget", key, count, windowStart: Date.now() }],
    });
    let scheduled = 0;
    const ctx: any = { db, scheduler: { runAfter: async () => { scheduled++; } } };
    await assert.rejects(research.start.handler(ctx, { domain: "notion.so", ipHash: "network", example: true }));
    assert.equal(scheduled, 0);
    assert.equal(db.rows("researchSessions").length, 1);
  }
});
