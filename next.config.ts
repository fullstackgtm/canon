import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_CANON_AUTH: process.env.CANON_AUTH ?? "clerk" },
  output: "standalone",
  async rewrites() {
    return process.env.NEXT_PUBLIC_CANON_SELFHOST === "true" ? [
      { source: "/convex/:path*", destination: "http://127.0.0.1:3210/:path*" },
      { source: "/convex-site/:path*", destination: "http://127.0.0.1:3211/:path*" },
    ] : [];
  },
  experimental: {
    serverActions: {
      // Clerk's post-sign-in cache action carries the public site's Origin
      // through the reverse proxy.
      allowedOrigins: [new URL(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://dev.canoncrm.com").host, "dev.fullstackgtm.com"],
    },
  },
  turbopack: {
    root: process.cwd(),
  },
  // CI type-checks every commit (tsgo); repeating it in `next build` cost ~37s per deploy.
  typescript: {
    ignoreBuildErrors: true,
  },
  // The old consulting pages were retired with the CanonCRM
  // rebrand; send old links to the homepage instead of the sign-in gate.
  async redirects() {
    return [
      ...["/about", "/alternatives", "/diagnostic", "/resources"].flatMap((path) => [
        { source: path, destination: "/", permanent: true },
        { source: `${path}/:rest*`, destination: "/", permanent: true },
      ]),
      // A company has one page since the Accounts and Companies pages merged; old links to the Companies one land on it.
      { source: "/dashboard/records/account/:id", destination: "/dashboard/accounts/:id", permanent: false },
      // Recipes became Customization; saved links and bookmarks to it and its editors land on the new route.
      { source: "/dashboard/recipes", destination: "/dashboard/customization", permanent: false },
      { source: "/dashboard/recipes/:rest*", destination: "/dashboard/customization/:rest*", permanent: false },
    ];
  },
  async headers() {
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
    ];
  },
};

export default nextConfig;
