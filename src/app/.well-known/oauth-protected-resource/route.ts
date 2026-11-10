/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata endpoint.
 *
 * We intentionally do NOT serve /.well-known/openid-configuration or
 * /.well-known/oauth-authorization-server on this domain — Clerk is the
 * issuer and serves those on the issuer domain; this document points at it
 * via `authorization_servers`.
 */
import { protectedResourceMetadata } from "../_lib.ts";

export function GET() {
  return Response.json(protectedResourceMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
