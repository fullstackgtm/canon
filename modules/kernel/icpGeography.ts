import { COUNTRY_NAME_BY_ISO } from "./dimensions.ts";

const ISO_TO_COUNTRY: Record<string, string> = { ...COUNTRY_NAME_BY_ISO, uk: "united kingdom" };
const REGION_TO_COUNTRIES: Record<string, string[]> = {
  "north america": ["united states", "canada"],
  europe: ["united kingdom", "germany", "france", "netherlands", "ireland", "spain", "italy", "sweden", "switzerland"],
  emea: ["united kingdom", "germany", "france", "netherlands", "ireland"],
  apac: ["australia", "singapore", "india", "japan", "new zealand"],
  "asia pacific": ["australia", "singapore", "india", "japan", "new zealand"],
};

export function icpGeosToCountries(geos: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const geo of geos ?? []) {
    const g = geo.toLowerCase().trim();
    if (ISO_TO_COUNTRY[g]) out.add(ISO_TO_COUNTRY[g]);
    else if (REGION_TO_COUNTRIES[g]) REGION_TO_COUNTRIES[g].forEach((c) => out.add(c));
    else if (Object.values(ISO_TO_COUNTRY).includes(g)) out.add(g);
  }
  return [...out];
}

/** ICP geos (ISO codes, country names or regions) -> uppercase ISO country codes. */
export function icpGeosToIso(geos: string[] | undefined): string[] {
  const isoFor = new Map<string, string>();
  for (const [iso, name] of Object.entries(ISO_TO_COUNTRY)) if (!isoFor.has(name)) isoFor.set(name, iso === "uk" ? "gb" : iso);
  return [...new Set(icpGeosToCountries(geos).map((name) => isoFor.get(name)).filter((iso): iso is string => Boolean(iso)).map((iso) => iso.toUpperCase()))];
}
