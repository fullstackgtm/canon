/**
 * CanonCRM attribute catalog: which attributes the ledger tracks per entity
 * type (docs/canoncrm-spec.md). Deals have a fixed set that projects onto the
 * deals table. Accounts and contacts have a core set plus `custom.<slug>`
 * attributes, the slots research agents answer into; a worked account's or
 * contact's values project onto its ledger hot row (lib/canon/partyLedger.ts).
 *
 * The core sets are the kernel's FACT_ATTRIBUTES (modules/kernel/facts.ts),
 * which modules' fact grants are checked against too; there is no second list.
 */
import { CUSTOM_FIELD_API_NAME, STANDARD_OBJECTS } from "../objects/registry.ts";
import { standardFactAttributes } from "../../../modules/kernel/facts.ts";

export const ENTITY_TYPES = ["opportunity", "account", "contact"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Deal fields tracked by the ledger, including structured credit splits. */
export const DEAL_ATTRIBUTES = standardFactAttributes("deals");
export type DealAttribute = (typeof DEAL_ATTRIBUTES)[number];

export const ACCOUNT_ATTRIBUTES = standardFactAttributes("companies");

export const CONTACT_ATTRIBUTES = standardFactAttributes("people");

export const CORE_ATTRIBUTES: Readonly<Record<EntityType, readonly string[]>> = {
  opportunity: DEAL_ATTRIBUTES,
  account: ACCOUNT_ATTRIBUTES,
  contact: CONTACT_ATTRIBUTES,
};

/** `custom.<slug>`: an org-defined attribute (a research agent's answer). Accounts and contacts only. */
export const CUSTOM_ATTRIBUTE = CUSTOM_FIELD_API_NAME;

export function isKnownAttribute(entityType: EntityType, attribute: string): boolean {
  if (CORE_ATTRIBUTES[entityType].includes(attribute)) return true;
  return entityType !== "opportunity" && CUSTOM_ATTRIBUTE.test(attribute);
}

export function isStructuredAttribute(entityType: EntityType, attribute: string): boolean {
  const object = entityType === "opportunity" ? "deal" : entityType;
  return STANDARD_OBJECTS[object].fields.some((field) => field.apiName === attribute && field.type === "splits");
}

/** Structured fields use their versioned object writer, not scalar proposals. */
export function isScalarProposalAttribute(entityType: EntityType, attribute: string): boolean {
  return isKnownAttribute(entityType, attribute) && !isStructuredAttribute(entityType, attribute);
}

/** What the entity is called in prompts and labels. */
export const ENTITY_NOUN: Readonly<Record<EntityType, string>> = { opportunity: "deal", account: "company", contact: "person" };

const LABELS: Readonly<Record<EntityType, Readonly<Record<string, string>>>> = {
  opportunity: {
    name: "deal name", amount: "deal amount", currency: "currency", closeDate: "expected close date", stage: "sales stage",
    forecastCategory: "forecast category", probability: "win probability", isClosed: "closed flag", isWon: "won flag",
    crmOwnerId: "deal owner", dealType: "deal type", nextStep: "next step",
  },
  account: {
    name: "company name", domain: "website domain", industry: "industry", employees: "employee count",
    annualRevenue: "annual revenue", country: "headquarters country", linkedinUrl: "LinkedIn URL", ownerId: "account owner",
  },
  contact: {
    fullName: "full name", title: "job title", email: "email address", phone: "phone number",
    linkedinUrl: "LinkedIn URL", ownerId: "contact owner",
  },
};

/** A readable name for an attribute, for prompts (custom attributes read as their slug). */
export function attributeLabel(entityType: EntityType, attribute: string): string {
  return LABELS[entityType][attribute] ?? attribute.replace(/^custom\./, "").replace(/_/g, " ");
}
