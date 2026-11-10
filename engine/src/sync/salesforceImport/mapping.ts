/**
 * Pure Salesforce -> record-service mapping for the Bulk import.
 *
 * Each mapper returns either `{ ok: input }` or `{ reject: reason }`; every
 * source row produces exactly one of the two, which is what lets the import
 * prove `upserted + rejected == source count`.
 */
import { FREE_EMAIL_DOMAINS } from "../../freeEmailDomains.ts";
import type { AccountInput, ContactInput, CustomRecordInput, ObjectDef, ObjectFieldType } from "./contracts.ts";

export type Mapped<T> = { ok: T; reject?: undefined } | { ok?: undefined; reject: string };

const SUFFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** Salesforce 15-char id -> 18-char case-insensitive id. 18-char ids pass through. */
export function normalizeSfId(id: string | undefined | null): string | undefined {
  const s = (id ?? "").trim();
  if (s.length === 18 && /^[A-Za-z0-9]{18}$/.test(s)) return s;
  if (s.length !== 15 || !/^[A-Za-z0-9]{15}$/.test(s)) return undefined;
  let suffix = "";
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const ch = s[block * 5 + i];
      if (ch >= "A" && ch <= "Z") flags |= 1 << i;
    }
    suffix += SUFFIX[flags];
  }
  return s + suffix;
}

/** Website / URL / bare host -> registrable-ish domain ("www." stripped, lowercase). */
export function domainFromWebsite(website: string | undefined | null): string | undefined {
  let s = (website ?? "").trim().toLowerCase();
  if (!s) return undefined;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0].split("@").pop()!.split(":")[0];
  s = s.replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 253) return undefined;
  return s;
}

export function domainFromEmail(email: string | undefined | null): string | undefined {
  const at = (email ?? "").trim().toLowerCase().split("@");
  if (at.length !== 2) return undefined;
  const d = domainFromWebsite(at[1]);
  if (!d || FREE_EMAIL_DOMAINS.has(d)) return undefined;
  return d;
}

const clean = (v: string | undefined | null, max = 512) => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : undefined;
};

function cleanEmail(v: string | undefined | null): string | undefined {
  const s = clean(v, 320)?.toLowerCase();
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
}

// ---------- Account ----------

export const ACCOUNT_FIELDS = ["Id", "Name", "Website", "Industry", "NumberOfEmployees", "BillingCountry", "OwnerId", "ParentId"] as const;

export function mapAccount(row: Record<string, string>): Mapped<AccountInput> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const name = clean(row.Name);
  if (!name) return { reject: "Account has no Name" };
  const domain = domainFromWebsite(row.Website);
  if (!domain)
    return { reject: row.Website?.trim() ? `Website "${row.Website.trim().slice(0, 80)}" is not a valid domain` : "Account has no Website; accounts are keyed by domain" };
  const employees = row.NumberOfEmployees ? Number(row.NumberOfEmployees) : undefined;
  return {
    ok: {
      sfId,
      domain,
      name,
      industry: clean(row.Industry),
      employees: employees !== undefined && Number.isInteger(employees) && employees >= 0 ? employees : undefined,
      country: clean(row.BillingCountry, 128),
    },
  };
}

// ---------- Contact ----------

export const CONTACT_FIELDS = ["Id", "AccountId", "FirstName", "LastName", "Name", "Title", "Email"] as const;

/** Parent account of a contact, as imported (domain) or why it is missing. */
export type ParentAccount = { domain: string } | { missing: string };

export function fullNameOf(row: Record<string, string>): string | undefined {
  return clean(row.Name) ?? clean([row.FirstName, row.LastName].filter(Boolean).join(" "));
}

/**
 * `parent` is the resolved parent account (by AccountId). A contact with no
 * AccountId falls back to its non-free email domain; the engine creates that
 * stub account first (see `stubAccountsFor`).
 */
export function mapContact(row: Record<string, string>, parent: ParentAccount | undefined): Mapped<ContactInput> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const fullName = fullNameOf(row);
  if (!fullName) return { reject: "Contact has no name" };
  const email = cleanEmail(row.Email);
  let accountDomain: string | undefined;
  if (row.AccountId) {
    if (!parent) return { reject: `parent Account ${normalizeSfId(row.AccountId) ?? row.AccountId} not found` };
    if ("missing" in parent) return { reject: `parent Account ${normalizeSfId(row.AccountId)} was not imported: ${parent.missing}` };
    accountDomain = parent.domain;
  } else {
    accountDomain = domainFromEmail(email);
    if (!accountDomain) return { reject: "Contact has no Account and no company email domain" };
  }
  return { ok: { sfId, fullName, accountDomain, title: clean(row.Title), email } };
}

// ---------- Lead ----------

export const LEAD_FIELDS = ["Id", "FirstName", "LastName", "Name", "Company", "Website", "Email", "Title", "IsConverted"] as const;

/** Domain a lead's account is keyed by: Website, else company email domain. */
export function leadDomain(row: Record<string, string>): string | undefined {
  return domainFromWebsite(row.Website) ?? domainFromEmail(row.Email);
}

export function mapLead(row: Record<string, string>): Mapped<ContactInput> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  if (String(row.IsConverted).toLowerCase() === "true") return { reject: "Lead is converted; it is imported as its Contact" };
  const fullName = fullNameOf(row);
  if (!fullName) return { reject: "Lead has no name" };
  const accountDomain = leadDomain(row);
  if (!accountDomain) return { reject: "Lead has no Website and no company email domain" };
  return { ok: { sfId, fullName, accountDomain, title: clean(row.Title), email: cleanEmail(row.Email) } };
}

/**
 * Accounts that must exist before contacts keyed by `accountDomain` can be
 * upserted: one per domain not already imported, named after the Lead's
 * Company (or the domain). Upserted with merge by domain, so a TAM account
 * with that domain absorbs it.
 */
export function stubAccountsFor(rows: Array<{ domain: string; company?: string }>, known: (domain: string) => boolean): AccountInput[] {
  const out = new Map<string, AccountInput>();
  for (const r of rows) {
    if (known(r.domain) || out.has(r.domain)) continue;
    out.set(r.domain, { domain: r.domain, name: clean(r.company) ?? r.domain });
  }
  return [...out.values()];
}

// ---------- Generic / custom objects ----------

/** Describe field types that Bulk API 2.0 query cannot return. */
const UNQUERYABLE_TYPES = new Set(["address", "location", "base64", "complexvalue"]);

export function bulkFieldsOf(fields: Array<{ name: string; type: string }>): string[] {
  return fields.filter((f) => !UNQUERYABLE_TYPES.has(f.type.toLowerCase())).map((f) => f.name);
}

export function objectFieldType(sfType: string): ObjectFieldType {
  switch (sfType.toLowerCase()) {
    case "int": case "double": case "currency": case "percent": case "long": return "number";
    case "boolean": return "boolean";
    case "date": return "date";
    case "datetime": return "datetime";
    case "picklist": case "multipicklist": return "picklist";
    case "reference": return "reference";
    case "string": case "textarea": case "email": case "phone": case "url": case "id": case "combobox": case "encryptedstring": case "time":
      return "string";
    default: return "json";
  }
}

export function objectDefFromDescribe(d: { name: string; label: string; fields: Array<{ name: string; type: string; referenceTo?: string[] }> }): ObjectDef {
  return {
    name: d.name,
    label: d.label,
    fields: d.fields
      .filter((f) => !UNQUERYABLE_TYPES.has(f.type.toLowerCase()) && f.name !== "Id")
      .map((f) => ({ name: f.name, type: objectFieldType(f.type), ...(f.referenceTo?.length ? { referenceTo: f.referenceTo } : {}) })),
  };
}

export function coerceCustomValue(raw: string, type: ObjectFieldType | undefined): unknown {
  if (raw === "") return null;
  switch (type) {
    case "number": { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
    case "boolean": return raw.toLowerCase() === "true";
    case "reference": return normalizeSfId(raw) ?? raw;
    default: return raw;
  }
}

export function mapCustom(row: Record<string, string>, def: ObjectDef | undefined): Mapped<CustomRecordInput> {
  const sfId = normalizeSfId(row.Id);
  if (!sfId) return { reject: "invalid Salesforce Id" };
  const types = new Map(def?.fields.map((f) => [f.name, f.type]) ?? []);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "Id") continue;
    fields[k] = coerceCustomValue(v, types.get(k));
  }
  return { ok: { sfId, fields } };
}
