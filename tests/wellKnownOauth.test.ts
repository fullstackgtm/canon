import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../src/app/.well-known/_lib.ts";
import { GET as getProtectedResource } from "../src/app/.well-known/oauth-protected-resource/route.ts";
import { GET as getAuthorizationServer } from "../src/app/.well-known/oauth-authorization-server/route.ts";
import { GET as getAuthMd } from "../src/app/auth.md/route.ts";
import { GET as getLlmsTxt } from "../src/app/llms.txt/route.ts";

// Exercise the production fallbacks regardless of the local shell env.
delete process.env.NEXT_PUBLIC_SITE_URL;
delete process.env.SITE_URL;
delete process.env.CLERK_JWT_ISSUER_DOMAIN;

test("protected-resource metadata carries the required RFC 9728 fields", () => {
  const metadata = protectedResourceMetadata();

  assert.equal(metadata.resource, "https://canoncrm.com");
  // Clerk (humans/orgs) plus the app itself (agent registration/device flow).
  assert.deepEqual(metadata.authorization_servers, [
    "https://clerk.fullstackgtm.com",
    "https://canoncrm.com",
  ]);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
  assert.equal(metadata.resource_documentation, "https://canoncrm.com/llms.txt");
  // Issuer OIDC scopes plus the agent read scopes, which ARE enforced
  // per-scope on /api/public/* (see src/app/api/public/_lib.ts).
  assert.deepEqual(metadata.scopes_supported, [
    "openid",
    "profile",
    "email",
    "read:evals",
  ]);
});

test("metadata derives resource and issuer from env when set", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.com/";
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://example.clerk.accounts.dev/";
  try {
    const metadata = protectedResourceMetadata();
    assert.equal(metadata.resource, "https://staging.example.com");
    assert.deepEqual(metadata.authorization_servers, [
      "https://example.clerk.accounts.dev",
      "https://staging.example.com",
    ]);
    const authServer = authorizationServerMetadata();
    assert.equal(authServer.issuer, "https://staging.example.com");
  } finally {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
  }
});

test("GET /.well-known/oauth-protected-resource returns cacheable JSON", async () => {
  const response = getProtectedResource();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match(response.headers.get("cache-control") ?? "", /public/);

  const body = await response.json();
  assert.equal(body.resource, "https://canoncrm.com");
  assert.deepEqual(body.authorization_servers, [
    "https://clerk.fullstackgtm.com",
    "https://canoncrm.com",
  ]);
  assert.deepEqual(body.bearer_methods_supported, ["header"]);
});

test("AS metadata (RFC 8414) only claims endpoints and grants that exist", async () => {
  const response = getAuthorizationServer();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /public/);

  const body = await response.json();
  const issuer = "https://canoncrm.com";
  assert.equal(body.issuer, issuer);
  assert.equal(body.registration_endpoint, `${issuer}/api/agents/register`);
  assert.equal(
    body.device_authorization_endpoint,
    `${issuer}/api/oauth/device_authorization`,
  );
  assert.equal(body.token_endpoint, `${issuer}/api/oauth/token`);
  // The device-code grant is the ONLY grant; no redirect flows exist, so no
  // authorization endpoint and truthfully zero response types.
  assert.deepEqual(body.grant_types_supported, [
    "urn:ietf:params:oauth:grant-type:device_code",
  ]);
  assert.deepEqual(body.response_types_supported, []);
  assert.equal(body.authorization_endpoint, undefined);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(body.scopes_supported, ["read:evals"]);
});

test("AS metadata carries a spec-complete auth.md agent_auth block", async () => {
  const body = await getAuthorizationServer().json();
  const issuer = "https://canoncrm.com";
  // One complete registration method per the auth.md spec: the "anonymous"
  // identity type with both its endpoints present. Nothing unimplemented is
  // advertised (no identity_assertion, service_auth, or events_endpoint).
  assert.deepEqual(body.agent_auth, {
    skill: `${issuer}/auth.md`,
    register_uri: `${issuer}/api/agents/register`,
    claim_uri: `${issuer}/api/agents/claim`,
    identity_types_supported: ["anonymous"],
    identity_endpoint: `${issuer}/api/agents/register`,
    claim_endpoint: `${issuer}/api/agents/claim`,
    anonymous: {
      credential_types_supported: ["bearer_token"],
      registration_uri: `${issuer}/api/agents/register`,
      claim_uri: `${issuer}/api/agents/claim`,
    },
    credential_types_supported: ["bearer_token"],
    registration_scopes: ["read:evals"],
    revocation_contact: "ryan@fullstackgtm.com",
    documentation: `${issuer}/auth.md`,
  });
});

test("GET /auth.md describes both tiers and points at the metadata", async () => {
  const response = getAuthMd();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);

  const body = await response.text();
  // Tier 1: self-registration for public reads.
  assert.match(body, /POST https:\/\/canoncrm\.com\/api\/agents\/register/);
  assert.match(body, /operator_contact/);
  assert.match(body, /api\/public\/leaderboard/);
  // The claim ceremony — and its security line: ownership, never access.
  assert.match(body, /POST https:\/\/canoncrm\.com\/api\/agents\/claim/);
  assert.match(body, /claim_token/);
  assert.match(body, /never grants organization data access/);
  // Tier 2: human-approved pairing, both the CLI shortcut and RFC 8628.
  assert.match(body, /fullstackgtm login --via https:\/\/canoncrm\.com/);
  assert.match(body, /api\/oauth\/device_authorization/);
  assert.match(body, /urn:ietf:params:oauth:grant-type:device_code/);
  // Discovery pointers.
  assert.match(body, /\.well-known\/oauth-protected-resource/);
  assert.match(body, /\.well-known\/oauth-authorization-server/);
  assert.match(
    body,
    /https:\/\/clerk\.fullstackgtm\.com\/\.well-known\/openid-configuration/,
  );
});

test("GET /llms.txt serves the product summary with auth pointers", async () => {
  const response = getLlmsTxt();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  const body = await response.text();
  assert.match(body, /# CanonCRM/);
  assert.match(body, /auth\.md/);
  assert.match(body, /\.well-known\/oauth-authorization-server/);
});

test("self-host discovery and documentation use SITE_URL before the public build setting", async () => {
  process.env.SITE_URL = "https://crm.example.org/";
  process.env.NEXT_PUBLIC_SITE_URL = "https://stale.example.org";
  try {
    const metadata = protectedResourceMetadata();
    assert.equal(metadata.resource, "https://crm.example.org");
    assert.equal(metadata.resource_documentation, "https://crm.example.org/llms.txt");
    assert.equal(authorizationServerMetadata().token_endpoint, "https://crm.example.org/api/oauth/token");
    assert.match(await getAuthMd().text(), /# Authentication: https:\/\/crm\.example\.org/);
    assert.match(await getLlmsTxt().text(), /https:\/\/crm\.example\.org\/auth\.md/);
  } finally {
    delete process.env.SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  }
});
