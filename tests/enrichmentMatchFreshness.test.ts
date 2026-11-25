import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
for (const name of ["secRevenue", "revenueCalibration"]) {
  const json = require(`../convex/lib/enrich/${name}.v1.json`);
  Object.defineProperty(json, "default", { value: json, configurable: true });
}
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("consolidation ignores old-domain enrichment but accepts normalized current domains", async () => {
  let domain = "new.example";
  const db = memoryDb({ enrichmentMatches: [{ _id: "match", orgId: "org", recordId: "1", domain: "old.example", source: "pdl", values: { industry: "Retail" } }] });
  const loaded = loadConvex(["fieldConsolidationActions.ts", "enrichmentMatches.ts"], {
    "enrichFreeFill.ts": (r) => ({ ...r, hubspot: async () => async (path: string) => path.endsWith("/search") ? { total: 1 } : { results: [{ id: "1", properties: { domain } }] } }),
  }, { URLSearchParams });
  let profile: any;
  const ctx = {
    runQuery: async (ref: unknown, args: any) => String(ref).endsWith("forRecords") ? loaded["enrichmentMatches.ts"].forRecords.handler({ db }, args) : { doc: { orgId: "org", columns: [{ object: "companies", name: "@pdl.industry" }] } },
    runMutation: async (ref: unknown, args: any) => { assert.ok(String(ref).endsWith("saveProfile")); profile = args.profile; },
  };
  await loaded["fieldConsolidationActions.ts"].profileObject.handler(ctx, { id: "profile", object: "companies" });
  assert.equal(profile.columns["@pdl.industry"].filled, 0);
  domain = "https://www.old.example/";
  await loaded["fieldConsolidationActions.ts"].profileObject.handler(ctx, { id: "profile", object: "companies" });
  assert.equal(profile.columns["@pdl.industry"].filled, 1);
});

test("a coverage check with no match clears a record's cached enrichment", async () => {
  const db = memoryDb({ enrichmentMatches: [{ _id: "match", orgId: "org", recordId: "1", domain: "old.example", source: "pdl", values: {} }] });
  let indexFails = true;
  const loaded = loadConvex(["enrichFreeFill.ts", "enrichmentMatches.ts"], {
    "records.ts": (r) => ({ ...r, clientFor: () => ({ mode: "memory", lookupShared: async () => { if (indexFails) throw new Error("Unavailable"); return []; } }) }),
    "lib/providers/treg.ts": (r) => ({ ...r, tregKey: () => undefined }),
    "hubspotActions.ts": (r) => ({ ...r, accessTokenForOrg: async () => ({ accessToken: "fixture" }) }),
  }, { fetch: async () => new Response(JSON.stringify({ results: [] })) });
  const ctx = {
    runQuery: async () => true,
    runMutation: async (ref: unknown, args: any) => {
      if (String(ref).endsWith("upsert")) return loaded["enrichmentMatches.ts"].upsert.handler({ db }, args);
      assert.ok(String(ref).endsWith("chunkMatched"));
    },
  };
  await loaded["enrichFreeFill.ts"].matchChunk.handler(ctx, { orgId: "org", runKey: "run", companies: [{ id: "1", properties: { domain: "old.example" } }] });
  assert.equal(db.rows("enrichmentMatches").length, 1);
  indexFails = false;
  await loaded["enrichFreeFill.ts"].matchChunk.handler(ctx, { orgId: "org", runKey: "run", companies: [{ id: "1", properties: { domain: "new.example" } }] });
  assert.equal(db.rows("enrichmentMatches").length, 0);
});
