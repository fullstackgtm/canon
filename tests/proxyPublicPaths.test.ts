import assert from "node:assert/strict";
import { test } from "node:test";
import { isClerkContextOnlyPath, isPublicPath } from "../src/publicPaths.ts";

/**
 * The public-path matcher is a security boundary: everything it lets through
 * skips the Clerk session gate. Assert its coverage exactly — the agent
 * endpoints it must include, and the near-misses it must not.
 */

test("agent endpoints that authenticate themselves are public", () => {
  for (const path of [
    "/api/agents/register",
    "/api/public/leaderboard",
    "/api/lead-magnet/start",
    "/api/oauth/device_authorization",
    "/api/oauth/token",
    "/api/v1/records/lead",
  ]) {
    assert.equal(isPublicPath(path), true, `${path} must be public`);
  }
});

test("/ and /mcp are clerk-context-only: middleware runs but never session-gates them", () => {
  // Regression for the two failure modes seen in prod:
  // - fully public -> clerkMiddleware skipped -> route auth() throws
  //   "can't detect clerkMiddleware" -> every OAuth token rejected;
  // - fully protected -> session 307/404 before the route's RFC 9728 401.
  for (const path of ["/", "/mcp"]) {
    assert.equal(isPublicPath(path), false, `${path} must NOT skip clerkMiddleware`);
    assert.equal(isClerkContextOnlyPath(path), true);
  }
  // Exact match only — no subtree, no near-misses.
  for (const path of ["/mcp/extra", "/mcpx", "/dashboard"]) {
    assert.equal(isClerkContextOnlyPath(path), false, `${path} must be session-gated`);
  }
});

test("the matcher is exact — no accidental broadening", () => {
  for (const path of [
    "/api/agents",
    "/api/agents/",
    "/api/agents/list",
    "/api/agents/register/extra",
    "/api/agentsregister",
    // The auth.md claim ceremony is the "user authenticates" step: it must
    // stay behind the Clerk session gate, never public.
    "/api/agents/claim",
    "/api/public", // only the subtree, and every route in it gates itself
    "/api/oauth",
    "/api/oauth/revoke",
    "/api/oauth/token/extra",
    "/api/v1",
    "/api/v10/records",
    "/", // clerk-context-only (see below), NOT public
    "/mcp", // clerk-context-only (see below), NOT public
    "/mcp/extra",
    "/mcpx",
    // The device-flow approval page requires a signed-in human.
    "/activate",
    // Retired consulting pages redirect in next.config.ts; never public.
    "/about",
    "/alternatives",
    "/diagnostic",
    "/resources/bi-tool-ratings",
    "/dashboard",
    "/dashboard/cli-auth",
    "/terms/extra",
    "/privacyx",
  ]) {
    assert.equal(isPublicPath(path), false, `${path} must NOT be public`);
  }
});

test("pre-existing public paths are unchanged", () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/auth.md",
    "/llms.txt",
    "/terms",
    "/privacy",
    "/sign-in",
    "/api/gtm/summary",
    "/api/cli/auth/start",
  ]) {
    assert.equal(isPublicPath(path), true, `${path} must stay public`);
  }
});

test("visitor public paths include only the interstitial, grant reader and named routes", () => {
  for (const path of ["/r", "/r/v/abcdefghijklmnopqrstuv", "/r/v/abcdefghijklmnopqrstuv/visit", "/api/visit/open", "/api/visit/page", "/api/visit/op", "/api/visit/transition", "/api/visit/upload", "/api/visit/file", "/api/visit/request-code", "/api/visit/verify-code"]) assert.equal(isPublicPath(path), true, path);
  for (const path of ["/api/visit/request-code/extra", "/api/visit/verify-code/extra"]) assert.equal(isPublicPath(path), false, path);
  for (const path of ["/r/secret", "/rx", "/r/v", "/r/v/short", "/r/dashboard", "/api/visit", "/api/visit/open/extra", "/api/visit/op/extra", "/api/visit/transition/extra", "/api/visit/upload/extra", "/api/visit/file/extra", "/api/visits/page", "/dashboard/r", "/dashboard"]) assert.equal(isPublicPath(path), false, path);
});
