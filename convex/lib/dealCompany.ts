/**
 * Which register company a deal belongs to. A person links a deal to a
 * company with its `companyId` field (a register id, `acc_…`). A deal synced
 * from a CRM carries its CRM account (`accountId`, a `crmAccounts` row), which
 * resolves to the company whose ledger stream holds that account's CRM id.
 * The person's link wins: it is an explicit choice, the CRM's is inferred.
 *
 * Pure: no database access.
 */

export type CompanyLink =
  | { kind: "stored"; companyId: string }
  | { kind: "crm"; crmAccountId: string }
  | { kind: "none" };

type LinkedDeal = { companyId?: string; accountId?: string };

export function companyLinkOf(deal: LinkedDeal): CompanyLink {
  if (deal.companyId) return { kind: "stored", companyId: deal.companyId };
  if (deal.accountId) return { kind: "crm", crmAccountId: deal.accountId };
  return { kind: "none" };
}

/**
 * The deals of one company, each once, by close date: the deals linked to it,
 * and those whose CRM account is one of `crmAccountIds` (the CRM accounts of
 * the company's stream) unless a person linked them elsewhere.
 */
export function companyDeals<D extends LinkedDeal & { _id: string; closeDate: string }>(
  companyId: string,
  crmAccountIds: readonly string[],
  candidates: readonly D[],
): Array<D & { link: Exclude<CompanyLink, { kind: "none" }> }> {
  const crm = new Set(crmAccountIds);
  const seen = new Set<string>();
  const out: Array<D & { link: Exclude<CompanyLink, { kind: "none" }> }> = [];
  for (const deal of candidates) {
    const link = companyLinkOf(deal);
    if (seen.has(deal._id) || link.kind === "none") continue;
    if (link.kind === "stored" ? link.companyId !== companyId : !crm.has(link.crmAccountId)) continue;
    seen.add(deal._id);
    out.push({ ...deal, link });
  }
  return out.sort((a, b) => a.closeDate.localeCompare(b.closeDate));
}
