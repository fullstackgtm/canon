/**
 * CRM-synced annual revenue -> record-service annotations for the TAM
 * explorer's revenue pass. Pure.
 *
 * crmAccounts.annualRevenue is stored in CENTS (hubspotActions /
 * salesforceActions convert with toCents); annotations carry dollars.
 * Accounts match by domain, normalized as the record service does on upsert.
 * When several CRM accounts share a domain, the largest revenue wins.
 */
import type { AnnotateRecord } from "../recordContract";
import { normalizeDomain } from "../recordClient.ts";

export function crmRevenueRecords(rows: Array<{ domain?: string | null; annualRevenueCents?: number | null }>): AnnotateRecord[] {
  const byDomain = new Map<string, number>();
  for (const r of rows) {
    if (!r.domain || typeof r.annualRevenueCents !== "number" || !(r.annualRevenueCents > 0)) continue;
    const domain = normalizeDomain(r.domain);
    if (!domain) continue;
    const dollars = Math.round(r.annualRevenueCents / 100);
    if (dollars > (byDomain.get(domain) ?? 0)) byDomain.set(domain, dollars);
  }
  return [...byDomain].map(([domain, revenue]) => ({ domain, revenue, revenueSource: "crm" as const }));
}
