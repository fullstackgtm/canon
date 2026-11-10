/**
 * What CRMs say about fields a person holds (lib/canon/personHold.ts), kept in `parentDisagreements` with
 * `association: "field"` beside the link disagreements, one row per record, field and CRM record.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { FieldClaim, FieldClaimStore } from "./canon/personHold";
import type { FactValue } from "./canon/policy";

/** Claims read for one record: a few fields, each from at most a couple of CRMs. */
const CLAIMS_PER_RECORD_MAX = 50;

export const asFieldClaim = (d: Doc<"parentDisagreements">): FieldClaim | null =>
  d.association === "field" && d.attribute
    ? { id: d._id, recordId: d.accountId, field: d.attribute, provider: d.provider, ref: d.crmRef, value: (d.crmValue ?? null) as FactValue, seenAt: d.seenAt }
    : null;

/** Every field claim kept for a record. */
export async function fieldClaimsOf(ctx: QueryCtx, orgId: Id<"organizations">, recordId: string): Promise<FieldClaim[]> {
  const rows = await ctx.db.query("parentDisagreements")
    .withIndex("by_orgId_and_accountId_and_crmRef", (q) => q.eq("orgId", orgId).eq("accountId", recordId))
    .take(CLAIMS_PER_RECORD_MAX);
  return rows.flatMap((d) => asFieldClaim(d) ?? []);
}

/** The store the deal writer settles claims through, each record's read once per transaction. */
export function fieldClaimStore(ctx: MutationCtx): FieldClaimStore {
  const read = new Map<string, FieldClaim[]>();
  const org = (id: string) => id as Id<"organizations">;
  const of = async (orgId: string, recordId: string) => {
    const hit = read.get(recordId) ?? (await fieldClaimsOf(ctx, org(orgId), recordId));
    read.set(recordId, hit);
    return hit;
  };
  return {
    of,
    async put(orgId, c, replaces) {
      const row = {
        orgId: org(orgId), accountId: c.recordId, provider: c.provider, crmRef: c.ref, crmParentId: null, seenAt: c.seenAt,
        association: "field" as const, attribute: c.field, crmValue: c.value as Doc<"parentDisagreements">["crmValue"],
      };
      const kept = await of(orgId, c.recordId);
      if (replaces) await ctx.db.replace(replaces as Id<"parentDisagreements">, row);
      const id = replaces ?? (await ctx.db.insert("parentDisagreements", row));
      read.set(c.recordId, [...kept.filter((k) => k.id !== replaces), { ...c, id }]);
    },
    async remove(_orgId, id) {
      await ctx.db.delete(id as Id<"parentDisagreements">);
      for (const [recordId, rows] of read) read.set(recordId, rows.filter((k) => k.id !== id));
    },
  };
}
