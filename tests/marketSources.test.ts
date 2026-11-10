import assert from "node:assert/strict";
import test from "node:test";
import { searchMarketSources, rankSources, type SourceSearchDeps, type SourceFacts, type SourceMatch } from "../convex/lib/tam/marketSources.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const handlers = loadConvex(["marketSources.ts"], {
  "records.ts": (real) => ({ ...real,
    requireCaller: async (ctx: { caller: unknown }) => ctx.caller,
    callerClient: (ctx: { client: unknown }) => ctx.client,
  }),
  "lib/treg.ts": (real) => ({ ...real, paidCallsAllowed: () => true }),
})["marketSources.ts"];

const now = 1793310000000;
const seeds = [{ domain: "acme.com", name: "Acme" }, { domain: "beta.com", name: "Beta" }];
const facts: SourceFacts = { key: "https://builders.org/members", url: "https://builders.org/members", title: "Builders", kind: "association", markets: ["construction"], listedCount: 240, filterable: true, exportable: false };
function fixture(extra: Partial<SourceSearchDeps> = {}) {
  const kept: { source: SourceFacts; match: SourceMatch }[] = [];
  const deps: SourceSearchDeps = { paid: true, now, serp: async () => [], cached: async () => null,
    fetchPage: async (url) => ({ text: "<p>Members include Acme and Beta.</p>", finalUrl: url }),
    model: async () => ({ ...facts, listsCompanies: true }),
    keep: async (source, match) => { kept.push({ source, match }); }, ...extra,
  };
  return { kept, deps };
}

test("searches each seed using the exact reverse-directory operators", async () => {
  const queries: string[] = [];
  const { deps } = fixture({ serp: async (query) => { queries.push(query); return []; } });
  assert.deepEqual(await searchMarketSources([seeds[0]], deps), { status: "done" });
  assert.deepEqual(queries, [
    '"Acme" -site:acme.com',
    '"acme.com" -site:acme.com',
    '"Acme" (directory OR "member list" OR "vendor list" OR "contractor list")',
  ]);
});

test("keeps page evidence only with a verbatim mention, reuses metadata, and skips prohibited hosts", async () => {
  const fetched: string[] = [], modeled: string[] = [];
  const rows = ["https://builders.org/members?sort=name#top", "https://other.org/list", "https://acme.com/list", "https://www.linkedin.com/company/acme", "https://google.com/search?q=acme", "https://www.thomasnet.com/suppliers"];
  const { kept, deps } = fixture({
    serp: async () => rows.map((url) => ({ url, title: "A directory", snippet: "Acme and Beta are listed here" })),
    cached: async (key) => key === facts.key ? { ...facts, lastSeenAt: now - 1000 } : null,
    fetchPage: async (url) => { fetched.push(url); return { text: url.includes("builders.org") ? "<p>Members include Acme and beta.com.</p>" : "Other businesses only.", finalUrl: url }; },
    model: async (text) => { modeled.push(text); return { ...facts, listsCompanies: true }; },
  });
  assert.deepEqual(await searchMarketSources(seeds, deps), { status: "done" });
  assert.deepEqual(kept.map((k) => k.match), [
    { sourceKey: "https://builders.org/members", seedDomain: "acme.com", quote: "Members include Acme and beta.com.", query: '"Acme" -site:acme.com' },
    { sourceKey: "https://builders.org/members", seedDomain: "beta.com", quote: "Members include Acme and beta.com.", query: '"Beta" -site:beta.com' },
  ]);
  assert.deepEqual(fetched, ["https://builders.org/members?sort=name#top", "https://other.org/list"]);
  assert.deepEqual(modeled, []);
  const fresh = fixture({ serp: async () => [{ url: facts.url, title: "Builders", snippet: "" }] });
  await searchMarketSources([seeds[0]], fresh.deps);
  assert.equal(fresh.kept[0].source.title, "Builders");
});

test("stores only public source facts globally and counts distinct seeds across workspace reruns", async () => {
  const db = memoryDb({ marketSourceSearches: [
    { _id: "run1", orgId: "org1", status: "running", seeds, results: [] },
    { _id: "run2", orgId: "org2", status: "running", seeds, results: [] },
  ] });
  const match = { sourceKey: facts.key, seedDomain: "acme.com", quote: "Acme is a member.", query: '"Acme" -site:acme.com' };
  await handlers.keep.handler({ db }, { runId: "run1", source: facts, match });
  await handlers.keep.handler({ db }, { runId: "run2", source: facts, match });
  await handlers.keep.handler({ db }, { runId: "run2", source: facts, match: { ...match, seedDomain: "beta.com", quote: "Beta is a member." } });
  const row = db.rows("marketSources")[0];
  assert.deepEqual(Object.keys(row).sort(), ["_creationTime", "_id", "exportable", "filterable", "firstSeenAt", "key", "kind", "lastSeenAt", "listedCount", "markets", "seedHits", "title", "url"]);
  assert.deepEqual({ title: row.title, seedHits: row.seedHits, markets: JSON.parse(JSON.stringify(row.markets)) }, { title: "Builders", seedHits: 2, markets: ["construction"] });
  assert.equal(JSON.stringify(row).includes("acme.com"), false);
  assert.equal(JSON.stringify(row).includes("beta.com"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(db.rows("marketSourceSearches")[1].results)), [match, { ...match, seedDomain: "beta.com", quote: "Beta is a member." }]);
});

test("ranks sources found for multiple distinct seeds before single-seed sources", () => {
  assert.deepEqual(rankSources([{ title: "Alpha", seedHits: 1 }, { title: "Zulu", seedHits: 2 }, { title: "Beta", seedHits: 3 }]), [
    { title: "Beta", seedHits: 3 }, { title: "Zulu", seedHits: 2 }, { title: "Alpha", seedHits: 1 },
  ]);
});

test("refuses without paid calls before touching any injected provider", async () => {
  const fail = async (): Promise<never> => { throw new Error("A refused run must not call a provider"); };
  const { deps } = fixture({ paid: false, serp: fail, fetchPage: fail, model: fail });
  const result = await searchMarketSources(seeds, deps);
  assert.equal(result.status, "refused");
  assert.equal(result.reason?.includes("dev and production"), true);
});

test("catalog matches canonical industries and normalizes workspace countries", async () => {
  const { catalogForMarket } = await import("../convex/lib/tam/sourceCatalog.ts");
  const us = catalogForMarket({ industry: ["Construction"], country: ["united states"] });
  assert.deepEqual(us.map((s) => s.id), ["usaspending", "sam", "state-procurement", "edgar", "thomasnet", "crunchbase", "bbb", "contractor-licenses"]);
  assert.deepEqual(catalogForMarket({ industry: ["Construction"], country: ["Canada"] }).map((s) => s.id), ["thomasnet", "crunchbase", "bbb"]);
});


test("starts from won accounts, otherwise the first active ICP's fit-ranked accounts, otherwise refuses", async () => {
  let won = true, hasIcp = true;
  const saved: Array<{ seeds: unknown; reason?: string }> = [];
  const ctx = {
    caller: { orgId: "org", userId: "user" },
    client: {
      listObjects: async () => ({ rows: won ? [{ values: { companyId: "won-account" } }] : [], nextCursor: null }),
      get: async () => ({ account: { name: "Winner", domain: "winner.com" } }),
      list: async (_org: string, req: unknown) => {
        assert.deepEqual(JSON.parse(JSON.stringify(req)), { filter: { icpId: "first" }, sort: { field: "fit", dir: "desc" }, limit: 100 });
        return { rows: [{ name: "Best fit", domain: "bestfit.com" }, { name: "Next fit", domain: "nextfit.com" }] };
      },
    },
    runQuery: async () => ({ icpId: hasIcp ? "first" : null }),
    runMutation: async (_ref: unknown, args: { seeds: unknown; reason?: string }) => { saved.push(args); return "run"; },
  };
  assert.equal(await handlers.start.handler(ctx, {}), "run");
  won = false;
  await handlers.start.handler(ctx, {});
  hasIcp = false;
  await handlers.start.handler(ctx, {});
  assert.deepEqual(JSON.parse(JSON.stringify(saved.map((r) => r.seeds))), [
    [{ name: "Winner", domain: "winner.com" }],
    [{ name: "Best fit", domain: "bestfit.com" }, { name: "Next fit", domain: "nextfit.com" }],
    [],
  ]);
  assert.equal(typeof saved[2].reason, "string");
});
