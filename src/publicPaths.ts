/**
 * The proxy's public-path matcher, in its own module (no next/server import)
 * so tests can assert its exact coverage: everything it lets through skips
 * the Clerk session gate, which makes it a security boundary. See
 * tests/proxyPublicPaths.test.ts before broadening anything here.
 */
export function isPublicPath(pathname: string) {
  return (
    // Auth-discovery endpoints (RFC 9728 protected-resource metadata,
    // RFC 8414 authorization-server metadata, auth.md) exist precisely so
    // unauthenticated agents can learn how to sign in — they must never 307
    // to /sign-in.
    pathname.startsWith("/.well-known/") ||
    isVisitPublicPath(pathname) ||
    pathname === "/auth.md" ||
    pathname === "/llms.txt" ||
    pathname === "/terms" ||
    pathname === "/privacy" ||
    pathname.startsWith("/pricing") ||
    pathname.startsWith("/product") ||
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/api/gtm") ||
    // The record API (docs/record-api.md) authenticates every request itself
    // with a bearer token (Clerk JWT or paired CLI token) and answers 401
    // without one. CLI tokens are not Clerk sessions, so the gate cannot apply.
    pathname.startsWith("/api/v1/") ||
    // CLI device-flow + observability endpoints authenticate themselves
    // (device codes / broker tokens), never via Clerk. They must bypass the
    // browser-session gate or the CLI gets 307'd to /sign-in (it has no session).
    pathname.startsWith("/api/cli") ||
    // Agent self-registration and the Tier-1 public reads: unauthenticated
    // by design (registration) or agent-token-authenticated (reads) — never
    // Clerk. Exact matches where possible: no accidental broadening.
    // NOTE: /api/agents/claim — the auth.md claim ceremony — is deliberately
    // NOT here: claiming is the "user authenticates" step and must sit
    // behind the Clerk session gate.
    pathname === "/api/agents/register" ||
    pathname.startsWith("/api/public/") ||
    // Anonymous lead-magnet endpoints are separately rate-limited, SSRF-guarded,
    // bounded, and return only server-masked contact previews.
    pathname.startsWith("/api/lead-magnet/") ||
    // RFC 8628 device flow (agent-facing OAuth issuer). NOTE: /activate — the
    // human approval page — is deliberately NOT public; approving requires a
    // signed-in session.
    pathname === "/api/oauth/device_authorization" ||
    pathname === "/api/oauth/token"
  );
}

/**
 * Paths where clerkMiddleware must RUN (its context headers are what let the
 * route call auth()) but must NOT session-protect. The homepage needs Clerk
 * context to branch signed-in users to /dashboard and signed-out users to
 * /sign-in. MCP clients authenticate with Clerk OAuth tokens via withMcpAuth
 * in the route, and a session 307/404 from the middleware would break their flow.
 *
 * This is deliberately neither bucket:
 * - fully public (isPublicPath) skips clerkMiddleware entirely -> route-level
 *   auth() throws "can't detect clerkMiddleware" and every token is rejected;
 * - fully protected 307s/404s the client before the route's own RFC 9728
 *   401-with-discovery can answer.
 * The route still 404s while MCP_REMOTE_ENABLED is off, so nothing is
 * exposed while the feature is dark.
 */
export function isClerkContextOnlyPath(pathname: string) {
  // /start/<token> is the anonymous research progress page (WS3): it must be
  // reachable signed-out, but it renders Clerk sign-up CTAs and its /claim
  // child calls Convex with the Clerk session, so it needs Clerk context.
  return pathname === "/" || pathname === "/mcp" || pathname.startsWith("/start/");
}

export function isVisitPublicPath(pathname: string): boolean {
  return pathname === "/r" || /^\/r\/v\/[A-Za-z0-9_-]{22}(?:\/[A-Za-z0-9_-]+)*\/?$/.test(pathname) || ["/api/visit/open", "/api/visit/page", "/api/visit/op", "/api/visit/transition", "/api/visit/upload", "/api/visit/file", "/api/visit/request-code", "/api/visit/verify-code"].includes(pathname);
}
