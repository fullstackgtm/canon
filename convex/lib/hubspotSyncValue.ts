import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { NOT_WRITTEN, syncFingerprint, unchangedRow } from "./syncUnchanged.ts";

const PROVIDER = "hubspot";
const extraValue = v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()));

// A sync's rows, as the action maps them from HubSpot (lib/hubspotMirror.ts).
export const syncAccountRow = v.object({
  crmId: v.string(),
  name: v.string(),
  domain: v.optional(v.string()),
  industry: v.optional(v.string()),
  employeeCount: v.optional(v.number()),
  annualRevenue: v.optional(v.number()),
  crmOwnerId: v.optional(v.string()),
  ownerId: v.optional(v.id("users")),
  rawData: v.optional(v.any()),
  // A portal import's custom property values, as Canon values.
  extra: v.optional(v.record(v.string(), extraValue)),
});

export const syncContactRow = v.object({
  crmId: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  title: v.optional(v.string()),
  accountId: v.optional(v.id("crmAccounts")),
  // The company's HubSpot id, resolved here when accountId is not given (a sync page holds no account ids).
  accountCrmId: v.optional(v.string()),
  crmOwnerId: v.optional(v.string()),
  ownerId: v.optional(v.id("users")),
  rawData: v.optional(v.any()),
  // A portal import's further values (lifecycle stage, lead status), as Canon values.
  extra: v.optional(v.record(v.string(), extraValue)),
});

export const syncDealRow = v.object({
  crmId: v.string(),
  name: v.string(),
  amount: v.optional(v.number()),
  closeDate: v.string(),
  dealType: v.union(
    v.literal("new_business"),
    v.literal("expansion"),
    v.literal("renewal"),
    v.literal("one_time"),
  ),
  revenueType: v.union(v.literal("one_time"), v.literal("recurring")),
  primaryRepId: v.optional(v.id("users")),
  crmOwnerId: v.optional(v.string()),
  accountId: v.optional(v.id("crmAccounts")),
  // The company's HubSpot id, resolved here when accountId is not given (a sync page holds no account ids).
  accountCrmId: v.optional(v.string()),
  stage: v.optional(v.string()),
  forecastCategory: v.optional(
    v.union(
      v.literal("omit"),
      v.literal("pipeline"),
      v.literal("best_case"),
      v.literal("commit"),
      v.literal("closed_won"),
      v.literal("closed_lost"),
    ),
  ),
  probability: v.optional(v.number()),
  isClosed: v.boolean(),
  isWon: v.boolean(),
  closedAt: v.optional(v.number()),
  rawData: v.optional(v.any()),
  // When the deal was created in HubSpot.
  createdAt: v.optional(v.number()),
  // A portal import's custom property values (a deal field holds one value).
  extra: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
});

/** What a sync writes to a company's mirror row. An owner a person or territory rule assigned stays. */
export function accountSyncValue(existing: Pick<Doc<"crmAccounts">, "rawData" | "ownerId"> | null, account: Infer<typeof syncAccountRow>, now: number) {
  const hasManualOwnerOverride =
    typeof existing?.rawData === "object" &&
    existing.rawData !== null &&
    ["manual", "territory_rule"].includes(
      existing.rawData.accountAssignmentSource,
    );
  const manualAssignmentMetadata = hasManualOwnerOverride
    ? {
        accountAssignmentSource: existing.rawData.accountAssignmentSource,
        accountAssignmentUpdatedAt: existing.rawData.accountAssignmentUpdatedAt,
        accountAssignmentUpdatedBy: existing.rawData.accountAssignmentUpdatedBy,
        planningTerritoryId: existing.rawData.planningTerritoryId,
        planningTerritoryName: existing.rawData.planningTerritoryName,
        planningTerritoryAppliedAt: existing.rawData.planningTerritoryAppliedAt,
      }
    : {};
  const syncedRawData =
    typeof account.rawData === "object" && account.rawData !== null
      ? account.rawData
      : {};
  return {
    provider: PROVIDER,
    name: account.name,
    domain: account.domain,
    industry: account.industry,
    employeeCount: account.employeeCount,
    annualRevenue: account.annualRevenue,
    ownerId: hasManualOwnerOverride ? existing.ownerId : account.ownerId,
    crmOwnerId: account.crmOwnerId,
    rawData: {
      ...syncedRawData,
      ...manualAssignmentMetadata,
    },
    lastSyncAt: now,
  };
}

/** What a sync writes to a person's mirror row. */
export function contactSyncValue(contact: Infer<typeof syncContactRow>, accountId: Id<"crmAccounts"> | undefined, now: number) {
  return {
    provider: PROVIDER,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email?.toLowerCase(),
    phone: contact.phone,
    title: contact.title,
    accountId,
    ownerId: contact.ownerId,
    crmOwnerId: contact.crmOwnerId,
    rawData: contact.rawData,
    lastSyncAt: now,
  };
}

/**
 * What HubSpot says a deal's ledger fields are (convex/canon.ts SYNCED_DEAL_ATTRIBUTES). They reach the row through the
 * ledger, which leaves a value a person set as it is (lib/canon/personHold.ts); a new row starts from them.
 */
export function dealSyncValues(deal: Infer<typeof syncDealRow>) {
  return {
    name: deal.name,
    amount: deal.amount,
    currency: "USD",
    closeDate: deal.closeDate,
    dealType: deal.dealType,
    crmOwnerId: deal.crmOwnerId,
    stage: deal.stage,
    forecastCategory: deal.forecastCategory,
    probability: deal.probability,
    isClosed: deal.isClosed,
    isWon: deal.isWon,
  };
}

/**
 * The columns a sync writes to a deal's row itself: its HubSpot link, raw record and sync time. Every field a person
 * can hold is in dealSyncValues instead, and so is the owner (canon.ts saveDeal's `owner`).
 */
export function dealSyncValue(deal: Infer<typeof syncDealRow>, accountId: Id<"crmAccounts"> | undefined, now: number) {
  return {
    revenueType: deal.revenueType,
    accountId,
    crmProvider: PROVIDER,
    crmUrl: `https://app.hubspot.com/contacts/deal/${deal.crmId}`,
    rawData: deal.rawData,
    closedAt: deal.closedAt,
    lastSyncAt: now,
    updatedAt: now,
    ...(deal.createdAt !== undefined ? { createdAt: deal.createdAt } : {}),
  };
}

export function accountUnchanged(existing: Record<string, unknown> | null, value: ReturnType<typeof accountSyncValue>, extra?: unknown): boolean {
  return !!existing && !extra && unchangedRow(existing, value);
}

export function contactUnchanged(existing: Record<string, unknown> | null, value: ReturnType<typeof contactSyncValue>, extra?: unknown): boolean {
  return !!existing && existing.lastSyncAt !== NOT_WRITTEN && !extra && unchangedRow(existing, value);
}

/** The fingerprint of what a sync sent for a deal, its values and owner included: the same as when they were all the row's patch. */
export const dealSyncHash = (deal: Infer<typeof syncDealRow>, value: ReturnType<typeof dealSyncValue>) =>
  syncFingerprint({ ...value, ...dealSyncValues(deal), primaryRepId: deal.primaryRepId });

export function dealUnchanged(existing: Record<string, unknown> | null, deal: Infer<typeof syncDealRow>, value: ReturnType<typeof dealSyncValue>, extra?: unknown): boolean {
  return !!existing && !extra && existing.syncHash === dealSyncHash(deal, value);
}
