type Env = Record<string, string | undefined>;

export const STORAGE_SANDBOX_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'";
export const CONVEX_PROXY_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

// Matches every route except visitor portal routes (which set a stricter nonce CSP in src/proxy.ts)
// and same-origin Convex reverse-proxy routes (which carry their own stricter policies below).
export const APP_CSP_SOURCE = "/((?!r(?:/|$)|api/visit(?:/|$)|convex(?:/|$)|convex-site(?:/|$)).*)";

function parseHttpOrigin(raw: string | undefined): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function wsOrigin(url: URL): string {
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

/**
 * Derive Server Actions CSRF allowed origins from configured site URLs rather than hardcoding
 * development hostnames into every build.
 */
export function serverActionAllowedOrigins(env: Env = process.env): string[] {
  const hosts = new Set<string>();
  for (const candidate of [env.SITE_URL, env.NEXT_PUBLIC_SITE_URL]) {
    const parsed = parseHttpOrigin(candidate);
    if (parsed) hosts.add(parsed.host);
  }
  const extra = env.SERVER_ACTIONS_ALLOWED_ORIGINS;
  if (extra) {
    for (const part of extra.split(",")) {
      const host = part.trim();
      if (host && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * Decode a Clerk publishable key (`pk_live_...` / `pk_test_...`) into its Frontend API origin
 * so custom Clerk domains (for example `clerk.canoncrm.com`) are permitted by CSP.
 */
export function clerkFrontendOrigin(publishableKey: string | undefined): string | null {
  const key = publishableKey?.trim();
  if (!key) return null;
  const match = /^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/.exec(key);
  if (!match) return null;
  try {
    const normalized = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").replace(/\$$/, "");
    if (!/^[A-Za-z0-9.-]+$/.test(decoded) || !decoded.includes(".")) return null;
    return `https://${decoded}`;
  } catch {
    return null;
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

/**
 * Baseline app-wide Content-Security-Policy compatible with Next.js hydration, Clerk, Convex
 * WebSockets, Telnyx WebRTC, and self-hosted local/Convex auth.
 */
export function appContentSecurityPolicy(env: Env = process.env): string {
  const isDev = env.NODE_ENV !== "production";
  const selfHost = env.NEXT_PUBLIC_CANON_SELFHOST === "true";
  const authMode = env.CANON_AUTH ?? env.NEXT_PUBLIC_CANON_AUTH ?? "clerk";
  const clerkOrigin = clerkFrontendOrigin(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const clerkEnabled = authMode !== "local" && authMode !== "convex" && (!selfHost || Boolean(clerkOrigin));

  const convexUrl = parseHttpOrigin(env.NEXT_PUBLIC_CONVEX_URL);
  const convexSiteUrl = parseHttpOrigin(env.NEXT_PUBLIC_CONVEX_SITE_URL);

  const clerkOrigins = clerkEnabled
    ? unique([clerkOrigin, "https://*.clerk.accounts.dev", "https://*.clerk.com"])
    : [];

  const scriptSrc = unique([
    "'self'",
    "'unsafe-inline'",
    isDev ? "'unsafe-eval'" : null,
    ...clerkOrigins,
    clerkEnabled ? "https://challenges.cloudflare.com" : null,
  ]);

  const connectSrc = unique([
    "'self'",
    convexUrl?.origin,
    convexUrl ? wsOrigin(convexUrl) : null,
    convexSiteUrl?.origin,
    // Self-hosted images are built before runtime SITE_URL is known; allow WebSockets to same-host HTTPS or local HTTP.
    selfHost ? "wss:" : null,
    selfHost ? "ws://localhost:*" : null,
    selfHost ? "ws://127.0.0.1:*" : null,
    !selfHost ? "https://*.convex.cloud" : null,
    !selfHost ? "wss://*.convex.cloud" : null,
    !selfHost ? "https://*.convex.site" : null,
    ...clerkOrigins,
    clerkEnabled ? "https://clerk-telemetry.com" : null,
    clerkEnabled ? "https://challenges.cloudflare.com" : null,
    // Telnyx browser softphone (src/components/crm/browser-phone.ts).
    "wss://rtc.telnyx.com",
    "wss://rtcdev.telnyx.com",
    "https://*.telnyx.com",
    "wss://*.telnyx.com",
    isDev ? "http://127.0.0.1:*" : null,
    isDev ? "ws://127.0.0.1:*" : null,
    isDev ? "http://localhost:*" : null,
    isDev ? "ws://localhost:*" : null,
  ]);

  const frameSrc = unique([
    "'self'",
    ...clerkOrigins,
    clerkEnabled ? "https://challenges.cloudflare.com" : null,
  ]);

  const formAction = unique([
    "'self'",
    ...clerkOrigins,
  ]);

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    `form-action ${formAction.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function nextSecurityHeaders(env: Env = process.env) {
  return [
    {
      source: "/(.*)",
      headers: [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        {
          key: "Referrer-Policy",
          value: "strict-origin-when-cross-origin",
        },
        {
          key: "Permissions-Policy",
          // The dialer's browser audio needs the microphone on Canon's own pages (docs/dialer.md, D2); frames and other origins stay blocked.
          value: "camera=(), microphone=(self), geolocation=()",
        },
        { key: "X-DNS-Prefetch-Control", value: "on" },
      ],
    },
    {
      source: APP_CSP_SOURCE,
      headers: [
        { key: "Content-Security-Policy", value: appContentSecurityPolicy(env) },
      ],
    },
    {
      source: "/convex/:path*",
      headers: [
        { key: "Content-Security-Policy", value: CONVEX_PROXY_CSP },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
    {
      source: "/convex/api/storage/:path*",
      headers: [
        { key: "Content-Security-Policy", value: STORAGE_SANDBOX_CSP },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    },
    {
      source: "/convex-site/modules/file",
      headers: [
        { key: "Content-Security-Policy", value: STORAGE_SANDBOX_CSP },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    },
  ];
}
