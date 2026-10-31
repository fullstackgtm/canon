import assert from "node:assert/strict";
import test from "node:test";
import { companyPatch, personPatch, profilePage, readCompany, readRoutedPerson, sameEmployer } from "../convex/lib/enrichProfile.ts";
import { locateQuote } from "../convex/lib/research/agentLoop.ts";

// Trimmed from real replies, 2026-10-13: treg people.enrich (Ocean.io) and companies.enrich (The Companies API).
const person = { output: { full_name: "Prerna Gupta", title: "Sales Operations Lead (Salesforce Admin)", company_domain: "caisoft.com", linkedin_url: "https://www.linkedin.com/in/prerna-gupta-7a410938", location: "Ahmedabad, Gujarat, India" },
  raw: { seniorities: ["Senior"], departments: ["Sales", "Engineering"],
    currentJobDescription: "Leading Sales Operations at Example Buyer Software.<br>Tools: Salesforce, HubSpot, NetSuite, GONG",
    experiences: [{ domain: "caisoft.com", jobTitle: "Sales Operations Lead (Salesforce Admin)", dateFrom: "2024-11" }] } };
const company = { output: { name: "Caisoft", domain: "caisoft.com", industry: "information-technology-and-services", description: "Example Buyer Software LLC is a business consulting and software development company.", employees: 420, founded: 1978, linkedin_url: "https://linkedin.com/company/caisoftware" },
  raw: { finances: { revenue: "50m-100m" }, locations: { headquarters: { city: { name: "Smithfield" }, state: { name: "Rhode Island" }, country: { name: "United States" } } },
    secondaries: { emailPatterns: [{ pattern: "[F1][L]", usagePercentage: 96.4 }] }, technologies: { active: ["hubspot", "wordpress"] }, analytics: { monthlyVisitors: "under-10k" } } };

test("a person's profile fills their empty fields, adds its columns, and becomes a page research can quote", () => {
  const p = readRoutedPerson(person)!;
  assert.equal(sameEmployer(p, "www.caisoft.com"), true);
  assert.deepEqual(personPatch(p, { title: "Salesforce Administrator", linkedinUrl: null }), {
    linkedinUrl: "https://www.linkedin.com/in/prerna-gupta-7a410938",
    "custom.seniority": "Senior",
    "custom.department": "Sales, Engineering",
    "custom.location": "Ahmedabad, Gujarat, India",
    "custom.in_role_since": "2024-11",
    "custom.about": "Leading Sales Operations at Example Buyer Software.\nTools: Salesforce, HubSpot, NetSuite, GONG",
  });
  const page = profilePage(p)!;
  assert.equal(page.url, "https://www.linkedin.com/in/prerna-gupta-7a410938");
  assert.ok(locateQuote("Tools: Salesforce, HubSpot, NetSuite, GONG", [page]));
  assert.equal(readRoutedPerson({ output: { full_name: null }, raw: null }), null);
});

test("a company's profile fills the account's empty fields and adds its columns", () => {
  assert.deepEqual(companyPatch(readCompany(company)!, { employees: 420, industry: null, country: "United States", linkedinUrl: null }), {
    industry: "information technology and services",
    linkedinUrl: "https://www.linkedin.com/company/caisoftware",
    "custom.description": "Example Buyer Software LLC is a business consulting and software development company.",
    "custom.hq_city": "Smithfield",
    "custom.founded": 1978,
    "custom.revenue_range": "50m-100m",
    "custom.tech_stack": "hubspot, wordpress",
    "custom.hq_state": "Rhode Island",
    "custom.email_pattern": "[F1][L]",
    "custom.web_traffic": "under-10k",
  });
});
