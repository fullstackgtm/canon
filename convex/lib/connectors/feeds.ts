/**
 * The one way Canon code writes a feed (docs/connector-feeds.md). A connector hands an item in; Canon keeps its
 * declared fields as the item's latest state (`feedItems`) and appends a `feedLog` row only when that state changed,
 * so a replayed webhook or a repeated poll writes nothing. Runs inside the caller's mutation.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { manifestOf } from "../modules/packages";
import { connectorOf, feedOf, itemData } from "./registry.ts";

type Org = Id<"organizations">;
const ERROR_MAX = 300;

export type FeedItemIn = {
  id: string;
  /** Orders updates to one item: an older one than stored is dropped (a status that arrives late). */
  version?: number;
  data: Record<string, unknown>;
  deleted?: boolean;
};

export type PutResult = { status: "written"; seq: number } | { status: "unchanged" } | { status: "stale" } | { status: "refused"; error: string };

/**
 * A member's link to a member-scoped connector, made the first time Canon writes for them: a connector that already
 * holds its own account rows (LinkedIn, the dialer) needs no linking step of its own.
 */
export async function memberLink(ctx: MutationCtx, orgId: Org, connector: string, userId: Id<"users">): Promise<Doc<"connectorLinks">> {
  const decl = connectorOf(connector);
  if (!decl || decl.scope !== "member") throw new Error(`${connector} is not a member connector.`);
  const found = await ctx.db.query("connectorLinks").withIndex("by_orgId_and_connector_and_userId", (q) => q.eq("orgId", orgId).eq("connector", connector).eq("userId", userId)).first();
  if (found) return found;
  const id = await ctx.db.insert("connectorLinks", { orgId, connector, userId, status: "ok", createdAt: Date.now() });
  return (await ctx.db.get(id))!;
}

/** Note why a link's item was refused; the Feeds page shows it. */
export async function linkError(ctx: MutationCtx, linkId: Id<"connectorLinks">, error: string) {
  await ctx.db.patch(linkId, { lastError: error.slice(0, ERROR_MAX), lastErrorAt: Date.now() });
}

/** JSON with object keys sorted: Convex hands a stored object back with its keys in its own order. */
const canonical = (x: unknown): string =>
  Array.isArray(x) ? `[${x.map(canonical).join(",")}]`
  : x !== null && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(x) ?? "null";
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Write one item of `feed` through `link`. The link must belong to the feed's connector and be live. */
export async function putFeedItem(ctx: MutationCtx, link: Doc<"connectorLinks">, feed: string, item: FeedItemIn): Promise<PutResult> {
  const owner = feedOf(feed);
  if (!owner || owner.connector.id !== link.connector) throw new Error(`${link.connector} doesn't write ${feed}.`);
  if (link.status === "revoked") return { status: "refused", error: "This link was removed." };
  const parsed = itemData(owner.decl, item.data);
  if (!parsed.ok) {
    await linkError(ctx, link._id, parsed.error);
    return { status: "refused", error: parsed.error };
  }
  const itemId = item.id.slice(0, 300);
  const now = Date.now();
  const deleted = item.deleted ?? false;
  const stored = await ctx.db.query("feedItems").withIndex("by_orgId_and_feed_and_itemId", (q) => q.eq("orgId", link.orgId).eq("feed", feed).eq("itemId", itemId)).unique();
  if (stored && item.version !== undefined && stored.version !== undefined && item.version < stored.version) return { status: "stale" };
  // A delete keeps the item's last fields, so a module still reads what it was.
  const data = deleted && stored ? stored.data : parsed.data;
  if (stored && stored.deleted === deleted && same(stored.data, data)) {
    if (item.version !== undefined && item.version !== stored.version) await ctx.db.patch(stored._id, { version: item.version });
    return { status: "unchanged" };
  }
  const version = item.version === undefined ? {} : { version: item.version };
  const before = stored && !stored.deleted ? stored.data : null;
  if (stored) await ctx.db.patch(stored._id, { ...version, linkId: link._id, data, deleted, updatedAt: now });
  else await ctx.db.insert("feedItems", { orgId: link.orgId, feed, itemId, linkId: link._id, ...version, data, deleted, updatedAt: now });
  const last = await ctx.db.query("feedLog").withIndex("by_orgId_and_feed_and_seq", (q) => q.eq("orgId", link.orgId).eq("feed", feed)).order("desc").first();
  const seq = (last?.seq ?? 0) + 1;
  await ctx.db.insert("feedLog", {
    orgId: link.orgId, feed, seq, itemId, linkId: link._id,
    before, after: deleted ? null : data, at: now,
  });
  await ctx.db.patch(link._id, { lastItemAt: now });
  const modules = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", link.orgId).eq("status", "installed")).take(50);
  if (modules.some((pkg) => Object.values(manifestOf(pkg).feeds ?? {}).some((f) => f.feed === feed))) {
    await ctx.scheduler.runAfter(0, internal.moduleJobs.feedItems, { orgId: link.orgId });
  }
  return { status: "written", seq };
}
