import assert from "node:assert/strict";
import test from "node:test";
import { challengeIcp, CRM_SOURCE, proposalFilters, proposalQuickEnrich, type ChallengeContext } from "../convex/lib/tam/challengeIcp.ts";
import type { FetchedPage } from "../convex/lib/research/agentLoop.ts";

const context: ChallengeContext = {
  vendorDomain: "commissionly.example",
  sells: ["calculate sales commissions"],
  wonDeals: [{ name: "Acme renewal", account: "Acme Supply", industry: "wholesale", employees: 240 }],
  lostDeals: [],
  bestAccounts: [],
  decided: [{ name: "Staffing firms", industries: ["staffing and recruiting"], state: "dismissed", reason: "too small" }],
};
// What the current ICP searches: software companies, 50-500 people, buyers at VP level.
const icp = { companyIndustries: { include: ["software development"] }, companyEmployeeNumberRange: { min: 50, max: 500 }, leadSeniorities: { include: ["vp"] } };

const page = (url: string, text: string): FetchedPage => ({ url, text, links: [] });
const pages: Record<string, FetchedPage> = {
  "https://commissionly.example/": page("https://commissionly.example/", "Commissionly calculates sales commissions for teams that pay on quota attainment."),
  "https://trade.example/dealers": page("https://trade.example/dealers", "Most franchise auto dealers pay salespeople a commission on every vehicle sold."),
};

test("challenge keeps only verbatim quotes, drops markets inside the ICP, and cites fetched pages", async () => {
  const calls: string[] = [];
  const out = await challengeIcp(context, icp, {
    fetchPage: async (url) => pages[url] ?? null,
    call: async (_prompt, tool) => {
      calls.push(tool);
      if (tool === "cite_pages") {
        return { claims: [
          { proposal: 0, text: "Dealers pay on commission", quote: "Most franchise auto dealers pay salespeople a commission on every vehicle sold.", sourceUrl: "https://trade.example/dealers" },
          { proposal: 0, text: "Dealers are growing", quote: "Dealer revenue grew 40% last year.", sourceUrl: "https://trade.example/dealers" },
        ] };
      }
      return { proposals: [
        { name: "Auto dealerships", rationale: "They pay commissions.", industries: ["retail", "not a real industry"], risks: ["Long sales cycle"],
          claims: [
            { text: "We calculate commissions", quote: "calculates sales commissions for teams", sourceUrl: "https://commissionly.example/" },
            { text: "Dealers love software", quote: "Dealers love software more than anyone", sourceUrl: "https://commissionly.example/" },
          ], readUrls: ["https://trade.example/dealers", "https://missing.example/"] },
        { name: "More software", rationale: "Same market.", industries: ["software development"], claims: [] },
        { name: "Staffing firms again", rationale: "Dismissed before.", industries: ["staffing and recruiting"], claims: [] },
        { name: "Made up", rationale: "Bad industry.", industries: ["space tourism"], claims: [] },
      ] };
    },
  });
  assert.deepEqual(calls, ["challenge_icp", "cite_pages"]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].industries, ["retail"]);
  const claims = out[0].claims;
  // Verbatim in the company's own page: kept and sourced. Invented: a hypothesis (no quote).
  assert.equal(claims[0].sourceUrl, "https://commissionly.example/");
  assert.equal(claims[1].quote, undefined);
  // Unsupported cited claims remain hypotheses instead of disappearing.
  assert.equal(claims.length, 4);
  assert.deepEqual(claims[3], { text: "Dealers are growing" });
  assert.equal(claims[2].sourceUrl, "https://trade.example/dealers");
  assert.notEqual(claims[0].sourceUrl, CRM_SOURCE);
});

test("an accepted market searches its own industries with the ICP's buyers and geography", () => {
  const f = proposalFilters({ industries: ["retail"], employeeMin: 10, countries: [] }, { ...icp, companyLocations: { include: ["United States"] } });
  assert.deepEqual(f, {
    companyIndustries: { include: ["retail"] },
    companyLocations: { include: ["United States"] },
    companyEmployeeNumberRange: { min: 10 },
    leadSeniorities: { include: ["vp"] },
  });
});

test("an accepted market fills from QuickEnrich: its industries, size and countries over the ICP's buyers", () => {
  const q = proposalQuickEnrich({ industries: ["retail"], employeeMin: 51, employeeMax: 200, countries: ["United States"] }, {
    name: "icp", firmographics: { geos: ["gb"], employeeBands: ["1-10"] }, persona: { titleKeywords: ["Head of Ecommerce"] },
  });
  assert.deepEqual(q.country_code?.include, ["US"]);
  assert.ok(q.title?.include.includes("Head of Ecommerce"));
  assert.ok(q.industry_linkedin?.include.length, "the market's industry maps to QuickEnrich's");
  assert.ok(q.number_of_employees?.include.length, "the market's size, not the ICP's");
});
