import assert from "node:assert/strict";
import test from "node:test";
import { companyPatch, personPatch, profilePage, readCompany, readRoutedPerson, sameEmployer } from "../convex/lib/enrichProfile.ts";
import { locateQuote } from "../convex/lib/research/agentLoop.ts";

// Shaped like real replies, 2026-10-13, with fictional values: treg people.enrich (Ocean.io) and companies.enrich (The Companies API).
const person = { output: { full_name: "Jordan Lee", title: "Sales Operations Lead (Salesforce Admin)", company_domain: "buyer.example", linkedin_url: "https://www.linkedin.com/in/jordan-lee-example", location: "Austin, Texas, United States" },
  raw: { seniorities: ["Senior"], departments: ["Sales", "Engineering"],
    currentJobDescription: "Leading Sales Operations at Example Buyer Software.<br>Tools: Salesforce, HubSpot, NetSuite, GONG",
    experiences: [{ domain: "buyer.example", jobTitle: "Sales Operations Lead (Salesforce Admin)", dateFrom: "2024-11" }] } };
const company = { output: { name: "Example Buyer", domain: "buyer.example", industry: "information-technology-and-services", description: "Example Buyer Software LLC is a business consulting and software development company.", employees: 420, founded: 1990, linkedin_url: "https://linkedin.com/company/example-buyer" },
  raw: { finances: { revenue: "50m-100m" }, locations: { headquarters: { city: { name: "Springfield" }, state: { name: "Illinois" }, country: { name: "United States" } } },
    secondaries: { emailPatterns: [{ pattern: "[F1][L]", usagePercentage: 96.4 }] }, technologies: { active: ["hubspot", "wordpress"] }, analytics: { monthlyVisitors: "under-10k" } } };

test("a person's profile fills their empty fields, adds its columns, and becomes a page research can quote", () => {
  const p = readRoutedPerson(person)!;
  assert.equal(sameEmployer(p, "www.buyer.example"), true);
  assert.deepEqual(personPatch(p, { title: "Salesforce Administrator", linkedinUrl: null }), {
    linkedinUrl: "https://www.linkedin.com/in/jordan-lee-example",
    "custom.seniority": "Senior",
    "custom.department": "Sales, Engineering",
    "custom.location": "Austin, Texas, United States",
    "custom.in_role_since": "2024-11",
    "custom.about": "Leading Sales Operations at Example Buyer Software.\nTools: Salesforce, HubSpot, NetSuite, GONG",
  });
  const page = profilePage(p)!;
  assert.equal(page.url, "https://www.linkedin.com/in/jordan-lee-example");
  assert.ok(locateQuote("Tools: Salesforce, HubSpot, NetSuite, GONG", [page]));
  assert.equal(readRoutedPerson({ output: { full_name: null }, raw: null }), null);
});

test("a company's profile fills the account's empty fields and adds its columns", () => {
  assert.deepEqual(companyPatch(readCompany(company)!, { employees: 420, industry: null, country: "United States", linkedinUrl: null }), {
    industry: "information technology and services",
    linkedinUrl: "https://www.linkedin.com/company/example-buyer",
    "custom.description": "Example Buyer Software LLC is a business consulting and software development company.",
    "custom.hq_city": "Springfield",
    "custom.founded": 1990,
    "custom.revenue_range": "50m-100m",
    "custom.tech_stack": "hubspot, wordpress",
    "custom.hq_state": "Illinois",
    "custom.email_pattern": "[F1][L]",
    "custom.web_traffic": "under-10k",
  });
});
