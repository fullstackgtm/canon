import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { jwksFor, serviceJwtConfig, signServiceJwt, SERVICE_JWT_AUDIENCE } from "../src/lib/canonServiceJwt.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("service JWTs carry the Clerk user and org, expire in 5 minutes, and verify against the published JWKS", () => {
  const config = serviceJwtConfig({ CANON_SERVICE_JWT_PRIVATE_KEY: pem.replace(/\n/g, "\\n"), CANON_SERVICE_JWT_ISSUER: "https://canoncrm.com/service" });
  assert.ok(config);
  const jwt = signServiceJwt(config, { clerkUserId: "user_1", clerkOrgId: "org_9", clientId: "client_x" }, 1000);
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "canon-1" });
  assert.deepEqual(payload, { iss: "https://canoncrm.com/service", aud: SERVICE_JWT_AUDIENCE, sub: "user_1", iat: 1000, exp: 1300, org_id: "org_9", azp: "client_x" });
  const jwk = jwksFor(config.privateKeyPem, "canon-1").keys[0];
  assert.equal(jwk.kid, "canon-1");
  assert.equal(jwk.d, undefined, "the JWKS never contains private material");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url")));
});

test("no service identity without both a key and an issuer", () => {
  assert.equal(serviceJwtConfig({ CANON_SERVICE_JWT_ISSUER: "x" }), null);
  assert.equal(serviceJwtConfig({ CANON_SERVICE_JWT_PRIVATE_KEY: pem }), null);
});
