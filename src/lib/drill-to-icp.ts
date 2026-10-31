/**
 * A treemap drill (tam-levels Pivot filters) as a saved ICP's spec, for "Save as
 * ICP" (docs/tam-and-icps.md, step 1). Accounts carry each source's own industry
 * spelling, so industries go through the same mapping the ICP gate reads them
 * back with: the canonical industries (services/record-service/src/industries.ts).
 * AI-field answers become AI-field criteria. Filters an ICP can't hold yet (starter
 * segments, Jev segments) are reported back.
 */
import { canonIndustry, industryLabel } from "../../services/record-service/src/industries.ts";
import { icpGeosToIso } from "../../convex/lib/researchPipeline.ts";
import { emptySpec } from "../../convex/lib/icps.ts";
import type { IcpSpec } from "../../convex/lib/icpSpec.ts";
import { NONE, REGION_OF_COUNTRY, SIZE_BANDS } from "../../services/record-service/src/dimensions.ts";
import type { Pivot } from "./tam-levels.ts";

export type DrillSpec = { spec: IcpSpec; unsaved: string[]; empty: boolean };

const BANDS = new Set<string>(SIZE_BANDS.map((b) => b.key));
/** ISO codes per region key, from the record service's own region table. */
const isoInRegion = (region: string) =>
  Object.entries(REGION_OF_COUNTRY).filter(([country, r]) => r === region && /^[a-z]{2}$/.test(country) && country !== "uk").map(([iso]) => iso);

export function drillToSpec(pivot: Pivot, labelOf: (dim: string) => string): DrillSpec {
  const spec = emptySpec();
  const unsaved: string[] = [];
  let countries: string[] = [];
  let regionCountries: string[] = [];
  for (const { dim, values } of pivot.filters) {
    const known = values.filter((v) => v !== NONE);
    // An ICP can't require an unknown value (it would read as "any"): say so rather than widen the pocket.
    if (values.includes(NONE)) unsaved.push(`${labelOf(dim)}: Unknown`);
    if (!known.length) continue;
    if (dim === "industry") {
      // Tiles group by canonical industry; a value no table maps can't be an ICP criterion yet.
      spec.market.industries = [...new Set(known.map((k) => canonIndustry(k)).filter((k): k is string => Boolean(k)))];
      const unmapped = known.filter((k) => !canonIndustry(k));
      if (unmapped.length) unsaved.push(`${unmapped.map(industryLabel).join(", ")} (no canonical industry)`);
    }
    else if (dim === "sizeBand") spec.market.employeeBands = known.filter((b) => BANDS.has(b));
    else if (dim === "country") countries = icpGeosToIso(known).map((c) => c.toLowerCase());
    else if (dim === "region") regionCountries = [...new Set(known.flatMap(isoInRegion))];
    // An AI field's answers are an ICP criterion as they are (lib/icpSpec.ts custom).
    else if (dim.startsWith("field:")) spec.custom = [...(spec.custom ?? []), { slug: dim.slice("field:".length), values: known }];
    else unsaved.push(labelOf(dim));
  }
  // A drill narrows: a country filter inside a region is the narrower of the two.
  spec.market.countries = countries.length ? countries : regionCountries;
  const empty = !spec.market.industries.length && !spec.market.employeeBands.length && !spec.market.countries.length && !spec.custom?.length;
  return { spec, unsaved, empty };
}

