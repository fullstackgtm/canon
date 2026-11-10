import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageReport, estimateRevenue, fillPlan, fillsFor, indexMatch, industryOption, mergeReports, namesAgree, planFills, rootDomainCandidates, sourceValues,
  type HubspotCompany, type Match,
} from "../convex/lib/enrich/freeFill.ts";
import type { SharedCompanyDetail } from "../convex/lib/recordContract.ts";
import { createFakeRecordClient, createMemoryRecordStore, pdlSampleDetails } from "../convex/lib/recordClient.ts";

const OPTIONS = [
  { label: "Computer Software", value: "COMPUTER_SOFTWARE" },
  { label: "Hospital & Health Care", value: "HOSPITAL_HEALTH_CARE" },
];
const row = (over: Partial<SharedCompanyDetail> = {}): SharedCompanyDetail => ({
  domain: "acme.io", name: "acme", industry: "computer software", country: "united states", region: "new york", locality: "new york",
  linkedinUrl: "linkedin.com/company/acme", founded: 2015, sizeBand: "51-200", employeesMin: 51, employeesMax: 200, domainConfidence: "high", ...over,
});
const company = (id: string, properties: HubspotCompany["properties"]): HubspotCompany => ({ id, properties });
const pdl = (r: SharedCompanyDetail, via: Match["via"] = "domain"): Match => ({ row: r, source: "pdl", via, domain: r.domain });

test("fills only blanks, from the portal's own industry options", () => {
  const { fills } = fillsFor(company("1", { name: "Acme", domain: "https://www.acme.io/", city: "Brooklyn", industry: "" }), pdl(row()), OPTIONS);
  const by = Object.fromEntries(fills.map((f) => [f.property, f]));
  assert.equal(by.city, undefined, "a typed value is never overwritten");
  assert.equal(by.industry.value, "COMPUTER_SOFTWARE");
  assert.equal(by.industry.before, "", "compare-and-set on the blank the read saw");
  assert.equal(by.numberofemployees.value, "51");
  assert.equal(by.state.value, "New York");
  assert.equal(by.country.value, "United States");
  assert.equal(by.linkedin_company_page.value, "https://www.linkedin.com/company/acme");
  assert.equal(by.founded_year.value, "2015");
  assert.equal(by.annualrevenue.source, "estimate");
  assert.equal(industryOption("hospital & health care", OPTIONS)?.value, "HOSPITAL_HEALTH_CARE");
  assert.equal(industryOption("machinery", OPTIONS), null, "no portal option: left blank, not guessed");
});

test("industries map across LinkedIn's old and 2022 lists", () => {
  // A 2022-list portal option for PDL's old "computer software".
  assert.equal(industryOption("computer software", [{ label: "Software Development", value: "SOFTWARE_DEVELOPMENT" }])?.value, "SOFTWARE_DEVELOPMENT");
});

test("names agree on the company, not on noise", () => {
  assert.ok(namesAgree("Acme Robotics, Inc.", "acme robotics"));
  assert.ok(namesAgree("HoneyBook", "honeybook inc"));
  assert.ok(namesAgree("Acme", "Acme Robotics"));
  assert.ok(!namesAgree("Calanar", "shawati interiors"));
  assert.ok(!namesAgree("AB Group", "AB Holdings"), "nothing distinctive left to compare");
});

test("root domains: subdomains and country-code sites", () => {
  assert.deepEqual(rootDomainCandidates("shop.acme.com"), ["acme.com"]);
  assert.deepEqual(rootDomainCandidates("acme.co.uk"), ["acme.com"]);
  assert.deepEqual(rootDomainCandidates("eu.acme.co.uk").sort(), ["acme.co.uk", "acme.com"]);
  assert.deepEqual(rootDomainCandidates("acme.com"), []);
});

test("index match: exact, low confidence confirmed by name, root domain, or why not", () => {
  const index = new Map([
    ["acme.io", row()],
    ["globex.com", row({ domain: "globex.com", name: "globex", domainConfidence: "low" })],
    ["initech.com", row({ domain: "initech.com", name: "initech" })],
    ["hooli.com", row({ domain: "hooli.com", name: "something else", domainConfidence: "low" })],
  ]);
  const via = (c: HubspotCompany) => { const m = indexMatch(c, index); return "gap" in m ? m.gap : m.via; };
  assert.equal(via(company("1", { name: "Acme", domain: "acme.io" })), "domain");
  assert.equal(via(company("2", { name: "Globex Corp", domain: "globex.com" })), "name");
  assert.equal(via(company("3", { name: "Initech", domain: "initech.co.uk" })), "root");
  assert.equal(via(company("4", { name: "Initrode", domain: "shop.initech.com" })), "notFound", "root match needs agreeing names");
  assert.equal(via(company("5", { name: "Hooli", domain: "hooli.com" })), "namesDisagree");
  assert.equal(via(company("6", { name: "Nowhere" })), "noDomain");
});

test("SEC revenue wins over an estimate; a name lookup also fills the domain", () => {
  const sec = fillsFor(company("2", { domain: "hubspot.com" }), pdl(row({ domain: "hubspot.com" })), OPTIONS).fills.find((f) => f.property === "annualrevenue");
  assert.equal(sec?.source, "sec");
  assert.ok(Number(sec?.value) > 1e9);
  const { fills } = fillsFor(company("3", { name: "Acme" }), pdl(row(), "lookup"), OPTIONS);
  assert.equal(fills.find((f) => f.property === "domain")?.value, "acme.io");
});

test("estimate scales with size and rounds to two significant figures", () => {
  const small = estimateRevenue("computer software", 11, 50)!;
  const big = estimateRevenue("computer software", 1001, 5000)!;
  assert.ok(big > small * 50);
  assert.equal(String(small).replace(/0+$/, "").length <= 2, true);
  assert.equal(estimateRevenue(undefined, undefined, undefined), null);
});

test("coverage report counts matches, gaps and source-empty blanks; plan", () => {
  const companies = [
    company("1", { name: "Acme", domain: "acme.io", industry: "COMPUTER_SOFTWARE" }),
    company("2", { name: "No domain" }),
    company("3", { name: "Unknown", domain: "unknown.example" }),
  ];
  const { report, fills } = coverageReport(companies, new Map([["1", pdl(row({ founded: undefined }))]]), OPTIONS, new Map([["3", "notFound" as const]]));
  assert.equal(report.companies, 3);
  assert.equal(report.withoutDomain, 1);
  assert.equal(report.matched, 1);
  assert.deepEqual(report.gaps, { noDomain: 1, notFound: 1 });
  const industry = report.fields.find((f) => f.property === "industry")!;
  assert.deepEqual([industry.filled, industry.fillable], [1, 0]);
  assert.equal(report.fields.find((f) => f.property === "founded_year")!.sourceEmpty, 1);
  assert.equal(report.fillableCells, fills.length);
  const plan = fillPlan(fills, new Date("2026-10-28T00:00:00Z"));
  assert.equal(plan.operations.length, fills.length);
  assert.ok(plan.operations.every((op) => op.operation === "set_field" && op.objectType === "account" && op.approvalRequired));
  assert.equal(plan.operations.find((op) => op.field === "annualrevenue")?.riskLevel, "medium");
});

test("fake record client looks up the synthetic index by normalized domain", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore() });
  const known = pdlSampleDetails()[0];
  const rows = await client.lookupShared([`https://www.${known.domain}/x`, "nope.example"]);
  assert.deepEqual(rows.map((r) => r.domain), [known.domain]);
});

test("chunk reports merge into the whole portal's report", () => {
  const a = coverageReport([company("1", { domain: "acme.io" })], new Map([["1", pdl(row())]]), OPTIONS).report;
  const b = coverageReport([company("2", { domain: "beta.io", city: "Austin" }), company("3", {})], new Map([["2", pdl(row({ domain: "beta.io" }), "root")]]), OPTIONS).report;
  const m = mergeReports(mergeReports(null, a), b);
  assert.equal(m.companies, 3);
  assert.equal(m.withoutDomain, 1);
  assert.equal(m.matched, 2);
  assert.deepEqual(m.matchedVia, { domain: 1, root: 1 });
  assert.deepEqual(m.gaps, { noDomain: 1 });
  assert.equal(m.fillableCells, a.fillableCells + b.fillableCells);
  const city = m.fields.find((f) => f.property === "city")!;
  assert.deepEqual([city.filled, city.fillable], [1, 1]);
});

test("a plan leaves a property a Canon field owns to it, and keeps the source's raw values for consolidation", () => {
  const match = pdl(row());
  const { fills } = fillsFor(company("1", { name: "Acme", domain: "acme.io" }), match, OPTIONS);
  const planned = planFills(fills, { includeEstimates: false, owned: new Set(["industry"]) });
  assert.deepEqual(planned.map((f) => f.property), ["numberofemployees", "city", "state", "country", "linkedin_company_page", "founded_year"]);
  assert.deepEqual(sourceValues(match), {
    industry: "computer software", numberofemployees: 51, city: "New York", state: "New York", country: "United States",
    linkedin_company_page: "https://www.linkedin.com/company/acme", founded_year: 2015,
  });
});

test("a name lookup proposes only the domain, for review, and only for distinctive names", async () => {
  const { distinctiveName } = await import("../convex/lib/enrich/freeFill.ts");
  const { fills } = fillsFor(company("3", { name: "Acme Robotics" }), pdl(row(), "lookup"), OPTIONS);
  assert.deepEqual(fills.map((f) => f.property), ["domain"]);
  assert.equal(fillPlan(fills, new Date()).operations[0]!.riskLevel, "medium");
  assert.ok(distinctiveName("Acme Robotics"));
  assert.ok(distinctiveName("Salesforce"));
  assert.ok(!distinctiveName("Hooli"));
  assert.ok(!distinctiveName("AB Inc"));
});
