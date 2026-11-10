export type DealTerm = { key: string; label: string; rule: string; severity: "high" | "medium" | "low" };

export const DEFAULT_DEAL_TERMS: readonly DealTerm[] = [
  { key: "auto_renew", label: "Auto-renew", rule: "Never strike auto-renew.", severity: "high" },
  { key: "discount_timing", label: "Discount timing", rule: "No discount beyond quarter end without an exchange.", severity: "high" },
  { key: "payment", label: "Payment terms", rule: "Payment terms net 30 or shorter.", severity: "medium" },
  { key: "scope", label: "Scope and rate", rule: "No added scope or delivery resources without an agreed price or scope exchange.", severity: "medium" },
];

/** Older packages inherit the defaults; an explicit empty list disables term checks. */
export const termsFor = (plays: { terms?: readonly DealTerm[] }): readonly DealTerm[] => plays.terms ?? DEFAULT_DEAL_TERMS;
