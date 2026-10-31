import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { principalAccess, recordVisible, roleIn } from "../../permissions";
import { fieldLevel, may } from "../access";
import { ID } from "../canon/identity";
import { normalizeSuppression } from "../suppressions/domain";

export type RecipientMergeField = "name" | "firstName" | "email";
export type CanonicalRecipientBinding = {
  contactId: string;
  streamId: Id<"canonEntities">;

  version: number;
  address: string;
  merge: Partial<Record<RecipientMergeField, string>>;
};
type RefusalCode = "invalid_request" | "principal_unavailable" | "contact_unavailable" | "projection_unavailable" | "contact_forbidden" | "field_unavailable";
export type CanonicalRecipientResult = { allowed: true; binding: CanonicalRecipientBinding }
  | { allowed: false; refused: { code: RefusalCode; text: string } };
type RecipientRequest = {
  orgId: Id<"organizations">;
  contactId: string;
  principalIds: readonly Id<"users">[];
  mergeFields: readonly RecipientMergeField[];
};
const refuse = (code: RefusalCode, text: string): CanonicalRecipientResult => ({ allowed: false, refused: { code, text } });
const positiveVersion = (version: number) => Number.isSafeInteger(version) && version > 0;

export async function readCanonicalMailboxRecipient(ctx: QueryCtx, request: RecipientRequest): Promise<CanonicalRecipientResult> {
  return readRecipient(ctx, request, new Map());
}

export function canonicalMailboxRecipientReader(ctx: QueryCtx) {
  const principals = new Map<string, ReturnType<typeof principalAccess>>();
  return (request: RecipientRequest) => readRecipient(ctx, request, principals);
}

async function readRecipient(ctx: QueryCtx, request: RecipientRequest, principals: Map<string, ReturnType<typeof principalAccess>>): Promise<CanonicalRecipientResult> {
  if (!request || Object.keys(request).some((key) => !["orgId", "contactId", "principalIds", "mergeFields"].includes(key))
    || typeof request.orgId !== "string" || typeof request.contactId !== "string" || !/^con_[A-Za-z0-9_-]{1,200}$/.test(request.contactId)
    || !Array.isArray(request.principalIds) || !request.principalIds.length || Array.from(request.principalIds).some((id) => typeof id !== "string")
    || !Array.isArray(request.mergeFields) || Array.from(request.mergeFields).some((field) => !["name", "firstName", "email"].includes(field))) {
    return refuse("invalid_request", "A canonical contact and closed recipient fields are required.");
  }
  const orgId = ctx.db.normalizeId("organizations", request.orgId);
  if (!orgId) return refuse("principal_unavailable", "The recipient workspace or a causal principal is unavailable.");
  const principalIds = [...new Set(request.principalIds)];
  const principalKey = JSON.stringify([orgId, principalIds]);
  if (!principals.has(principalKey)) principals.set(principalKey, (async () => {
    if (!(await ctx.db.get(orgId))) return null;
    for (const raw of principalIds) {
      const id = ctx.db.normalizeId("users", raw);
      const user = id ? await ctx.db.get(id) : null;
      if (!user || !user.isActive || user.isHidden || await roleIn(ctx, user, orgId) === null) return null;
    }
    return principalAccess(ctx, orgId, principalIds);
  })());
  const accesses = await principals.get(principalKey)!;
  if (!accesses) return refuse("principal_unavailable", "The recipient workspace or a causal principal is unavailable.");

  const mappings = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) =>
    q.eq("orgId", orgId).eq("provider", ID.recordContact).eq("externalId", request.contactId)).take(2);
  if (mappings.length !== 1) return refuse("contact_unavailable", "The canonical contact identity is unavailable or ambiguous.");
  const entity = await ctx.db.get(mappings[0].entityId);
  if (!entity || entity.orgId !== orgId || entity.entityType !== "contact" || entity.mergedInto !== undefined) {
    return refuse("contact_unavailable", "The canonical contact identity is unavailable or ambiguous.");
  }
  const rows = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", entity._id)).take(2);
  const row = rows[0];
  if (rows.length !== 1 || !row || row.orgId !== orgId || row.streamId !== entity._id || row.object !== "contact"
    || row.lifecycle.status !== "active" || !positiveVersion(row.version)) {
    return refuse("projection_unavailable", "A complete current worked-contact projection is required.");
  }
  const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id)).order("desc").take(2);
  const latest = entries[0];
  if (!latest || latest.orgId !== orgId || latest.streamId !== entity._id || latest.object !== "contact"
    || !positiveVersion(latest.version) || latest.version !== row.version || entries[1]?.version === latest.version) {
    return refuse("projection_unavailable", "A complete current worked-contact projection is required.");
  }

  const needsName = request.mergeFields.some((field) => field === "name" || field === "firstName");
  for (const access of accesses) {
    if (!may(access, "contact", "read") || !(await recordVisible(ctx, access, row))) {
      return refuse("contact_forbidden", "Every causal principal must be able to read this contact.");
    }
    if (fieldLevel(access, "contact", "email") === "hidden" || (needsName && fieldLevel(access, "contact", "fullName") === "hidden")) {
      return refuse("field_unavailable", "A required canonical recipient field is unavailable.");
    }
  }
  const address = typeof row.values.email === "string" ? normalizeSuppression("email", row.values.email) : null;
  const name = needsName && typeof row.values.fullName === "string" ? row.values.fullName.trim() : "";
  if (!address || (needsName && !name)) return refuse("field_unavailable", "A required canonical recipient field is unavailable.");
  const merge: CanonicalRecipientBinding["merge"] = {};
  for (const field of request.mergeFields) {
    if (field === "email") merge.email = address;
    else if (field === "name") merge.name = name;
    else merge.firstName = name.split(/\s+/)[0];
  }
  return { allowed: true, binding: { contactId: request.contactId, streamId: entity._id, version: row.version, address, merge } };
}
