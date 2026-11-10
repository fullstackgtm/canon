/**
 * A HubSpot record as the mirror tables take it (crmAccounts, crmContacts, deals), from the connector's canonical
 * shape. The scheduled sync (hubspotActions.ts) and the portal import (hubspotImport.ts) both write through these,
 * so the two never disagree about a value and never overwrite each other's writes with a different one.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { CanonicalAccount, CanonicalContact, CanonicalDeal } from "../../engine/src/types.ts";

/** The canonical model carries amounts in major units; the app stores cents. */
export function toCents(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function mapDealType(value: unknown): "new_business" | "expansion" | "renewal" | "one_time" {
  const type = String(value ?? "").toLowerCase();
  if (type.includes("renew")) return "renewal";
  if (type.includes("expan") || type.includes("upsell") || type.includes("add")) return "expansion";
  if (type.includes("one")) return "one_time";
  return "new_business";
}

/** A HubSpot ISO timestamp as epoch milliseconds, or undefined. */
export function hubspotTime(value: unknown): number | undefined {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

type Ids<T extends string> = Readonly<Record<string, T>>;

export function mirrorAccount<U extends string>(account: CanonicalAccount, ownerMap: Ids<U>) {
  return {
    crmId: account.crmId ?? account.id,
    name: account.name,
    domain: account.domain,
    industry: account.industry,
    employeeCount: account.employeeCount === undefined ? undefined : Math.round(account.employeeCount),
    annualRevenue: account.annualRevenue === undefined ? undefined : toCents(account.annualRevenue),
    crmOwnerId: account.ownerId,
    ownerId: account.ownerId ? ownerMap[account.ownerId] : undefined,
    rawData: account.raw,
  };
}

export function mirrorContact<U extends string, A extends string>(contact: CanonicalContact, ownerMap: Ids<U>, accountMap: Ids<A>) {
  return {
    crmId: contact.crmId ?? contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    title: contact.title,
    crmOwnerId: contact.ownerId,
    ownerId: contact.ownerId ? ownerMap[contact.ownerId] : undefined,
    accountId: contact.accountId ? accountMap[contact.accountId] : undefined,
    rawData: contact.raw,
  };
}

/**
 * Closed and won come from the deal's pipeline stage (the connector reads them from the pipeline definitions), so
 * a custom pipeline's closed stage is closed. Ownerless and amountless deals are kept: the audit flags them.
 */
export function mirrorDeal<U extends string, A extends string>(deal: CanonicalDeal, ownerMap: Ids<U>, accountMap: Ids<A>, today: string) {
  const isWon = deal.isWon === true;
  const isClosed = isWon || deal.isClosed === true;
  const closeDate = deal.closeDate ?? today;
  const closeTime = Date.parse(closeDate);
  return {
    crmId: deal.crmId ?? deal.id,
    name: deal.name,
    amount: deal.amount === undefined ? undefined : toCents(deal.amount),
    closeDate,
    dealType: mapDealType(deal.dealType),
    revenueType: "one_time" as const,
    primaryRepId: deal.ownerId ? ownerMap[deal.ownerId] : undefined,
    crmOwnerId: deal.ownerId,
    accountId: deal.accountId ? accountMap[deal.accountId] : undefined,
    stage: deal.stage,
    forecastCategory: (isWon ? "closed_won" : isClosed ? "closed_lost" : "pipeline") as "closed_won" | "closed_lost" | "pipeline",
    probability: deal.probability,
    isClosed,
    isWon,
    closedAt: isClosed && Number.isFinite(closeTime) ? closeTime : undefined,
    rawData: deal.raw,
    createdAt: hubspotTime((deal.raw as { createdAt?: unknown } | undefined)?.createdAt),
  };
}
