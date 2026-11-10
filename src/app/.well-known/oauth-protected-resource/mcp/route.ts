/**
 * RFC 9728 protected-resource metadata scoped to the /mcp endpoint (the
 * path-scoped discovery modern MCP clients follow from the 401's
 * resource_metadata hint). It names Clerk as the authorization server —
 * MCP clients then use Clerk's own AS metadata + Dynamic Client Registration
 * on the Clerk domain. The app's root /.well-known/oauth-authorization-server
 * stays the agent-facing issuer (registration + device flow) and is
 * deliberately NOT replaced by Clerk's; see docs/remote-mcp.md.
 *
 * Feature-flagged with the /mcp route itself: metadata must never advertise
 * an endpoint that 404s.
 */

import { siteBase } from "../../../api/agents/_lib.ts";

export const dynamic = "force-dynamic";

function flagOff(): Response | null {
  return process.env.MCP_REMOTE_ENABLED !== "true"
    ? new Response(null, { status: 404 })
    : null;
}

export async function GET(request: Request): Promise<Response> {
  const off = flagOff();
  if (off) return off;
  const { protectedResourceHandlerClerk } = await import("@clerk/mcp-tools/next");
  // Pin the resource to the configured public origin so an internal request
  // URL cannot leak into discovery metadata.
  return protectedResourceHandlerClerk({ resource: siteBase(request) })(request);
}

export async function OPTIONS(): Promise<Response> {
  const off = flagOff();
  if (off) return off;
  const { metadataCorsOptionsRequestHandler } = await import("@clerk/mcp-tools/next");
  return metadataCorsOptionsRequestHandler()();
}
