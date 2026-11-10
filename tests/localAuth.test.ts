import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { jwksFor, signServiceJwt } from "../src/lib/canonServiceJwt.ts";
import { hashPassword, verifyPassword, signLocalSessionToken } from "../src/lib/localAuthCrypto.ts";
import { localAuthGate } from "../src/lib/localAuthGate.ts";
import { setupCodeMatches } from "../src/lib/setupCode.ts";
import { newSetupCode } from "../scripts/selfhost/platform.mjs";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("local passwords and session identities use scrypt and the existing RS256 provider", async () => {
  const password = "a long local password";
  const hash = await hashPassword(password);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const config = { privateKeyPem, issuer: "https://crm.example.com/service", kid: "local-test" };
  const subject = "local_12345678-1234-1234-1234-123456789abc";
  const token = signLocalSessionToken(config, subject, "local", 1000);
  const [header, payload, signature] = token.split(".");
  const key = createPublicKey({ key: jwksFor(privateKeyPem, config.kid).keys[0], format: "jwk" });
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")), true);
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}x`), key, Buffer.from(signature, "base64url")), false);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(claims, { iss: config.issuer, aud: "canon-service", sub: subject, org_id: "local", iat: 1000, exp: 1300, canon_session: "local" });
  const { agentClientOf } = loadConvex(["lib.ts"])["lib.ts"] as unknown as { agentClientOf: (ctx: unknown) => Promise<string | null> };
  const before = { CANON_AUTH: process.env.CANON_AUTH, CANON_SERVICE_JWT_ISSUER: process.env.CANON_SERVICE_JWT_ISSUER };
  try {
    process.env.CANON_AUTH = "local";
    process.env.CANON_SERVICE_JWT_ISSUER = config.issuer;
    const classify = (payload: Record<string, unknown>) => agentClientOf({ auth: { getUserIdentity: async () => ({ ...payload, issuer: payload.iss, subject: payload.sub }) } });
    assert.equal(await classify(claims), null, "a signed local session can use human-only operations");
    const agent = signServiceJwt(config, { clerkUserId: subject, clerkOrgId: "local", clientId: "local" }, 1000);
    const agentClaims = JSON.parse(Buffer.from(agent.split(".")[1], "base64url").toString());
    assert.equal(await classify(agentClaims), "local", "an agent for the same member remains an agent");
    assert.equal(await classify({ ...agentClaims, azp: undefined }), "unknown");
    process.env.CANON_AUTH = "clerk";
    assert.equal(await classify(claims), "unknown", "the hosted mode retains its service-token rules");
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.throws(() => signLocalSessionToken(config, "local_auth_server", "local"));
});

test("local auth gates pages and APIs using a live session, while sign-in and invites stay reachable", async () => {
  const sessions = new Set(["valid"]);
  const resolve = async (token: string | undefined) => token && sessions.has(token);
  const request = (path: string, cookie?: string) => new Request(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
  assert.equal((await localAuthGate(request("/dashboard"), resolve))?.status, 307);
  assert.equal((await localAuthGate(request("/dashboard", "canon_session=forged"), resolve))?.status, 307);
  assert.equal(await localAuthGate(request("/dashboard", "canon_session=valid"), resolve), null);
  sessions.clear();
  assert.equal((await localAuthGate(request("/dashboard", "canon_session=valid"), resolve))?.status, 307);
  assert.equal((await localAuthGate(request("/api/modules/transition"), resolve))?.status, 401);
  for (const path of ["/sign-in", "/sign-up?invite=test", "/api/local-auth", "/api/public/version"]) assert.equal(await localAuthGate(request(path), resolve), null);
});

test("credential lookup and registration admit only the local auth broker", async () => {
  const env = { CANON_AUTH: "local", CANON_SERVICE_JWT_ISSUER: "https://canon.test/service" };
  const handlers = loadConvex(["localAuth.ts"], {}, { process: { env } })["localAuth.ts"];
  const credential = { _id: "credential", email: "ada@example.com", userId: "user", passwordHash: "test-hash" };
  const db = memoryDb({ localCredentials: [credential], organizations: [{ _id: "org", clerkOrgId: "local" }] });
  const broker = { issuer: env.CANON_SERVICE_JWT_ISSUER, subject: "local_auth_server" };
  let identity: typeof broker | null = null;
  const ctx = { db, auth: { getUserIdentity: async () => identity } };
  const registration = { email: "new@example.com", name: "New member", passwordHash: "test-hash", subject: "local_12345678-1234-1234-1234-123456789abc", tokenHash: "test-session", expiresAt: Date.now() + 1000 };
  for (const denied of [null, { ...broker, issuer: "https://foreign.test" }, { ...broker, subject: "local_member" }]) {
    identity = denied;
    await assert.rejects(handlers.credential.handler(ctx, { email: credential.email }), /Local auth server required/);
    await assert.rejects(handlers.register.handler(ctx, registration), /Local auth server required/);
  }
  identity = broker;
  env.CANON_AUTH = "clerk";
  await assert.rejects(handlers.credential.handler(ctx, { email: credential.email }), /Local auth server required/);
  await assert.rejects(handlers.register.handler(ctx, registration), /Local auth server required/);
  env.CANON_AUTH = "local";
  assert.equal((await handlers.credential.handler(ctx, { email: credential.email }))._id, credential._id);
  await assert.rejects(handlers.register.handler(ctx, registration), /Setup is complete/);
  assert.equal(db.rows("localCredentials").length, 1);
  assert.equal(db.rows("localSessions").length, 0);
});

test("the first owner registers only with the install's setup code", () => {
  const code = newSetupCode();
  assert.match(code, /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
  assert.notEqual(code, newSetupCode());
  assert.equal(setupCodeMatches(code, code), true);
  assert.equal(setupCodeMatches(` ${code.toLowerCase().replaceAll("-", " ")} `, code), true, "typed from a log, in any case and spacing");
  for (const given of [undefined, "", code.slice(0, -1), `${code}2`, newSetupCode()]) assert.equal(setupCodeMatches(given, code), false);
  for (const expected of [undefined, "", "short"]) assert.equal(setupCodeMatches(expected, expected), false, "no configured code admits nobody");
});
