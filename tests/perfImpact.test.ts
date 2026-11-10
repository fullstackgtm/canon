import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { BASELINE, compareImpact, markdownReport, measureImpact, type Metrics } from "../scripts/perf-impact.ts";

const measuredPaths = [
  "scripts/perf-impact.ts",
  "perf/baseline.json",
  "engine/src/connectors/hubspot.ts",
  "engine/src/types.ts",
  "engine/src/mappings.ts",
  "engine/src/progress.ts",
  "engine/src/connectors/hubspotPacing.ts",
  "engine/src/sync/salesforceImport/contracts.ts",
  "engine/src/sync/hubspotImport/client.ts",
  "engine/src/sync/hubspotImport/testing/fakeHubspot.ts",
  "engine/src/sync/salesforceImport/testing/fakeSalesforce.ts",
  "engine/src/sync/salesforceImport/sfClient.ts",
  "convex/hubspot.ts",
  "convex/lib/hubspotSyncValue.ts",
  "convex/lib/syncUnchanged.ts",
  "convex/lib/hubspotSyncPlan.ts",
  "convex/lib/pagePrefetch.ts",
  "convex/lib/hubspotSlices.ts",
  "convex/lib/hubspotMirror.ts",
];

test("every measured module is named for PR test selection and exists", async () => {
  for (const path of measuredPaths) await access(new URL(`../${path}`, import.meta.url));
});

test("stack-free sync counts stay within the performance impact baseline", async (t) => {
  const saved: Metrics = JSON.parse(await readFile(BASELINE, "utf8"));
  const baseline = Object.fromEntries(Object.entries(saved).filter(([key]) => !key.startsWith("page.")));
  const metrics = await measureImpact();
  assert.ok(Object.keys(metrics).every((key) => !key.startsWith("page.")), "Stack-free measurement must not require page loads");
  for (const [scenario, read, written] of [["full", 1520, 1520], ["fullRepeat", 1520, 0], ["incremental", 15, 15], ["noChange", 15, 0]] as const) {
    assert.equal(metrics[`sync.hubspot.${scenario}.rowsRead`], read, `${scenario} must consume every expected row`);
    assert.equal(metrics[`sync.hubspot.${scenario}.rowsWritten`], written, `${scenario} must make exactly the expected upsert decisions`);
  }
  assert.equal(metrics["sync.salesforce.full.rowsRead"], 1600);
  const comparison = compareImpact(metrics, baseline);
  for (const row of comparison.filter((row) => row.marker === "WARN")) t.diagnostic(`WARN ${row.name}: ${row.before} -> ${row.value} (${row.percent?.toFixed(2)}%)`);
  assert.equal(comparison.filter((row) => row.marker === "FAIL").length, 0, `${markdownReport(metrics, baseline)}\nRegenerate and review the baseline with npm run perf:impact -- --write-baseline`);
});

test("baseline comparison detects new, removed, growing and shrinking counts", () => {
  const markers = (metrics: Metrics, baseline: Metrics) => compareImpact(metrics, baseline).map(({ name, marker }) => [name, marker]);
  assert.deepEqual(markers({ new: 1 }, { removed: 1 }), [["new", "FAIL"], ["removed", "FAIL"]]);
  assert.deepEqual(markers({ count: 89 }, { count: 100 }), [["count", "FAIL"]]);
  assert.deepEqual(markers({ count: 90 }, { count: 100 }), [["count", ""]]);
  assert.deepEqual(markers({ count: 110 }, { count: 100 }), [["count", ""]]);
  assert.deepEqual(markers({ count: 111 }, { count: 100 }), [["count", "WARN"]]);
  assert.deepEqual(markers({ count: 125 }, { count: 100 }), [["count", "WARN"]]);
  assert.deepEqual(markers({ count: 126 }, { count: 100 }), [["count", "FAIL"]]);
  assert.deepEqual(markers({ count: 1 }, { count: 0 }), [["count", "FAIL"]]);
  assert.deepEqual(markers({ count: 0 }, { count: 0 }), [["count", ""]]);
  assert.match(markdownReport({ count: 80 }, { count: 100 }), /-20.*-20.00%.*FAIL/);
});
