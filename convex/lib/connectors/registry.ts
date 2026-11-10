/**
 * Canon's connectors (shared gap P5, docs/connector-feeds.md). A connector is Canon code that talks to one outside
 * system with Canon's secrets and writes what it learns into feeds, which modules read. One file per connector; this
 * file only lists them. Runtime-neutral: no Node imports, so default-runtime functions and tests import it.
 */
import { webhook } from "./webhook.ts";
import { linkedin } from "./linkedin.ts";

/** A field a feed's items carry. `time` is ms since the epoch; `object` and `list` hold JSON. */
export type FeedFieldType = "string" | "number" | "boolean" | "time" | "object" | "list";
export type FeedField = { type: FeedFieldType; label: string };

export type FeedDecl = {
  label: string;
  /** The fields an item may carry. Anything else a connector hands in is dropped before it is stored. */
  fields: Record<string, FeedField>;
  /** An item larger than this, as JSON, is refused into its link's error. Large payloads live in Canon records. */
  maxItemBytes: number;
};

export type ConnectorDecl = {
  id: string;
  label: string;
  /** `member`: one link per member (their recorder, their LinkedIn); `workspace`: links an admin adds. */
  scope: "member" | "workspace";
  auth: "signedWebhook" | "oauth" | "apiKey" | "canon";
  /** Canon env vars the connector needs (Doppler); the Feeds page says which are missing, never their values. */
  env: readonly string[];
  /** Feed names start with the connector's id: `webhook.events`. */
  feeds: Record<string, FeedDecl>;
};

export const CONNECTORS: Record<string, ConnectorDecl> = { [webhook.id]: webhook, [linkedin.id]: linkedin };

export function connectorOf(id: string): ConnectorDecl | null {
  return Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id] : null;
}

/** The connector that owns a feed, and the feed's declaration. */
export function feedOf(feed: string): { connector: ConnectorDecl; decl: FeedDecl } | null {
  const connector = connectorOf(feed.split(".")[0]);
  const decl = connector && Object.hasOwn(connector.feeds, feed) ? connector.feeds[feed] : null;
  return connector && decl ? { connector, decl } : null;
}

const fits: Record<FeedFieldType, (x: unknown) => boolean> = {
  string: (x) => typeof x === "string",
  number: (x) => typeof x === "number" && Number.isFinite(x),
  boolean: (x) => typeof x === "boolean",
  time: (x) => typeof x === "number" && Number.isFinite(x),
  object: (x) => typeof x === "object" && x !== null && !Array.isArray(x),
  list: (x) => Array.isArray(x),
};

/**
 * An item's data as the feed stores it: its declared fields only, each null when absent, or the first problem. A
 * field of the wrong type refuses the item rather than store it wrong.
 */
export function itemData(decl: FeedDecl, data: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(decl.fields)) {
    const value = data[name] ?? null;
    if (value !== null && !fits[field.type](value)) return { ok: false, error: `${field.label} must be ${field.type === "list" ? "a list" : `a ${field.type}`}.` };
    out[name] = value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes > decl.maxItemBytes) return { ok: false, error: `The item is ${bytes} bytes; ${decl.label} takes at most ${decl.maxItemBytes}.` };
  return { ok: true, data: out };
}
