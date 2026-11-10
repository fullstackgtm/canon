import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadPdl } from "../scripts/load-pdl.ts";
import { pdlPath } from "../src/pdl.ts";
import { startApp, tempDir } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/pdl_companies_sample.csv", import.meta.url));

describe("PDL company index", () => {
  it("loads the fixture with attribution and serves prospect search", async () => {
    const dataDir = tempDir("rs-pdl-");
    const r = await loadPdl(FIXTURE, dataDir, "fixture");
    assert.equal(r.rows, 6); // 8 rows - 1 without website - 1 duplicate domain

    const db = await DuckDBInstance.create(pdlPath(dataDir), { access_mode: "READ_ONLY" });
    const c = await db.connect();
    const attr = (await c.runAndReadAll(`SELECT license, notice, datasetVersion FROM attribution`)).getRowObjectsJS()[0];
    assert.equal(attr.license, "CC BY 4.0");
    assert.match(String(attr.notice), /People Data Labs/);
    c.closeSync();
    db.closeSync();

    const { app, client } = await startApp({ dataDir });
    try {
      const all = await client.call("POST", "/v1/shared/prospects/search", { limit: 50 });
      assert.equal(all.status, 200);
      assert.equal(all.json.total, 6);
      const piper = all.json.rows.find((x: any) => x.domain === "piedpiper.com");
      assert.equal(piper.name, "pied piper"); // the duplicate with a LinkedIn URL wins
      assert.equal(piper.linkedinUrl, "https://linkedin.com/company/pied-piper");
      assert.ok(all.json.rows.some((x: any) => x.domain === "globex.io"), "www. stripped");

      const sw = await client.call("POST", "/v1/shared/prospects/search", { filter: { industry: ["Computer Software"], country: ["united states"] } });
      assert.deepEqual(sw.json.rows.map((x: any) => x.domain).sort(), ["globex.io", "piedpiper.com"]);
      const big = await client.call("POST", "/v1/shared/prospects/search", { filter: { employeeMin: 5000 } });
      assert.deepEqual(big.json.rows.map((x: any) => x.domain).sort(), ["globex.io", "hooli.com", "umbrella-health.de"]);
      const q = await client.call("POST", "/v1/shared/prospects/search", { filter: { q: "hoo" } });
      assert.equal(q.json.total, 1);
      assert.equal((await client.call("POST", "/v1/shared/prospects/search", { limit: 1000 })).status, 400);

      // rank: same weights as /rescore; best fit first across the whole match set, with `fit` on rows.
      const rank = {
        base: 10,
        industries: { "computer software": 40, "machinery": 20 },
        countries: { "united kingdom": 30, "united states": 20 },
        employeeBands: [{ min: 201, max: 500, weight: 20 }, { min: 51, max: 200, weight: 10 }],
      };
      const ranked = await client.call("POST", "/v1/shared/prospects/search", { rank, limit: 3 });
      assert.equal(ranked.status, 200);
      // initech: 10 + 40 (software) + 30 (UK) + 20 (201-500) = 100
      assert.equal(ranked.json.rows[0].domain, "initech.co.uk");
      assert.equal(ranked.json.rows[0].fit, 100);
      const fits = ranked.json.rows.map((x: any) => x.fit);
      assert.deepEqual([...fits].sort((a: number, b: number) => b - a), fits, "sorted by fit desc");
      assert.equal(ranked.json.total, 6, "total is unaffected by ranking");
      // No company_tags in this index: the archetype filter is refused, never ignored.
      const noTags = await client.call("POST", "/v1/shared/prospects/search", { filter: { archetype: ["software_tech/b2b_saas"] } });
      assert.equal(noTags.status, 422);
      const unranked = await client.call("POST", "/v1/shared/prospects/search", { limit: 3 });
      assert.ok(unranked.json.rows.every((x: any) => x.fit === undefined), "no fit without rank");

      // 1.19.0 market sizes: grouped on the same keys workspace facets use (canonical industries, regions, size bands).
      const facet = async (body: unknown) => {
        const r = await client.call("POST", "/v1/shared/prospects/facets", body);
        assert.equal(r.status, 200);
        return Object.fromEntries(r.json.groups.map((g: any) => [g.key, g.count]));
      };
      assert.deepEqual(await facet({ groupBy: "industry" }), {
        "software development": 3, "industrial machinery manufacturing": 1, "hospitals and health care": 1, "technology, information and internet": 1,
      });
      assert.deepEqual(await facet({ groupBy: "region", filter: { industry: ["software development"] } }), { "north-america": 2, europe: 1 });
      assert.deepEqual(await facet({ groupBy: "sizeBand", filter: { region: ["europe"] } }), { "201-500": 1, "10001+": 1 });
      assert.equal((await client.call("POST", "/v1/shared/prospects/search", { filter: { sizeBand: ["11-50"] } })).json.total, 1);

      // 1.46.0 lookup: full detail per known domain, normalized like the index; unknown domains are absent.
      const lookup = await client.call("POST", "/v1/shared/prospects/lookup", { domains: ["https://www.Globex.io/about", "acmerobotics.com", "nope.example"] });
      assert.equal(lookup.status, 200);
      const byDomain = Object.fromEntries(lookup.json.rows.map((x: any) => [x.domain, x]));
      assert.deepEqual(Object.keys(byDomain).sort(), ["acmerobotics.com", "globex.io"]);
      assert.equal(byDomain["acmerobotics.com"].locality, "boston");
      assert.equal(byDomain["acmerobotics.com"].region, "massachusetts");
      assert.equal(byDomain["acmerobotics.com"].founded, 2015);
      assert.equal(byDomain["acmerobotics.com"].sizeBand, "51-200");
      assert.equal(byDomain["acmerobotics.com"].employeesMax, 200);
      assert.equal(byDomain["acmerobotics.com"].domainConfidence, "high");
      assert.equal((await client.call("POST", "/v1/shared/prospects/lookup", { domains: [] })).status, 400);
    } finally {
      await app.shutdown();
    }
  });

  it("filters by business type from company_tags, above a confidence floor", async () => {
    const dataDir = tempDir("rs-pdl-tags-");
    await loadPdl(FIXTURE, dataDir, "fixture");
    const db = await DuckDBInstance.create(pdlPath(dataDir));
    const c = await db.connect();
    await c.run(`CREATE TABLE company_tags (domain VARCHAR, archetype VARCHAR, p DOUBLE, source VARCHAR, version VARCHAR, tagged_at TIMESTAMP)`);
    await c.run(`INSERT INTO company_tags VALUES
      ('globex.io', 'software_tech/b2b_saas', 0.9, 'jev', 'v', now()),
      ('hooli.com', 'software_tech/b2b_saas', 0.5, 'model', 'v', now()),
      ('piedpiper.com', 'software_tech/b2b_saas', 0.1, 'model', 'v', now()),
      ('initech.co.uk', 'professional_services/management_consulting', 0.8, 'jev_top4', 'v', now())`);
    c.closeSync();
    db.closeSync();
    const { app, client } = await startApp({ dataDir });
    try {
      const saas = await client.call("POST", "/v1/shared/prospects/search", { filter: { archetype: ["software_tech/b2b_saas"] } });
      assert.equal(saas.status, 200);
      assert.deepEqual(saas.json.rows.map((x: any) => x.domain).sort(), ["globex.io", "hooli.com"], "piedpiper's 0.1 tag is below the default floor");
      const loose = await client.call("POST", "/v1/shared/prospects/search", { filter: { archetype: ["software_tech/b2b_saas"], minArchetypeP: 0 } });
      assert.equal(loose.json.total, 3);
      const two = await client.call("POST", "/v1/shared/prospects/search", { filter: { archetype: ["software_tech/b2b_saas", "professional_services/management_consulting"], minArchetypeP: 0.7 } });
      assert.deepEqual(two.json.rows.map((x: any) => x.domain).sort(), ["globex.io", "initech.co.uk"]);
    } finally {
      await app.shutdown();
    }
  });
});
