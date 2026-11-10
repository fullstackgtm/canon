/**
 * The argument validators of the creates whose shape is not an object's
 * registry fields: a deal (deals.create) and a company or person added to the
 * register (records.upsert). They live here, not beside the functions, so the
 * record API's OpenAPI document (src/app/api/v1/_openapi.ts) describes a
 * create body from the validator Convex checks it with.
 */
import { v } from "convex/values";

export const dealCreateArgs = {
  name: v.string(),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  closeDate: v.string(),
  stage: v.string(),
  pipelineId: v.optional(v.union(v.string(), v.null())),
  dealType: v.optional(v.string()),
  revenueType: v.optional(v.string()),
  primaryRepId: v.optional(v.id("users")),
  /** The register company (`acc_…`) the deal is with. */
  companyId: v.optional(v.string()),
  /** Values of the org's custom deal fields, by `custom.<slug>`; a required one must be here (CP7b). */
  custom: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
};

export const upsertAccount = v.object({
  domain: v.string(), name: v.string(),
  industry: v.optional(v.string()), employees: v.optional(v.number()), country: v.optional(v.string()), linkedinUrl: v.optional(v.string()),
});

export const upsertContact = v.object({
  fullName: v.string(), accountDomain: v.optional(v.string()), accountId: v.optional(v.string()),
  title: v.optional(v.string()), email: v.optional(v.string()), linkedinUrl: v.optional(v.string()),
});
