import assert from "node:assert/strict";
import test from "node:test";
import { accountQueries, DOMAINS_PER_SEARCH, marketIsNarrow, marketQueries, parseAccountList } from "../convex/lib/addRecords.ts";
import { splitFilters } from "../convex/lib/leadsforge.ts";

test("parseAccountList: domains, URLs and names, deduplicated, junk reported", () => {
  const { accounts, invalid } = parseAccountList("acme.com\nhttps://www.Globex.com/about, Globex Corp\nacme.com, Acme Inc\nnot a domain\n\n");
  assert.deepEqual(accounts, [{ domain: "acme.com", name: "Acme Inc" }, { domain: "globex.com", name: "Globex Corp" }]);
  assert.deepEqual(invalid, ["not a domain"]);
});

test("parseAccountList: a CSV header picks the domain and name columns", () => {
  const { accounts } = parseAccountList('Account Name,Website,Owner\n"Initech, LLC",initech.com,Bill\nUmbrella,umbrella.io,Ann');
  assert.deepEqual(accounts, [{ domain: "initech.com", name: "Initech, LLC" }, { domain: "umbrella.io", name: "Umbrella" }]);
});

test("accountQueries: one search pair per chunk of domains, persona filters only", () => {
  const domains = Array.from({ length: DOMAINS_PER_SEARCH + 1 }, (_, i) => `co${i}.com`);
  const qs = accountQueries(domains, { levels: ["vp"], departments: ["Sales"], titles: [] });
  assert.equal(qs.length, 2);
  assert.equal(qs[1].leadsforge.companyDomains?.include.length, 1);
  assert.deepEqual(qs[0].leadsforge.leadSeniorities, { include: ["vp"] });
  assert.equal(qs[0].leadsforge.companyIndustries, undefined);
  assert.deepEqual(qs[1].quickenrich.company_url, { include: ["co100.com"], exclude: [] });
});

test("a saturated search for named companies halves its domain list first", () => {
  const split = splitFilters({ companyDomains: { include: ["a.com", "b.com", "c.com"] }, leadSeniorities: { include: ["vp", "director"] } });
  assert.deepEqual(split?.map((f) => f.companyDomains?.include), [["a.com", "b.com"], ["c.com"]]);
});

test("a market search needs a firmographic filter and maps to both sources", () => {
  assert.equal(marketIsNarrow({ industries: [], countries: [], employeeBands: [] }), false);
  const q = marketQueries({ industries: ["computer games"], countries: ["ie"], employeeBands: ["11-50"] }, { levels: [], departments: [], titles: [] });
  assert.deepEqual(q.leadsforge.companyIndustries, { include: ["computer games"] });
  assert.deepEqual(q.leadsforge.companyLocations, { include: ["Ireland"] });
  assert.deepEqual(q.quickenrich.country_code, { include: ["IE"], exclude: [] });
});

test("buyer location narrows people by where they are, apart from where the company is", () => {
  const persona = { levels: [], departments: [], titles: [], countries: ["us"] };
  const q = marketQueries({ industries: ["software development"], countries: ["us"], employeeBands: [] }, persona);
  // QuickEnrich's country_code is the company's HQ; locality is the person's.
  assert.deepEqual(q.quickenrich.country_code, { include: ["US"], exclude: [] });
  assert.deepEqual(q.quickenrich.locality, { include: ["United States"], exclude: [] });
  assert.deepEqual(q.leadsforge.leadLocations, { include: ["United States"] });
  // Named companies keep it too, and survive Leadsforge's splitting.
  const [named] = accountQueries(["a.com", "b.com"], persona);
  assert.deepEqual(named.quickenrich.locality, { include: ["United States"], exclude: [] });
  assert.ok(splitFilters(named.leadsforge)!.every((f) => f.leadLocations?.include[0] === "United States"));
  assert.equal(marketQueries({ countries: ["us"] }, { levels: [], departments: [], titles: [] }).quickenrich.locality, undefined);
});
