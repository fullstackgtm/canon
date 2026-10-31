/**
 * Convex-side surface of the Salesforce Bulk import: the pure mapping and
 * engine live in engine/src/sync/salesforceImport/ (tested
 * there against a Bulk 2.0 simulator); this module re-exports what Convex
 * needs plus the validators for sfImportJobs rows.
 */
import { v } from "convex/values";

export {
  mapAccount,
  mapContact,
  mapLead,
  mapCustom,
  normalizeSfId,
  domainFromWebsite,
  domainFromEmail,
} from "../../engine/src/sync/salesforceImport/mapping.ts";

/** Max rejected rows kept on a job for `listRejected` (counts stay exact). */
export const REJECTED_SAMPLE_CAP = 1000;
/** Each import action stops at a chunk boundary after this long and reschedules itself. */
export const RUN_SLICE_MS = 7 * 60 * 1000;

export const objectStateValidator = v.object({
  apiName: v.string(),
  sfTotal: v.number(),
  upserted: v.number(),
  merged: v.number(),
  rejected: v.number(),
  bulkJobId: v.optional(v.string()),
  state: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
  locator: v.optional(v.string()),
  chunksDone: v.optional(v.number()),
  seen: v.optional(v.number()),
  error: v.optional(v.string()),
});

export const rejectedRowValidator = v.object({ object: v.string(), sfId: v.optional(v.string()), reason: v.string() });

/** Salesforce owners kept on a job for the owner report; past it, the rest are dropped (an org with more users is rare). */
export const OWNERS_CAP = 2000;

export const ownerTallyValidator = v.object({
  sfUserId: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  memberId: v.optional(v.string()),
  records: v.number(),
});

/** Add a chunk's owner counts to a job's, keyed by Salesforce user id. */
export function mergeOwners<T extends { sfUserId: string; records: number }>(current: readonly T[], chunk: readonly T[], cap: number): T[] {
  const out = new Map(current.map((o) => [o.sfUserId, o]));
  for (const o of chunk) {
    const had = out.get(o.sfUserId);
    if (had) out.set(o.sfUserId, { ...had, records: had.records + o.records });
    else if (out.size < cap) out.set(o.sfUserId, o);
  }
  return [...out.values()];
}

/** Drop undefined keys so objects match Convex validators exactly. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined)) as T;
}
