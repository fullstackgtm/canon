// In the self-hosted container, Convex builds storage and HTTP-action URLs from the browser's
// address (CONVEX_CLOUD_ORIGIN, CONVEX_SITE_ORIGIN). The processes inside can't fetch those: the
// published port can differ from the container's, and a public domain may not resolve from inside.
// The entrypoint gives Next and the backend's Node action runner the backend's own addresses, and
// this maps one onto the other. Without those variables (the hosted app, Convex Cloud), a URL
// passes through unchanged.

type Env = Record<string, string | undefined>;

export function internalUrl(url: string, env: Env = process.env): string {
  const pairs = [[env.CONVEX_CLOUD_ORIGIN, env.CANON_INTERNAL_CONVEX_URL], [env.CONVEX_SITE_ORIGIN, env.CANON_INTERNAL_CONVEX_SITE_URL]];
  for (const [outside, inside] of pairs) {
    if (!outside || !inside) continue;
    const base = outside.replace(/\/+$/, "");
    if (url === base || url.startsWith(`${base}/`)) return `${inside.replace(/\/+$/, "")}${url.slice(base.length)}`;
  }
  // The Node action runner calls the backend at new URL("/api/actions/<op>", CONVEX_CLOUD_ORIGIN), which drops the
  // origin's /convex path: that reaches Next on the container's own port, and nothing on any other.
  const [[cloud, inside]] = pairs;
  if (cloud && inside) {
    const root = new URL(cloud).origin;
    if (url.startsWith(`${root}/api/actions/`)) return `${inside.replace(/\/+$/, "")}${url.slice(root.length)}`;
  }
  return url;
}
