/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata for the app-as-issuer.
 *
 * Clerk remains the issuer for humans (its own openid-configuration lives on
 * the Clerk domain); THIS document describes the agent-facing issuer on the
 * app domain: self-registration for read-only tokens and the RFC 8628 device
 * flow for human-approved org access. Every endpoint listed here is real —
 * see src/app/.well-known/_lib.ts.
 */
import { authorizationServerMetadata } from "../_lib.ts";

export function GET() {
  return Response.json(authorizationServerMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
