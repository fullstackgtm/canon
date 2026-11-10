import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as mcpGet, POST as mcpPost } from "../src/app/mcp/route.ts";
import { GET as mcpResourceMetadata } from "../src/app/.well-known/oauth-protected-resource/mcp/route.ts";
import { getLeaderboardText } from "../src/app/mcp/_tools.ts";

/**
 * The remote MCP endpoint ships FLAGGED OFF (MCP_REMOTE_ENABLED). Tool
 * handlers are unit-tested against fixtures; the Clerk OAuth wrapper itself
 * (auth({acceptsToken:"oauth_token"}) + verifyClerkToken) requires a live
 * Clerk middleware context and dashboard-enabled OAuth, so it is exercised
 * by the docs/remote-mcp.md rollout checklist rather than stubbed here —
 * stubbing Clerk's request context would test the stub, not the wiring.
 */

delete process.env.MCP_REMOTE_ENABLED;

function mcpRequest(method: "GET" | "POST") {
  return new Request("http://localhost/mcp", {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    ...(method === "POST"
      ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }
      : {}),
  });
}

test("/mcp is a plain 404 while the feature flag is off", async () => {
  delete process.env.MCP_REMOTE_ENABLED;
  assert.equal((await mcpGet(mcpRequest("GET"))).status, 404);
  assert.equal((await mcpPost(mcpRequest("POST"))).status, 404);

  // "false" is not "true" — only the exact opt-in enables it.
  process.env.MCP_REMOTE_ENABLED = "false";
  try {
    assert.equal((await mcpPost(mcpRequest("POST"))).status, 404);
  } finally {
    delete process.env.MCP_REMOTE_ENABLED;
  }
});

test("the MCP protected-resource metadata is flagged off with the endpoint", async () => {
  delete process.env.MCP_REMOTE_ENABLED;
  const response = await mcpResourceMetadata(
    new Request("http://localhost/.well-known/oauth-protected-resource/mcp"),
  );
  assert.equal(response.status, 404, "metadata must never advertise a 404 endpoint");
});

test("MCP resource metadata serves the public origin, not the proxy bind address", async () => {
  // An internal reverse-proxy URL must not become the public resource identifier.
  process.env.MCP_REMOTE_ENABLED = "true";
  process.env.NEXT_PUBLIC_SITE_URL = "https://canoncrm.com";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
    "pk_test_" + Buffer.from("example.clerk.accounts.dev$").toString("base64");
  try {
    const response = await mcpResourceMetadata(
      new Request("http://0.0.0.0:3000/.well-known/oauth-protected-resource/mcp"),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resource, "https://canoncrm.com");
    assert.deepEqual(body.authorization_servers, ["https://example.clerk.accounts.dev"]);
    assert.ok(!JSON.stringify(body).includes("0.0.0.0"), "bind address must never leak");
  } finally {
    delete process.env.MCP_REMOTE_ENABLED;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  }
});

test("get_leaderboard mirrors the committed Tier-1 artifact exactly", () => {
  const board = JSON.parse(getLeaderboardText());
  assert.equal(board.benchmark, "CRM-Ops Bench");
  assert.equal(board.models.length, 10);
  assert.match(board.generatedFrom.commit, /^[0-9a-f]{40}$/);
  const fable = board.models.find(
    (entry: { model: string }) => entry.model === "anthropic/claude-fable-5",
  );
  assert.equal(fable.arms.raw.cup, 95.6);
  assert.equal(fable.arms.fullstackgtm.violations, 0);
});
