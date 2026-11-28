import type { NextConfig } from "next";
import { nextSecurityHeaders, serverActionAllowedOrigins } from "./src/lib/nextSecurityConfig.ts";

const allowedOrigins = serverActionAllowedOrigins(process.env);

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
      allowedOrigins,
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
      { source: "/dashboard/deals/:id", destination: "/dashboard/records/deal/:id", permanent: false },
      // Recipes became Customization; saved links and bookmarks to it and its editors land on the new route.
      { source: "/dashboard/recipes", destination: "/dashboard/customization", permanent: false },
      { source: "/dashboard/recipes/:rest*", destination: "/dashboard/customization/:rest*", permanent: false },
    ];
  },
  async headers() {
    return nextSecurityHeaders(process.env);
  },
};

export default nextConfig;
