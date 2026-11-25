import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ipIsLoopback, ipIsPrivate } from "./portable/ipAddress.ts";

export { ipIsLoopback, ipIsPrivate };

export const DEFAULT_PUBLIC_HTTP_MAX_BYTES = 5_000_000;

export type PublicAddress = { address: string; family: number };
export type PublicLookup = (hostname: string) => Promise<PublicAddress[]>;

export class PublicHttpSsrfError extends Error {
  readonly code = "SSRF_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "PublicHttpSsrfError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const systemLookup: PublicLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family }));

/** Resolve once and reject the entire hostname if any answer is non-public (or non-loopback when loopback is opted in). */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: PublicLookup = systemLookup,
  options: { allowLoopback?: boolean } = {},
): Promise<PublicAddress[]> {
  const literal = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(literal);
  const addresses = family ? [{ address: literal, family }] : await lookup(literal);
  if (addresses.length === 0) throw new Error(`public HTTP: ${literal} did not resolve to an address.`);
  const loopbackAllowed = Boolean(options.allowLoopback) && LOOPBACK_HOSTS.has(literal);
  for (const { address } of addresses) {
    if (loopbackAllowed) {
      if (!ipIsLoopback(address)) {
        throw new PublicHttpSsrfError(`public HTTP refuses ${literal} — loopback target resolved to non-loopback address ${address} (SSRF guard).`);
      }
      continue;
    }
    if (ipIsPrivate(address)) {
      throw new PublicHttpSsrfError(`public HTTP refuses ${literal} — it resolves to private/internal address ${address} (SSRF guard).`);
    }
  }
  return addresses;
}

export async function assertPublicUrl(
  rawUrl: string,
  lookup: PublicLookup = systemLookup,
  options: { allowLoopback?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`market capture: "${rawUrl}" is not a valid URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`market capture refuses ${url.protocol} URLs (only http/https): ${rawUrl}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopbackAllowed = Boolean(options.allowLoopback) && LOOPBACK_HOSTS.has(host);
  if (isIP(host) && !loopbackAllowed && ipIsPrivate(host)) {
    throw new PublicHttpSsrfError(`market capture refuses private/loopback address ${host} (SSRF guard).`);
  }
  const addresses = await resolvePublicAddresses(host, lookup, options);
  // Keep the resolved set available to the request path without changing the public API.
  Object.defineProperty(url, "__publicAddresses", { value: addresses });
  return url;
}

export type PublicHttpResult = { status: number; headers: Headers; body: Uint8Array; finalUrl: string };
type HopResult = Omit<PublicHttpResult, "finalUrl">;
export type PublicRequestHop = (
  url: URL,
  addresses: PublicAddress[],
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  request?: { method?: "GET" | "POST"; body?: string | Uint8Array },
) => Promise<HopResult>;

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else if (value !== undefined) {
      out.set(key, value);
    }
  }
  return out;
}

const requestHop: PublicRequestHop = (url, addresses, headers, timeoutMs, maxBytes, request) => new Promise((resolve, reject) => {
  let cursor = 0;
  let settled = false;
  const method = request?.method ?? "GET";
  const body = request?.body;
  const reqHeaders: Record<string, string> = { ...headers };
  if (body !== undefined && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-length")) {
    reqHeaders["content-length"] = String(Buffer.byteLength(body));
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const options: RequestOptions & { autoSelectFamily?: boolean } = {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method,
    headers: reqHeaders,
    // Never reuse pooled sockets across requests: every request binds its own
    // TCP socket through the DNS-pinned lookup callback below.
    agent: false,
    // Node 20+ enables family autoselection by default and calls custom lookup
    // functions with `{ all: true }`. This transport already resolved and
    // validated every address, then pins one exact address per socket attempt;
    // disable the second selection layer so the callback keeps the classic
    // single-address contract and can never fall back to system DNS.
    autoSelectFamily: false,
    lookup: (_hostname, lookupOpts, callback) => {
      const requestedFamily = typeof lookupOpts === "number" ? lookupOpts : lookupOpts?.family;
      const eligible = requestedFamily ? addresses.filter((a) => a.family === requestedFamily) : addresses;
      if (!eligible.length) {
        return callback(new Error("public HTTP: no validated address matches the requested family"), "", 0);
      }
      if (typeof lookupOpts === "object" && lookupOpts?.all) {
        const list: LookupAddress[] = eligible.map((a) => ({ address: a.address, family: a.family }));
        return (callback as unknown as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, list);
      }
      const selected = eligible[cursor++ % eligible.length];
      callback(null, selected.address, selected.family);
    },
  };
  // Assigned once, after `req` exists; `finish` closes over it before then.
  // eslint-disable-next-line prefer-const
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = <T>(fn: (value: T) => void, value: T) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn(value);
  };
  const timeoutError = () => {
    const err = new Error(`public HTTP request timed out after ${timeoutMs}ms`);
    err.name = "TimeoutError";
    return err;
  };
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (res) => {
    const resHeaders = toHeaders(res.headers);
    if (maxBytes === 0) {
      finish(resolve, { status: res.statusCode ?? 0, headers: resHeaders, body: new Uint8Array() });
      res.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy(new Error(`public HTTP response exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => finish(resolve, { status: res.statusCode ?? 0, headers: resHeaders, body: Buffer.concat(chunks) }));
    res.on("error", (err) => finish(reject, err));
  });
  timer = setTimeout(() => req.destroy(timeoutError()), timeoutMs);
  req.setTimeout(timeoutMs, () => req.destroy(timeoutError()));
  req.on("error", (err) => finish(reject, err));
  if (body !== undefined) req.end(body);
  else req.end();
});

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-canon-signature", "canon-signature"]);

/** Public-only GET with DNS pinning, bounded bodies, and per-hop redirect validation. */
export async function publicHttpGet(rawUrl: string, options: {
  headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number;
  lookup?: PublicLookup; requestHop?: PublicRequestHop;
} = {}): Promise<PublicHttpResult> {
  let current = rawUrl;
  let headers = { ...(options.headers ?? {}) };
  const maxRedirects = options.maxRedirects ?? 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, options.lookup);
    const addresses = (url as URL & { __publicAddresses: PublicAddress[] }).__publicAddresses;
    const result = await (options.requestHop ?? requestHop)(url, addresses, headers, options.timeoutMs ?? 15_000, options.maxBytes ?? DEFAULT_PUBLIC_HTTP_MAX_BYTES, { method: "GET" });
    const location = result.headers.get("location");
    if (maxRedirects > 0 && result.status >= 300 && result.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())));
      }
      current = next.toString();
      continue;
    }
    return { ...result, finalUrl: current };
  }
  throw new Error(`public HTTP: too many redirects (>${maxRedirects}) for ${rawUrl}`);
}

/**
 * DNS-pinned HTTP/HTTPS POST for outbound webhooks. Resolves DNS once, validates
 * every returned address against private ranges, pins the validated IP directly
 * onto the socket (no TOCTOU window), and does not follow redirects by default
 * (`maxRedirects: 0`).
 */
export async function publicHttpPost(rawUrl: string, options: {
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowLoopback?: boolean;
  lookup?: PublicLookup;
  requestHop?: PublicRequestHop;
} = {}): Promise<PublicHttpResult> {
  let current = rawUrl;
  let headers = { ...(options.headers ?? {}) };
  const maxRedirects = options.maxRedirects ?? 0;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, options.lookup, { allowLoopback: options.allowLoopback });
    const addresses = (url as URL & { __publicAddresses: PublicAddress[] }).__publicAddresses;
    const result = await (options.requestHop ?? requestHop)(
      url,
      addresses,
      headers,
      options.timeoutMs ?? 15_000,
      options.maxBytes ?? DEFAULT_PUBLIC_HTTP_MAX_BYTES,
      { method: "POST", body: options.body },
    );
    const location = result.headers.get("location");
    if (maxRedirects > 0 && result.status >= 300 && result.status < 400 && location) {
      if (hop === maxRedirects) break;
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())));
      }
      current = next.toString();
      continue;
    }
    return { ...result, finalUrl: current };
  }
  throw new Error(`public HTTP: too many redirects (>${maxRedirects}) for ${rawUrl}`);
}
