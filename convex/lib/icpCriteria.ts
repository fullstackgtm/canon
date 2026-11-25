/**
 * ICP query lines (modules/kernel/icpQuery.ts) as record-service criteria: what Canon sends the record service to
 * count or list a tree node's companies and people.
 */
import { listOf, REVENUE, type Clause } from "../../modules/kernel/icpQuery.ts";
import type { AccountsFilter, IcpTreeAccount, IcpTreePerson } from "./recordContract.ts";
import { icpGeosToCountries } from "../../modules/kernel/icpGeography.ts";
import { NONE, REGION_OF_COUNTRY } from "../../modules/kernel/dimensions.ts";

const SCALE: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };
const BAND = /^(\d+)(?:-(\d+)|\+)$/;
const bandRange = (band: string) => {
  const m = band.match(BAND);
  return m ? { min: Number(m[1]), max: m[2] ? Number(m[2]) : 1_000_000_000 } : null;
};

/** A region's countries, as names and codes (record service dimensions.ts), the way accounts may carry them. */
const regionCountries = (regions: readonly string[]) => Object.entries(REGION_OF_COUNTRY).filter(([, r]) => regions.includes(r)).map(([c]) => c);
/** "1m-10m" as cents (annual revenue is stored in cents); "50m+" has no top. */
function revenueRange(band: string) {
  const m = band.match(REVENUE);
  if (!m) return null;
  const amount = (n: string, unit: string) => Math.round(Number(n) * SCALE[unit] * 100);
  return { min: amount(m[1], m[2]), max: m[3] ? amount(m[3], m[4]) : 1e17 };
}

/** A segment's company keys as record-service criteria (contract 1.31.0; cities, owners and revenue 1.40.0). */
export function accountCriteria(clauses: readonly Clause[]): IcpTreeAccount {
  const owners = (neg: boolean) => listOf(clauses, "owner", neg).map((o) => (o === "none" ? NONE : o));
  return {
    industries: listOf(clauses, "industry"),
    // Accounts carry country names, as gates match them (lib/icps.ts specGate). A region is its countries.
    countries: [...icpGeosToCountries(listOf(clauses, "country")), ...regionCountries(listOf(clauses, "region"))],
    employees: listOf(clauses, "size").flatMap((b) => bandRange(b) ?? []),
    excludeIndustries: listOf(clauses, "industry", true),
    excludeCountries: [...icpGeosToCountries(listOf(clauses, "country", true)), ...regionCountries(listOf(clauses, "region", true))],
    ...(listOf(clauses, "city").length ? { cities: listOf(clauses, "city") } : {}),
    ...(owners(false).length ? { owners: owners(false) } : {}),
    ...(owners(true).length ? { excludeOwners: owners(true) } : {}),
    ...(listOf(clauses, "revenue").length ? { revenue: listOf(clauses, "revenue").flatMap((b) => revenueRange(b) ?? []) } : {}),
    custom: clauses.flatMap((c) => (c.key === "field" ? [{ key: `custom.${c.slug}`, ...(c.values ? { values: c.values } : {}), ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) }] : [])),
  };
}

/**
 * Person keys as record-service criteria: someone whose title holds one of `titles`, or whose level is one of
 * `levels` (any, when none) and whose department is one of `departments` (any, when none); never anyone whose
 * title holds an `exclude` word. Location isn't checked: contacts carry none.
 */
export function personCriteria(clauses: readonly Clause[]): IcpTreePerson {
  const lower = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  return {
    levels: lower(listOf(clauses, "level")),
    departments: lower(listOf(clauses, "dept")),
    titles: lower(listOf(clauses, "title")),
    exclude: lower(listOf(clauses, "title", true)),
  };
}

/** Every criterion's record fields; adding a contract key requires an admission mapping. */
const ACCOUNT_CRITERION_FIELDS = {
  industries: "industry", excludeIndustries: "industry", countries: "country", excludeCountries: "country",
  employees: "employees", cities: "city", owners: "ownerId", excludeOwners: "ownerId", revenue: "annualRevenue", custom: null,
} satisfies Record<keyof IcpTreeAccount | keyof NonNullable<AccountsFilter["criteria"]>[number], string | null>;
const PERSON_CRITERION_FIELDS = {
  levels: "title", departments: "title", topics: "title", titles: "title", exclude: "title",
} satisfies Record<keyof IcpTreePerson, string>;

export function accountCriterionFields(criteria: IcpTreeAccount | undefined): string[] {
  return (Object.keys(ACCOUNT_CRITERION_FIELDS) as Array<keyof IcpTreeAccount>).flatMap((key) => {
    if (key === "custom") return (criteria?.custom ?? []).map((c) => c.key);
    return criteria?.[key]?.length ? [ACCOUNT_CRITERION_FIELDS[key]!] : [];
  });
}
export function personCriterionFields(criteria: IcpTreePerson | undefined): string[] {
  return (Object.keys(PERSON_CRITERION_FIELDS) as Array<keyof IcpTreePerson>).flatMap((key) => criteria?.[key]?.length ? [PERSON_CRITERION_FIELDS[key]] : []);
}
