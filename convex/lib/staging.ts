/**
 * Staged fills: a Market or Companies fill collects its accounts and contacts
 * for review instead of writing them to the CRM. The review page explores the
 * run by a few dimensions and adds the records a selection keeps.
 *
 * Every staged record carries its dimensions, and the run keeps a count per
 * combination of them (a cell), so any selection's totals are a sum over the
 * run's cells: exact, and cheap enough to recompute on every click.
 *
 * A selection filters accounts by the company dimensions and contacts by all
 * of them: a contact is added when it and its company pass. Pure and
 * Node-free (the UI imports it).
 */
import { DEPARTMENT, SENIORITY, classifyTitle } from "../../modules/kernel/titles.ts";
import { NONE, regionOf, sizeBandOf } from "../../modules/kernel/dimensions.ts";
import { normDomain } from "./peopleSources.ts";

export { NONE };

export type StagedKind = "account" | "contact";

/** The dimensions a run is explored by. Contacts carry all of them; accounts only the company ones. */
export type Dims = {
  region: string;
  industry: string;
  sizeBand: string;
  /** Already in the CRM: approving fills only its empty fields. */
  existing: boolean;
  seniority?: string;
  department?: string;
};

export const COMPANY_DIMS = ["region", "industry", "sizeBand"] as const;
export const PERSON_DIMS = ["seniority", "department"] as const;
export type FacetDim = (typeof COMPANY_DIMS)[number] | (typeof PERSON_DIMS)[number];

/** Free-text terms: kept when the text has any `include` term (none: any text) and no `exclude` term. Whole words, any case. */
export type Terms = { include?: string[]; exclude?: string[] };
/** Title terms filter contacts; company terms filter accounts by name and domain, and contacts through their company. */
export type Keywords = { title?: Terms; company?: Terms };

/**
 * Keys to keep per dimension (none or empty: keep all), whether to keep new or
 * existing records, and keyword filters. Cells can't count keywords: the review
 * page counts them over the records (staging.keywordCells).
 */
export type Selection = Partial<Record<FacetDim, string[]>> & {
  existing?: "new" | "existing";
  keywords?: Keywords;
  /** Keep only the companies of the contacts the selection keeps (also a count over the records). */
  accountsWithContacts?: boolean;
};

/** Whether the selection's totals need a count over the records (staging.countSelection) rather than the cells. */
export const needsCount = (s: Selection) => hasKeywords(s.keywords) || Boolean(s.accountsWithContacts);

const termsOf = (t: Terms | undefined) => ({
  include: (t?.include ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean),
  exclude: (t?.exclude ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean),
});
const hasTerm = (text: string, term: string) => {
  let at = text.indexOf(term);
  while (at >= 0) {
    // Whole words: "vp" is in "vp of sales" and "acme" in "acme.com", but not "mvp". A term
    // that starts or ends with punctuation (".io") is already bounded on that side.
    const word = /[a-z0-9]/;
    const before = !word.test(term[0]) || at === 0 || !word.test(text[at - 1]);
    const after = !word.test(term[term.length - 1]) || at + term.length >= text.length || !word.test(text[at + term.length]);
    if (before && after) return true;
    at = text.indexOf(term, at + 1);
  }
  return false;
};
export function termsPass(text: string | undefined, terms: Terms | undefined): boolean {
  const { include, exclude } = termsOf(terms);
  const t = (text ?? "").toLowerCase();
  if (include.length && !include.some((term) => hasTerm(t, term))) return false;
  return !exclude.some((term) => hasTerm(t, term));
}

export function hasKeywords(k: Keywords | undefined): k is Keywords {
  return [k?.title, k?.company].some((t) => termsOf(t).include.length + termsOf(t).exclude.length > 0);
}

/** Whether a record passes the keyword filters. `company`: the account itself, or a contact's company (undefined when unknown). */
export function keywordsPass(kind: StagedKind, record: { title?: string }, company: { name?: string; domain?: string } | undefined, k: Keywords | undefined): boolean {
  if (!k) return true;
  if (!termsPass(company ? `${company.name ?? ""} ${company.domain ?? ""}` : "", k.company)) return false;
  return kind === "account" || termsPass(record.title, k.title);
}

export type Cell = { kind: StagedKind; dims: Dims; count: number };

const classify = (table: typeof SENIORITY, title: string | undefined) => classifyTitle(table, title) ?? NONE;
export const seniorityOf = (title: string | undefined) => classify(SENIORITY, title);
export const departmentOf = (title: string | undefined) => classify(DEPARTMENT, title);

/** An account's dimensions. */
export function accountDims(a: { industry?: string; employees?: number; country?: string }, existing: boolean): Dims {
  return { region: regionOf(a.country), industry: a.industry?.trim() || NONE, sizeBand: sizeBandOf(a.employees), existing };
}

/** A contact's dimensions: its company's, plus its own level and department. */
export function contactDims(company: Dims, c: { title?: string }, existing: boolean): Dims {
  return { region: company.region, industry: company.industry, sizeBand: company.sizeBand, existing, seniority: seniorityOf(c.title), department: departmentOf(c.title) };
}

/** A staged contact's identity within a run, as the CRM matches it: LinkedIn, else company + name. */
export function contactKey(c: { accountDomain?: string; fullName: string; linkedinUrl?: string; email?: string }): string {
  if (c.email) return `e:${c.email.trim().toLowerCase()}`;
  if (c.linkedinUrl) return `l:${c.linkedinUrl.trim().toLowerCase().replace(/\/+$/, "")}`;
  return `n:${normDomain(c.accountDomain ?? "")}:${c.fullName.trim().toLowerCase()}`;
}

/** One cell's key: the record kind and its dimensions, in a fixed order. */
export function cellKey(kind: StagedKind, d: Dims): string {
  return JSON.stringify([kind, d.region, d.industry, d.sizeBand, d.existing, d.seniority ?? null, d.department ?? null]);
}

/** Whether a record with these dimensions is in the selection. */
export function selects(kind: StagedKind, d: Dims, s: Selection): boolean {
  if (s.existing === "new" && d.existing) return false;
  if (s.existing === "existing" && !d.existing) return false;
  for (const dim of COMPANY_DIMS) {
    const keep = s[dim];
    if (keep?.length && !keep.includes(d[dim])) return false;
  }
  if (kind === "account") return true;
  for (const dim of PERSON_DIMS) {
    const keep = s[dim];
    if (keep?.length && !keep.includes(d[dim] ?? NONE)) return false;
  }
  return true;
}

export type Totals = { accounts: number; contacts: number; existingAccounts: number; existingContacts: number };

/** What a selection adds, summed over the run's cells. */
export function totalsOf(cells: readonly Cell[], s: Selection = {}): Totals {
  const t: Totals = { accounts: 0, contacts: 0, existingAccounts: 0, existingContacts: 0 };
  for (const c of cells) {
    if (!c.count || !selects(c.kind, c.dims, s)) continue;
    if (c.kind === "account") {
      t.accounts += c.count;
      if (c.dims.existing) t.existingAccounts += c.count;
    } else {
      t.contacts += c.count;
      if (c.dims.existing) t.existingContacts += c.count;
    }
  }
  return t;
}

/**
 * One dimension's breakdown under the rest of the selection: each key's count
 * of contacts (person dimensions) or accounts (company dimensions), largest
 * first. The dimension's own filter is left out, so unticked keys still show
 * what they would add.
 */
export function facetOf(cells: readonly Cell[], dim: FacetDim, s: Selection = {}): Array<{ key: string; count: number }> {
  const kind: StagedKind = (PERSON_DIMS as readonly string[]).includes(dim) ? "contact" : "account";
  const rest: Selection = { ...s, [dim]: undefined };
  const counts = new Map<string, number>();
  for (const c of cells) {
    if (c.kind !== kind || !c.count || !selects(c.kind, c.dims, rest)) continue;
    const key = (c.dims[dim] as string | undefined) ?? NONE;
    counts.set(key, (counts.get(key) ?? 0) + c.count);
  }
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** A stored cell back to its kind and dimensions (the inverse of cellKey). */
export function cellFromKey(key: string, count: number): Cell {
  const [kind, region, industry, sizeBand, existing, seniority, department] = JSON.parse(key) as [StagedKind, string, string, string, boolean, string | null, string | null];
  return { kind, count, dims: { region, industry, sizeBand, existing, ...(seniority !== null ? { seniority } : {}), ...(department !== null ? { department } : {}) } };
}
