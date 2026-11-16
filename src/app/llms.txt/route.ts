import { selfHostedAuthText } from "../../lib/agentOnboarding.ts";
/**
 * llms.txt (llmstxt.org convention; checked by agent-readiness scanners
 * alongside auth.md and the OAuth discovery documents). Serves the same
 * product summary the MCP get_docs tool returns — one source of truth in
 * src/app/mcp/_tools.ts — plus the auth pointer.
 */
import { getDocsText } from "../mcp/_tools.ts";
import { appOrigin } from "../.well-known/_lib.ts";

export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.CANON_AUTH === "local" || process.env.CANON_AUTH === "convex") {
    return new Response(`# CanonCRM\n\nA self-hosted CRM for accounts, contacts, deals, custom objects, views, reports and automation proposals.\n\n${selfHostedAuthText(appOrigin())}\nRead ${appOrigin()}/auth.md for connection instructions. Once connected, call get_docs for the tool guide.`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const body = `${getDocsText()}
## Authentication

- Agents: ${appOrigin()}/auth.md (self-registration for reads; human-approved pairing for org access)
- Machine-readable: ${appOrigin()}/.well-known/oauth-protected-resource and ${appOrigin()}/.well-known/oauth-authorization-server
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
