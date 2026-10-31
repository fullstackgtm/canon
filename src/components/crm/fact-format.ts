import type { FactValue } from "../../../convex/lib/canon/policy";

const ATTRIBUTE_LABEL: Record<string, string> = {
  name: "Name", amount: "Amount", currency: "Currency", closeDate: "Close date", stage: "Stage",
  forecastCategory: "Forecast", probability: "Probability", isClosed: "Closed", isWon: "Won",
  crmOwnerId: "Owner", dealType: "Type", nextStep: "Next step",
  domain: "Domain", industry: "Industry", employees: "Employees", annualRevenue: "Revenue", country: "Country",
  linkedinUrl: "LinkedIn", ownerId: "Owner", fullName: "Name", title: "Title", email: "Email", phone: "Phone",
};

/** A fact's attribute as the review queue names it. */
export const attributeLabel = (a: string) => ATTRIBUTE_LABEL[a] ?? a.replace(/^custom\./, "").replace(/_/g, " ");

/** A fact's value as the review queue shows it. */
export const factValueText = (v: FactValue) => (v === null ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "object" ? v.map((s) => `${s.userId} · ${s.percentage}% ${s.kind}`).join("; ") : String(v));
