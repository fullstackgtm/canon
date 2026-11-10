import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { estimateSegments, runResearchPipeline } from "../convex/lib/researchPipeline.ts";
import { cleanForJev, jevAsk } from "../convex/lib/segments/jev.ts";
import { archetypeLabel, industryPhrase, marketSegments, occupationPhrase, type JevAsk, type MarketSegments } from "../convex/lib/segments/marketSegments.ts";
import type { Icp } from "../engine/src/icp.ts";

/** Fake Jev: a question scores high when its instructions match any of the patterns. */
function keywordAsk(patterns: RegExp[]): { ask: JevAsk; requests: number } {
  const state = { requests: 0 };
  const ask: JevAsk = async (_s, questions) => {
    state.requests++;
    return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, patterns.some((re) => re.test(q.instructions)) ? 0.95 : 0.02]));
  };
  return { ask, get requests() { return state.requests; } };
}

test("dental software: buyers name dental practices; adjacent segments come with a reason", async () => {
  const fake = keywordAsk([/dental/i, /a kind of: Medical software/]);
  const r = await marketSegments(fake.ask, "dentrix.com", "Dental practice management software for dental offices");
  assert.equal(r.buyers[0].archetype, "healthcare/dental_practice");
  assert.equal(r.buyers[0].label, "Dental practices");
  assert.equal(r.buyers[0].kind, "buyer");
  assert.equal(r.horizontal, false);
  assert.ok(r.jobs.includes("Medical software"));
  const buyerKeys = new Set(r.buyers.map((b) => b.archetype));
  for (const a of r.adjacent) {
    assert.equal(a.kind, "adjacent");
    assert.ok(!buyerKeys.has(a.archetype), "adjacent never repeats a buyer");
    assert.match(a.why, /concentrated in/);
  }
  assert.ok(r.buyers.every((b) => b.pdlIndustries.length > 0 || b.archetype.endsWith("/other")));
});

test("commission software reaches sales-heavy industries through subject roles", async () => {
  // Nothing matches as a buyer; sales-rep occupation groups and occupations match as subjects.
  const fake = keywordAsk([/workers in this occupation group .*: Sales Representatives/, /people employed as .*Sales (Representatives|Agents)/, /plausibly buy/]);
  const r = await marketSegments(fake.ask, "seller.example.org", "Sales commission software");
  assert.equal(r.buyers.length, 0);
  assert.ok(r.adjacent.length > 0);
  assert.ok(r.adjacent.some((a) => /manage/.test(a.why)), "subject paths explain that the product manages those roles");
});

test("adjacent candidates Jev finds implausible are dropped", async () => {
  // Same chain as above, but the plausibility check accepts only insurance agencies.
  const fake = keywordAsk([/workers in this occupation group .*: Sales Representatives/, /people employed as .*Sales (Representatives|Agents)/, /plausibly buy .*insurance/i]);
  const r = await marketSegments(fake.ask, "seller.example.org", "Sales commission software");
  assert.ok(r.adjacent.length > 0);
  assert.ok(r.adjacent.every((a) => a.archetype.startsWith("financial_insurance/insurance")), r.adjacent.map((a) => a.archetype).join(","));
  const unchecked = await marketSegments(fake.ask, "seller.example.org", "Sales commission software", { plausibilityCheck: false });
  assert.ok(unchecked.adjacent.length > r.adjacent.length, "without the check, more candidates are shown");
});

test("a general-purpose tool is flagged horizontal even when its site names few buyers", async () => {
  const fake = keywordAsk([/general-purpose business tool/, /dental/i]);
  const r = await marketSegments(fake.ask, "calendly.com", "Scheduling for everyone");
  assert.equal(r.horizontal, true);
  const vertical = await marketSegments(keywordAsk([/dental/i]).ask, "dentrix.com", "Dental practice software");
  assert.equal(vertical.horizontal, false);
});

test("a product matching most archetypes is flagged horizontal", async () => {
  const fake = keywordAsk([/built for, or marketed to/]);
  const r = await marketSegments(fake.ask, "docusign.com", "e-signature for every business");
  assert.equal(r.horizontal, true);
  assert.equal(r.buyers.length, 8, "buyers are capped");
});

test("labels and reasons read as plain English", () => {
  assert.equal(archetypeLabel("staffing_hr/staffing_agency"), "Staffing agencies");
  assert.equal(archetypeLabel("healthcare/other"), "Other healthcare");
  assert.equal(occupationPhrase("Sales Representatives, Wholesale and Manufacturing, Except Technical and Scientific Products"), "wholesale and manufacturing sales representatives");
  assert.equal(occupationPhrase("Insurance Sales Agents"), "insurance sales agents");
  assert.equal(occupationPhrase("Hairdressers, Hairstylists, and Cosmetologists"), "hairdressers, hairstylists, and cosmetologists");
  assert.equal(occupationPhrase("Sales Representatives, Wholesale and Manufacturing, Technical and Scientific Products"), "wholesale and manufacturing sales representatives (technical and scientific products)");
  assert.equal(industryPhrase("Agencies, Brokerages, and Other Insurance Related Activities"), "insurance agencies and brokerages");
  assert.equal(industryPhrase("Merchant Wholesalers, Durable Goods (4232, 4233, 4235, 4236, 4237, and 4239 only)"), "merchant wholesalers, durable goods");
});

const stubIcp: Icp = {
  name: "stub",
  firmographics: { industries: ["SaaS"], employeeBands: ["201-500"], geos: ["us"] },
  persona: { titleKeywords: ["revenue operations"], jobLevels: ["vp"], departments: ["operations"] },
};
const fakeClient = () => createFakeRecordClient({ store: createMemoryRecordStore() });
const segs: MarketSegments = {
  buyers: [{ archetype: "software_tech/b2b_saas", label: "B2b saas", group: "Software and tech", kind: "buyer", score: 0.9, why: "x", pdlIndustries: ["computer software"] }],
  adjacent: [{ archetype: "healthcare/other", label: "Other", group: "Healthcare", kind: "adjacent", score: 0.3, why: "y", pdlIndustries: [] }],
  horizontal: false,
  jobs: [],
};

test("pipeline stores segments with size estimates from the PDL index", async () => {
  const r = await runResearchPipeline({ domain: "acme.io", client: fakeClient(), deriveIcp: async () => stubIcp, deriveSegments: async () => segs });
  assert.ok(r.marketSegments);
  assert.ok((r.marketSegments.buyers[0].estCount ?? 0) > 0, "industry-based estimate");
  assert.equal(r.marketSegments.adjacent[0].estCount, null, "no industries, no estimate");
});

test("segments are counted by business-type tags when the index has them, else estimated from industries", async () => {
  const seen: unknown[] = [];
  const tagged = {
    searchShared: async (filter: { archetype?: string[] }) => { seen.push(filter); return { rows: [], total: filter.archetype ? 1234 : 99 }; },
  };
  const r = await estimateSegments(segs, tagged as never, { country: ["united states"] });
  assert.equal(r.buyers[0].estCount, 1234);
  assert.equal(r.buyers[0].countBasis, "tagged");
  assert.deepEqual(seen[0], { archetype: ["software_tech/b2b_saas"], country: ["united states"] });
  const fallback = await runResearchPipeline({ domain: "acme.io", client: fakeClient(), deriveIcp: async () => stubIcp, deriveSegments: async () => segs });
  assert.equal(fallback.marketSegments?.buyers[0].countBasis, "industry", "the fake index has no tags");
});

test("a segment failure is noted and never fails the pipeline", async () => {
  const r = await runResearchPipeline({
    domain: "acme.io", client: fakeClient(), deriveIcp: async () => stubIcp,
    deriveSegments: async () => { throw new Error("jev 503: unavailable"); },
  });
  assert.ok(r.tamTotal > 0);
  assert.deepEqual(r.marketSegments?.buyers, []);
  assert.match(r.marketSegments?.note ?? "", /jev 503/);
  const none = await runResearchPipeline({ domain: "acme.io", client: fakeClient(), deriveIcp: async () => stubIcp });
  assert.equal(none.marketSegments, undefined, "no classifier configured, no field");
});

test("jev client retries 429 and returns Noul probabilities", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
    return new Response(JSON.stringify({ answers: { q0: { type: "noul", noul: 0.8 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const ask = jevAsk("test-key", { fetch: fakeFetch });
  assert.deepEqual(await ask({}, { q0: { type: "noul", instructions: "x" } }, 10), { q0: 0.8 });
  assert.equal(calls, 2);
  const fail = jevAsk("k", { fetch: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch });
  await assert.rejects(fail({}, {}, 10), /jev 400/);
});

test("text sent to Jev is valid Unicode without control characters", () => {
  const cut = "Great food \u{1F600}".slice(0, -1); // half an emoji
  assert.deepEqual(cleanForJev({ a: [cut, "x\u0000y\u0007z\nok"] }), { a: ["Great food \uFFFD", "x y z\nok"] });
});
