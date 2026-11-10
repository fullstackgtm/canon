/**
 * A create's `Idempotency-Key` (docs/record-api.md, Create): every record create the API and MCP make runs through
 * `createOnce`, inside the mutation that creates, so the key check and the create are one transaction and two
 * requests with one key cannot both create. Convex runs mutations serializably: the second sees the first's row.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { artifactSha256 } from "./artifactVersioning";

/** How long a key is remembered after its first request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const IDEMPOTENCY_KEY_MAX = 200;

export const reusedIdempotencyKeyMessage = (key: string) => `Idempotency-Key ${key} was already used for a different request; send a new key for a new request`;

/**
 * Run `create` once per key for this user in this workspace. The first request stores its answer with a hash of
 * `request`; a later one with the same request gets that answer back and creates nothing; one with another request
 * is refused. An answer `keep` refuses (values rejected) is not stored, so a corrected retry with the key works. No
 * key: `create` runs as is.
 */
export async function createOnce<T>(
  ctx: MutationCtx,
  scope: { orgId: Id<"organizations">; userId: Id<"users"> },
  key: string | undefined,
  request: unknown,
  create: () => Promise<T>,
  keep: (result: T) => boolean = () => true,
): Promise<T> {
  if (key === undefined) return create();
  if (!key.length || key.length > IDEMPOTENCY_KEY_MAX) throw new ConvexError(`Idempotency-Key must be 1 to ${IDEMPOTENCY_KEY_MAX} characters`);
  const hash = await artifactSha256(request);
  const now = Date.now();
  const row = await ctx.db
    .query("apiIdempotencyKeys")
    .withIndex("by_orgId_and_userId_and_key", (q) => q.eq("orgId", scope.orgId).eq("userId", scope.userId).eq("key", key))
    .unique();
  if (row && row.expiresAt > now) {
    if (row.request !== hash) throw new ConvexError(reusedIdempotencyKeyMessage(key));
    return row.result as T;
  }
  const result = await create();
  if (!keep(result)) return result;
  const doc = { ...scope, key, request: hash, result: result ?? null, expiresAt: now + IDEMPOTENCY_TTL_MS };
  if (row) await ctx.db.replace(row._id, doc);
  else await ctx.db.insert("apiIdempotencyKeys", doc);
  return result;
}

/** A ledger save worth replaying: one that created a record or a proposal, not one whose values were rejected. */
export const createdOrProposed = (result: { status: string }) => result.status === "applied" || result.status === "proposed";

/** Keys past their day, a batch at a time. */
export async function purgeExpiredKeys(ctx: MutationCtx, batch: number): Promise<number> {
  const expired = await ctx.db.query("apiIdempotencyKeys").withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now())).take(batch);
  await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
  return expired.length;
}
