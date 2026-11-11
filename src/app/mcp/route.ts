/**
 * Remote MCP endpoint (streamable HTTP) with Clerk OAuth — FEATURE-FLAGGED.
 *
 * Until MCP_REMOTE_ENABLED=true this route (and its protected-resource
 * metadata sibling) is a plain 404: nothing is advertised that isn't live,
 * and none of the MCP/Clerk machinery is even imported. Flipping the flag
 * requires Clerk Dashboard prerequisites (OAuth + Dynamic Client
 * Registration) — see docs/remote-mcp.md for the exact steps, the DCR abuse
 * surface, and the rollout checklist.
 *
 * Callers authenticate with a Clerk OAuth access token (MCP clients, `canon
 * login`) or a paired CLI token (headless agents). A self-hosted install
 * (CANON_AUTH=local) has no Clerk: it serves /mcp without the flag, to paired
 * CLI tokens only (`canon login` pairs one). Canon tools (./_canonTools.ts)
 * then run as that user through a short-lived service JWT, so normal role and
 * org checks apply. A connection can do what its user can do in the dashboard.
 */

export const dynamic = "force-dynamic";

type RouteHandler = (request: Request) => Response | Promise<Response>;

let cachedHandler: RouteHandler | null = null;

// Last time each user+client was recorded as agent-connected, so /mcp writes
// to Convex at most once per window per process.
const RECORD_INTERVAL_MS = 10 * 60 * 1000;
const lastRecorded = new Map<string, number>();

async function buildHandler(): Promise<RouteHandler> {
  // Imported lazily so the module graph (mcp-handler, Clerk server SDK) only
  // loads when the feature is actually enabled.
  const [{ createMcpHandler, withMcpAuth }, tools, { canonTools, toolErrorMessage, toolResultText }, jwt, { ConvexHttpClient }, { api }, limits] =
    await Promise.all([
      import("mcp-handler"),
      import("./_tools.ts"),
      import("./_canonTools.ts"),
      import("../../lib/canonServiceJwt.ts"),
      import("convex/browser"),
      import("../../../convex/_generated/api.js"),
      import("../api/v1/_rateLimit.ts"),
    ]);
  const convexUrl = () => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
    return url;
  };

  // Marks the user as agent-connected (it unlocks the dashboard). Never fails the request.
  const recordConnection = async (who: { clerkUserId: string; clerkOrgId?: string | null }, clientId: string | undefined) => {
    const key = `${who.clerkUserId}|${clientId ?? ""}`;
    const now = Date.now();
    if (now - (lastRecorded.get(key) ?? 0) < RECORD_INTERVAL_MS) return;
    const config = jwt.serviceJwtConfig();
    if (!config) return;
    lastRecorded.set(key, now);
    try {
      const convex = new ConvexHttpClient(convexUrl());
      convex.setAuth(jwt.signServiceJwt(config, { clerkUserId: who.clerkUserId, clerkOrgId: who.clerkOrgId, clientId }));
      await convex.mutation(api.agentConnections.record, {});
    } catch {
      lastRecorded.delete(key);
    }
  };

  const handler = createMcpHandler(
    (server) => {
      server.registerTool(
        "get_leaderboard",
        {
          description:
            "CRM-Ops Bench results: per-model completion-under-policy (CuP), violations, and run counts across raw / informed / CanonCRM tool arms, with provenance (source commit of runs.jsonl). Same data as GET /api/public/leaderboard.",
        },
        () => ({
          content: [{ type: "text", text: tools.getLeaderboardText() }],
        }),
      );
      server.registerTool(
        "get_docs",
        {
          description:
            "llms.txt-style summary of CanonCRM: what the product does and how agents get read or org access.",
        },
        () => ({
          content: [{ type: "text", text: tools.getDocsText() }],
        }),
      );
      for (const tool of canonTools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: !tool.writes, destructiveHint: tool.destructive ?? false, openWorldHint: false },
          },
          async (args: Record<string, unknown>, extra: { authInfo?: { token?: string; clientId?: string; extra?: Record<string, unknown> } }) => {
            const config = jwt.serviceJwtConfig();
            const who = extra.authInfo?.extra as { clerkUserId?: string; clerkOrgId?: string | null } | undefined;
            if (!config || !who?.clerkUserId) {
              return { isError: true, content: [{ type: "text" as const, text: "Canon tools are not configured on this deployment." }] };
            }
            // The record API's budgets (api/v1/_rateLimit.ts): a paired token shares one budget across /mcp and
            // /api/v1; an OAuth connection counts as its user. The second ceiling is the user's, as an OAuth token
            // carries no workspace.
            const kind = tool.writes ? "write" : "read";
            const budget = limits.limitsFrom(process.env);
            const token = extra.authInfo?.token;
            const credential = token?.startsWith("fsgtm_") ? limits.tokenKey(token) : `mcp:${who.clerkUserId}:${extra.authInfo?.clientId ?? ""}`;
            const decision = limits.apiLimiter.admit([
              { key: `${credential}:${kind}`, limit: budget.token[kind] },
              { key: `user:${who.clerkUserId}:${kind}`, limit: budget.workspace[kind] },
            ], Date.now());
            if (!decision.allowed) {
              return { isError: true, content: [{ type: "text" as const, text: `Rate limited: ${decision.limit} ${kind}s a minute for this connection. Retry after ${decision.resetSeconds} s.` }] };
            }
            const convex = new ConvexHttpClient(convexUrl());
            convex.setAuth(jwt.signServiceJwt(config, { clerkUserId: who.clerkUserId, clerkOrgId: who.clerkOrgId, clientId: extra.authInfo?.clientId }));
            try {
              const result = await tool.run(convex, args);
              return { content: [{ type: "text" as const, text: toolResultText(tool, args, result) }] };
            } catch (error) {
              const message = toolErrorMessage(tool, args, error);
              return { isError: true, content: [{ type: "text" as const, text: message.slice(0, 2000) }] };
            }
          },
        );
      }
    },
    {
      serverInfo: { name: "canon", version: "0.1.0" },
    },
    {
      basePath: "/",
      // Streamable HTTP only: SSE would require a Redis backing store and no
      // target client needs it.
      disableSse: true,
    },
  );

  return withMcpAuth(
    handler,
    async (_request, token) => {
      // No bearer -> no auth info; withMcpAuth turns that into an RFC 9728
      // 401 pointing at our protected-resource metadata.
      if (!token) return undefined;
      if (token.startsWith("fsgtm_")) {
        // Paired CLI token (headless agents). Agent tokens (fsgtm_agent_) never resolve.
        const who = await new ConvexHttpClient(convexUrl()).action(api.agentIdentity.resolveCliToken, { cliToken: token });
        if (!who) return undefined;
        await recordConnection(who, "canon-cli-token");
        return { token, clientId: "canon-cli-token", scopes: ["canon"], extra: { ...who } };
      }
      if (process.env.CANON_AUTH === "local") return undefined;
      const [{ verifyClerkToken }, { auth }] = await Promise.all([import("@clerk/mcp-tools/next"), import("@clerk/nextjs/server")]);
      const clerkAuth = await auth({ acceptsToken: "oauth_token" });
      const info = verifyClerkToken(clerkAuth, token);
      const userId = (info?.extra as { userId?: string } | undefined)?.userId;
      if (!info || !userId) return undefined;
      await recordConnection({ clerkUserId: userId, clerkOrgId: null }, info.clientId);
      return { ...info, extra: { ...info.extra, clerkUserId: userId, clerkOrgId: null } };
    },
    {
      required: true,
      resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      // Keep the challenge on the same public origin as discovery metadata.
      // Strict clients reject cross-origin resource_metadata URLs.
      resourceUrl: process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || undefined,
    },
  );
}

async function route(request: Request): Promise<Response> {
  if (process.env.CANON_AUTH !== "local" && process.env.MCP_REMOTE_ENABLED !== "true") {
    return new Response(null, { status: 404 });
  }
  cachedHandler ??= await buildHandler();
  return cachedHandler(request);
}

export { route as GET, route as POST, route as DELETE };
