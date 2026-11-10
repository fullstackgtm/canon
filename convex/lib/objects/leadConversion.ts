/**
 * Converting a lead (CP6): what a lead's fields become on the company, person
 * and deal it is converted into, and what the conversion does to a person's
 * lifecycle stage. The map is the registry's, so a field added to an object is
 * carried the same way with no change here:
 *
 *   - Standard fields by a fixed table (STANDARD_MAP) plus the three that need
 *     a rule: the person's name (first and last), the company's name (the
 *     lead's `company`) and the company's domain (typed, else the work email's).
 *   - Custom fields by apiName: a lead's `custom.<slug>` goes to the person's
 *     field of that slug when it has one of the same type, else to the
 *     company's. A value the target would refuse (another type, a picklist
 *     option it lacks) is listed as not carried over, never dropped silently.
 *
 * Records that already exist (a company with the domain, a person with the
 * email) are kept as they are: the map fills only records the conversion
 * creates. Pure: the caller passes the definitions and the lead's values.
 */
import { coerce, CUSTOM_FIELD_API_NAME, type FieldDef, type FieldValue, type ResolvedObjectDef } from "./registry.ts";

export type ConvertTarget = "account" | "contact";

/** One lead field and where it lands. `value` is the registry value the target field takes. */
export type MappedField = { target: ConvertTarget; apiName: string; label: string; from: string; value: FieldValue };
export type SkippedField = { from: string; value: FieldValue; reason: string };

/** The standard fields that carry over unchanged in meaning: lead field, target object, target field. */
export const STANDARD_MAP: ReadonlyArray<{ from: string; target: ConvertTarget; to: string }> = [
  { from: "title", target: "contact", to: "title" },
  { from: "phone", target: "contact", to: "phone" },
  { from: "status", target: "contact", to: "leadStatus" },
  { from: "ownerId", target: "contact", to: "ownerId" },
];

/** Lead fields with no field on the company or person to land on, listed so the preview is honest about them. */
const NO_TARGET = ["leadSource"] as const;

/** Lead fields the rules above read (or the conversion writes), so the custom-field pass and the preview leave them be. */
const HANDLED = new Set(["firstName", "lastName", "company", "email", ...STANDARD_MAP.map((m) => m.from), ...NO_TARGET]);

export type ConversionPlan = {
  company: { name: string; domain: string | null };
  person: { fullName: string; email: string | null };
  /** Applied to the records the conversion creates. */
  fields: MappedField[];
  skipped: SkippedField[];
};

export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "comcast.net",
]);

/** The company domain a lead's work email names; a personal mailbox names none. */
export function domainOfEmail(email: string | null | undefined): string | null {
  const domain = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return domain.includes(".") && !FREEMAIL_DOMAINS.has(domain) ? domain : null;
}

const text = (v: FieldValue | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const isEmpty = (v: FieldValue | undefined) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** A lead's values as the registry stores them (by apiName), planned into what the conversion creates. */
export function planConversion(
  defs: { lead: ResolvedObjectDef; contact: ResolvedObjectDef; account: ResolvedObjectDef },
  lead: Readonly<Record<string, FieldValue>>,
  domain?: string | null,
): ConversionPlan {
  const fullName = [text(lead.firstName), text(lead.lastName)].filter(Boolean).join(" ");
  const company = text(lead.company);
  const email = text(lead.email)?.toLowerCase() ?? null;
  const typed = text(domain)?.toLowerCase() ?? null;
  const resolvedDomain = typed ?? domainOfEmail(email);
  const fields: MappedField[] = [];
  const skipped: SkippedField[] = [];
  const target = (def: ResolvedObjectDef, apiName: string) => {
    const f = def.byApiName.get(apiName);
    return f && f.archivedAt === undefined && !f.system && f.type !== "formula" ? f : null;
  };
  const land = (from: FieldDef, to: ConvertTarget, field: FieldDef, value: FieldValue) => {
    const checked = coerce(defs[to], { [field.apiName]: value }, { mode: "update" });
    if (checked.ok) fields.push({ target: to, apiName: field.apiName, label: field.label, from: from.label, value: checked.values[0].value });
    else skipped.push({ from: from.label, value, reason: checked.errors[0].message });
  };

  for (const m of STANDARD_MAP) {
    const from = target(defs.lead, m.from);
    const value = from && lead[from.apiName];
    if (!from || isEmpty(value)) continue;
    const to = target(defs[m.target], m.to);
    if (to) land(from, m.target, to, value as FieldValue);
  }
  for (const from of defs.lead.fields) {
    if (HANDLED.has(from.apiName) || !CUSTOM_FIELD_API_NAME.test(from.apiName) || from.archivedAt !== undefined || from.type === "formula") continue;
    const value = lead[from.apiName];
    if (isEmpty(value)) continue;
    // The person first: custom data about a lead is mostly about the person. A company only takes what the person has no field for.
    const homes = (["contact", "account"] as const).flatMap((o) => {
      const to = target(defs[o], from.apiName);
      return to && to.type === from.type ? [{ o, to }] : [];
    });
    if (homes.length) land(from, homes[0].o, homes[0].to, value as FieldValue);
    else skipped.push({ from: from.label, value: value as FieldValue, reason: `No field named ${from.apiName} of the same type on a company or person` });
  }
  for (const name of NO_TARGET) {
    const from = target(defs.lead, name);
    const value = from && lead[from.apiName];
    if (from && !isEmpty(value)) skipped.push({ from: from.label, value: value as FieldValue, reason: "A company or person has no field for it" });
  }
  return { company: { name: company ?? resolvedDomain ?? "", domain: resolvedDomain }, person: { fullName, email }, fields, skipped };
}

/** The fields the record service takes when it creates a person (the rest are edits). */
const AT_CREATION = new Set(["title"]);

type Patch = Record<string, FieldValue>;

/**
 * What a conversion writes given what the register already has. An existing
 * company or person is kept as it is (nothing is written to it), except that
 * a person's lifecycle stage moves forward; a new person becomes the
 * company's primary contact, an existing one keeps the primary they have.
 */
export function writesFor(
  plan: ConversionPlan,
  match: { company: { id: string } | null; person: { id: string; stage: string | null } | null },
  madeDeal: boolean,
) {
  const patch = (target: ConvertTarget, skip?: ReadonlySet<string>): Patch =>
    Object.fromEntries(plan.fields.filter((f) => f.target === target && !skip?.has(f.apiName)).map((f) => [f.apiName, f.value]));
  const stage = lifecycleAfterConversion(match.person?.stage, madeDeal);
  const accountPatch = match.company ? {} : patch("account");
  const personPatch: Patch = { ...(match.person ? {} : patch("contact", AT_CREATION)), ...(stage ? { lifecycleStage: stage } : {}) };
  const title = match.person ? undefined : plan.fields.find((f) => f.target === "contact" && AT_CREATION.has(f.apiName))?.value;
  return {
    createsCompany: match.company === null,
    createsPerson: match.person === null,
    /** The person's job title, given to the record service at creation. */
    title: typeof title === "string" ? title : undefined,
    accountPatch: Object.keys(accountPatch).length ? accountPatch : null,
    personPatch: Object.keys(personPatch).length ? personPatch : null,
    stage,
    primary: match.person === null,
  };
}

/** Lifecycle stages in funnel order. `evangelist` and `other` sit outside it: a conversion never changes them. */
export const LIFECYCLE_FUNNEL = ["subscriber", "lead", "mql", "sql", "opportunity", "customer"] as const;

/**
 * The lifecycle stage a conversion sets on a person: opportunity when it made
 * a deal, else sales qualified. Null when the person should keep theirs: they
 * are already at or past it, or sit outside the funnel (evangelist, other).
 */
export function lifecycleAfterConversion(current: string | null | undefined, madeDeal: boolean): "sql" | "opportunity" | null {
  const next = madeDeal ? "opportunity" : "sql";
  if (!current) return next;
  const rank = (LIFECYCLE_FUNNEL as readonly string[]).indexOf(current);
  if (rank < 0) return null;
  return rank >= (LIFECYCLE_FUNNEL as readonly string[]).indexOf(next) ? null : next;
}
