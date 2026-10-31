/**
 * The large sample dataset (convex/sampleData.ts): a sales team, companies, their people and a year of deals with
 * dated changes, generated from a fixed seed and dated from the day it loads, so it never goes stale. The same day
 * gives the same rows; every key is stable, so loading again writes the same records.
 *
 * Pure: no database, no clock. Amounts are whole dollars.
 */

export type SampleRep = { key: string; name: string; role: "manager" | "rep"; title: string; manager?: string };
export type SampleCompany = { key: string; domain: string; name: string; industry: string; employees: number; country: string };
export type SamplePerson = { companyKey: string; fullName: string; title: string; email: string };
export type SampleStatus = { stage: string; forecastCategory: "pipeline" | "best_case" | "commit" | "closed_won" | "closed_lost"; isClosed: boolean; isWon: boolean };
export type SampleChange = { day: string; values: Record<string, string | number | boolean> };
export type SampleDeal = {
  key: string; name: string; companyKey: string; owner: string; type: "new_business" | "expansion" | "renewal";
  created: string; amount: number; closeDate: string; start: SampleStatus; changes: SampleChange[];
};
export type SampleDataset = { reps: SampleRep[]; companies: SampleCompany[]; people: SamplePerson[]; deals: SampleDeal[] };

export const SAMPLE_SIZES = { companies: 300, peoplePerCompany: 3, deals: 600 } as const;

export const SAMPLE_REPS: readonly SampleRep[] = [
  { key: "maya", name: "Maya Chen", role: "manager", title: "Sales Manager, Enterprise" },
  { key: "omar", name: "Omar Haddad", role: "manager", title: "Sales Manager, Mid-market" },
  { key: "jules", name: "Jules Moreau", role: "rep", title: "Account Executive", manager: "maya" },
  { key: "priya", name: "Priya Nair", role: "rep", title: "Account Executive", manager: "maya" },
  { key: "sam", name: "Sam Okoro", role: "rep", title: "Account Executive", manager: "maya" },
  { key: "tess", name: "Tess Walker", role: "rep", title: "Account Executive", manager: "maya" },
  { key: "diego", name: "Diego Ruiz", role: "rep", title: "Account Executive", manager: "omar" },
  { key: "hana", name: "Hana Sato", role: "rep", title: "Account Executive", manager: "omar" },
  { key: "liam", name: "Liam Byrne", role: "rep", title: "Account Executive", manager: "omar" },
  { key: "zoe", name: "Zoe Adler", role: "rep", title: "Account Executive", manager: "omar" },
];

const STATUS: Record<string, SampleStatus> = {
  Discovery: { stage: "Discovery", forecastCategory: "pipeline", isClosed: false, isWon: false },
  Proposal: { stage: "Proposal", forecastCategory: "best_case", isClosed: false, isWon: false },
  Negotiation: { stage: "Negotiation", forecastCategory: "commit", isClosed: false, isWon: false },
  "Closed Won": { stage: "Closed Won", forecastCategory: "closed_won", isClosed: true, isWon: true },
  "Closed Lost": { stage: "Closed Lost", forecastCategory: "closed_lost", isClosed: true, isWon: false },
};
const OPEN = ["Discovery", "Proposal", "Negotiation"] as const;

const LEFT = ["Blue", "North", "Silver", "Cedar", "Harbor", "Summit", "Iron", "Bright", "Granite", "Maple", "Copper", "Falcon", "River", "Pine", "Atlas", "Clear", "Red", "Stone", "Golden", "Lake"];
const RIGHT = ["field", "point", "gate", "line", "works", "path", "bridge", "wave", "peak", "forge", "light", "crest", "dale", "stream", "haven"];
const KIND = ["Logistics", "Health", "Software", "Foods", "Energy", "Robotics", "Analytics", "Retail", "Labs", "Finance", "Media", "Freight", "Clinics", "Security", "Systems"];
const INDUSTRY: Record<string, string> = {
  Logistics: "logistics and supply chain", Health: "hospital & health care", Software: "computer software", Foods: "food production",
  Energy: "renewables & environment", Robotics: "industrial automation", Analytics: "information technology and services", Retail: "retail",
  Labs: "biotechnology", Finance: "financial services", Media: "online media", Freight: "transportation/trucking/railroad",
  Clinics: "medical practice", Security: "computer & network security", Systems: "computer software",
};
const COUNTRY = ["united states", "united states", "united states", "canada", "united kingdom", "germany", "australia"];
const FIRST = ["Alex", "Bea", "Cole", "Dana", "Eli", "Fran", "Gabe", "Ines", "Jon", "Kira", "Leo", "Mina", "Noah", "Ola", "Pat", "Quinn", "Rosa", "Seth", "Tara", "Uma", "Vic", "Wren", "Yara", "Zane"];
const LAST = ["Abbott", "Bishop", "Castro", "Dunn", "Ellis", "Fischer", "Grant", "Hughes", "Ito", "Jensen", "Kaur", "Lopez", "Mendes", "Novak", "Ortiz", "Park", "Quint", "Reyes", "Shah", "Tran", "Usman", "Vance", "Weber", "Young"];
const TITLES = ["VP Operations", "Head of Revenue", "Director of IT", "CFO", "Procurement Manager", "COO", "Head of Data", "VP Engineering"];
const DAY_MS = 86_400_000;

/** A seeded generator (mulberry32): the same seed, the same sequence. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The dataset dated from `today` (YYYY-MM-DD): deals created over the past year, closing up to two quarters ahead. */
export function sampleDataset(today: string): SampleDataset {
  const rnd = random(20261025);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const now = Date.parse(`${today}T12:00:00Z`);
  const day = (offset: number) => ymd(now + offset * DAY_MS);

  const companies: SampleCompany[] = [];
  const names = new Set<string>();
  while (companies.length < SAMPLE_SIZES.companies) {
    const kind = pick(KIND);
    const name = `${pick(LEFT)}${pick(RIGHT)} ${kind}`;
    if (names.has(name)) continue;
    names.add(name);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    companies.push({ key: `c${companies.length + 1}`, domain: `${slug}.demo`, name, industry: INDUSTRY[kind]!, employees: pick([25, 60, 120, 250, 500, 1200, 4000]), country: pick(COUNTRY) });
  }

  const people: SamplePerson[] = [];
  for (const c of companies) {
    for (let i = 0; i < SAMPLE_SIZES.peoplePerCompany; i++) {
      const first = pick(FIRST), last = pick(LAST);
      people.push({ companyKey: c.key, fullName: `${first} ${last}`, title: pick(TITLES), email: `${first}.${last}${i}@${c.domain}`.toLowerCase() });
    }
  }

  const reps = SAMPLE_REPS.filter((r) => r.role === "rep").map((r) => r.key);
  const deals: SampleDeal[] = [];
  for (let i = 0; i < SAMPLE_SIZES.deals; i++) {
    const company = pick(companies);
    const type = pick(["new_business", "new_business", "new_business", "expansion", "renewal"] as const);
    const createdAt = -int(5, 365);
    const cycle = int(30, 120);
    let close = createdAt + cycle;
    const amount = Math.round((type === "expansion" ? int(5, 60) : int(10, 200)) * 1000 / 500) * 500;
    const changes: SampleChange[] = [];
    // Each stage the deal reaches, dated along its cycle; a deal whose close is past is decided.
    const decided = close < 0 || rnd() < 0.08;
    const won = rnd() < (type === "renewal" ? 0.8 : 0.45);
    const reach = decided ? (won ? 3 : int(1, 3)) : int(0, 2);
    const at = (fraction: number) => Math.min(-1, createdAt + Math.max(1, Math.round(cycle * fraction)));
    for (let s = 1; s <= Math.min(reach, 2); s++) changes.push({ day: day(at(s / 4)), values: { ...STATUS[OPEN[s]!]! } });
    // Some deals slip once, some change size: the changes What moved and the waterfalls read.
    if (rnd() < 0.3) {
      const pushed = close + int(14, 45);
      const when = at(0.6);
      if (when > createdAt) changes.push({ day: day(when), values: { closeDate: day(pushed) } });
      close = pushed;
    }
    if (rnd() < 0.2) {
      const when = at(0.5);
      if (when > createdAt) changes.push({ day: day(when), values: { amount: Math.round(amount * (rnd() < 0.5 ? 0.8 : 1.15)) * 100 } });
    }
    if (decided) {
      const closedOn = Math.min(-1, close);
      changes.push({ day: day(closedOn), values: { ...STATUS[won ? "Closed Won" : "Closed Lost"]!, closeDate: day(closedOn) } });
    } else if (close <= 0) {
      close = int(7, 180);
      changes.push({ day: day(-1), values: { closeDate: day(close) } });
    }
    changes.sort((a, b) => a.day.localeCompare(b.day));
    const label = type === "renewal" ? "Renewal" : type === "expansion" ? "Expansion" : "New";
    deals.push({
      key: `d${i + 1}`, name: `${company.name} – ${label}`, companyKey: company.key, owner: pick(reps), type,
      created: day(createdAt), amount, closeDate: day(createdAt + cycle), start: STATUS.Discovery!, changes,
    });
  }
  return { reps: [...SAMPLE_REPS], companies, people, deals };
}

/** What the sample-data picker offers, in its order, and what each needs loaded with it. */
export const SAMPLE_SETS = [
  { key: "team", label: "Sales team", detail: "Two managers and eight reps, members who never sign in", needs: [] },
  { key: "companies", label: "Companies", detail: "About 300 companies across 15 industries", needs: [] },
  { key: "people", label: "People", detail: "900 people, three at each company", needs: ["companies"] },
  { key: "deals", label: "Deals", detail: "600 deals over the past year and next two quarters, with stage, close-date and amount changes", needs: ["companies", "team"] },
  { key: "forecast", label: "Forecast example (Northwind)", detail: "The Forecast plan's team and eight deals, for What moved", needs: [] },
  { key: "customerSuccess", label: "Customer success example (Acme)", detail: "Six customers and twelve renewal, expansion and churn deals, for Retention", needs: [] },
] as const;

export type SampleSetKey = (typeof SAMPLE_SETS)[number]["key"];

/** The picked sets plus every set they need, in the picker's order. */
export function withNeeds(picked: readonly SampleSetKey[]): SampleSetKey[] {
  const out = new Set<SampleSetKey>();
  const add = (key: SampleSetKey) => {
    if (out.has(key)) return;
    out.add(key);
    for (const need of SAMPLE_SETS.find((s) => s.key === key)!.needs) add(need);
  };
  picked.forEach(add);
  return SAMPLE_SETS.map((s) => s.key).filter((k) => out.has(k));
}
