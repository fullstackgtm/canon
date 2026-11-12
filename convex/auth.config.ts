// Clerk sessions (the dashboard) plus, when configured, Canon's own short-lived
// service JWTs for agent requests (hosted MCP and the canon CLI). The app mints
// those only after verifying a Clerk OAuth token or a paired CLI token; see
// src/lib/canonServiceJwt.ts. CANON_SERVICE_JWKS is a data: URI of the public
// JWKS, so Convex never fetches keys over the network.
const serviceIssuer = process.env.CANON_SERVICE_JWT_ISSUER;
const serviceJwks = process.env.CANON_SERVICE_JWKS;
let authMode = "clerk";
try {
  authMode = process.env.CANON_AUTH ?? "clerk";
} catch {
  // Convex auth-config evaluation throws on an unset variable. Existing Clerk installs need no new setting.
}

const authConfig = {
  providers: [
    ...(authMode === "local" ? [] : [{
      domain: authMode === "convex" ? process.env.CONVEX_SITE_URL : process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    }]),
    ...(serviceIssuer && serviceJwks
      ? [{
        type: "customJwt" as const,
        issuer: serviceIssuer,
        jwks: serviceJwks,
        algorithm: "RS256" as const,
        applicationID: "canon-service",
      }]
      : []),
  ],
};

export default authConfig;
