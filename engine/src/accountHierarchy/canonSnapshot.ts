/**
 * The account hierarchy manager's snapshot built from Canon's own records: the companies a caller sees, their
 * `account_parent` edges, the workspace's members and its deals. Produces the same snapshot shape the Salesforce
 * reader does, so detection, research and proposals run unchanged and work for any workspace (HubSpot import, CSV,
 * hand-entered).
 *
 * The caller passes rows it already read under someone's visibility. An edge whose either end is not among those
 * companies is dropped, the same rule the record page's related lists follow, so a hidden or deleted company never
 * appears as a parent either.
 *
 * Pure: no Node-only imports.
 */
import type { CanonicalAccount, CanonicalGtmSnapshot } from "../types.ts";

export type CanonCompany = {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  country?: string;
  employees?: number;
  annualRevenue?: number;
  ownerId?: string;
  status?: string;
  /** Derived traits (AI field answers), readable by policy field name. */
  traits?: Record<string, string>;
};
/** One `account_parent` edge: `childId` sits under `parentId`. */
export type CanonParentEdge = { childId: string; parentId: string; createdAt: number };
export type CanonMember = { id: string; name: string; email?: string };
export type CanonDeal = { id: string; companyId: string; name: string; ownerId?: string; stage?: string; closeDate?: string; isClosed: boolean; isWon: boolean; amount?: number };

export function canonSnapshot(input: {
  companies: readonly CanonCompany[];
  parents: readonly CanonParentEdge[];
  members: readonly CanonMember[];
  deals?: readonly CanonDeal[];
  generatedAt?: string;
}): CanonicalGtmSnapshot {
  const seen = new Set(input.companies.map((c) => c.id));
  // Many-to-one: a company has one parent. Should two edges ever exist, the oldest wins.
  const parentOf = new Map<string, string>();
  for (const e of [...input.parents].sort((a, b) => a.createdAt - b.createdAt)) {
    if (e.childId === e.parentId || !seen.has(e.childId) || !seen.has(e.parentId) || parentOf.has(e.childId)) continue;
    parentOf.set(e.childId, e.parentId);
  }
  const accounts: CanonicalAccount[] = input.companies.map((c) => ({
    id: c.id,
    provider: "canon",
    name: c.name,
    ...(c.domain ? { domain: c.domain } : {}),
    ...(parentOf.has(c.id) ? { parentAccountId: parentOf.get(c.id) } : {}),
    ...(c.industry ? { industry: c.industry } : {}),
    ...(c.ownerId ? { ownerId: c.ownerId } : {}),
    ...(c.employees !== undefined ? { employeeCount: c.employees } : {}),
    ...(c.annualRevenue !== undefined ? { annualRevenue: c.annualRevenue } : {}),
    // Policy fields name Canon keys: a column (country, status) or a trait.
    raw: rawOf(c),
  }));
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provider: "canon",
    users: input.members.map((m) => ({ id: m.id, provider: "canon", name: m.name, ...(m.email ? { email: m.email } : {}), active: true })),
    accounts,
    contacts: [],
    deals: (input.deals ?? [])
      .filter((d) => seen.has(d.companyId))
      .map((d) => ({
        id: d.id,
        provider: "canon",
        accountId: d.companyId,
        name: d.name,
        ...(d.ownerId ? { ownerId: d.ownerId } : {}),
        ...(d.stage ? { stage: d.stage } : {}),
        ...(d.closeDate ? { closeDate: d.closeDate } : {}),
        isClosed: d.isClosed,
        isWon: d.isWon,
        ...(d.amount !== undefined ? { amount: d.amount } : {}),
      })),
    activities: [],
  };
}

/** The company's columns, with its traits flattened beside them (a column wins a clash). */
function rawOf(c: CanonCompany): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...(c.traits ?? {}) };
  for (const [k, v] of Object.entries(c)) if (k !== "traits") raw[k] = v;
  return raw;
}
