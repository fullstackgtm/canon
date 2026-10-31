import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConvex } from "./convexHandlers.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import { parseModuleManifest, type ModuleManifest } from "../modules/kernel/manifest.ts";
import { gateAnswer, outputSchema } from "../modules/kernel/ai.ts";
import { freePopulationRequest } from "../modules/kernel/freePopulation.ts";
import { challengeCalls } from "../modules/examples/icps/challenge.ts";
import { CRM_SOURCE, contextText, parseProposals, proposalSearch } from "../modules/examples/icps/challengeDomain.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";
import type { Icp } from "../engine/src/icp.ts";
import type { readWebPages as ReadWebPages, sampleMarkets as SampleMarkets } from "../convex/moduleWebActions.ts";
import type { Person } from "../convex/lib/peopleSources.ts";

const manifest = JSON.parse(readFileSync("modules/examples/icps/module.json", "utf8")) as ModuleManifest;
const sources = loadConvex(["moduleWebActions.ts", "lib/treg.ts"]);
const readWebPages = sources["moduleWebActions.ts"].readWebPages as unknown as typeof ReadWebPages;
const sampleMarkets = sources["moduleWebActions.ts"].sampleMarkets as unknown as typeof SampleMarkets;
const TregRefusal = sources["lib/treg.ts"].TregRefusal as unknown as new (...args: unknown[]) => Error;
const icp = { name: "Current", firmographics: { industries: ["software development"], employeeBands: ["51-200"], geos: ["GB"] }, persona: { jobLevels: ["vp"], departments: ["finance"], titleKeywords: [] } } as Icp;
const ctx: CallContext = { now: 1792600000000, caller: { userId: "member", role: "manager" }, args: { key: "run" } };
const run = (state: string, data: Record<string, unknown> = {}): ReadDoc => ({ key: "run", version: 3, owner: "member", parentKey: null, createdAt: 1, updatedAt: 2, data: { state, ...data } });
const market = { name: "Retail inventory", industries: ["retail"], countries: [], employeeMin: 501, rationale: "Test hypothesis", claims: [], risks: [], readUrls: [] };

test("0.4 upgrades preserve every published field and existing collection while queued declarations fail closed", () => {
  const old = JSON.parse(readFileSync("tests/fixtures/modules/icps-0.4.0.json", "utf8"));
  assert.equal(parseModuleManifest(manifest).ok, true);
  assert.deepEqual(planUpgrade(old, defaultSlots(old), manifest, old.version).problems, []);
  assert.deepEqual(old.provides, manifest.provides);
  for (const name of Object.keys(old.collections)) assert.deepEqual(old.collections[name], manifest.collections[name]);
  for (const change of [
    (m: ModuleManifest) => { m.machines!.challenge.transitions.readCitations.system = true; },
    (m: ModuleManifest) => { m.calls!.sizeChallenge.system = true; },
    (m: ModuleManifest) => { m.calls!.proposeChallenge.ai!.queue!.then = "readCitations"; },
    (m: ModuleManifest) => { m.calls!.refineChallenge.reads.accounts = { canon: "companies.bestFit" }; },
    (m: ModuleManifest) => { delete m.reads!.market; },
    (m: ModuleManifest) => { m.calls!.acceptMarket.canon!.operation = "research.start"; },
    (m: ModuleManifest) => {
      m.calls!.implicitSample = { ...m.calls!.sizeChallenge, writes: [], returns: "value" };
      delete m.calls!.implicitSample.step;
      m.pages[0].bind!.implicit = { call: "implicitSample", args: { key: "unused" } };
    },
    (m: ModuleManifest) => { m.calls!.acceptMarket.canon!.then!.input.query.field = "key"; },
    (m: ModuleManifest) => { m.machines!.marketDecision.transitions.accept.effects = [{ notify: ["owner"], message: "Extra side effect" }]; },
  ]) { const changed = structuredClone(manifest); change(changed); assert.equal(parseModuleManifest(changed).ok, false); }
});

test("quotes span the exact CRM text and actually read pages while unsupported claims remain hypotheses", () => {
  const ai = manifest.calls!.proposeChallenge.ai!;
  const crm = contextText({ sells: ["calculate sales commissions"], wonDeals: [], lostDeals: [], bestAccounts: [], decided: [] });
  const page = { id: "https://trade.test/", url: "https://trade.test/", text: "Dealerships pay commissions on vehicle sales." };
  const input = { proposals: [{ ...market, claims: [
    { text: "CRM mechanism", quote: "calculate sales commissions", sourceUrl: CRM_SOURCE },
    { text: "Commission buyers", quote: page.text, sourceUrl: page.id },
    { text: "Unverified expansion claim", quote: "Sales have doubled this year.", sourceUrl: page.id },
    { text: "Wrong source", quote: page.text, sourceUrl: "https://unread.test/" },
  ] }] };
  const result = gateAnswer(ai, outputSchema(manifest, ai)!, input, { run: run("proposing", { crmText: crm, url: CRM_SOURCE }), pages: [page] }, {});
  const claims = (result.data.proposals as Array<{ claims: Array<Record<string, unknown>> }>)[0].claims;
  assert.deepEqual([result.kept, claims.length], [2, 4]);
  assert.deepEqual(claims[2], { text: "Unverified expansion claim" });
  assert.deepEqual(claims[3], { text: "Wrong source" });
});

test("requested pages are bounded safe HTTPS reads with stable URL sources and empty reads skip citation", async () => {
  let fetched = 0;
  const pages = await readWebPages({ urls: ["https://trade.test/a", "https://trade.test/a", "https://missing.test/"] }, false, async (url) => { fetched++; return url.includes("missing") ? null : { text: "<p>A trade source with an exact quote about regional manufacturers.</p>", finalUrl: url }; });
  assert.deepEqual(Array.from(pages, (p) => [p.id, p.url]), [["https://trade.test/a", "https://trade.test/a"]]);
  assert.equal(fetched, 2);
  for (const urls of [["http://trade.test/"], ["https://127.0.0.1/"], Array(7).fill("https://trade.test/")]) await assert.rejects(readWebPages({ urls }, true));
  const output = await challengeCalls.readChallengeCitations(ctx, { run: run("checking"), pages: [] });
  assert.equal(output.intents!.at(-1)!.op, "transition");
  assert.equal((output.intents!.at(-1) as { name: string }).name, "size");
});

test("normalization excludes decided and inside markets and preserves max-only and open min queries", () => {
  const found = parseProposals({ proposals: [null, market, { ...market, name: "Inside", industries: ["software development"], employeeMin: 60, employeeMax: 100 }, { ...market, name: "Decided", industries: ["staffing and recruiting"] }] }, { icp: { companyIndustries: { include: ["software development"] }, companyEmployeeNumberRange: { min: 51, max: 200 } }, decided: [{ name: "Earlier", industries: ["staffing and recruiting"], state: "dismissed", reason: "Too small" }] });
  assert.deepEqual(found.map((p) => p.name), ["Retail inventory"]);
  const min = freePopulationRequest(proposalSearch(market, icp));
  assert.deepEqual([min.employeeMin, min.employeeMax, min.countries, min.buyer.levels], [501, undefined, ["GB"], ["vp"]]);
  const max = freePopulationRequest(proposalSearch({ ...market, employeeMin: undefined, employeeMax: 19 }, icp));
  assert.deepEqual([max.employeeMin, max.employeeMax], [undefined, 19]);
});

test("challenge context converts granted deal cents and omits amounts without their currency", async () => {
  const output = await challengeCalls.startChallenge(ctx, { plan: [{ available: true }], runs: [], markets: [], signup: [], lost: [], best: [], won: [
    { name: "Granted", amount: 21000025, currency: "USD" },
    { name: "Currency hidden", amount: 21000025 },
  ] });
  const created = output.intents!.find((it) => it.op === "put") as Extract<import("../modules/kernel/calls.ts").Intent, { op: "put" }>;
  const context = JSON.parse(String(created.data.contextJson));
  assert.deepEqual(context.wonDeals, [{ name: "Granted", amount: 210000.25, currency: "USD" }, { name: "Currency hidden" }]);
  assert.match(String(created.data.crmText), /USD 210,000\.25/);
});

test("free sizing omits absent, paused and failed queries, counts nonempty distinct domains and stops on Treg refusal", async () => {
  const queries = [market, { ...market, industries: ["accounting"] }, { ...market, industries: ["construction"] }].map((p) => proposalSearch(p, icp));
  let calls = 0;
  const page = async () => { calls++; return { people: [{ company: { domain: "a.test" } }, { company: { domain: "a.test" } }, { company: { domain: "" } }] as Person[], next: null, total: 4, rateRemaining: null }; };
  assert.deepEqual(Array.from(await sampleMarkets(queries, { paused: false, page })), [undefined, undefined, undefined]);
  assert.deepEqual(Array.from(await sampleMarkets(queries, { token: "fake", paused: true, page })), [undefined, undefined, undefined]);
  assert.equal(calls, 0);
  const results = await sampleMarkets(queries, { token: "fake", paused: false, page: async () => { if (calls++ === 0) throw new Error("ordinary one-query failure"); return page(); } });
  assert.equal(results[0], undefined);
  assert.deepEqual({ ...results[1] }, { accounts: 1, capped: true });
  const uncapped = await sampleMarkets(queries.slice(0, 1), { token: "fake", paused: false, page: async () => ({ people: [{ company: { domain: "b.test" } }] as Person[], next: null, total: 1, rateRemaining: null }) });
  assert.deepEqual({ ...uncapped[0] }, { accounts: 1, capped: false });
  const next = await sampleMarkets(queries.slice(0, 1), { token: "fake", paused: false, page: async () => ({ people: [], next: "cursor", total: 0, rateRemaining: null }) });
  assert.deepEqual({ ...next[0] }, { accounts: 0, capped: true });
  calls = 0;
  await sampleMarkets(queries, { token: "fake", paused: false, page: async () => { calls++; throw new TregRefusal(402, "budget", "zero ceiling", null); } });
  assert.equal(calls, 1);
});
