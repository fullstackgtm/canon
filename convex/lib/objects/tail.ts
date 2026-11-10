/**
 * The ledger feed the record service's projector pulls (docs/cp0-object-layer.md,
 * "Ledger" and migration step 6): request parsing, paging and auth for the
 * `/ledger/*` HTTP routes in convex/http.ts.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { ObjectDef } from "./registry.ts";
import { SHARDS, type StoredEntry } from "./write.ts";

export const TAIL_LIMIT_DEFAULT = 200;
export const TAIL_LIMIT_MAX = 500;
export const STREAM_LIMIT_MAX = 500;
/**
 * Serialized bytes per `/ledger/tail` or `/ledger/stream` page. An entry's text
 * is unbounded up to Convex's 1 MiB document limit, so 500 entries can pass the
 * 16 MiB a query may read or return; the page stops at this budget instead.
 */
export const PAGE_BYTES_MAX = 4 * 1024 * 1024;

const encoder = new TextEncoder();
/** An entry's size as the feed sends it: UTF-8 bytes of its JSON. */
export const wireSize = (row: unknown) => encoder.encode(JSON.stringify(row)).length;

/**
 * Take a page from a lazily read index range: at most `limit` rows and, past
 * the first row, no row that would take the page over `maxBytes`. The first
 * row is always taken, so an entry larger than the budget still moves the
 * cursor. Reads at most one row beyond the page; `more` is whether one was there.
 */
export async function boundedPage<T>(
  rows: AsyncIterable<T>,
  opts: { limit: number; maxBytes?: number; size?: (row: T) => number },
): Promise<{ items: T[]; more: boolean }> {
  const maxBytes = opts.maxBytes ?? PAGE_BYTES_MAX;
  const size = opts.size ?? wireSize;
  const items: T[] = [];
  let bytes = 0;
  for await (const row of rows) {
    if (items.length >= opts.limit) return { items, more: true };
    const n = size(row);
    if (items.length > 0 && bytes + n > maxBytes) return { items, more: true };
    items.push(row);
    bytes += n;
  }
  return { items, more: false };
}

/** A ledger entry as the feed sends it: the entry plus its object and (shard, seq). */
export type WireEntry = StoredEntry & { redactedAt?: number };

export type TailParams = { org: string; shard: number; after: number; limit: number };
export type StreamParams = { org: string; id: string; fromVersion: number; limit: number };

export type TailResponse = {
  entries: WireEntry[];
  /** The shard's last issued `seq` when the page was read. */
  head: number;
};

/**
 * Where each shard's ledger ends, and the org's resolved object definitions.
 * The projector reads both on every catch-up, so a registry change reaches it
 * even when no shard moved, and rebuilds an object whose columns changed.
 */
export type HeadsResponse = { heads: Record<string, number>; defs: ObjectDef[] };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function intParam(params: URLSearchParams, name: string, opts: { min: number; max: number; fallback?: number }): number | string {
  const raw = params.get(name);
  if (raw === null || raw === "") return opts.fallback ?? `${name} is required`;
  if (!/^\d{1,15}$/.test(raw)) return `${name} must be a whole number`;
  const n = Number(raw);
  return n < opts.min || n > opts.max ? `${name} must be ${opts.min} to ${opts.max}` : n;
}

export function parseTailParams(params: URLSearchParams): Parsed<TailParams> {
  const org = params.get("org") ?? "";
  if (!ID.test(org)) return { ok: false, error: "org is required" };
  const shard = intParam(params, "shard", { min: 0, max: SHARDS - 1 });
  const after = intParam(params, "after", { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  const limit = intParam(params, "limit", { min: 1, max: TAIL_LIMIT_MAX, fallback: TAIL_LIMIT_DEFAULT });
  for (const v of [shard, after, limit]) if (typeof v === "string") return { ok: false, error: v };
  return { ok: true, value: { org, shard: shard as number, after: after as number, limit: limit as number } };
}

export function parseStreamParams(params: URLSearchParams): Parsed<StreamParams> {
  const org = params.get("org") ?? "";
  const id = params.get("id") ?? "";
  if (!ID.test(org)) return { ok: false, error: "org is required" };
  if (!ID.test(id)) return { ok: false, error: "id is required" };
  const fromVersion = intParam(params, "fromVersion", { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 });
  const limit = intParam(params, "limit", { min: 1, max: STREAM_LIMIT_MAX, fallback: STREAM_LIMIT_MAX });
  for (const v of [fromVersion, limit]) if (typeof v === "string") return { ok: false, error: v };
  return { ok: true, value: { org, id, fromVersion: fromVersion as number, limit: limit as number } };
}

export function parseOrgParam(params: URLSearchParams): Parsed<{ org: string }> {
  const org = params.get("org") ?? "";
  return ID.test(org) ? { ok: true, value: { org } } : { ok: false, error: "org is required" };
}

/**
 * A tail page from the entries an index read returned for `seq > after`.
 * `seq` is gap-free and commits in order, so the page is the run after+1,
 * after+2, ... The page stops at the first missing number rather than skip
 * it, so the projector can never move its cursor past an entry it has not seen.
 */
export function tailPage(rows: readonly WireEntry[], after: number, head: number): TailResponse {
  const entries: WireEntry[] = [];
  for (const row of rows) {
    if (row.seq !== after + entries.length + 1) break;
    entries.push(row);
  }
  return { entries, head };
}

/**
 * Whether an `Authorization` header carries the expected bearer token. Both
 * sides are hashed first, so the comparison takes the same time whatever the
 * token's length or how much of it matches.
 */
export async function bearerMatches(header: string | null, expected: string): Promise<boolean> {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(m?.[1] ?? ""), digest(expected)]);
  let diff = m ? 0 : 1;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
