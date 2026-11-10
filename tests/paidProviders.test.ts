import assert from "node:assert/strict";
import test from "node:test";
import { acceptable, onTarget, paidProvider } from "../convex/lib/paidProviders.ts";

const market = { industries: ["software development"], employeeBands: ["51-200"], countries: ["us"] };
const persona = { levels: ["vp"], departments: ["Sales"], titles: [] };

test("each paid source's rows read into one shape; the bar wants a full last name, a LinkedIn URL and a domain", () => {
  const icy = paidProvider("icypeas")!.rows({ leads: [
    { firstname: "Brad", lastname: "Justus", profileUrl: "https://www.linkedin.com/in/bradmjustus", lastJobTitle: "VP of Sales", lastCompanyName: "CodaMetrix", lastCompanyWebsite: "http://www.codametrix.com" },
    { firstname: "Tomi", lastname: "P.", profileUrl: "https://www.linkedin.com/in/tomi", lastCompanyWebsite: "tempo.io" },
  ] });
  assert.deepEqual(icy[0], { firstName: "Brad", lastName: "Justus", title: "VP of Sales", linkedinUrl: "https://www.linkedin.com/in/bradmjustus", companyName: "CodaMetrix", companyDomain: "codametrix.com" });
  assert.deepEqual(icy.map(acceptable), [true, false], "an abbreviated last name fails");
  const pro = paidProvider("prospeo")!.rows({ results: [{ person: { first_name: "Justus", last_name: "Jaramillo", linkedin_url: "https://www.linkedin.com/in/jj", current_job_title: "VP of Sales" }, company: { name: "Acme", domain: "acme.com" } }] });
  assert.equal(acceptable(pro[0]), true);
  const body = paidProvider("prospeo")!.body(market, persona, 25) as { filters: { company_headcount_range?: string[] } };
  assert.deepEqual(body.filters.company_headcount_range, ["51-100", "101-200"], "company size reaches Prospeo");
  const crust = paidProvider("crustdata")!.rows({ profiles: [{
    basic_profile: { name: "Peter Lawley", current_title: "VP of Sales" },
    social_handles: { professional_network_identifier: { profile_url: "https://www.linkedin.com/in/peterlawley" } },
    experience: { employment_details: { current: [{ name: "Tomorrow's Office", company_website: "" }] } },
  }] });
  assert.equal(acceptable(crust[0]), false, "no company domain fails");
});

test("on target: a persona title phrase's words all appear in the person's title", () => {
  const person = (title: string) => ({ firstName: "A", lastName: "Bee", title });
  assert.equal(onTarget(person("VP of Sales"), market, persona), true);
  assert.equal(onTarget(person("Vice President, Sales and Business Development"), market, persona), true);
  assert.equal(onTarget(person("Sales Development Representative"), market, persona), false);
});

test("a run pages through each source: its total and the next page's cursor", () => {
  assert.deepEqual(paidProvider("icypeas")!.page({ total: 303, leads: [{}], pagination: { token: "t2" } }), { total: 303, next: "t2" });
  assert.deepEqual(paidProvider("icypeas")!.page({ total: 303, leads: [], pagination: { token: "t9" } }), { total: 303, next: null }, "an empty page ends the run");
  assert.deepEqual(paidProvider("prospeo")!.page({ pagination: { current_page: 1, total_page: 48, total_count: 1198 } }), { total: 1198, next: "2" });
  assert.equal(paidProvider("prospeo")!.page({ pagination: { current_page: 48, total_page: 48, total_count: 1198 } }).next, null);
  assert.deepEqual(paidProvider("crustdata")!.page({ profiles: [{}], next_cursor: "c2", total_count: 166325417 }), { total: null, next: "c2" }, "a ranked search's total is not a market size");
  assert.equal((paidProvider("prospeo")!.body(market, persona, 25, "7") as { page: number }).page, 7);
});
