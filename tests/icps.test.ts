import assert from "node:assert/strict";
import test from "node:test";
import { emptySpec, specBuyer, specGate } from "../convex/lib/icps.ts";
import { gatedFit, isBuyer } from "../convex/lib/icpGates.ts";
import { accountQueries, canonDepartments, marketQueries } from "../convex/lib/addRecords.ts";
import { splitQuickEnrich } from "../convex/lib/quickenrich.ts";
import { defaultModel } from "../recipes/index.ts";
import { FIT_MODEL } from "../recipes/models.ts";

const canonFit = defaultModel("scoring.fit");

const saas = { ...emptySpec(), market: { industries: ["software development"], employeeBands: ["51-200"], countries: ["us"] } };
const banks = { ...emptySpec(), market: { industries: ["banking"], employeeBands: ["1001-5000"], countries: ["gb"] } };

test("specGate: a saved ICP becomes a gate whose perfect match scores 100", () => {
  const g = specGate("saas", { ...saas, exclude: { industries: ["staffing and recruiting"], countries: ["ca"], titles: [] }, custom: [{ slug: "fit_kind", values: ["SaaS"] }] }, canonFit);
  assert.ok((g.industries["software development"] ?? 0) > 0);
  assert.deepEqual(g.employees.map((b) => [b.min, b.max]), [[51, 200]], "only the ICP's own sizes: a neighbouring band fails the gate");
  assert.ok(g.excludeIndustries.includes("staffing and recruiting"));
  assert.deepEqual(g.excludeCountries, ["canada"]);
  assert.deepEqual(g.custom, [{ key: "custom.fit_kind", values: ["saas"] }]);
  const perfect = gatedFit({ industry: "Software Development", country: "United States", employees: 120, custom: { "custom.fit_kind": "saas" } }, [g]);
  assert.deepEqual(perfect, { fit: 1, icpIds: ["saas"] });
});

test("gatedFit: ICPs never mix, unknowns fail, exclusions stay inside their ICP", () => {
  const gates = [specGate("saas", saas, canonFit), specGate("banks", { ...banks, exclude: { industries: [], countries: ["us"], titles: [] } }, canonFit)];
  const fit = (row: Parameters<typeof gatedFit>[0]) => gatedFit(row, gates);
  assert.deepEqual(fit({ industry: "software development", country: "united kingdom", employees: 2000 }), { fit: 0, icpIds: [] }, "one ICP's industry with another's country");
  assert.deepEqual(fit({ industry: "software development", country: "united states" }), { fit: 0, icpIds: [] }, "an unknown size fails a size criterion");
  assert.deepEqual(fit({ industry: "banking", country: "united kingdom", employees: 2000 }), { fit: 1, icpIds: ["banks"] });
  // Score history has no AI-field answers as of a date: a gate they'd decide leaves fit unknown.
  assert.deepEqual(gatedFit({ industry: "software development", country: "united states", employees: 120 }, [specGate("x", { ...saas, custom: [{ slug: "k", values: ["a"] }] }, canonFit)], false), { unknown: true });
});

test("specGate: a size band the ICP names and weights 0 earns 0, not the unlisted-size points", () => {
  const zeroCentral = specGate("saas", saas, { ...canonFit, bands: { ...canonFit.bands, central: 0 } });
  assert.deepEqual(zeroCentral.employees.map((b) => b.weight), [0]);
});

test("specGate: no scoring.fit settings the kernel accepts leave a gate with a max of 0", () => {
  const floor = (key: string) => (FIT_MODEL.settings[key] as { min: number }).min;
  const lowest = { ...canonFit, base: floor("fitBase"), industryRanks: [0], countryRanks: [0], bands: { central: 0, inside: 0, adjacent: 0 }, unlistedBand: 0 };
  const persona = { ...emptySpec(), persona: { ...emptySpec().persona, levels: ["vp"] } };
  assert.ok(specGate("p", persona, lowest).max > 0, "the record service refuses a gate whose max is 0");
});

test("market and account searches carry the exclusions", () => {
  const exclude = { industries: ["staffing and recruiting"], countries: ["ca"], titles: ["Intern"] };
  const { quickenrich } = marketQueries(saas.market, saas.persona, exclude);
  assert.deepEqual(quickenrich.industry_linkedin?.exclude, ["Staffing and Recruiting"]);
  assert.deepEqual(quickenrich.country_code?.exclude, ["CA"]);
  assert.deepEqual(quickenrich.title?.exclude, ["Intern"]);
  // Named companies keep only the title exclusions.
  const [named] = accountQueries(["acme.com"], saas.persona, exclude);
  assert.deepEqual(named.quickenrich.title?.exclude, ["Intern"]);
  assert.equal(named.quickenrich.country_code, undefined);
});

test("splitting a big search keeps its exclusions and skips excluded values", () => {
  const { quickenrich } = marketQueries({ ...saas.market, countries: ["us", "ca", "gb"] }, saas.persona, { industries: [], countries: ["ca"], titles: ["Intern"] });
  const children = splitQuickEnrich(quickenrich) ?? [];
  assert.deepEqual(children.map((c) => c.country_code?.include), [["US"], ["GB"]]);
  for (const child of children) {
    assert.deepEqual(child.country_code?.exclude, ["CA"]);
    assert.deepEqual(child.title?.exclude, ["Intern"]);
  }
});

test("canonical industries: every source's spelling passes the same gate, and no loose rule widens it", () => {
  const it = specGate("it", { ...emptySpec(), market: { industries: ["it services and it consulting"], employeeBands: [], countries: [] } }, canonFit);
  for (const industry of ["IT Services and IT Consulting", "information technology and services", "INFORMATION_TECHNOLOGY_AND_SERVICES"]) {
    assert.deepEqual(gatedFit({ industry }, [it]), { fit: 1, icpIds: ["it"] }, industry);
  }
  assert.deepEqual(gatedFit({ industry: "management consulting" }, [it]), { fit: 0, icpIds: [] });
});

test("market sizes: views with a market, and one cache key per view", async () => {
  const { cacheKey, marketFilter } = await import("../convex/lib/marketSize.ts");
  assert.equal(marketFilter({ industry: ["computer software"], ownerId: "u1" }), null, "an owner filter has no market");
  assert.equal(marketFilter({ icpId: "x" }), null);
  const f = marketFilter({ industry: ["Software Development", "computer software"], country: ["United States"], sizeBand: ["51-200"] })!;
  assert.deepEqual(f, { industry: ["software development"], country: ["united states"], sizeBand: ["51-200"] });
  assert.equal(cacheKey(f, "region"), cacheKey({ sizeBand: ["51-200"], country: ["united states"], industry: ["software development"] }, "region"));
  assert.equal(cacheKey(f, "region"), "region|industry=software development|country=united states|sizeBand=51-200");
});

test("outside-TAM fills: fill a real gap, never a covered, tiny or huge one", async () => {
  const { gapDecision, gapKey, icpMarketFilter } = await import("../convex/lib/icpGap.ts");
  assert.deepEqual(gapDecision(639, 15), { fill: true, gap: 624 });
  assert.equal(gapDecision(1000, 850).fill, false, "80% held is covered");
  assert.equal(gapDecision(30, 10).fill, false, "a gap under 25 is too small");
  assert.deepEqual(gapDecision(27258, 942), { fill: false, gap: 26316, reason: "too_large" });
  const spec = { ...emptySpec(), market: { industries: ["computer software"], employeeBands: ["51-200"], countries: ["us"] } };
  assert.deepEqual(icpMarketFilter(spec), { industry: ["software development"], country: ["united states"], sizeBand: ["51-200"] });
  assert.equal(icpMarketFilter(emptySpec()), null, "an ICP that narrows nothing has no market to fill");
  assert.equal(gapKey(spec), gapKey({ ...spec, market: { ...spec.market, industries: ["computer software"] } }));
  assert.notEqual(gapKey(spec), gapKey({ ...spec, persona: { ...spec.persona, levels: ["vp"] } }), "new buyers are new criteria");
});

test("AI-field levels: drilled answers filter accounts and save as ICP criteria", async () => {
  const { levelsFor, pivotFilter, valueLabel } = await import("../src/lib/tam-levels.ts");
  const { drillToSpec } = await import("../src/lib/drill-to-icp.ts");
  const meta = [{ key: "jtbd", kind: "choice" as const, label: "JTBD" }, { key: "model", kind: "choice" as const, label: "Business model", field: true, options: [{ key: "saas", label: "SaaS" }] }];
  assert.deepEqual(levelsFor(meta, false).slice(-1), ["field:model"]);
  const pivot = { group: "industry" as const, filters: [{ dim: "industry" as const, values: ["software development"] }, { dim: "field:model" as const, values: ["saas"] }], values: ["count" as const] };
  assert.deepEqual(pivotFilter(pivot).custom, { model: ["saas"] });
  assert.equal(valueLabel("field:model", "saas", { segments: meta }), "SaaS");
  assert.equal(valueLabel("field:model", "__none__", { segments: meta }), "Not answered");
  const { spec, unsaved } = drillToSpec(pivot, (d) => d);
  assert.deepEqual(spec.custom, [{ slug: "model", values: ["saas"] }]);
  assert.deepEqual(unsaved, []);
});

test("an ICP's buyer reads its persona as the outbound search does: level x department or topic, or a title naming its own level", () => {
  const spec = { ...emptySpec(), persona: { levels: ["vp", "head"], departments: [], titles: ["revenue operations", "sales operations", "head of sales"], countries: ["us"] }, exclude: { industries: [], countries: [], titles: ["intern"] } };
  const buyer = specBuyer(spec, canonFit.buyerLevels);
  assert.deepEqual(buyer, { levels: ["vp", "head"], departments: ["revenue operations"], topics: ["revenue operations", "sales operations"], titles: ["head of sales"], exclude: ["intern"] });
  const who = ["VP RevOps", "Head of Revenue Operations", "Head of Sales", "Director of Revenue Operations", "VP Marketing", "RevOps Intern"].filter((t) => isBuyer(t, buyer));
  assert.deepEqual(who, ["VP RevOps", "Head of Revenue Operations", "Head of Sales"]);
  assert.deepEqual(specBuyer(emptySpec(), canonFit.buyerLevels).levels, ["cxo", "vp", "head", "director"], "no level picked means the senior buyers");
  const titleOnly = specBuyer({ ...emptySpec(), persona: { levels: [], departments: [], titles: ["Head of Sales"], countries: [] } }, canonFit.buyerLevels);
  assert.deepEqual([isBuyer("Head of Sales", titleOnly), isBuyer("VP Engineering", titleOnly)], [true, false], "a title that names its level is the whole buyer");
  const gate = { id: "i", base: 10, max: 10, industries: {}, countries: {}, employees: [], excludeIndustries: [], excludeCountries: [], custom: [], buyer };
  assert.deepEqual(gatedFit({ titles: ["VP Marketing"] }, [gate]), { fit: 0, icpIds: [] });
  assert.deepEqual(gatedFit({ titles: ["VP RevOps"] }, [gate]), { fit: 1, icpIds: ["i"] });
});

test("canonDepartments: every department an ICP counts is one the form shows", () => {
  // A derived ICP on dev, 2026-10-12: "finance" and "accounting" hid behind the Revenue operations chip and let a VP of Finance in.
  assert.deepEqual(canonDepartments(["sales operations", "finance", "revenue operations", "accounting", "Revenue operations", "Procurement"]), ["Revenue operations", "Finance", "Procurement"]);
  const buyer = specBuyer({ ...emptySpec(), persona: { levels: ["vp"], departments: ["Revenue operations"], titles: [], countries: [] } }, canonFit.buyerLevels);
  assert.deepEqual(["VP RevOps", "VP Finance", "VP of Sales"].filter((t) => isBuyer(t, buyer)), ["VP RevOps"]);
});
