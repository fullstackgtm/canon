/**
 * Research enrichment (docs/credits.md): one person's or one company's profile from a treg provider, read into
 * the fields it fills and, for a person, a page research can quote. Pure. Measured replies, 2026-10-13: treg's
 * routed people.enrich (served by Ocean.io) and companies.enrich (served by The Companies API).
 */
import type { FetchedPage } from "./research/agentLoop.ts";

/** Field values a profile writes: standard fields a record keeps, and `custom.*` columns it adds. */
export type EnrichPatch = Record<string, string | number>;

export type PersonProfile = {
  fullName: string;
  headline: string | null;
  about: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  location: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** "2024-05-01": when they started their current role. */
  roleStart: string | null;
};

const text = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** A profile URL as a full https URL ("linkedin.com/in/x" becomes "https://www.linkedin.com/in/x"). */
export function profileUrl(raw: string | null): string | null {
  if (!raw) return null;
  const bare = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  return /^[a-z]{2,3}\.linkedin\.com\/|^linkedin\.com\//i.test(bare) ? `https://www.${bare.replace(/^[a-z]{2,3}\.linkedin\.com/i, "linkedin.com")}` : `https://${bare}`;
}

/**
 * The person in a treg people.enrich reply (`{ output, raw, _treg }`): its normalized fields, and what the serving
 * provider adds (Ocean.io, measured 2026-10-13: seniorities, departments, the current job's own description, and
 * work history with start dates). Null when it found nobody.
 */
export function readRoutedPerson(body: unknown): PersonProfile | null {
  const b = body as { output?: Record<string, unknown>; raw?: Record<string, unknown> } | null;
  const o = b?.output;
  const name = text(o?.full_name);
  if (!o || !name) return null;
  const raw = (b?.raw && typeof b.raw === "object" ? b.raw : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string").join(", ") || null : null);
  const current = Array.isArray(raw.experiences) ? (raw.experiences[0] as Record<string, unknown> | undefined) : undefined;
  const description = text(raw.currentJobDescription)?.replace(/<br\s*\/?>/gi, "\n") ?? null;
  return {
    fullName: name,
    headline: text(raw.headline) ?? text(raw.summary),
    about: description,
    title: text(o.title) ?? text(raw.jobTitle),
    seniority: list(raw.seniorities),
    department: list(raw.departments),
    location: text(o.location),
    linkedinUrl: profileUrl(text(o.linkedin_url)),
    companyName: text(o.company),
    companyDomain: text(o.company_domain),
    roleStart: text(current?.dateFrom),
  };
}

/** Whether the profile is this person at this company: its current employer's domain is the company's. */
export function sameEmployer(p: PersonProfile, domain: string): boolean {
  const bare = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return !!p.companyDomain && bare(p.companyDomain) === bare(domain);
}

/**
 * What a person's profile writes onto their contact: the standard fields they don't have yet (title, LinkedIn),
 * and the profile's own columns.
 */
export function personPatch(p: PersonProfile, has: { title?: string | null; linkedinUrl?: string | null }): EnrichPatch {
  const out: EnrichPatch = {};
  if (!has.title && p.title) out.title = p.title.slice(0, 200);
  if (!has.linkedinUrl && p.linkedinUrl) out.linkedinUrl = p.linkedinUrl;
  const custom: Array<[string, string | null]> = [
    ["headline", p.headline], ["seniority", p.seniority], ["department", p.department], ["location", p.location],
    ["in_role_since", p.roleStart], ["about", p.about],
  ];
  for (const [k, v] of custom) if (v) out[`custom.${k}`] = v.slice(0, 2000);
  return out;
}

/**
 * The profile as a page research reads and quotes, at the person's profile URL: it counts as their own page.
 * Its words are the provider's, so a quote from it is word for word in the profile it describes.
 */
export function profilePage(p: PersonProfile): FetchedPage | null {
  if (!p.linkedinUrl) return null;
  const lines = [
    `${p.fullName}${p.headline ? ` - ${p.headline}` : ""}`,
    p.title || p.companyName ? `Current role: ${[p.title, p.companyName && `at ${p.companyName}`].filter(Boolean).join(" ")}${p.roleStart ? ` (since ${p.roleStart})` : ""}.` : null,
    p.location ? `Location: ${p.location}.` : null,
    p.about ? `About the role: ${p.about}` : null,
  ].filter(Boolean);
  return { url: p.linkedinUrl, text: lines.join("\n"), links: [] };
}

export type CompanyProfile = {
  employees: number | null;
  industry: string | null;
  description: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  linkedinUrl: string | null;
  founded: number | null;
  revenueRange: string | null;
  technologies: string[];
  emailPattern: string | null;
  monthlyVisitors: string | null;
};

/** The company in a treg companies.enrich reply (`{ output, raw }`), or null when it found nothing. */
export function readCompany(body: unknown): CompanyProfile | null {
  const b = body as { output?: Record<string, unknown>; raw?: Record<string, any> } | null;
  const o = b?.output;
  if (!o || !text(o.name) && !text(o.domain)) return null;
  const raw = b?.raw ?? {};
  const hq = raw.locations?.headquarters ?? {};
  const pattern = Array.isArray(raw.secondaries?.emailPatterns) ? raw.secondaries.emailPatterns[0] : null;
  return {
    employees: typeof o.employees === "number" ? o.employees : null,
    industry: text(o.industry)?.replace(/-/g, " ") ?? null,
    description: text(o.description),
    city: text(hq.city?.name),
    state: text(hq.state?.name),
    country: text(hq.country?.name),
    linkedinUrl: profileUrl(text(o.linkedin_url)),
    founded: typeof o.founded === "number" ? o.founded : typeof raw.about?.yearFounded === "number" ? raw.about.yearFounded : null,
    revenueRange: text(raw.finances?.revenue),
    technologies: Array.isArray(raw.technologies?.active) ? raw.technologies.active.filter((t: unknown): t is string => typeof t === "string").slice(0, 40) : [],
    emailPattern: pattern && typeof pattern.pattern === "string" ? pattern.pattern : null,
    monthlyVisitors: text(raw.analytics?.monthlyVisitors),
  };
}

/** What a company's profile writes onto its account: standard fields it doesn't have yet, and its own columns. */
export function companyPatch(c: CompanyProfile, has: { employees?: number | null; industry?: string | null; country?: string | null; linkedinUrl?: string | null }): EnrichPatch {
  const out: EnrichPatch = {};
  // The account fields a person may edit (recordContract EDITABLE_ACCOUNT_FIELDS); the rest are the profile's columns.
  if (has.employees == null && c.employees != null) out.employees = c.employees;
  if (!has.industry && c.industry) out.industry = c.industry;
  if (!has.country && c.country) out.country = c.country;
  if (!has.linkedinUrl && c.linkedinUrl) out.linkedinUrl = c.linkedinUrl;
  if (c.description) out["custom.description"] = c.description.slice(0, 2000);
  if (c.city) out["custom.hq_city"] = c.city;
  if (c.founded != null) out["custom.founded"] = c.founded;
  if (c.revenueRange) out["custom.revenue_range"] = c.revenueRange;
  if (c.technologies.length) out["custom.tech_stack"] = c.technologies.join(", ");
  if (c.state) out["custom.hq_state"] = c.state;
  if (c.emailPattern) out["custom.email_pattern"] = c.emailPattern;
  if (c.monthlyVisitors) out["custom.web_traffic"] = c.monthlyVisitors;
  return out;
}
