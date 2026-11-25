import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { trustedClientIp } from "../src/lib/clientIp.ts";
import { smokeBypassAllowed } from "../src/lib/smokeBypass.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const env = { CANON_SERVICE_JWT_ISSUER: "https://test.example/service", CANON_AUTH: "convex", CANON_SETUP_CODE: "setup-code-123456" };
const loaded = loadConvex(["cliAuth.ts", "agentAuth.ts", "lib.ts", "lib/membership.ts", "convexAuthUsers.ts", "http.ts"], {}, { process: { env } });

test("only the deployment-selected ingress header supplies client IPs on every surface", () => {
  const headers = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "cf-connecting-ip": "3.3.3.3" });
  assert.equal(trustedClientIp(headers, {}), null);
  assert.equal(trustedClientIp(headers, { CANON_CLIENT_IP_HEADER: "x-forwarded-for" }), "2.2.2.2");
  assert.equal(trustedClientIp(headers, { CANON_CLIENT_IP_HEADER: "cf-connecting-ip" }), "3.3.3.3");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of walk("src").filter((p) => /\.tsx?$/.test(p) && p !== "src/lib/clientIp.ts")) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /["'](?:x-forwarded-for|cf-connecting-ip)["']/i, file);
  }
});

test("both insertion bridges require the server identity before invoking an internal mutation", async () => {
  for (const [file, name] of [["cliAuth.ts", "startFromServer"], ["agentAuth.ts", "registerFromServer"]]) {
    let calls = 0;
    const ctx = { auth: { getUserIdentity: async () => null as any }, runMutation: async () => { calls++; return {}; } };
    for (const identity of [null, { subject: "auth_broker_server", issuer: "untrusted" }, { subject: "user", issuer: env.CANON_SERVICE_JWT_ISSUER }]) {
      ctx.auth.getUserIdentity = async () => identity;
      await assert.rejects(loaded[file][name].handler(ctx, {}));
    }
    assert.equal(calls, 0);
    ctx.auth.getUserIdentity = async () => ({ subject: "auth_broker_server", issuer: env.CANON_SERVICE_JWT_ISSUER });
    await loaded[file][name].handler(ctx, {});
    assert.equal(calls, 1);
  }
});

test("pairing limits are persisted per IP without a deployment-wide pending cap", async () => {
  const db = memoryDb({});
  const start = loaded["cliAuth.ts"].start;
  for (let i = 0; i < 10; i++) await start.handler({ db }, { registrationIpHash: "a", deviceCodeHash: String(i), userCode: String(i) });
  await assert.rejects(start.handler({ db }, { registrationIpHash: "a", deviceCodeHash: "blocked", userCode: "blocked" }));
  await start.handler({ db }, { registrationIpHash: "b", deviceCodeHash: "other", userCode: "other" });
  assert.equal(db.rows("cliAuthRequests").length, 11);
});

test("agent registration keeps the durable per-IP limit behind the broker", async () => {
  const db = memoryDb({});
  const register = loaded["agentAuth.ts"].register;
  const args = (n: number, ip = "a") => ({ name: `Agent ${n}`, operatorContact: `ops${n}@example.com`, tokenHash: String(n).repeat(64), registrationIpHash: ip.repeat(64) });
  for (let i = 0; i < 5; i++) await register.handler({ db }, args(i));
  await assert.rejects(register.handler({ db }, args(5)));
  await register.handler({ db }, args(6, "b"));
  assert.equal(db.rows("agentRegistrations").length, 6);
});

test("home membership activation and role override apply to credentials and membership checks", async () => {
  const user = { _id: "user", clerkUserId: "user_ok", orgId: "org", isActive: true, role: "admin" };
  const db = memoryDb({ users: [user], orgMemberships: [{ _id: "member", userId: "user", orgId: "org", isActive: true, role: "rep" }] });
  const member = loaded["lib/membership.ts"].credentialMember as any;
  const belongs = loaded["lib.ts"].userBelongsToOrg as any;
  assert.equal((await member({ db }, user, "org")).role, "rep");
  await db.patch("user", { isActive: false });
  assert.equal(await belongs({ db }, { ...user, isActive: false }, "org"), false);
  assert.equal(await member({ db }, user, "org"), null);
  assert.equal(await (loaded["lib.ts"].userRowBelongsToOrg as any)({ db }, user, "org"), true);
});

test("Convex registration requires first-owner setup and later invitations", async () => {
  const create = loaded["convexAuthUsers.ts"].createOrUpdateUser as any;
  const db = memoryDb({});
  const args = { type: "credentials", profile: { email: "a@example.com" } };
  await assert.rejects(create({ db, scheduler: { runAfter: async () => "scheduled" } }, args));
  assert.equal(db.rows("users").length, 0);
  await create({ db, scheduler: { runAfter: async () => "scheduled" } }, { ...args, profile: { ...args.profile, setupCode: env.CANON_SETUP_CODE } });
  await assert.rejects(create({ db, scheduler: { runAfter: async () => "scheduled" } }, { ...args, profile: { email: "b@example.com", setupCode: env.CANON_SETUP_CODE } }));
});

test("production refuses smoke bypass and development checks both token headers", () => {
  for (const name of ["x-fsgtm-smoke-bypass", "x-fsgtm-ui-smoke"]) {
    const headers = new Headers({ [name]: "token" });
    assert.equal(smokeBypassAllowed(headers, { NODE_ENV: "production", FSGTM_SMOKE_BYPASS_TOKEN: "token" }), false);
    assert.equal(smokeBypassAllowed(headers, { NODE_ENV: "development", FSGTM_SMOKE_BYPASS_TOKEN: "token" }), true);
    assert.equal(smokeBypassAllowed(headers, { NODE_ENV: "development", FSGTM_SMOKE_BYPASS_TOKEN: "wrong" }), false);
  }
});

test("webhook auth responses do not distinguish missing ids, missing signatures or bad signatures", async () => {
  for (const prefix of ["/agents/webhook/", "/connectors/webhook/"]) {
    const [handler] = (loaded["http.ts"].default as any).lookup(`${prefix}example`, "POST");
    const responses = [];
    for (const stored of [null, { secret: "test-secret", agentId: "example", linkId: "example" }]) {
      for (const headers of [new Headers(), new Headers({ "x-canon-signature": "invalid", "x-canon-timestamp": String(Math.floor(Date.now() / 1000)) })]) {
        const response = await handler({ runQuery: async () => stored }, new Request(`https://test.example${prefix}example`, { method: "POST", body: "{}", headers }));
        responses.push([response.status, await response.text()]);
      }
    }
    for (const response of responses) assert.deepEqual(response, responses[0]);
    assert.equal(responses[0][0], 401);
  }
});

test("record-service webhook rejects incorrect authorization and accepts the configured token", async () => {
  const config = { RECORD_SERVICE_TOKEN: "test-secret" };
  const http = loadConvex(["http.ts"], {}, { process: { env: config } })["http.ts"].default as any;
  const [handler] = http.lookup("/record-service/changes", "POST");
  for (const token of ["", "Bearer wrong", "Bearer test-secret"]) {
    const response = await handler({}, new Request("https://test.example/record-service/changes", { method: "POST", headers: { authorization: token }, body: "{}" }));
    assert.equal(response.status, token === "Bearer test-secret" ? 200 : 401);
  }
});

test("only a workspace manager can enable a Convex-auth invitation, and signup requires it", async () => {
  let actor: any = { _id: "admin", orgId: "org", role: "admin", isActive: true };
  const m = loadConvex(["users.ts", "convexAuthUsers.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async () => actor }) }, { process: { env } });
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [{ _id: "member", orgId: "org", clerkUserId: "member:invited", email: "invited@example.com", isActive: true, role: "rep" }] });
  const ctx = { db, runQuery: async (_ref: unknown, args: unknown) => m["users.ts"].inviteTarget.handler({ db }, args), runMutation: async (_ref: unknown, args: unknown) => m["users.ts"].recordInvite.handler({ db }, args) };
  const input = { type: "oauth", profile: { email: "invited@example.com", emailVerified: true } };
  const create = m["convexAuthUsers.ts"].createOrUpdateUser as any;
  await assert.rejects(create({ db }, input));
  actor = { ...actor, role: "rep" };
  await assert.rejects(m["users.ts"].invite.handler(ctx, { userId: "member" }));
  actor = { ...actor, role: "admin", orgId: "other" };
  await assert.rejects(m["users.ts"].invite.handler(ctx, { userId: "member" }));
  actor = { ...actor, orgId: "org" };
  await m["users.ts"].invite.handler(ctx, { userId: "member" });
  assert.equal(await create({ db }, input), "member");
  await db.patch("member", { isActive: false });
  await assert.rejects(create({ db }, input));
});
