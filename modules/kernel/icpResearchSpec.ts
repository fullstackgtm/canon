import type { IcpSpec } from "./icpSpec.ts";
import { COUNTRIES, canonDepartments } from "./icpVocabulary.ts";
import { icpIndustriesToLeadsforge } from "./icpIndustries.ts";
import { icpGeosToIso } from "./icpGeography.ts";

/** The parts of a derived ICP (engine/src/icp.ts `Icp`) the kit reads: its market and its buyer. */
export type DerivedIcp = {
  firmographics: { industries?: string[]; employeeBands?: string[]; geos?: string[] };
  persona: { jobLevels?: string[]; departments?: string[]; titleKeywords?: string[] };
};

const KNOWN_COUNTRIES = new Set(COUNTRIES.map((c) => c.value));

/** A derived ICP (website research) in the form's vocabularies. */
export function specFromIcp(icp: DerivedIcp | null | undefined): IcpSpec {
  return {
    market: {
      industries: icpIndustriesToLeadsforge(icp?.firmographics.industries),
      employeeBands: icp?.firmographics.employeeBands ?? [],
      countries: icpGeosToIso(icp?.firmographics.geos).map((c) => c.toLowerCase()).filter((c) => KNOWN_COUNTRIES.has(c)),
    },
    persona: {
      levels: icp?.persona.jobLevels ?? [],
      departments: canonDepartments(icp?.persona.departments ?? []),
      titles: icp?.persona.titleKeywords ?? [],
    },
    exclude: { industries: [], countries: [], titles: [] },
  };
}

export const cleanSpecStrings = (values: string[], max = 60) => [...new Set(values.map((s) => s.trim()).filter(Boolean))].slice(0, max).map((s) => s.slice(0, 120));

export function cleanResearchSpec(spec: IcpSpec): IcpSpec {
  const c = cleanSpecStrings;
  return {
    market: { industries: c(spec.market.industries), employeeBands: c(spec.market.employeeBands), countries: c(spec.market.countries) },
    persona: { levels: c(spec.persona.levels), departments: c(canonDepartments(spec.persona.departments)), titles: c(spec.persona.titles), countries: c(spec.persona.countries ?? []) },
    exclude: { industries: c(spec.exclude.industries), countries: c(spec.exclude.countries), titles: c(spec.exclude.titles) },
  };
}
