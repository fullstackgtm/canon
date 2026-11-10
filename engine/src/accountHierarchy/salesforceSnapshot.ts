/**
 * A read-only Salesforce snapshot for the account hierarchy manager: every Account, Opportunity, Contact (account
 * link only) and User, with the custom fields the workspace policy names kept in `raw`. The engine connector's own
 * snapshot selects only mapped fields, so this reads with its own SELECTs through whatever SOQL function the caller
 * has: Convex's authenticated org connection, or the `sf` CLI in the prototype script.
 *
 * Pure: no Node-only imports.
 */
import type { CanonicalGtmSnapshot } from "../types.ts";
import type { HierarchyPolicy } from "./policy.ts";

export type SoqlRow = Record<string, unknown>;
/** Runs one SELECT and returns every row (all pages). */
export type SoqlQuery = (soql: string) => Promise<SoqlRow[]>;
/** The field names an object has (from describe). */
export type DescribeFields = (sobject: "Account" | "Opportunity") => Promise<Set<string>>;

const ACCOUNT_STANDARD = ["Id", "Name", "Website", "ParentId", "OwnerId", "Industry", "BillingCountry", "CreatedDate", "CreatedById", "LastActivityDate"];
const DEAL_STANDARD = ["Id", "AccountId", "OwnerId", "Name", "StageName", "CloseDate", "IsClosed", "IsWon", "Amount"];
/** Custom fields read when the org has them, whether or not the policy names them: they help detection. */
const ACCOUNT_OPTIONAL = ["Website_Domain__c"];

/** The provider field names a policy reads from accounts and deals. */
export function policyFields(policy: HierarchyPolicy): { account: string[]; deal: string[] } {
  const account = [
    ...ACCOUNT_OPTIONAL,
    policy.customerStatus?.field,
    policy.ultimateParentField,
    policy.region?.countryField,
    policy.region?.regionField,
    ...policy.fillableFields,
  ].filter((f): f is string => Boolean(f) && /^[A-Za-z][A-Za-z0-9_]*$/.test(f!));
  const deal = [policy.activeContract?.endDateField].filter((f): f is string => Boolean(f) && /^[A-Za-z][A-Za-z0-9_]*$/.test(f!));
  return { account, deal };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function readSalesforceSnapshot(
  query: SoqlQuery,
  describe: DescribeFields,
  policy: HierarchyPolicy,
  now = new Date().toISOString(),
): Promise<CanonicalGtmSnapshot> {
  const wanted = policyFields(policy);
  const [accountFields, dealFields] = await Promise.all([describe("Account"), describe("Opportunity")]);
  const accountSelect = [...new Set([...ACCOUNT_STANDARD, ...wanted.account.filter((f) => accountFields.has(f))])];
  const dealSelect = [...new Set([...DEAL_STANDARD, ...wanted.deal.filter((f) => dealFields.has(f))])];
  const [users, accounts, contacts, deals] = await Promise.all([
    query("SELECT Id, Name, Email, IsActive FROM User"),
    query(`SELECT ${accountSelect.join(", ")} FROM Account`),
    query("SELECT Id, AccountId FROM Contact WHERE AccountId != null"),
    query(`SELECT ${dealSelect.join(", ")} FROM Opportunity`),
  ]);
  return {
    generatedAt: now,
    provider: "salesforce",
    users: users.map((u) => ({ id: String(u.Id), provider: "salesforce", name: String(u.Name ?? ""), email: str(u.Email), active: u.IsActive === true })),
    accounts: accounts.map((a) => ({
      id: String(a.Id),
      provider: "salesforce",
      name: String(a.Name ?? ""),
      domain: str(a.Website_Domain__c) ?? str(a.Website),
      parentAccountId: str(a.ParentId),
      industry: str(a.Industry),
      ownerId: str(a.OwnerId),
      lastActivityAt: str(a.LastActivityDate),
      raw: stripAttributes(a),
    })),
    contacts: contacts.map((c) => ({ id: String(c.Id), provider: "salesforce", accountId: str(c.AccountId) })),
    deals: deals.map((d) => ({
      id: String(d.Id),
      provider: "salesforce",
      accountId: str(d.AccountId),
      ownerId: str(d.OwnerId),
      name: String(d.Name ?? ""),
      stage: str(d.StageName),
      closeDate: str(d.CloseDate),
      isClosed: d.IsClosed === true,
      isWon: d.IsWon === true,
      amount: typeof d.Amount === "number" ? d.Amount : undefined,
      raw: stripAttributes(d),
    })),
    activities: [],
  };
}

/** Drops the `attributes` blocks the REST API adds to every record. */
export function stripAttributes(row: SoqlRow): SoqlRow {
  const out: SoqlRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "attributes") continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? stripAttributes(v as SoqlRow) : v;
  }
  return out;
}
