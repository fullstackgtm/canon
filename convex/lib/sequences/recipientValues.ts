import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { principalAccess } from "../../permissions";
import { fieldLevel, canSeeRecord, may } from "../access";
import { readCanonicalMailboxRecipient } from "../outbound/recipients";

export async function sequenceRecipientValues(ctx: QueryCtx, orgId: Id<"organizations">, sequenceKey: string, contactId: string, principals: readonly Id<"users">[], fields: readonly string[]) {
  const recipient = await readCanonicalMailboxRecipient(ctx, { orgId, contactId, principalIds: principals, mergeFields: [] });
  if (!recipient.allowed) throw new Error(recipient.refused.text);
  const check = await ctx.db.query("sequenceRecipientChecks").withIndex("by_orgId_and_sequenceKey_and_contactId", (q) => q.eq("orgId", orgId).eq("sequenceKey", sequenceKey).eq("contactId", contactId)).unique();
  // The check is the approval-time snapshot: later steps prepare days after it, so only a changed address or name refuses.
  if (!check || check.checkedAt > Date.now() || check.address !== recipient.binding.address) throw new Error("Review the sequence variables for this recipient before preparing email.");
  const accesses = await principalAccess(ctx, orgId, principals);
  const needsName = fields.some((f) => f === "to.firstName" || f === "to.name");
  const needsCompany = fields.some((f) => f.startsWith("company.")) || fields.includes("to.firstName") && !check.fullName;
  if (!accesses || accesses.some((a) => fieldLevel(a, "contact", "emailStatus") === "hidden" || needsName && fieldLevel(a, "contact", "fullName") === "hidden" || needsCompany && fieldLevel(a, "contact", "accountId") === "hidden")) throw new Error("A required Canon variable is hidden.");
  if (needsCompany && accesses.some((a) => !may(a, "account", "read") || !canSeeRecord(a, "account", true, check.companyOwnerId)
    || fieldLevel(a, "account", "name") === "hidden" || fields.includes("company.domain") && fieldLevel(a, "account", "domain") === "hidden")) throw new Error("The recipient company is unavailable to a causal principal.");
  if (needsName) {
    const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", recipient.binding.streamId)).unique();
    const name = typeof row?.values.fullName === "string" ? row.values.fullName.trim() : "";
    if (name !== check.fullName.trim()) throw new Error("The canonical recipient name changed after review.");
  }
  return { streamId: recipient.binding.streamId, emailStatus: check.emailStatus,
    values: { "to.name": check.fullName, "to.firstName": check.fullName.trim().split(/\s+/)[0], "to.email": check.address, "company.name": needsCompany ? check.companyName : "", "company.domain": needsCompany ? check.companyDomain : "" } };
}
