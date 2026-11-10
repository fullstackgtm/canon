import assert from "node:assert/strict";
import { test } from "node:test";
import { convexClient } from "../src/app/api/gtm/_lib.ts";
import { GET as gtmSummary } from "../src/app/api/gtm/summary/route.ts";
import { POST as cliToken } from "../src/app/api/cli/token/route.ts";
import { POST as cliRun } from "../src/app/api/cli/run/route.ts";
import { startConvexStub } from "./fixtures/convexStub.ts";

/**
 * The tenant-isolation proof: a self-registered agent token must be rejected
 * by every org-scoped surface (/api/gtm/*, /api/cli/*), with a teaching error
 * that names the upgrade path — while existing token types keep exactly
 * today's behavior.
 */

delete process.env.NEXT_PUBLIC_SITE_URL;
process.env.NEXT_PUBLIC_CONVEX_URL ??= "http://127.0.0.1:1";

const AGENT_TOKEN = `fsgtm_agent_${"ab".repeat(32)}`;

function withBearer(url: string, token: string, ip = "203.0.113.50") {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ provider: "hubspot" }),
  });
}

test("convexClient rejects agent tokens with a teaching 403", async () => {
  const request = withBearer("http://localhost/api/gtm/summary", AGENT_TOKEN);
  const result = convexClient(request);
  assert.ok("error" in result && result.error, "agent token must be rejected");
  const error = result.error;
  assert.equal(error.status, 403);
  const body = await error.json();
  assert.equal(body.error, "insufficient_scope");
  assert.match(body.message, /fullstackgtm login --via/);
  assert.match(body.message, /\/api\/public\//);
  assert.ok(body.register_uri.endsWith("/api/agents/register"));
  assert.match(error.headers.get("www-authenticate") ?? "", /insufficient_scope/);
});

test("an org-scoped /api/gtm route rejects an agent token end to end", async () => {
  const response = await gtmSummary(
    withBearer("http://localhost/api/gtm/summary", AGENT_TOKEN),
  );
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(body.message, /human-approved pairing/i);
});

test("/api/cli/token and /api/cli/run reject agent tokens without touching Convex", async () => {
  const stub = await startConvexStub(() => ({ value: null }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    for (const route of [cliToken, cliRun]) {
      const response = await route(
        withBearer("http://localhost/api/cli/token", AGENT_TOKEN),
      );
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error, "insufficient_scope");
      assert.match(body.message, /pairing/);
    }
    assert.equal(stub.calls.length, 0, "no Convex function may see an agent token");
  } finally {
    await stub.close();
  }
});

test("existing broker tokens keep exactly today's behavior on /api/cli/token", async () => {
  const stub = await startConvexStub(() => ({
    value: { accessToken: "minted-hubspot-token", fieldMappings: {} },
  }));
  process.env.NEXT_PUBLIC_CONVEX_URL = stub.url;
  try {
    const response = await cliToken(
      withBearer("http://localhost/api/cli/token", "fsgtm_regular_broker_token"),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accessToken, "minted-hubspot-token");
    assert.equal(stub.calls[0]?.path, "cliAuthActions:mintProviderToken");
  } finally {
    await stub.close();
  }
});

test("existing Clerk-style bearer tokens still reach convexClient unrejected", () => {
  process.env.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:1";
  const request = withBearer("http://localhost/api/gtm/summary", "eyJhbGciOi.fake.jwt");
  const result = convexClient(request);
  assert.ok(!("error" in result && result.error), "must not be rejected");
  assert.ok("client" in result && result.client);
});
