import { normalizeCompanyWebsite } from "../../engine/src/portable/websiteSources.ts";

export type WebPagesRequest = { domain: string; urls?: never } | { urls: string[]; domain?: never };

export function publicPageUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("Use a public HTTPS page URL.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Use a public HTTPS page without credentials or a port.");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal)$/.test(host) || /^[\d.]+$/.test(host)) throw new Error("Use a public HTTPS hostname.");
  url.hash = "";
  return url.toString();
}

export function webPagesRequest(args: Record<string, unknown>): WebPagesRequest {
  if ("urls" in args) {
    if (Object.keys(args).some((k) => k !== "urls") || !Array.isArray(args.urls) || args.urls.length > 6) throw new Error("web.pages accepts at most six URLs, or one domain.");
    return { urls: [...new Set(args.urls.map(publicPageUrl))] };
  }
  if (Object.keys(args).some((k) => k !== "domain") || typeof args.domain !== "string" || args.domain.length > 2048) throw new Error("web.pages requires one company domain.");
  const raw = args.domain.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.username || url.password || url.port || !/^https?:$/.test(url.protocol)) throw new Error("Use a public HTTP(S) company domain without credentials or a port.");
  const { domain } = normalizeCompanyWebsite(raw);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.length > 253 || /(?:^|\.)(?:localhost|local|internal)$/.test(domain) || /^[\d.]+$/.test(domain)) throw new Error("Use a public company domain.");
  return { domain };
}
