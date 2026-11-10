/**
 * Workspace policy for the account hierarchy manager. Everything provider- or company-specific lives here, so the
 * detector and planner stay generic across Salesforce and HubSpot. Custom fields are named by their provider API
 * name and read from the record's `raw` payload (the only place the engine keeps them).
 *
 * The hard rules (`rules`) default to the safe setting and are per workspace: a workspace can relax them only by
 * saying so in its policy.
 */

export type HierarchyRules = {
  /** Never choose or change an account owner. Default true: routing decides owners. */
  neverChangeAccountOwners: boolean;
  /** Never change a deal/opportunity owner, including through a merge. Default true. */
  neverChangeDealOwners: boolean;
  /** Flag every merge or parent move that touches an account with an active contract. Default true. */
  flagActiveContracts: boolean;
  /** Hold (don't propose) a merge when more than one duplicate has an active contract. Default true. */
  holdMergeOfTwoActiveContracts: boolean;
  /** Nothing is applied without approval. Always true; present so a policy file states it. */
  requireApproval: true;
};

export type HierarchyPolicy = {
  rules: HierarchyRules;
  /** Account fields a merge survivor takes from a duplicate when its own value is blank. Never the owner. */
  fillableFields: string[];
  /** How "active contract" is read: a won deal whose `endDateField` is after today. Unset: no contract signal. */
  activeContract?: { endDateField: string };
  /** Account field holding a customer status, ranked high to low (`["Existing", "Sponsored Customer", "Churned"]`). */
  customerStatus?: { field: string; rank: string[] };
  /** Account field holding an enrichment vendor's ultimate parent name (ZoomInfo, Clearbit...). A lead, never proof. */
  ultimateParentField?: string;
  /** Account fields for region and country, and how a country maps to a region. */
  region?: { countryField: string; regionField: string; byCountry: Record<string, string> };
  /** Accounts bulk-created on a date by a user: shells that lose survivor ties and sort first in detection. */
  shellBatches: Array<{ createdDate: string; createdByName: string }>;
  /** Domains that never identify a company (personal mail, your own domain). */
  ignoredDomains: string[];
  /** Users whose ownership counts as "no owner" (a pool or integration user). */
  poolOwnerNames: string[];
};

export const DEFAULT_RULES: HierarchyRules = {
  neverChangeAccountOwners: true,
  neverChangeDealOwners: true,
  flagActiveContracts: true,
  holdMergeOfTwoActiveContracts: true,
  requireApproval: true,
};

export const DEFAULT_POLICY: HierarchyPolicy = {
  rules: DEFAULT_RULES,
  fillableFields: ["domain", "industry"],
  shellBatches: [],
  ignoredDomains: ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com"],
  poolOwnerNames: [],
};

/** Merge a partial policy (a workspace's JSON) over the defaults. Rules can only be set explicitly, field by field. */
export function resolvePolicy(partial: Partial<HierarchyPolicy> & { rules?: Partial<HierarchyRules> } = {}): HierarchyPolicy {
  const rules = { ...DEFAULT_RULES, ...(partial.rules ?? {}), requireApproval: true as const };
  return { ...DEFAULT_POLICY, ...partial, rules };
}

/** Validates a policy as a person entered it (JSON on the hosted page): known fields must have the right shapes. */
export function checkPolicyInput(raw: unknown): HierarchyPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The policy must be a JSON object.");
  const p = raw as Record<string, unknown>;
  for (const key of ["fillableFields", "ignoredDomains", "poolOwnerNames"]) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || (p[key] as unknown[]).some((x) => typeof x !== "string"))) {
      throw new Error(`${key} must be a list of strings.`);
    }
  }
  if ((p.fillableFields as string[] | undefined)?.some((f) => /owner/i.test(f))) throw new Error("Owners are never filled: remove owner fields from fillableFields.");
  if (p.rules !== undefined) {
    if (typeof p.rules !== "object" || p.rules === null || Array.isArray(p.rules)) throw new Error("rules must be an object.");
    for (const [k, val] of Object.entries(p.rules)) if (typeof val !== "boolean") throw new Error(`rules.${k} must be true or false.`);
    if ((p.rules as Record<string, unknown>).requireApproval === false) throw new Error("rules.requireApproval can't be turned off.");
  }
  if (p.shellBatches !== undefined && (!Array.isArray(p.shellBatches) || (p.shellBatches as unknown[]).some((b) => !b || typeof (b as { createdDate?: unknown }).createdDate !== "string" || typeof (b as { createdByName?: unknown }).createdByName !== "string"))) {
    throw new Error("shellBatches must be a list of { createdDate, createdByName }.");
  }
  return resolvePolicy(p as Partial<HierarchyPolicy>);
}
