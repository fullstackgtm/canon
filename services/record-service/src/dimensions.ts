// TAM explorer dimensions (contract 1.4.0): employee size bands and country ->
// region. Pure and import-free so the Convex app and UI import this file
// directly; the service turns the same tables into SQL in ops.ts.

/** Group key for accounts with no value for a dimension. Also accepted in filters. */
export const NONE = "__none__";

export const SIZE_BANDS = [
  { key: "1-10", label: "1–10", min: 0, max: 10 },
  { key: "11-50", label: "11–50", min: 11, max: 50 },
  { key: "51-200", label: "51–200", min: 51, max: 200 },
  { key: "201-500", label: "201–500", min: 201, max: 500 },
  { key: "501-1000", label: "501–1,000", min: 501, max: 1000 },
  { key: "1001-5000", label: "1,001–5,000", min: 1001, max: 5000 },
  { key: "5001-10000", label: "5,001–10,000", min: 5001, max: 10000 },
  { key: "10001+", label: "10,001+", min: 10001, max: Number.MAX_SAFE_INTEGER },
] as const;

export function sizeBandOf(employees: number | null | undefined): string {
  if (employees === null || employees === undefined) return NONE;
  return SIZE_BANDS.find((b) => employees <= b.max)?.key ?? NONE;
}

export const REGIONS = [
  { key: "north-america", label: "North America" },
  { key: "latin-america", label: "Latin America" },
  { key: "europe", label: "Europe" },
  { key: "middle-east-africa", label: "Middle East & Africa" },
  { key: "asia-pacific", label: "Asia-Pacific" },
  { key: "other", label: "Other" },
] as const;

// Lowercase country names as PDL and CRMs write them, plus ISO 3166 alpha-2 codes.
const REGION_COUNTRIES: Record<string, string[]> = {
  "north-america": ["united states", "usa", "us", "united states of america", "canada", "ca"],
  "latin-america": [
    "mexico", "mx", "brazil", "br", "argentina", "ar", "chile", "cl", "colombia", "co", "peru", "pe", "venezuela", "ve",
    "ecuador", "ec", "uruguay", "uy", "paraguay", "py", "bolivia", "bo", "costa rica", "cr", "panama", "pa", "guatemala", "gt",
    "dominican republic", "do", "puerto rico", "pr", "el salvador", "sv", "honduras", "hn", "nicaragua", "ni", "jamaica", "jm",
    "trinidad and tobago", "tt", "cuba", "cu", "bahamas", "bs", "barbados", "bb",
  ],
  europe: [
    "united kingdom", "uk", "gb", "great britain", "england", "scotland", "wales", "northern ireland", "ireland", "ie",
    "germany", "de", "france", "fr", "spain", "es", "italy", "it", "netherlands", "nl", "belgium", "be", "luxembourg", "lu",
    "switzerland", "ch", "austria", "at", "sweden", "se", "norway", "no", "denmark", "dk", "finland", "fi", "iceland", "is",
    "portugal", "pt", "poland", "pl", "czechia", "czech republic", "cz", "slovakia", "sk", "hungary", "hu", "romania", "ro",
    "bulgaria", "bg", "greece", "gr", "croatia", "hr", "slovenia", "si", "serbia", "rs", "estonia", "ee", "latvia", "lv",
    "lithuania", "lt", "ukraine", "ua", "belarus", "by", "russia", "ru", "moldova", "md", "bosnia and herzegovina", "ba",
    "north macedonia", "mk", "albania", "al", "montenegro", "me", "malta", "mt", "cyprus", "cy", "monaco", "mc", "liechtenstein", "li",
  ],
  "middle-east-africa": [
    "israel", "il", "united arab emirates", "ae", "uae", "saudi arabia", "sa", "qatar", "qa", "kuwait", "kw", "bahrain", "bh",
    "oman", "om", "jordan", "jo", "lebanon", "lb", "turkey", "türkiye", "tr", "iran", "ir", "iraq", "iq", "egypt", "eg",
    "south africa", "za", "nigeria", "ng", "kenya", "ke", "ghana", "gh", "morocco", "ma", "tunisia", "tn", "algeria", "dz",
    "ethiopia", "et", "uganda", "ug", "tanzania", "tz", "rwanda", "rw", "senegal", "sn", "ivory coast", "côte d'ivoire", "ci",
    "cameroon", "cm", "zimbabwe", "zw", "zambia", "zm", "botswana", "bw", "namibia", "na", "mauritius", "mu", "angola", "ao",
  ],
  "asia-pacific": [
    "china", "cn", "japan", "jp", "south korea", "korea", "kr", "india", "in", "singapore", "sg", "australia", "au",
    "new zealand", "nz", "hong kong", "hk", "taiwan", "tw", "indonesia", "id", "malaysia", "my", "thailand", "th",
    "vietnam", "vn", "philippines", "ph", "pakistan", "pk", "bangladesh", "bd", "sri lanka", "lk", "nepal", "np",
    "cambodia", "kh", "myanmar", "mm", "mongolia", "mn", "kazakhstan", "kz", "uzbekistan", "uz", "macau", "mo",
  ],
};

export const REGION_OF_COUNTRY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(REGION_COUNTRIES).flatMap(([region, countries]) => countries.map((c) => [c, region])),
);

export function regionOf(country: string | null | undefined): string {
  const c = (country ?? "").trim().toLowerCase();
  if (!c) return NONE;
  return REGION_OF_COUNTRY[c] ?? "other";
}

/** Trait keys name Jev segments; they appear in JSON paths, so the alphabet is narrow. */
export const TRAIT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * ISO 3166 alpha-2 code -> the lowercase country name PDL and CRMs write, for every country the region
 * table knows: an ICP stores codes, accounts carry names, and each side converts through this.
 */
export const COUNTRY_NAME_BY_ISO: Readonly<Record<string, string>> = { us: "united states", ca: "canada", mx: "mexico", br: "brazil", ar: "argentina", cl: "chile", co: "colombia", pe: "peru", ve: "venezuela", ec: "ecuador", uy: "uruguay", py: "paraguay", bo: "bolivia", cr: "costa rica", pa: "panama", gt: "guatemala", do: "dominican republic", pr: "puerto rico", sv: "el salvador", hn: "honduras", ni: "nicaragua", jm: "jamaica", tt: "trinidad and tobago", cu: "cuba", bs: "bahamas", bb: "barbados", gb: "united kingdom", ie: "ireland", de: "germany", fr: "france", es: "spain", it: "italy", nl: "netherlands", be: "belgium", lu: "luxembourg", ch: "switzerland", at: "austria", se: "sweden", no: "norway", dk: "denmark", fi: "finland", is: "iceland", pt: "portugal", pl: "poland", cz: "czech republic", sk: "slovakia", hu: "hungary", ro: "romania", bg: "bulgaria", gr: "greece", hr: "croatia", si: "slovenia", rs: "serbia", ee: "estonia", lv: "latvia", lt: "lithuania", ua: "ukraine", by: "belarus", ru: "russia", md: "moldova", ba: "bosnia and herzegovina", mk: "north macedonia", al: "albania", me: "montenegro", mt: "malta", cy: "cyprus", mc: "monaco", li: "liechtenstein", il: "israel", ae: "united arab emirates", sa: "saudi arabia", qa: "qatar", kw: "kuwait", bh: "bahrain", om: "oman", jo: "jordan", lb: "lebanon", tr: "turkey", ir: "iran", iq: "iraq", eg: "egypt", za: "south africa", ng: "nigeria", ke: "kenya", gh: "ghana", ma: "morocco", tn: "tunisia", dz: "algeria", et: "ethiopia", ug: "uganda", tz: "tanzania", rw: "rwanda", sn: "senegal", ci: "c\u00f4te d'ivoire", cm: "cameroon", zw: "zimbabwe", zm: "zambia", bw: "botswana", na: "namibia", mu: "mauritius", ao: "angola", cn: "china", jp: "japan", kr: "south korea", in: "india", sg: "singapore", au: "australia", nz: "new zealand", hk: "hong kong", tw: "taiwan", id: "indonesia", my: "malaysia", th: "thailand", vn: "vietnam", ph: "philippines", pk: "pakistan", bd: "bangladesh", lk: "sri lanka", np: "nepal", kh: "cambodia", mm: "myanmar", mn: "mongolia", kz: "kazakhstan", uz: "uzbekistan", mo: "macau" };
