/**
 * An ICP tree node's query (convex/lib/icpQuery.ts) as the sentence the ICPs page reads and edits: plain words with
 * tokens, each token one clause of the query. Editing a token sets that clause's values and writes the query back.
 * Pure: the page and tests import it.
 */
import { REGIONS } from "../../modules/kernel/dimensions.ts";
import { COUNTRIES, EMPLOYEE_BANDS, LEVELS } from "../../convex/lib/icpVocabulary.ts";
import { formatQuery, type Clause, type IcpQuery, type NodeKind } from "../../convex/lib/icpQuery.ts";
import { industryLabel } from "../../modules/kernel/industries.ts";

/** Where a clause sits: in the node's own clauses, or in its `has` group `has`. */
export type ClausePath = { has?: number; index: number };
export type Part = string | { path: ClausePath; clause: Clause; text: string };
/** An account AI field, as researchAgents.list returns it. */
export type AiField = { slug: string; label: string; options: Array<{ key: string; label: string }> | null; answerType: "text" | "number" | "boolean" | null };

const countryLabel = (c: string) => COUNTRIES.find((x) => x.value === c)?.label ?? c.toUpperCase();
const levelLabel = (l: string) => LEVELS.find((x) => x.value === l)?.label ?? l;
const orList = (xs: readonly string[], word = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`);

/** Contiguous bands read as one range: 201-500 and 501-1000 are "201–1,000". */
export function bandsLabel(bands: readonly string[]): string {
  const idx = bands.map((b) => EMPLOYEE_BANDS.indexOf(b as (typeof EMPLOYEE_BANDS)[number])).filter((i) => i >= 0).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  const lo = (i: number) => Number(EMPLOYEE_BANDS[i].split(/[-+]/)[0]).toLocaleString();
  const hi = (i: number) => (EMPLOYEE_BANDS[i].endsWith("+") ? null : Number(EMPLOYEE_BANDS[i].split("-")[1]).toLocaleString());
  return runs.map(([a, b]) => (hi(b) === null ? `${lo(a)}+` : `${lo(a)}–${hi(b)}`)).join(", ");
}

/** A value of a clause's key, as people read it. */
export function valueLabel(key: Clause["key"], v: string, field?: AiField): string {
  switch (key) {
    case "industry": return industryLabel(v);
    case "country": case "location": return countryLabel(v);
    case "level": return levelLabel(v);
    case "size": return bandsLabel([v]);
    case "region": return REGIONS.find((r) => r.key === v)?.label ?? v;
    case "owner": return v === "none" ? "no one" : v;
    case "field": return field?.options?.find((o) => o.key === v)?.label ?? (v === "true" ? "Yes" : v === "false" ? "No" : v);
    default: return v;
  }
}

export function clauseText(c: Clause, fields: readonly AiField[]): string {
  if (c.key === "field") {
    const f = fields.find((x) => x.slug === c.slug);
    if (!c.values) return c.min !== undefined && c.max !== undefined ? `${c.min}–${c.max}` : c.min !== undefined ? `${c.min} or more` : `up to ${c.max}`;
    return orList(c.values.map((v) => valueLabel("field", v, f)));
  }
  if (c.key === "size") return bandsLabel(c.values);
  if (c.key === "title") return orList(c.values.map((v) => `“${v}”`), c.neg ? "or" : "or");
  return orList(c.values.map((v) => valueLabel(c.key, v)));
}

const fieldLabel = (slug: string, fields: readonly AiField[]) => (fields.find((f) => f.slug === slug)?.label ?? slug).toLowerCase();

function companyPhrase(c: Clause, path: ClausePath, fields: readonly AiField[]): Part[] {
  const t: Part = { path, clause: c, text: clauseText(c, fields) };
  switch (c.key) {
    case "industry": return [c.neg ? "not in " : "in ", t];
    case "size": return ["with ", t, " employees"];
    case "country": case "region": case "city": return [c.neg ? "not based in " : "based in ", t];
    case "owner": return [c.neg ? "not owned by " : "owned by ", t];
    case "revenue": return ["with ", t, " in annual revenue"];
    case "field": return [`where ${fieldLabel(c.slug, fields)} is `, t];
    default: return [t];
  }
}

/** Who: "a VP or Head in Revenue operations, or anyone titled “CRO”, never anyone titled “intern”". */
/**
 * `buyer`: an ICP's has(…), where no level means C-suite, VP, Head or Director (lib/icps.ts specBuyer), unless it
 * names only titles, which then match on their own.
 */
function personPhrase(clauses: readonly Clause[], has: number | undefined, fields: readonly AiField[], lead: "a" | "no" | "", buyer = false): Part[] {
  const at = (key: Clause["key"], neg = false) => clauses.findIndex((c) => c.key === key && c.neg === neg);
  const tok = (i: number): Part => ({ path: { ...(has !== undefined ? { has } : {}), index: i }, clause: clauses[i], text: clauseText(clauses[i], fields) });
  const [li, di, ti, xi, gi] = [at("level"), at("dept"), at("title"), at("title", true), at("location")];
  const out: Part[] = [];
  if (li >= 0) out.push(lead ? `${lead} ` : "", tok(li));
  else if (buyer && (di >= 0 || ti < 0)) out.push("a C-suite, VP, Head or Director");
  else out.push(lead === "no" ? "no one" : lead === "a" ? "someone" : "anyone");
  if (di >= 0) out.push(" in ", tok(di));
  if (ti >= 0) out.push(li >= 0 || di >= 0 ? ", or anyone titled " : " titled ", tok(ti));
  if (gi >= 0) out.push(", located in ", tok(gi));
  if (xi >= 0) out.push(", never anyone titled ", tok(xi));
  return out.filter((p) => p !== "");
}

const join = (groups: Part[][], sep: string): Part[] => groups.flatMap((g, i) => (i ? [sep, ...g] : g));

/** The node's sentence. An ICP without has(…) names the default buyer as plain words. */
export function sentence(kind: NodeKind, q: IcpQuery, fields: readonly AiField[]): Part[] {
  const company = q.clauses.map((c, index) => companyPhrase(c, { index }, fields));
  if (kind === "persona") return ["There, reach ", ...personPhrase(q.clauses, undefined, fields, ""), "."];
  if (kind === "segment") {
    const has = q.has.map((h, i) => (h.neg ? ["with ", ...personPhrase(h.clauses, i, fields, "no")] : ["that employ ", ...personPhrase(h.clauses, i, fields, "a")]));
    const all = [...company, ...has];
    return all.length ? ["Of those, the ones ", ...join(all, " and "), "."] : ["All of its parent's accounts."];
  }
  const buyer = q.has.findIndex((h) => !h.neg);
  return [
    "Companies ", ...(company.length ? join(company, ", ") : ["of any kind"]), ", where ",
    ...(buyer >= 0 ? personPhrase(q.has[buyer].clauses, buyer, fields, "a", true) : ["someone is C-suite, VP, Head or Director"]),
    buyer >= 0 ? " works." : ".",
  ];
}

/** The sentence as plain text, for the table. */
export const sentenceText = (parts: readonly Part[]) => parts.map((p) => (typeof p === "string" ? p : p.text)).join("");

/** The query with one clause's values replaced, as its line. Empty values drop the clause, and an emptied has(…) goes too. */
export function withValues(q: IcpQuery, path: ClausePath, next: Partial<Extract<Clause, { key: "field" }>> & { values?: string[] }): string {
  const set = (cs: Clause[]): Clause[] => cs.flatMap((c, i) => {
    if (i !== path.index) return [c];
    const merged = { ...c, ...next } as Clause;
    const empty = merged.key === "field" ? !merged.values?.length && merged.min === undefined && merged.max === undefined : !merged.values.length;
    return empty ? [] : [merged];
  });
  const out: IcpQuery = path.has === undefined
    ? { ...q, clauses: set(q.clauses) }
    : { ...q, has: q.has.flatMap((h, i) => (i !== path.has ? [h] : (() => { const cs = set(h.clauses); return cs.length ? [{ ...h, clauses: cs }] : []; })())) };
  return formatQuery(out);
}

/** The query with a clause added: to the node's own clauses, to has group `has`, or to a new has(…) group. */
export function withClause(q: IcpQuery, clause: Clause, where: { has?: number; newHas?: { neg: boolean } } = {}): string {
  if (where.newHas) return formatQuery({ ...q, has: [...q.has, { neg: where.newHas.neg, clauses: [clause] }] });
  if (where.has !== undefined) return formatQuery({ ...q, has: q.has.map((h, i) => (i === where.has ? { ...h, clauses: [...h.clauses, clause] } : h)) });
  return formatQuery({ ...q, clauses: [...q.clauses, clause] });
}
