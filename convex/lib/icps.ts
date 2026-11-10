/**
 * Saved ICPs: a workspace keeps several, each a market (industries, sizes,
 * countries), a persona (levels, departments, titles) and what to exclude.
 * The spec is the Add records form's shape, so a saved ICP starts a fill as is.
 * Each active ICP is a gate (specGate): an account is in it only when it passes
 * every company criterion and one of its contacts is a buyer (specBuyer), and its fit is its rank inside the ICPs it passes, 0 outside
 * them (gatedFit mirrors the record service's SQL). ICPs never mix. Pure and
 * Node-free (the UI imports it).
 */
import { canonDepartments, specToIcp } from "./addRecords.ts";
import type { IcpGate } from "./recordContract.ts";
import { icpGeosToCountries, icpIndustryTerms, icpToWeights } from "./researchPipeline.ts";
import type { IcpExclude, IcpSpec } from "../../modules/kernel/icpSpec.ts";
import { DEPARTMENT, SENIORITY, classifyTitle } from "../../modules/kernel/titles.ts";
import type { FitModel } from "../../recipes/models.ts";

export type { IcpExclude, IcpSpec };

export const MAX_ICPS = 25;

export const emptyExclude = (): IcpExclude => ({ industries: [], countries: [], titles: [] });
export const emptySpec = (): IcpSpec => ({
  market: { industries: [], employeeBands: [], countries: [] },
  persona: { levels: [], departments: [], titles: [], countries: [] },
  exclude: emptyExclude(),
});

export { specFromIcp } from "../../modules/kernel/icpResearchSpec.ts";

const BAND = /^(\d+)(?:-(\d+)|\+)$/;

/**
 * A saved ICP as a record-service gate. Its include sets carry the rank weights
 * icpToWeights gives (primary industry and country, central size bands score
 * more); bands outside the ICP get none, since they fail the gate. `max` is a
 * perfect match's points, so a perfect match scores 100.
 */
export function specGate(id: string, spec: IcpSpec, fit: FitModel): IcpGate {
  const w = icpToWeights(specToIcp(spec.market, spec.persona), fit);
  const employees = spec.market.employeeBands.flatMap((band) => {
    const m = band.match(BAND);
    if (!m) return [];
    const min = Number(m[1]);
    return [{ min, max: m[2] ? Number(m[2]) : 1_000_000_000, weight: w.employeeBands?.find((b) => b.min === min)?.weight ?? fit.unlistedBand }];
  });
  const top = (values: number[]) => (values.length ? Math.max(...values) : 0);
  const base = w.base ?? 0;
  return {
    id,
    base,
    max: base + top(Object.values(w.industries ?? {})) + top(Object.values(w.countries ?? {})) + top(employees.map((b) => b.weight)),
    industries: w.industries ?? {},
    countries: w.countries ?? {},
    employees,
    excludeIndustries: icpIndustryTerms(spec.exclude.industries).flatMap((t) => t.names),
    excludeCountries: icpGeosToCountries(spec.exclude.countries),
    custom: (spec.custom ?? []).map((c) => ({
      key: `custom.${c.slug}`,
      ...(c.values?.length ? { values: c.values.map((v) => v.toLowerCase()) } : {}),
      ...(c.min !== undefined ? { min: c.min } : {}),
      ...(c.max !== undefined ? { max: c.max } : {}),
    })).filter((c) => c.values || c.min !== undefined || c.max !== undefined),
    buyer: specBuyer(spec, fit.buyerLevels),
  };
}

/**
 * Who must work at an account for it to be in the ICP, as the outbound search reads the persona
 * (lib/quickenrich.ts icpTitles): someone at one of its levels in one of its departments or topics.
 * A title keyword that names a level ("Head of Sales") is a buyer on its own; any other keyword is
 * a topic, and also names its department when it reads as one ("revenue operations"). With only
 * such titles and no department or topic, the levels drop out, as icpTitles drops bare levels.
 * Excluded titles never count. Persona countries aren't checked: contacts carry no location. An ICP that picks no
 * level means `buyerLevels`, the workspace's scoring.fit setting.
 */
export function specBuyer(spec: IcpSpec, buyerLevels: readonly string[]): NonNullable<IcpGate["buyer"]> {
  const lower = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const keywords = lower(spec.persona.titles);
  const titles = keywords.filter((k) => classifyTitle(SENIORITY, k) !== null);
  const topics = keywords.filter((k) => !titles.includes(k));
  const departments = lower([...canonDepartments(spec.persona.departments), ...topics.flatMap((k) => classifyTitle(DEPARTMENT, k) ?? [])]);
  // Levels alone admit anyone senior: only when nothing else says who. Titles that name their own level already do.
  const bare = !departments.length && !topics.length;
  const levels = bare && titles.length ? [] : lower(spec.persona.levels.length ? spec.persona.levels : buyerLevels);
  return { levels, departments, topics, titles, exclude: lower(spec.exclude.titles) };
}
