function parseHttpUrl(raw: string | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function configuredSiteUrls(env: Record<string, string | undefined> = process.env): URL[] {
  const urls: URL[] = [];
  for (const raw of [env.SITE_URL, env.APP_URL, env.NEXT_PUBLIC_SITE_URL]) {
    const parsed = parseHttpUrl(raw);
    if (parsed) urls.push(parsed);
  }
  return urls;
}

export function isLocalAuthOriginAllowed(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set<string>([new URL(request.url).origin, ...configuredSiteUrls(env).map((url) => url.origin)]);
  return allowed.has(origin);
}

export function localAuthCookieSecure(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const siteUrl = configuredSiteUrls(env)[0];
  return (siteUrl ?? new URL(request.url)).protocol === "https:";
}
