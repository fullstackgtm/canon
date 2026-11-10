import assert from "node:assert/strict";
import { test } from "node:test";
import { clientCredentialsError, mintClientCredentialsToken, myDomainOrigin, salesforceCanRefresh, tokenExpiresAt } from "../convex/lib/salesforceClientCredentials.ts";

test("a pasted My Domain, Lightning address or org page becomes the My Domain origin", () => {
  assert.equal(myDomainOrigin("acme.my.salesforce.com"), "https://acme.my.salesforce.com");
  assert.equal(myDomainOrigin(" https://acme.my.salesforce.com/ "), "https://acme.my.salesforce.com");
  assert.equal(myDomainOrigin("https://acme.lightning.force.com/lightning/setup/SetupOneHome/home"), "https://acme.my.salesforce.com");
  assert.equal(myDomainOrigin("https://ACME--uat.sandbox.lightning.force.com"), "https://acme--uat.sandbox.my.salesforce.com");
});

test("a URL that is not an org's My Domain is refused before any key leaves", () => {
  for (const bad of ["", "not a url", "http://acme.my.salesforce.com", "https://evil.example.com", "https://salesforce.com.evil.io"]) {
    assert.throws(() => myDomainOrigin(bad), bad);
  }
  assert.throws(() => myDomainOrigin("https://login.salesforce.com"), /My Domain/);
  assert.throws(() => myDomainOrigin("test.salesforce.com"), /My Domain/);
});

test("the key mints a token at the org's token endpoint", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ access_token: "00Dtoken", instance_url: "https://acme.my.salesforce.com", id: "https://login.salesforce.com/id/00D/005" }));
  }) as typeof fetch;
  const token = await mintClientCredentialsToken({ domain: "https://acme.my.salesforce.com", clientId: "key", clientSecret: "secret" }, fetcher);
  assert.ok(token.expiresAt > Date.now() + 14 * 60 * 1000, "an opaque token lasts the shortest session timeout");
  assert.deepEqual({ ...token, expiresAt: 0 }, { accessToken: "00Dtoken", expiresAt: 0, instanceUrl: "https://acme.my.salesforce.com", identityUrl: "https://login.salesforce.com/id/00D/005" });
  assert.equal(calls[0].url, "https://acme.my.salesforce.com/services/oauth2/token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { grant_type: "client_credentials", client_id: "key", client_secret: "secret" });
});

test("a token whose instance URL is not Salesforce is refused", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ access_token: "t", instance_url: "https://evil.example.com" }))) as unknown as typeof fetch;
  await assert.rejects(mintClientCredentialsToken({ domain: "https://acme.my.salesforce.com", clientId: "k", clientSecret: "s" }, fetcher));
});

test("an unreachable My Domain says to check the URL", async () => {
  const fetcher = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(
    mintClientCredentialsToken({ domain: "https://nope.my.salesforce.com", clientId: "k", clientSecret: "s" }, fetcher),
    /Could not reach https:\/\/nope\.my\.salesforce\.com/,
  );
});

test("Salesforce's refusals say what to change", () => {
  assert.match(clientCredentialsError(400, JSON.stringify({ error: "invalid_client_id", error_description: "client identifier invalid" })), /consumer key or secret/);
  assert.match(clientCredentialsError(400, JSON.stringify({ error: "invalid_grant", error_description: "no client credentials user enabled" })), /run-as user/);
  assert.match(clientCredentialsError(400, JSON.stringify({ error: "unsupported_grant_type" })), /Client Credentials Flow/);
  assert.match(clientCredentialsError(404, "<html>"), /HTTP 404/);
});

test("a JWT access token's own expiry wins over the session default", () => {
  const now = 1_700_000_000_000;
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  assert.equal(tokenExpiresAt(jwt({ exp: now / 1000 + 300 }), now), now + 300_000, "a five-minute JWT");
  assert.equal(tokenExpiresAt(jwt({ exp: now / 1000 + 86_400 }), now), now + 15 * 60 * 1000, "never longer than the default");
  assert.equal(tokenExpiresAt("00Dxx!opaque", now), now + 15 * 60 * 1000);
  assert.equal(tokenExpiresAt("a.b.c", now), now + 15 * 60 * 1000, "an unreadable payload");
});

test("scheduled syncs skip OAuth connections this deployment cannot refresh", () => {
  assert.equal(salesforceCanRefresh({ clientCredentials: "enc" }, {}), true);
  assert.equal(salesforceCanRefresh({}, {}), false);
  assert.equal(salesforceCanRefresh({}, { SALESFORCE_CLIENT_ID: "id" }), true);
});
