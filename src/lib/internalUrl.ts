// In the self-hosted container, Convex builds storage and HTTP-action URLs from the browser's
// address (CONVEX_CLOUD_ORIGIN, CONVEX_SITE_ORIGIN). The Next server can't fetch those itself: the
// published port can differ from the container's, and a public domain may not resolve from inside.
// The entrypoint gives Next the backend's own addresses, and this maps one onto the other.
// Without those variables (the hosted app, Convex Cloud), a URL passes through unchanged.

type Env = Record<string, string | undefined>;

export function internalUrl(url: string, env: Env = process.env): string {
  const pairs = [[env.CONVEX_CLOUD_ORIGIN, env.CANON_INTERNAL_CONVEX_URL], [env.CONVEX_SITE_ORIGIN, env.CANON_INTERNAL_CONVEX_SITE_URL]];
  for (const [outside, inside] of pairs) {
    if (!outside || !inside) continue;
    const base = outside.replace(/\/+$/, "");
    if (url === base || url.startsWith(`${base}/`)) return `${inside.replace(/\/+$/, "")}${url.slice(base.length)}`;
  }
  return url;
}
