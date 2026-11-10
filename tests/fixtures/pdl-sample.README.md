# pdl-sample.json — SYNTHETIC FIXTURE

3,000 **synthetic** companies in the field shape of the People Data Labs free
company dataset (`id, name, website, size, founded, industry, locality,
region, country, linkedin_url`). Every website uses the reserved `.example`
TLD and every LinkedIn slug ends in `-fixture`; none of these are real firms.

It stands in for the real PDL index (CC BY 4.0, downloaded manually from
peopledatalabs.com/company-dataset) until the record service's shared
`pdl_companies.duckdb` is loaded. It is produced by `generatePdlSample()` in
`convex/lib/recordClient.ts` (deterministic seed), and
`tests/crmRecordClient.test.ts` asserts the two stay identical. Regenerate with:

    node --experimental-strip-types -e 'import("./convex/lib/recordClient.ts").then(m=>require("fs").writeFileSync("tests/fixtures/pdl-sample.json", JSON.stringify(m.generatePdlSample()).replace(/\},\{/g,"},\n{")+"\n"))'
