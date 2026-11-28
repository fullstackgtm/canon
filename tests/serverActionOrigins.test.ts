import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import nextConfig from "../next.config.ts";
import {
  APP_CSP_SOURCE,
  CONVEX_PROXY_CSP,
  STORAGE_SANDBOX_CSP,
  appContentSecurityPolicy,
  clerkFrontendOrigin,
  nextSecurityHeaders,
  serverActionAllowedOrigins,
} from "../src/lib/nextSecurityConfig.ts";

const require = createRequire(import.meta.url);
const { isCsrfOriginAllowed } = require("next/dist/server/app-render/csrf-protection.js");
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js");

test("server action allowedOrigins derives only from configured site URLs with no hardcoded dev origins", () => {
  const unset = serverActionAllowedOrigins({});
  assert.deepEqual(unset, []);
  for (const origin of ["dev.crm.example", "dev.example.com", "attacker.example", ""]) {
    assert.equal(isCsrfOriginAllowed(origin, unset), false, origin);
  }

  const configured = serverActionAllowedOrigins({
    SITE_URL: "https://crm.example.com",
    NEXT_PUBLIC_SITE_URL: "https://app.example.com:8443",
  });
  for (const origin of ["crm.example.com", "app.example.com:8443"]) {
    assert.equal(isCsrfOriginAllowed(origin, configured), true, origin);
  }
  for (const origin of [
    "dev.crm.example",
    "dev.example.com",
    "attacker.example",
    "crm.example.com.attacker.example",
    "attacker.crm.example.com",
    "",
  ]) {
    assert.equal(isCsrfOriginAllowed(origin, configured), false, origin);
  }
});

test("next.config.ts security headers enforce app-wide CSP, preserve visitor CSP, and sandbox Convex storage", async () => {
  const clerkKey = `pk_live_${Buffer.from("clerk.canoncrm.com$").toString("base64")}`;
  assert.equal(clerkFrontendOrigin(clerkKey), "https://clerk.canoncrm.com");

  const hostedCsp = appContentSecurityPolicy({
    NODE_ENV: "production",
    CANON_AUTH: "clerk",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkKey,
    NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://happy-otter-123.convex.site",
  });
  assert.match(hostedCsp, /default-src 'self'/);
  assert.match(hostedCsp, /script-src [^;]*'self'[^;]*'unsafe-inline'[^;]*https:\/\/clerk\.canoncrm\.com/);
  assert.match(hostedCsp, /script-src [^;]*https:\/\/happy-otter-123\.convex\.site/);
  assert.doesNotMatch(hostedCsp, /script-src [^;]*\*\.convex\.site/);
  assert.doesNotMatch(hostedCsp, /'unsafe-eval'/);
  assert.match(hostedCsp, /connect-src [^;]*wss:\/\/happy-otter-123\.convex\.cloud/);
  assert.match(hostedCsp, /connect-src [^;]*wss:\/\/rtc\.telnyx\.com/);
  assert.match(hostedCsp, /object-src 'none'/);
  assert.match(hostedCsp, /frame-ancestors 'none'/);

  const selfHostCsp = appContentSecurityPolicy({
    NODE_ENV: "production",
    CANON_AUTH: "local",
    NEXT_PUBLIC_CANON_SELFHOST: "true",
  });
  assert.match(selfHostCsp, /connect-src [^;]*'self'[^;]*wss:/);
  assert.doesNotMatch(selfHostCsp, /clerk\.accounts\.dev/);

  const matchAppCsp = getPathMatch(APP_CSP_SOURCE);
  for (const path of ["/", "/dashboard", "/sign-in", "/recipes", "/reports", "/api/local-auth"]) {
    assert.ok(matchAppCsp(path), `${path} should receive app-wide CSP`);
  }
  for (const path of ["/r", "/r/v/abcdefghijklmnopqrstuv", "/api/visit/file", "/convex/api/storage/abc", "/convex-site/modules/file"]) {
    assert.equal(matchAppCsp(path), false, `${path} must keep its dedicated stricter CSP`);
  }

  const rules = await nextConfig.headers!();
  assert.equal(rules.length, nextSecurityHeaders(process.env).length);
  const bySource = new Map(rules.map((r) => [r.source, Object.fromEntries(r.headers.map((h) => [h.key, h.value]))]));
  assert.ok(bySource.get(APP_CSP_SOURCE)?.["Content-Security-Policy"]);
  assert.equal(bySource.get("/convex/:path*")?.["Content-Security-Policy"], CONVEX_PROXY_CSP);
  assert.equal(bySource.get("/convex/api/storage/:path*")?.["Content-Security-Policy"], STORAGE_SANDBOX_CSP);
  assert.equal(bySource.get("/convex/api/storage/:path*")?.["X-Content-Type-Options"], "nosniff");
  assert.equal(bySource.get("/convex-site/modules/file")?.["Content-Security-Policy"], STORAGE_SANDBOX_CSP);
});
