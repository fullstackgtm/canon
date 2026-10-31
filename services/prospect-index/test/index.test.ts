import { test } from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { BUILD_SQL } from "../src/sql.ts";
import { facets, lookupDomain, normalizeDomain, searchShared } from "../src/search.ts";

const fixture = new URL("./fixture.csv", import.meta.url).pathname;
async function built() {
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  for (const [, sql] of BUILD_SQL(`read_csv('${fixture}', header=true)`)) await conn.run(sql);
  return conn;
}

test("normalizes websites to bare domains and drops rows without a usable one", async () => {
  const c = await built();
  const r = await searchShared(c, {}, 50);
  assert.deepEqual(r.rows.map((x) => x.domain).sort(), ["acmeanalytics.com", "berlincode.de", "ibm.com", "shawatiinteriors.com"]);
  assert.equal(r.total, 4);
  assert.match(r.attribution, /People Data Labs/);
});

test("dedupes by domain, keeping the high-confidence row with a LinkedIn URL", async () => {
  const c = await built();
  const acme = await lookupDomain(c, "acmeanalytics.com");
  assert.equal(acme?.externalIds.pdl, "id1");
  assert.equal(acme?.employeeMin, 51);
  assert.equal(acme?.employees, 126);
});

test("flags websites that don't match the company name", async () => {
  const c = await built();
  assert.equal((await lookupDomain(c, "shawatiinteriors.com"))?.domainConfidence, "low");
  assert.equal((await lookupDomain(c, "ibm.com"))?.domainConfidence, "high"); // initials
  const strict = await searchShared(c, { minConfidence: "high" }, 50);
  assert.ok(!strict.rows.some((x) => x.domain === "shawatiinteriors.com"));
});

test("filters by industry, country, employee range, and excludes domains", async () => {
  const c = await built();
  const r = await searchShared(c, { industry: ["Computer Software"], country: ["united states"], employeeMin: 20, excludeDomains: ["https://www.ibm.com"] }, 50);
  assert.deepEqual(r.rows.map((x) => x.domain), ["acmeanalytics.com"]);
  const big = await searchShared(c, { employeeMin: 5000 }, 50);
  assert.deepEqual(big.rows.map((x) => x.domain), ["ibm.com"]);
});

test("lookupDomain falls back from subdomains and rejects junk", async () => {
  const c = await built();
  assert.equal((await lookupDomain(c, "https://app.acmeanalytics.com/login"))?.domain, "acmeanalytics.com");
  assert.equal(await lookupDomain(c, "not a domain"), null);
  assert.equal(normalizeDomain("HTTP://WWW.Example.COM/x"), "example.com");
});

test("q search is injection-safe and facets count values", async () => {
  const c = await built();
  const r = await searchShared(c, { q: "acme'; DROP TABLE companies; --" }, 10);
  assert.equal(r.total, 0);
  assert.equal((await searchShared(c, {}, 10)).total, 4);
  const f = await facets(c, "industry");
  assert.deepEqual(f.find((x) => x.value === "computer software")?.count, 2);
});
