import assert from "node:assert/strict";
import test from "node:test";
import type { Icp } from "../engine/src/icp.ts";
import {
  DEPARTMENTS,
  icpIndustriesToLeadsforge,
  icpToLeadsforge,
  INDUSTRIES,
  leadsforgeTam,
  leadsToRecords,
  relaxLeadsforge,
  REVENUE_RANGES,
  searchLeads,
  SENIORITIES,
  splitFilters,
  US_STATES,
  type Lead,
  type LeadsforgeFilters,
} from "../convex/lib/leadsforge.ts";
import { heuristicIcp, icpToWeights, runResearchPipeline } from "../convex/lib/researchPipeline.ts";
import { TregRefusal } from "../convex/lib/treg.ts";
import { defaultModel } from "../recipes/index.ts";

const icp: Icp = {
  name: "stub",
  firmographics: { industries: ["SaaS", "computer software", "Fintech"], employeeBands: ["51-200", "201-500"], geos: ["us", "gb"] },
  persona: { jobLevels: ["vp", "director", "cxo"], departments: ["sales", "revenue operations", "marketing"], titleKeywords: ["revenue operations"] },
};

test("every industry the mapper can emit is one of Leadsforge's exact values", () => {
  const labels = ["saas", "software", "internet", "it services", "cybersecurity", "fintech", "investing", "banking", "insurance",
    "marketing agency", "media", "healthcare", "biotech", "pharma", "staffing", "hr tech", "consulting", "real estate", "retail",
    "edtech", "logistics", "telecom", "wireless", "construction", "accounting", "automotive", "manufacturing", "legal", "hospitality",
    "restaurants", "nonprofit", "oil and gas", "utilities", "gaming", "semiconductors", "market research", "wholesale", "travel",
    "fitness", "government", "accounting"];
  const out = icpIndustriesToLeadsforge(labels);
  assert.ok(out.length > 30);
  for (const value of out) assert.ok(INDUSTRIES.includes(value), `"${value}" is not a Leadsforge industry`);
  assert.deepEqual(icpIndustriesToLeadsforge(["software development"]), ["software development"], "an exact value passes through");
  assert.deepEqual(icpIndustriesToLeadsforge(["pharmaceutical manufacturing"]), ["pharmaceutical manufacturing"], "an exact value is not broadened by the rules");
});

test("the ICP becomes one Leadsforge search with exact enum values", () => {
  const f = icpToLeadsforge(icp, ["united states", "united kingdom"]);
  assert.deepEqual(f.companyIndustries?.include, ["software development", "financial services"]);
  assert.deepEqual(f.companyLocations?.include, ["United States", "United Kingdom"]);
  assert.deepEqual(f.companyEmployeeNumberRange, { min: 51, max: 500 });
  assert.deepEqual(f.leadSeniorities?.include, ["vp", "director", "c_suite"]);
  assert.deepEqual(f.leadDepartments?.include, ["sales", "operations", "marketing"]);
  for (const s of f.leadSeniorities!.include) assert.ok((SENIORITIES as readonly string[]).includes(s));
  for (const d of f.leadDepartments!.include) assert.ok((DEPARTMENTS as readonly string[]).includes(d));
  const bare = icpToLeadsforge({ name: "x", firmographics: {}, persona: {} }, []);
  assert.deepEqual(bare, { leadSeniorities: { include: ["c_suite", "vp", "head", "director"] } }, "no levels: the buyers");
});

test("relaxation drops departments, then size, then location", () => {
  const steps = relaxLeadsforge(icpToLeadsforge(icp, ["united states"]));
  assert.equal(steps.length, 4);
  assert.ok(steps[1].leadDepartments === undefined && steps[1].companyEmployeeNumberRange);
  assert.ok(steps[2].companyEmployeeNumberRange === undefined && steps[2].companyLocations);
  assert.equal(steps[3].companyLocations, undefined);
  assert.ok(steps[3].companyIndustries, "industries are never relaxed");
});

test("a saturated search splits one dimension at a time, and the tree always ends", () => {
  const root = icpToLeadsforge(icp, ["united states", "united kingdom"]);
  const byCountry = splitFilters(root)!;
  assert.deepEqual(byCountry.map((f) => f.companyLocations?.include[0]), ["United States", "United Kingdom"]);
  const byState = splitFilters(byCountry[0])!;
  assert.equal(byState.length, US_STATES.length);
  const byIndustry = splitFilters(byState[0])!;
  assert.deepEqual(byIndustry.map((f) => f.companyIndustries?.include), [["software development"], ["financial services"]]);
  const byBand = splitFilters(byIndustry[0])!;
  assert.deepEqual(byBand.map((f) => f.companyEmployeeNumberRange), [{ min: 51, max: 200 }, { min: 201, max: 500 }]);
  const bySeniority = splitFilters(byBand[0])!;
  assert.equal(bySeniority.length, 3);
  const byDept = splitFilters(bySeniority[0])!;
  assert.equal(byDept.length, 3);
  const byRevenue = splitFilters(byDept[0])!;
  assert.equal(byRevenue.length, REVENUE_RANGES.length);
  assert.equal(splitFilters(byRevenue[0]), null, "fully split: a leaf");
  // The UK has no state split: it goes straight to industries.
  assert.equal(splitFilters(byCountry[1])!.length, 2);

  // Walk the whole tree as if every search saturated: finite, and every leaf is fully narrowed.
  let leaves = 0;
  const walk = (f: LeadsforgeFilters, depth: number) => {
    assert.ok(depth < 10, "split depth is bounded");
    const kids = splitFilters(f);
    if (!kids) return void leaves++;
    for (const k of kids) walk(k, depth + 1);
  };
  walk(byCountry[1], 0);
  assert.equal(leaves, 2 * 2 * 3 * 3 * REVENUE_RANGES.length, "industries x bands x seniorities x departments x revenue");
});

const lead = (id: string, name: [string, string], title: string, domain: string | null, extra: Partial<NonNullable<Lead["company"]>> = {}): Lead => ({
  id, firstName: name[0], lastName: name[1], jobTitle: title,
  company: domain === null ? null : { domain, employeeCount: 120, industry: "software development", location: { country: "United States" }, ...extra },
});

test("leads become one account per domain and a contact per person", () => {
  const { accounts, contacts } = leadsToRecords([
    lead("1", ["Ada", "One"], "VP Sales", "WWW.Acme.com"),
    lead("2", ["Bo", "Two"], "Director", "acme.com"),
    lead("3", ["Cy", "Three"], "CRO", null),
    lead("4", ["", ""], "Head of Sales", "beta.io", { employeeCount: null, website: "https://beta.io" }),
  ]);
  assert.deepEqual(accounts, [
    { domain: "acme.com", name: "Acme", industry: "software development", employees: 120, country: "united states" },
    { domain: "beta.io", name: "Beta", industry: "software development", country: "united states" },
  ]);
  assert.deepEqual(contacts, [
    { accountDomain: "acme.com", fullName: "Ada One", title: "VP Sales" },
    { accountDomain: "acme.com", fullName: "Bo Two", title: "Director" },
  ]);
});

type Seen = { url: string; init: RequestInit };
function treg(pages: Array<{ leads: Lead[]; cursor?: string | null; cost?: string }>, seen: Seen[] = []): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const p = pages[Math.min(i++, pages.length - 1)];
    return new Response(JSON.stringify({ leads: p.leads, cursor: p.cursor ?? null }), { status: 200, headers: { "X-Treg-Cost-Micro": p.cost ?? "0", "X-Treg-Call-Id": `c${i}` } });
  }) as unknown as typeof fetch;
}

test("searches are POSTed with a $0 ceiling; a full page with a cursor is saturated", async () => {
  const seen: Seen[] = [];
  const full = Array.from({ length: 3 }, (_, i) => lead(String(i), ["A", String(i)], "VP", `c${i}.com`));
  const page = await searchLeads({ token: "t", filters: { leadSeniorities: { include: ["vp"] } }, meta: { customer: "org_1" }, limit: 3, fetchImpl: treg([{ leads: full, cursor: "next" }], seen) });
  assert.equal(page.saturated, true);
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(seen[0].init.method, "POST");
  assert.equal(headers["X-Treg-Route-Max-Cost"], "0");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { leadSeniorities: { include: ["vp"] }, limit: 3 });
  const short = await searchLeads({ token: "t", filters: {}, meta: { customer: "o" }, limit: 3, fetchImpl: treg([{ leads: full.slice(0, 2), cursor: null }]) });
  assert.equal(short.saturated, false);
});

test("a search that reports any charge is refused, never silently paid, and never retried", async () => {
  await assert.rejects(
    searchLeads({ token: "t", filters: {}, meta: { customer: "o" }, fetchImpl: treg([{ leads: [], cost: "5000" }]) }),
    (err: unknown) => err instanceof TregRefusal && err.code === "not_free" && !err.temporary,
  );
});

test("the preview TAM relaxes until it finds enough accounts, one person per company", async () => {
  const seen: Seen[] = [];
  const few = [lead("1", ["A", "B"], "VP", "a.com")];
  const many = Array.from({ length: 30 }, (_, i) => lead(String(i), ["A", String(i)], "VP", `m${i}.com`));
  const r = await leadsforgeTam({ token: "t", icp, countries: ["united states"], minTam: 25, meta: { customer: "anonymous" }, fetchImpl: treg([{ leads: few }, { leads: many }], seen) });
  assert.equal(seen.length, 2, "stopped at the first step with enough accounts");
  assert.equal(r.total, 30);
  assert.equal((r.filter.filters as LeadsforgeFilters).leadDepartments, undefined, "kept the relaxed filters");
  assert.equal(JSON.parse(String(seen[0].init.body)).maxContactsPerCompany, 1);
});

test("the research pipeline uses an injected TAM search and ranks Leadsforge industries", async () => {
  const rows = [
    { domain: "fit.com", name: "Fit", industry: "software development", employees: 150, country: "united states" },
    { domain: "meh.com", name: "Meh", industry: "construction", employees: 150, country: "united states" },
    { domain: "visitor.io", name: "Visitor" },
  ];
  const result = await runResearchPipeline({
    domain: "visitor.io",
    client: { searchShared: async () => { throw new Error("PDL must not be used for the TAM"); } },
    searchTam: async () => ({ rows, total: rows.length, filter: { source: "leadsforge", filters: {} }, saturated: true }),
    deriveIcp: async () => icp,
  });
  assert.deepEqual(result.tam.map((r) => r.domain), ["fit.com", "meh.com"], "own domain dropped, best fit first");
  assert.equal((result.filter as { saturated?: boolean }).saturated, true);
  assert.ok(icpToWeights(heuristicIcp("x.io"), defaultModel("scoring.fit")).industries?.["software development"], "heuristic ICPs weight Leadsforge names too");
});

test("when the external TAM search fails, the preview falls back to the PDL index", async () => {
  let pdlCalls = 0;
  const result = await runResearchPipeline({
    domain: "visitor.io",
    client: { searchShared: async () => { pdlCalls++; return { rows: [{ domain: "pdl.com", name: "Pdl", industry: "computer software" }], total: 1 }; } },
    searchTam: async () => { throw new TregRefusal(402, "route_max_cost", "free allowance used up", null); },
    deriveIcp: async () => icp,
  });
  assert.ok(pdlCalls > 0);
  assert.deepEqual(result.tam.map((r) => r.domain), ["pdl.com"]);
  assert.equal((result.filter as { source?: string }).source, undefined, "the session records a PDL TAM, so the import uses ICP filters");
});
