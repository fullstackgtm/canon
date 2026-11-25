/**
 * Record webhooks (CP16b, docs/record-api.md "Webhooks"): the pure parts.
 * Which ledger entry becomes which event, what a delivery's body says, how
 * long to wait between attempts, and which destinations are refused. Free of
 * database and Node-only imports: convex/recordWebhooks.ts drives it.
 *
 * Deliveries are signed exactly like inbound agent webhooks
 * (lib/agents/webhook.ts): `X-Canon-Timestamp` and
 * `X-Canon-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
 */
import type { EntryBody } from "./objects/fold.ts";
import type { ObjectDef } from "./objects/registry.ts";
import { ipIsPrivate } from "../../engine/src/portable/ipAddress.ts";

export const RECORD_EVENTS = ["record.created", "record.updated", "record.deleted", "record.restored"] as const;
export type RecordEvent = (typeof RECORD_EVENTS)[number];

export type EventEntry = { object: string; version: number; seq: number; shard: number; observedAt: number; body: EntryBody; redactedAt?: number };
export type RecordEventBody = {
  event: RecordEvent;
  object: string;
  id: string;
  changedFields: string[];
  values: Record<string, unknown>;
  version: number;
  at: string;
  seq: number;
  shard: number;
  eventId: string;
};

/**
 * The event a ledger entry is, or null when it is not one. Only accepted
 * changes count: a proposal waiting for review, a rejection, a re-observation
 * with no change, a merge and an erasure produce nothing. A record's first
 * entry is its creation; later asserts and accepted decisions are updates.
 * `values` holds the new value of each changed field, by apiName.
 */
export function eventOf(entry: EventEntry, def: ObjectDef | undefined, recordId: string): RecordEventBody | null {
  if (entry.redactedAt !== undefined || !def) return null;
  const apiName = (fieldId: string) => def.fields.find((f) => f.fieldId === fieldId)?.apiName ?? fieldId;
  const body = entry.body;
  let event: RecordEvent;
  const values: Record<string, unknown> = {};
  if (body.kind === "assert") {
    if (body.status !== "accepted") return null;
    event = entry.version === 1 ? "record.created" : "record.updated";
    for (const a of body.assertions) values[apiName(a.fieldId)] = a.value;
  } else if (body.kind === "decide") {
    const accepted = body.decisions.filter((d) => d.status === "accepted");
    if (!accepted.length) return null;
    event = "record.updated";
    for (const d of accepted) values[apiName(d.fact.fieldId)] = d.fact.value;
  } else if (body.kind === "lifecycle") {
    if (body.op === "create") event = "record.created";
    else if (body.op === "delete") event = "record.deleted";
    else if (body.op === "restore") event = "record.restored";
    else return null;
  } else return null;
  return {
    event, object: entry.object, id: recordId, changedFields: Object.keys(values), values, version: entry.version,
    at: new Date(entry.observedAt).toISOString(), seq: entry.seq, shard: entry.shard, eventId: `${entry.shard}.${entry.seq}`,
  };
}

/** Wait before attempt n+1 after attempt n failed (n from 1): 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h. Null once attempts run out. */
export const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
export const backoffMs = (attempt: number): number | null => (attempt >= MAX_ATTEMPTS ? null : BACKOFF_MS[attempt - 1] ?? null);

export const RECEIVER_TIMEOUT_MS = 10_000;
/** An attempt that has not settled this long after it began is presumed dead and may be sent again. */
export const LEASE_MS = 120_000;

/**
 * Loopback webhook targets (`localhost`, `127.0.0.1`, `[::1]`) are refused by
 * default — including in self-hosted installs where `CONVEX_SITE_URL` points to
 * `127.0.0.1` — and require an explicit opt-in flag for local dev/testing.
 */
export const allowLoopbackWebhooks = (env: Record<string, string | undefined> = process.env): boolean =>
  env.CANON_ALLOW_LOOPBACK_WEBHOOKS === "true";

export type WebhookPostResult =
  | { ok: true; status: number }
  | { ok: false; error: string; retry: boolean; kind?: "ssrf" | "timeout" | "network" };

export type WebhookPoster = (req: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<WebhookPostResult>;

/** Whether an address is loopback, private, link-local, carrier-grade NAT, SIIT, NAT64, site-local, multicast or unspecified. */
export function privateAddress(ip: string): boolean {
  return ipIsPrivate(ip.replace(/^\[|\]$/g, ""));
}

/**
 * Why a URL cannot be a webhook destination, or null when it can. https only
 * (http or https to a loopback host is allowed only when `local: true` via
 * `CANON_ALLOW_LOOPBACK_WEBHOOKS=true`); no credentials in the URL; no IP
 * literal at all, so no private, loopback or link-local one; and no `localhost`,
 * `.local`, `.internal` or dotless name. The URL parser has already turned
 * decimal, hex and octal IPv4 spellings into dotted form, which the literal
 * rule catches. A public name that resolves to a private address is refused at
 * delivery time by the DNS-pinned Node transport (`publicHttpPost`).
 */
export function destinationProblem(raw: string, local = false): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "Enter a full URL, like https://example.com/hooks/canon"; }
  if (url.username || url.password) return "The URL cannot contain a username or password";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (local && loopback) return url.protocol === "http:" || url.protocol === "https:" ? null : "Use http or https";
  if (url.protocol !== "https:") return "The URL must start with https://";
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return "IP addresses are not allowed; use a hostname";
  if (/\.(localhost|local|internal|localdomain|lan)$/.test(host) || host.endsWith(".home.arpa") || !host.includes(".")) return "That hostname is not a public address";
  return null;
}

/** Whether any address a name resolved to is private: a public-looking name must not lead inside a network. */
export const resolvesPrivate = (addresses: readonly string[]): boolean => addresses.some(privateAddress);

export const newSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

export type EndpointState = { id: string; objects: readonly string[]; events: readonly string[]; cursors: Readonly<Record<string, number>> };

/**
 * What one shard's next entries (in `seq` order, starting after the lowest
 * endpoint cursor) mean for each endpoint: the deliveries to enqueue and the
 * cursor to store. An entry at or below an endpoint's cursor is skipped, so
 * an endpoint is never given an entry twice; every entry up to the last one
 * read moves the cursor, matched or not, so none is looked at again.
 */
export function planShard(
  endpoints: readonly EndpointState[],
  shard: number,
  entries: readonly EventEntry[],
  defs: ReadonlyMap<string, ObjectDef>,
  recordId: (entry: EventEntry) => string,
): { deliveries: Array<{ endpointId: string; body: RecordEventBody }>; cursors: Record<string, number> } {
  const deliveries: Array<{ endpointId: string; body: RecordEventBody }> = [];
  const cursors: Record<string, number> = {};
  const last = entries.length ? entries[entries.length - 1].seq : 0;
  const events = new Map<number, RecordEventBody | null>();
  for (const e of endpoints) {
    const cursor = e.cursors[String(shard)] ?? 0;
    for (const entry of entries) {
      if (entry.seq <= cursor) continue;
      if (!events.has(entry.seq)) events.set(entry.seq, eventOf(entry, defs.get(entry.object), recordId(entry)));
      const body = events.get(entry.seq);
      if (body && (!e.objects.length || e.objects.includes(body.object)) && e.events.includes(body.event)) deliveries.push({ endpointId: e.id, body });
    }
    if (last > cursor) cursors[e.id] = last;
  }
  return { deliveries, cursors };
}
