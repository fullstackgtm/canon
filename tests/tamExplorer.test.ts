import { test } from "node:test";
import assert from "node:assert/strict";
import { squarify } from "../src/lib/squarify.ts";
import {
  DEFAULT_PIVOT,
  MAX_FILTERS,
  MAX_FILTER_VALUES,
  currentRow,
  drill,
  levelsFor,
  parsePivot,
  pivotFilter,
  placeValue,
  removeValue,
  serializePivot,
  setFilter,
  setGroup,
  valueLabel,
  zoomOut,
} from "../src/lib/tam-levels.ts";
import { NONE, regionOf, sizeBandOf } from "../services/record-service/src/dimensions.ts";
import {
  annotateRow,
  createFakeRecordClient,
  createMemoryRecordStore,
  facetRows,
  matchesFilter,
} from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import { MAX_JTBD_OPTIONS, bucketFor, jtbdOptions, revenueFrom, traitKeyFor } from "../convex/lib/tam/jevSegments.ts";

test("squarify fills the box with areas proportional to values", () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: i, v }));
  const tiles = squarify(items, (x) => x.v, { x: 0, y: 0, w: 600, h: 400 });
  assert.equal(tiles.length, 7);
  const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
  assert.ok(Math.abs(area - 240_000) < 1e-6);
  for (const t of tiles) {
    assert.ok(Math.abs(t.w * t.h - (t.value / 24) * 240_000) < 1e-6);
    assert.ok(t.x >= -1e-9 && t.y >= -1e-9 && t.x + t.w <= 600 + 1e-6 && t.y + t.h <= 400 + 1e-6);
  }
  // squarified: no sliver tiles for a balanced input
  assert.ok(tiles.every((t) => Math.max(t.w / t.h, t.h / t.w) < 4));
  assert.deepEqual(squarify([{ v: 0 }, { v: -1 }], (x) => x.v, { x: 0, y: 0, w: 10, h: 10 }), []);
});

test("squarify lays a `last` item out after the rest, whatever its size, so it ends bottom-right", () => {
  const items = [{ id: "rest", v: 9 }, ...[6, 4, 3, 2].map((v, i) => ({ id: `g${i}`, v }))];
  const tiles = squarify(items, (x) => x.v, { x: 0, y: 0, w: 600, h: 400 }, { last: (x) => x.id === "rest" });
  assert.equal(tiles.at(-1)?.item.id, "rest");
  const rest = tiles.at(-1)!;
  assert.ok(Math.abs(rest.x + rest.w - 600) < 1e-6 && Math.abs(rest.y + rest.h - 400) < 1e-6);
});

test("view: drill steps down the level list, AI segments included", () => {
  const levels = levelsFor([{ key: "jtbd" }, { key: "reps" }], true);
  assert.deepEqual(levels, ["industry", "sizeBand", "region", "country", "trait:jtbd", "trait:reps"]);
  assert.deepEqual(levelsFor([{ key: "reps" }], false), ["industry", "sizeBand", "region", "country", "trait:reps"]);

  let p = DEFAULT_PIVOT;
  assert.deepEqual(p, { group: "industry", filters: [], values: ["count"] });
  assert.equal(currentRow(p, levels), "industry");
  p = drill(p, "industry", "computer software");
  assert.equal(currentRow(p, levels), "sizeBand");
  p = drill(p, "sizeBand", "51-200");
  assert.equal(currentRow(p, levels), "region");
  assert.deepEqual(pivotFilter(p), { industry: ["computer software"], sizeBand: ["51-200"] });
  for (const d of ["region", "country", "trait:jtbd"] as const) p = drill(p, d, "x");
  assert.equal(currentRow(p, levels), "trait:reps");
  assert.equal(currentRow(drill(p, "trait:reps", "yes"), levels), null);

  // Zoom out clears the deepest drill.
  assert.equal(currentRow(zoomOut(p, levels), levels), "trait:jtbd");
  assert.equal(zoomOut(DEFAULT_PIVOT, levels), DEFAULT_PIVOT);

  // Group by moves the start; a narrowed start level is reopened. Unknown groups start at the top.
  const fromSize = setGroup(drill(DEFAULT_PIVOT, "sizeBand", "1-10"), "sizeBand");
  assert.equal(currentRow(fromSize, levels), "sizeBand");
  assert.deepEqual(fromSize.filters, []);
  assert.equal(currentRow({ ...DEFAULT_PIVOT, group: "trait:gone" }, levels), "industry");

  // A multi-value filter keeps its level as the grouping; an empty filter matches everything.
  assert.equal(currentRow(setFilter(DEFAULT_PIVOT, "industry", ["a", "b"]), levels), "industry");
  assert.deepEqual(pivotFilter(setFilter(DEFAULT_PIVOT, "trait:reps", [])), {});
  assert.deepEqual(pivotFilter(setFilter(DEFAULT_PIVOT, "trait:reps", ["yes"])).traits, { reps: ["yes"] });

  // Values: reorder, and the last metric can't be removed.
  assert.deepEqual(placeValue(placeValue(DEFAULT_PIVOT, "revenue"), "revenue", 0).values, ["revenue", "count"]);
  assert.deepEqual(removeValue(DEFAULT_PIVOT, "count").values, ["count"]);

  assert.deepEqual(parsePivot(serializePivot(p)), p);
  // Every level can carry a filter, and a full filter survives the URL.
  const wide = levelsFor(Array.from({ length: 50 }, (_, i) => ({ key: `s${i}` })), true);
  const many = wide.reduce((acc, d) => setFilter(acc, d, Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `v${i}`)), DEFAULT_PIVOT);
  assert.ok(wide.length <= MAX_FILTERS);
  assert.deepEqual(parsePivot(serializePivot(many)), many);
  assert.deepEqual(parsePivot("not json"), DEFAULT_PIVOT);
  assert.deepEqual(
    parsePivot('{"g":"bogus","f":[["region",["europe",3]],["region",["x"]]],"v":["nope"]}'),
    { group: "industry", filters: [{ dim: "region", values: ["europe"] }], values: ["count"] },
  );
});

test("labels for dimension values", () => {
  assert.equal(valueLabel("sizeBand", "51-200"), "51–200 employees");
  assert.equal(valueLabel("region", "asia-pacific"), "Asia-Pacific");
  assert.equal(valueLabel("industry", "hospital & health care"), "Hospital & Health Care");
  assert.equal(valueLabel("industry", NONE), "Unknown");
  assert.equal(valueLabel("trait:reps", NONE), "Not scored yet");
  assert.equal(valueLabel("trait:jtbd", "staffing", { segments: [{ key: "jtbd", kind: "choice", label: "JTBD", options: [{ key: "staffing", label: "Staffing agencies" }] }] }), "Staffing agencies");
});

test("dimensions: size bands and regions", () => {
  assert.equal(sizeBandOf(undefined), NONE);
  assert.equal(sizeBandOf(10), "1-10");
  assert.equal(sizeBandOf(11), "11-50");
  assert.equal(sizeBandOf(250_000), "10001+");
  assert.equal(regionOf("United States"), "north-america");
  assert.equal(regionOf(" GB "), "europe");
  assert.equal(regionOf("narnia"), "other");
  assert.equal(regionOf(""), NONE);
});

const row = (over: Partial<AccountRow>): AccountRow => ({
  id: over.domain ?? "a", domain: "a.com", name: "A", fit: 0.5, status: "new", segmentIds: [], source: "t", updatedAt: 0, version: 1, ...over,
});

test("fake facets and filters match the service semantics", () => {
  const rows = [
    row({ id: "1", domain: "1.com", industry: "Software", employees: 40, country: "US", revenue: 10, revenueSource: "crm", traits: { reps: "yes" } }),
    row({ id: "2", domain: "2.com", industry: "software", employees: 300, country: "DE", traits: { reps: "no" } }),
    row({ id: "3", domain: "3.com", employees: 5, country: "Japan", segmentIds: ["s1", "s2"] }),
  ];
  const byIndustry = facetRows(rows, { groupBy: "industry" });
  assert.deepEqual(byIndustry.groups.map((g) => [g.key, g.count, g.revenue]), [["software development", 2, 10], [NONE, 1, 0]]);
  assert.equal(byIndustry.revenueKnown, 1);
  const bySegment = facetRows(rows, { groupBy: "segment" });
  assert.deepEqual(bySegment.groups.map((g) => [g.key, g.count]), [[NONE, 2], ["s1", 1], ["s2", 1]]);
  assert.deepEqual(facetRows(rows, { groupBy: "trait:reps" }).groups.map((g) => g.key), [NONE, "no", "yes"]);

  assert.equal(rows.filter((r) => matchesFilter(r, { region: ["europe"] })).length, 1);
  assert.equal(rows.filter((r) => matchesFilter(r, { sizeBand: ["11-50", "1-10"] })).length, 2);
  assert.equal(rows.filter((r) => matchesFilter(r, { industry: [NONE] })).length, 1);
  assert.equal(rows.filter((r) => matchesFilter(r, { traits: { reps: [NONE] } })).length, 1);
  assert.equal(rows.filter((r) => matchesFilter(r, { segmentId: NONE })).length, 2);
});

test("annotate: estimates never replace CRM revenue; traits merge and clear", () => {
  const crm = row({ revenue: 5, revenueSource: "crm", traits: { a: "1" } });
  assert.equal(annotateRow(crm, { id: "a", revenue: 9, revenueSource: "estimate" }).revenue, 5);
  assert.deepEqual(annotateRow(crm, { id: "a", traits: { a: null, b: "2" } }).traits, { b: "2" });
  const est = annotateRow(row({}), { id: "a", revenue: 7, revenueSource: "estimate", revenueConfidence: 0.4 });
  assert.deepEqual([est.revenue, est.revenueSource, est.revenueConfidence], [7, "estimate", 0.4]);
  assert.equal(annotateRow(est, { id: "a", revenue: null }).revenue, undefined);
});

test("fake client: annotate by id or domain, and re-imports keep derived data", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1 });
  const { ids } = await client.upsertAccounts("ws", { records: [{ domain: "acme.com", name: "Acme" }], source: "t", idempotencyKey: "k1" });
  const res = await client.annotate("ws", [
    { domain: "https://www.ACME.com/", revenue: 100, revenueSource: "crm" },
    { id: ids[0], traits: { reps: "yes" } },
    { domain: "missing.com", revenue: 1 },
  ]);
  assert.deepEqual(res, { updated: 2, missing: ["missing.com"] });
  await client.upsertAccounts("ws", { records: [{ domain: "acme.com", name: "Acme", industry: "software" }], source: "t", idempotencyKey: "k2" });
  const got = await client.get("ws", ids[0]);
  assert.equal(got?.account.revenue, 100);
  assert.deepEqual(got?.account.traits, { reps: "yes" });
  const facets = await client.facets("ws", { groupBy: "trait:reps", filter: { traits: { reps: ["yes"] } } });
  assert.deepEqual(facets.groups, [{ key: "yes", count: 1, revenue: 100, revenueKnown: 1, employees: 0 }]);
});

test("Jev answers become traits and revenue", () => {
  assert.equal(bucketFor({ type: "noul", noul: 0.9 }), "yes");
  assert.equal(bucketFor({ type: "noul", noul: 0.1 }), "no");
  assert.equal(bucketFor({ type: "noul", noul: 0.5 }), "unsure");
  assert.equal(bucketFor({ type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.4 }), "a");
  assert.equal(bucketFor({ type: "choice", choice: "a", probabilities: { a: 0.35, b: 0.33, c: 0.32 }, confidence: 0.02 }), "unsure");
  assert.deepEqual(revenueFrom({ type: "choice", choice: "1m-10m", probabilities: {}, confidence: 0.49 }), { revenue: 3_000_000, confidence: 0.49 });
  assert.equal(revenueFrom({ type: "choice", choice: "bogus", probabilities: {}, confidence: 1 }), null);
  assert.equal(traitKeyFor("Employs commissioned reps!", new Set()), "employs-commissioned-reps");
  assert.equal(traitKeyFor("Reps", new Set(["reps"])), "reps-2");
  assert.equal(traitKeyFor("JTBD", new Set()), "jtbd-2");
  assert.match(traitKeyFor("💸", new Set()), /^[a-z0-9][a-z0-9_-]*$/);
});

test("CRM revenue: cents become dollars, matched by normalized domain, largest wins", async () => {
  const { crmRevenueRecords } = await import("../convex/lib/tam/crmRevenue.ts");
  assert.deepEqual(crmRevenueRecords([
    { domain: "https://www.Acme.com/about", annualRevenueCents: 7_600_000_000 },
    { domain: "acme.com", annualRevenueCents: 100 },
    { domain: "zero.com", annualRevenueCents: 0 },
    { domain: null, annualRevenueCents: 500 },
    { domain: "beta.io", annualRevenueCents: 3_100_000_050 },
  ]), [
    { domain: "acme.com", revenue: 76_000_000, revenueSource: "crm" },
    { domain: "beta.io", revenue: 31_000_001, revenueSource: "crm" },
  ]);
});

test("jobs to be done come from researched jobs, falling back to buyer types", () => {
  const buyer = { archetype: "staffing_hr/staffing_agency", label: "Staffing agencies", why: "Pay recruiters per placement." };
  const fromJobs = jtbdOptions({ jobs: ["calculate sales commissions", "Calculate  sales commissions", " forecast pipeline "], buyers: [buyer], adjacent: [] });
  assert.equal(fromJobs.from, "jobs");
  assert.deepEqual(fromJobs.options, [
    { key: "calculate-sales-commissions", label: "Calculate sales commissions" },
    { key: "forecast-pipeline", label: "Forecast pipeline" },
  ]);

  const fromBuyers = jtbdOptions({ jobs: [], buyers: [buyer], adjacent: [] });
  assert.equal(fromBuyers.from, "buyers");
  assert.deepEqual(fromBuyers.options, [{ key: "staffing-hr-staffing-agency", label: "Staffing agencies", description: "Pay recruiters per placement." }]);

  const many = jtbdOptions({ jobs: Array.from({ length: 30 }, (_, i) => `job ${i}`), buyers: [], adjacent: [] });
  assert.equal(many.options.length, MAX_JTBD_OPTIONS);
  assert.equal(jtbdOptions(undefined).options.length, 0);
  // "none" is reserved for the Choice's own "none of these" option.
  assert.equal(jtbdOptions({ jobs: ["None"], buyers: [], adjacent: [] }).options.length, 0);
});

test("facets sum employees for the opportunity metric", () => {
  const rows = [
    { id: "a", industry: "software", employees: 100 },
    { id: "b", industry: "software" },
    { id: "c", industry: "retail", employees: 40 },
  ] as Partial<AccountRow>[];
  const res = facetRows(rows, { groupBy: "industry" });
  assert.equal(res.employees, 140);
  assert.equal(res.groups.find((g) => g.key === "software development")?.employees, 100);
});
