import { rateLimitHit } from "../convex/lib/rateLimit.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import {
  buildSegments,
  claimRedirect,
  decideClaim,
  heuristicIcp,
  icpToFilter,
  normalizeDomain,
  RATE_LIMITS,
  ResearchFailure,
  runResearchPipeline,
  scoreCompany,
  type ResearchStatus,
} from "../convex/lib/researchPipeline.ts";
import type { Icp } from "../engine/src/icp.ts";

const stubIcp: Icp = {
  name: "stub",
  firmographics: { industries: ["SaaS"], employeeBands: ["201-500", "501-1000"], geos: ["us"] },
  persona: { titleKeywords: ["revenue operations"], jobLevels: ["vp"], departments: ["operations"] },
};

function fakeClient() {
  return createFakeRecordClient({ store: createMemoryRecordStore() });
}

test("pipeline runs end to end with the fake record client and a stubbed LLM", async () => {
  const statuses: ResearchStatus[] = [];
  const result = await runResearchPipeline({
    domain: "https://www.Stripe.com/pricing",
    client: fakeClient(),
    deriveIcp: async (domain) => {
      assert.equal(domain, "stripe.com");
      return stubIcp;
    },
    onStatus: (status) => { statuses.push(status); },
  });
  assert.deepEqual(statuses, ["deriving", "building_tam", "sampling_contacts", "ready"]);
  assert.equal(result.icpSource, "llm");
  assert.ok(result.tamTotal > 0);
  assert.ok(result.tam.length > 0 && result.tam.length <= 1000);
  assert.equal(result.preview.length, 25);
  for (let i = 1; i < result.preview.length; i++) assert.ok(result.preview[i - 1].fit >= result.preview[i].fit, "preview is fit-sorted");
  assert.ok(result.tam.every((a) => a.industry === "computer software" && a.country === "united states"));
  assert.ok(result.tam.every((a) => (a.employees ?? 0) >= 201 && (a.employees ?? 0) <= 1000));
  assert.ok(result.segments.length > 0);
  assert.equal(result.segments.reduce((s, x) => s + x.count, 0), result.tam.length);
  assert.ok(result.preview.every((row) => row.segmentIds.length === 1 && row.status === "new"));
});

test("pipeline stops with a reason instead of guessing an ICP", async () => {
  const statuses: ResearchStatus[] = [];
  await assert.rejects(
    runResearchPipeline({
      domain: "google.com", client: fakeClient(), onStatus: (status) => { statuses.push(status); },
      deriveIcp: async () => { throw new Error("icp derive: model returned fewer than two website-verifiable evidence quotes."); },
    }),
    (error: unknown) => error instanceof ResearchFailure && error.stage === "deriving"
      && /couldn't back an ICP for google.com/.test(error.message) && /fewer than two/.test(error.detail),
  );
  assert.deepEqual(statuses, ["deriving"], "no heuristic ICP and no TAM after a failed derivation");
});

test("pipeline relaxes an over-narrow ICP filter instead of returning an empty TAM", async () => {
  const narrow: Icp = { ...stubIcp, firmographics: { industries: ["biotech"], employeeBands: ["10001+"], geos: ["sg"] } };
  const result = await runResearchPipeline({ domain: "x.com", client: fakeClient(), deriveIcp: async () => narrow, minTam: 25 });
  assert.ok(result.tamTotal >= 25);
  assert.equal(result.filter.country, undefined);
});

test("domain normalization rejects non-public input", () => {
  assert.equal(normalizeDomain(" WWW.Example.COM/path "), "example.com");
  for (const bad of ["", "localhost", "10.0.0.1", "foo", "printer.local", "a b.com"]) {
    assert.throws(() => normalizeDomain(bad), /domain/i, bad);
  }
});

test("icp maps to PDL filter vocab and scores firmographic fit", () => {
  const filter = icpToFilter(stubIcp);
  // The canonical industry and every source's spelling of it (PDL's are LinkedIn's earlier names).
  assert.deepEqual(filter, { industry: ["software development", "computer software", "program development"], country: ["united states"], employeeMin: 201, employeeMax: 1000 });
  const perfect = scoreCompany({ domain: "a.example", name: "A", industry: "computer software", employees: 350, country: "united states" }, stubIcp);
  const near = scoreCompany({ domain: "b.example", name: "B", industry: "computer software", employees: 120, country: "canada" }, stubIcp);
  assert.equal(perfect.fit, 1);
  assert.ok(near.fit > 0 && near.fit < perfect.fit);
  assert.ok(heuristicIcp("paystack.com").firmographics.industries?.includes("financial services"));
});

test("segments are ordered by fit and the claim redirect targets the top one", () => {
  const { segments, accounts } = buildSegments([
    { domain: "a", name: "a", industry: "internet", employees: 50, fit: 0.2 },
    { domain: "b", name: "b", industry: "computer software", employees: 5000, fit: 0.9 },
    { domain: "c", name: "c", industry: "internet", employees: 60, fit: 0.3 },
  ]);
  assert.equal(segments[0].id, "seg-computer-software-ent");
  assert.equal(segments[1].count, 2);
  assert.ok(accounts.every((a) => a.segmentIds?.length === 1));
  assert.equal(claimRedirect(segments), "/dashboard/accounts?segment=seg-computer-software-ent");
  assert.equal(claimRedirect([]), "/dashboard/accounts");
});

test("claim is idempotent for the same org and rejected cross-org", () => {
  assert.deepEqual(decideClaim({ status: "ready" }, "orgA"), { kind: "claim" });
  assert.throws(() => decideClaim({ status: "building_tam" }, "orgA"), /still running/);
  assert.deepEqual(decideClaim({ status: "ready", claimedByOrgId: "orgA" }, "orgA"), { kind: "already_claimed_by_you" });
  assert.throws(() => decideClaim({ status: "ready", claimedByOrgId: "orgA" }, "orgB"), /another workspace/);
  assert.throws(() => decideClaim({ status: "failed" }, "orgA"), /failed/);
});

test("rate limit trips after the window budget and resets after the window", () => {
  const rule = RATE_LIMITS.ip;
  let bucket = null as ReturnType<typeof rateLimitHit>["next"] | null;
  const t0 = 1_000_000;
  for (let i = 0; i < rule.limit; i++) {
    const hit = rateLimitHit(bucket, t0 + i, rule);
    assert.ok(hit.allowed, `hit ${i + 1} allowed`);
    bucket = hit.next;
  }
  assert.equal(rateLimitHit(bucket, t0 + 10, rule).allowed, false);
  assert.ok(rateLimitHit(bucket, t0 + rule.windowMs, rule).allowed);
});


test("ICP, raw segments and TAM publish before segment sizing finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const patches: Array<{ status: string; icp?: Icp; tamTotal?: number; preview?: unknown[] }> = [];
  let earlySegments = false;
  const run = runResearchPipeline({
    domain: "acme.example", client: fakeClient(), deriveIcp: async () => stubIcp,
    deriveSegments: async () => { await gate; return { buyers: [], adjacent: [], horizontal: false, jobs: [] }; },
    onFinding: async (patch) => { earlySegments = Boolean(patch.marketSegments); },
    onStatus: async (status, patch) => { patches.push({ status, ...patch }); if (status === "sampling_contacts") release(); },
  });
  await run;
  assert.equal(patches[1].icp?.name, "stub");
  assert.ok(patches[2].tamTotal! > 0);
  assert.ok(patches[2].preview!.length > 0);
  assert.equal(patches[2].status, "sampling_contacts");
  assert.ok(earlySegments);
  assert.equal(patches[3].status, "ready");
});

test("a failed early publication preserves successfully derived buyer segments", async () => {
  const result = await runResearchPipeline({
    domain: "acme.example", client: fakeClient(), deriveIcp: async () => stubIcp,
    deriveSegments: async () => ({ buyers: [], adjacent: [], horizontal: true, jobs: ["Scheduling"] }),
    onFinding: () => { throw new Error("Progress write unavailable"); },
  });
  assert.equal(result.marketSegments?.horizontal, true);
  assert.deepEqual(result.marketSegments?.jobs, ["Scheduling"]);
});
