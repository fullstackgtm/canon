/**
 * Why an account has the fit it has. The record service scores an account as
 * clamp(0, 100, base + industry weight + country weight + the weight of every
 * employee band it falls in), the same terms `fitUnderWeights` applies
 * (recordClient.ts). This lists those terms, so every reason is a term of the
 * stored score. Pure and free of Node imports: the UI calls it too.
 */
import type { IcpGate, IcpWeights } from "./recordContract";
import { industryWeight, sameIndustry } from "../../modules/kernel/industries.ts";

export type FitDimension = "base" | "industry" | "country" | "employees";
export type FitReason = {
  dimension: FitDimension;
  /** One line, e.g. "Industry: computer software is in your ICP". */
  text: string;
  /** Points out of 100 this term added (0 for a term the account missed). */
  points: number;
  matched: boolean;
};
export type FitExplanation = {
  /** Points out of 100 after capping. */
  total: number;
  /** Set when the terms summed past 0..100 and the score was clamped. */
  capped: "high" | "low" | null;
  reasons: FitReason[];
};

type Firmographics = { industry?: string; country?: string; employees?: number };

const bandLabel = (b: { min: number; max: number }) => (b.max >= 1_000_000_000 ? `${b.min}+` : `${b.min}-${b.max}`);

/**
 * The terms behind `fit` (0..1, as the app sees it). Null when the ICP weights
 * on hand do not reproduce `fit`, e.g. the workspace was re-scored with an
 * ICP this copy has not seen: better no explanation than a wrong one.
 */
export function explainFit(account: Firmographics, weights: IcpWeights, fit: number): FitExplanation | null {
  const reasons: FitReason[] = [];
  let raw = 0;
  const add = (reason: FitReason) => {
    raw += reason.points;
    reasons.push(reason);
  };
  if (weights.base) add({ dimension: "base", text: "Baseline for this ICP", points: weights.base, matched: true });

  const dimension = (
    key: "industry" | "country",
    label: string,
    table: Record<string, number> | undefined,
    value: string | undefined,
  ) => {
    if (!table || Object.keys(table).length === 0) return;
    const wanted = (value ?? "").toLowerCase();
    // An industry matches in any source's spelling (industries.ts); a country by name.
    const points = key === "industry" ? industryWeight(table, value) : Object.entries(table).find(([k]) => k.toLowerCase() === wanted)?.[1];
    if (points !== undefined) add({ dimension: key, text: `${label}: ${value} is in your ICP`, points, matched: true });
    else add({ dimension: key, text: value ? `${label}: ${value} is outside your ICP` : `${label} is not known`, points: 0, matched: false });
  };
  dimension("industry", "Industry", weights.industries, account.industry);
  dimension("country", "Country", weights.countries, account.country);

  const bands = weights.employeeBands ?? [];
  if (bands.length) {
    const employees = account.employees;
    const hits = employees === undefined ? [] : bands.filter((b) => employees >= b.min && employees <= b.max);
    if (hits.length) {
      add({
        dimension: "employees",
        text: `Employees: ${employees} is in the ${hits.map(bandLabel).join(", ")} size band`,
        points: hits.reduce((sum, b) => sum + b.weight, 0),
        matched: true,
      });
    } else {
      add({
        dimension: "employees",
        text: employees === undefined ? "Employees is not known" : `Employees: ${employees} is outside your ICP size bands`,
        points: 0,
        matched: false,
      });
    }
  }

  if (reasons.length === 0) return null;
  const total = Math.min(100, Math.max(0, raw));
  // `fit` is 0..1; the service stores points to a decimal. Allow rounding, not a different ICP.
  if (Math.abs(total - fit * 100) > 0.6) return null;
  return { total, capped: raw > 100 ? "high" : raw < 0 ? "low" : null, reasons };
}

/**
 * A research fact's evidence is `"<quote>"\n\nSource: <url>` (researchAgent
 * evidenceText). Anything else is not a citation and yields null.
 */
export function parseCitation(evidence: string | null | undefined): { quote: string; sourceUrl: string } | null {
  const m = evidence?.match(/^"([\s\S]+)"\s*\n\s*Source:\s*(https?:\/\/\S+)\s*$/);
  return m ? { quote: m[1], sourceUrl: m[2] } : null;
}

/**
 * Why an account has its fit under saved ICP gates (record service 1.14.0). In
 * an ICP: the terms of the ICP it ranks best in, scaled as the service scales
 * them (100 = a perfect match). Outside every ICP: for each one, the first
 * criterion it fails. Null when the gates on hand don't reproduce `fit`.
 */
export function explainGates(
  account: Firmographics & { icpIds?: string[] },
  gates: readonly IcpGate[],
  fit: number,
  nameOf: (icpId: string) => string,
): FitExplanation | null {
  if (!gates.length) return null;
  const weightOf = (set: Record<string, number>, value: string | undefined) =>
    Object.entries(set).find(([k]) => value !== undefined && k.toLowerCase() === value.toLowerCase())?.[1];
  const inside = gates.filter((g) => account.icpIds?.includes(g.id));
  if (!inside.length) {
    if (fit > 0.006) return null;
    const reasons = gates.map((g): FitReason => {
      const name = nameOf(g.id);
      const out = (dimension: FitDimension, why: string): FitReason => ({ dimension, text: `Not in ${name}: ${why}`, points: 0, matched: false });
      if (Object.keys(g.industries).length && industryWeight(g.industries, account.industry) === undefined) {
        return out("industry", account.industry ? `industry ${account.industry} is outside it` : "industry is not known");
      }
      if (Object.keys(g.countries).length && weightOf(g.countries, account.country) === undefined) {
        return out("country", account.country ? `country ${account.country} is outside it` : "country is not known");
      }
      const employees = account.employees;
      if (g.employees.length && (employees === undefined || !g.employees.some((b) => employees >= b.min && employees <= b.max))) {
        return out("employees", employees === undefined ? "employees is not known" : `${employees} employees is outside its sizes`);
      }
      if (g.excludeIndustries.some((x) => sameIndustry(x, account.industry))) return out("industry", `it excludes ${account.industry}`);
      if (g.excludeCountries.some((x) => x.toLowerCase() === (account.country ?? "").toLowerCase())) return out("country", `it excludes ${account.country}`);
      if (g.buyer && !g.custom.length) return out("base", "no one there matches its buyer");
      return out("base", g.buyer ? "no one there matches its buyer, or an AI field it requires isn't answered" : "an AI field it requires isn't answered, or answers otherwise");
    });
    return { total: 0, capped: null, reasons };
  }
  const scored = inside.map((g) => {
    const scale = 100 / g.max;
    const band = g.employees.filter((b) => account.employees !== undefined && account.employees >= b.min && account.employees <= b.max);
    const terms: FitReason[] = [{ dimension: "base", text: `In ${nameOf(g.id)}`, points: g.base * scale, matched: true }];
    const industry = industryWeight(g.industries, account.industry);
    if (industry !== undefined) terms.push({ dimension: "industry", text: `Industry: ${account.industry}`, points: industry * scale, matched: true });
    const country = weightOf(g.countries, account.country);
    if (country !== undefined) terms.push({ dimension: "country", text: `Country: ${account.country}`, points: country * scale, matched: true });
    if (band.length) {
      terms.push({ dimension: "employees", text: `Employees: ${account.employees} (${band.map(bandLabel).join(", ")})`, points: Math.max(...band.map((b) => b.weight)) * scale, matched: true });
    }
    return { terms, total: Math.round(terms.reduce((sum, t) => sum + t.points, 0)) };
  }).sort((a, b) => b.total - a.total);
  const best = scored[0];
  if (Math.abs(best.total - fit * 100) > 1) return null;
  const reasons = best.terms.map((t) => ({ ...t, points: Math.round(t.points) }));
  if (inside.length > 1) reasons.push({ dimension: "base", text: `Also in ${inside.filter((g) => !best.terms[0].text.endsWith(nameOf(g.id))).map((g) => nameOf(g.id)).join(", ")}`, points: 0, matched: true });
  return { total: best.total, capped: null, reasons };
}
