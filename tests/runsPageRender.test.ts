import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as runChart from "../src/lib/run-chart.ts";
import { formatDuration } from "../src/lib/format-duration.ts";

const require = createRequire(import.meta.url);
function load(path: string, stubs: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: Record<string, () => ReactNode> = {};
  runInNewContext(outputText, {
    exports,
    require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected dependency: ${id}`);
      return require(id);
    },
  });
  return exports;
}

const utils = { cn: (...classes: unknown[]) => classes.filter(Boolean).join(" ") };
const progress = load("../src/components/dashboard/progress-chip.tsx", { "@/lib/utils": utils });
const phaseBars = load("../src/components/job-phase-bars.tsx", { "@/lib/utils": utils });
const chart = load("../src/components/run-chart.tsx", { "@/lib/run-chart": runChart });
type Control = { "aria-label"?: string; children?: ReactNode; onClick?: () => void; onValueChange?: (value: string) => void };
function renderRows(rows: object[], state: unknown[] = [], controls: Control[] = [], status = "Exhausted", loads: number[] = []) {
  let stateIndex = 0;
  const runtime = require("react/jsx-runtime");
  const capture = (factory: typeof runtime.jsx) => (type: unknown, props: Control, key: unknown) => {
    if (props.onClick || props.onValueChange) controls.push(props);
    return factory(type, props, key);
  };
  const page = load("../src/app/dashboard/runs/page.tsx", {
    "react/jsx-runtime": { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) },
    react: { ...require("react"), useEffect: (effect: () => void) => effect(), useState: (initial: unknown) => {
      const index = stateIndex++;
      return [state[index] ?? initial, (value: unknown) => { state[index] = value; }];
    } },
    "@/components/run-chart": chart,
    "next/link": { default: ({ children }: { children: ReactNode }) => children },
    "convex/react": { usePaginatedQuery: (_query: unknown, { source }: { source: string }) => ({
      results: source === "jobs" ? rows : [], status: source === "jobs" ? status : "Exhausted", loadMore: (count: number) => loads.push(count),
    }), useMutation: () => async () => null },
    "../../../../convex/_generated/api": { api: { activity: { feed: {} }, populateActions: { stop: {} } } },
    "@/lib/toast": { toast: { error: () => undefined } },
    "@/lib/format-duration": { formatDuration },
    "@/components/dashboard": {
      ...progress,
      ViewFrame: ({ title, controls, children }: { title: string; controls?: ReactNode; children: ReactNode }) => createElement("main", null, createElement("h1", null, title), controls, children),
    },
    "@/components/job-phase-bars": phaseBars,
    "@/lib/utils": { ...utils, getErrorMessage: String },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
  });
  return renderToStaticMarkup(createElement(page.default));
}
const row = { id: "run", kind: "records", title: "Populate", status: "in_progress", at: 1 };
const text = (html: string) => html.replace(/<[^>]*>/g, "");

test("runs keeps static and live in-progress chips on one line in a scrollable table", () => {
  const html = renderRows([row, { ...row, id: "sync", kind: "sync" }, { ...row, id: "cli", kind: "cli" }]);
  const chips = [...html.matchAll(/<span class="([^"]*)"[^>]*>(?:<span[^>]*><\/span>)?in progress<\/span>/g)];
  assert.equal(chips.length, 3);
  for (const chip of chips) assert.ok(chip[1].split(" ").includes("whitespace-nowrap"));
  assert.match(html, /class="overflow-x-auto /);
});

test("runs separates entity results, preserves other metrics and distinguishes zero from absent", () => {
  const html = renderRows([
    { ...row, counts: { calls: 0, accounts: 12, contacts: 34, signals: 5, deals: 8 } },
    { ...row, id: "population", counts: { people: 4, companyNames: 2 } },
    { ...row, id: "evidence", kind: "evidence", counts: { fresh: 3, retained: 7, costUsd: 1.25 } },
  ]);
  assert.deepEqual([...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1])),
    ["Kind", "What ran", "Status", "Calls", "Companies", "People", "Signals", "Duration", "When"]);
  const cells = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].slice(1)
    .map((r) => [...r[1].matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => text(m[1])));
  assert.deepEqual(cells[0].slice(3, 7), ["0", "12", "34", "5"]);
  assert.match(cells[0][1], /8 Deals/);
  assert.deepEqual(cells[1].slice(3, 7), ["—", "2", "4", "—"]);
  assert.deepEqual(cells[2].slice(3, 7), ["—", "—", "—", "3Fresh7Retained"]);
  assert.match(cells[2][1], /\$1.25 Cost Usd/);
});

test("runs displays durations in milliseconds, seconds, minutes and hours", () => {
  const durations = [undefined, 0, 950, 1000, 12_400, 59_900, 60_000, 61_000, 2_350_500, 3_599_999, 3_600_000, 3_660_000, 90_000_000];
  const html = renderRows(durations.map((durationMs, i) => ({ ...row, id: `run-${i}`, durationMs })));
  const cells = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].slice(1)
    .map((r) => [...r[1].matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => text(m[1])));
  assert.deepEqual(cells.map((r) => r[7]), [
    "—", "0ms", "950ms", "1.0s", "12.4s", "59.9s", "1m 0s", "1m 1s", "39m 10s", "59m 59s", "1h 0m", "1h 1m", "25h 0m",
  ]);
});

test("runs offers Stop only on a stoppable population", () => {
  assert.match(text(renderRows([{ ...row, stoppable: true }])), /Stop/);
  assert.doesNotMatch(text(renderRows([row])), /Stop/);
});

test("runs maps only known phases to result metrics even before counts arrive", () => {
  const phase = (key: string) => ({ key, label: key, status: "processing", done: 2, total: 10 });
  const cases = [
    { keys: ["find"], expected: ["—", "—", "2/10", "—"] },
    { keys: ["leadsforge", "quickenrich", "icypeas", "prospeo", "crustdata"], expected: ["—", "—", "10/50", "—"] },
    { keys: ["accounts"], expected: ["—", "2/10", "—", "—"] },
    { keys: ["names"], expected: ["—", "2/10", "—", "—"] },
    { keys: ["rows", "add", "unknown"], expected: ["—", "—", "—", "—"] },
  ];
  for (const { keys, expected } of cases) {
    const html = renderRows([{ ...row, phases: keys.map(phase) }]);
    const cells = [...html.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => text(m[1]));
    assert.deepEqual(cells.slice(3, 7), expected, keys.join(", "));
  }
});

test("runs shows bars only for processing phases and falls back to a status chip", () => {
  const phases = [
    { key: "leadsforge", label: "Active search", status: "processing", done: 2, total: 10 },
    { key: "quickenrich", label: "Finished search", status: "completed", done: 10, total: 10 },
    { key: "icypeas", label: "Waiting search", status: "pending", done: 0, total: 10 },
    { key: "prospeo", label: "Failed search", status: "failed", done: 1, total: 10 },
  ];
  for (const active of [true, false]) {
    const html = renderRows([{ ...row, phases: active ? phases : phases.slice(1), counts: { calls: 13 } }]);
    const cells = [...html.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    assert.equal((cells[2].match(/role="progressbar"/g) ?? []).length, active ? 1 : 0);
    assert.doesNotMatch(cells[2], /Finished search|Waiting search|Failed search/);
    if (active) assert.match(cells[2], /aria-label="Active search"/);
    else assert.equal(text(cells[2]), "in progress");
    assert.equal(text(cells[3]), "13");
    assert.equal(text(cells[5]), active ? "13/40" : "11/30");
  }
});

test("runs places live progress in Status and phase counts in result columns, then removes bars", () => {
  const phases = [
    { key: "leadsforge", label: "Leadsforge people search", status: "processing", done: 10, total: 200, count: 34 },
    { key: "accounts", label: "Named accounts", status: "processing", done: 2, total: 5 },
    { key: "names", label: "Company names", status: "processing", done: 3, total: 20 },
  ];
  for (const status of ["in_progress", "success", "failed"]) {
    const html = renderRows([{ ...row, status, phases, counts: { calls: 17, accounts: 2, people: 34, companyNames: 3 } }]);
    const cells = [...html.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    assert.doesNotMatch(cells[1], /role="progressbar"|people search|34 people/);
    assert.equal((cells[2].match(/role="progressbar"/g) ?? []).length, status === "in_progress" ? 3 : 0);
    assert.doesNotMatch(text(cells[2]), /34 people|10\/200/);
    if (status !== "in_progress") assert.equal(text(cells[2]), status);
    assert.deepEqual(cells.slice(3, 6).map(text), status === "in_progress" ? ["17", "2/5Accounts3/20Company Names", "10/200"] : ["17", "2Accounts3Company Names", "34"]);
  }
  const starting = renderRows([{ ...row, phases: phases.map((p) => ({ ...p, done: 0 })), counts: { calls: 0, people: 0 } }]);
  const cells = [...starting.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => text(m[1]));
  assert.deepEqual(cells.slice(3, 6), ["0", "0/5Accounts0/20Company Names", "0/200"]);
});


test("runs defaults to a daily chart over all filtered rows and paginates the table", () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ ...row, id: `run-${i}`, title: `Run number ${i}`, at: Date.UTC(2026, 9, 12), kind: i === 50 ? "sync" : "records" }));
  const state: unknown[] = [];
  const controls: Control[] = [];
  const first = renderRows(rows, state, controls);
  assert.match(first, /aria-label="daily run counts by type"/);
  assert.match(first, /Records: 50/);
  assert.match(first, /Sync: 1/);
  assert.equal((first.match(/<tr /g) ?? []).length, 26);
  assert.match(first, /<button disabled=""[^>]*>Previous/);
  assert.match(first, /Page 1 of 3/);
  controls.find((control) => control.children === "Next")!.onClick!();
  assert.match(renderRows(rows, state), /Page 2 of 3/);
  controls.find((control) => control.onValueChange)!.onValueChange!("monthly");
  assert.match(renderRows(rows, state), /aria-label="monthly run counts by type"/);
  controls.find((control) => control.children === "Sync")!.onClick!();
  assert.equal(state[0], "sync");
  assert.equal(state[2], 0);
  assert.match(renderRows(rows, state), /Page 1 of 1/);
  const last = renderRows(rows, ["all", "weekly", 2]);
  assert.match(last, /aria-label="weekly run counts by type"/);
  assert.equal((last.match(/<tr /g) ?? []).length, 2);
  assert.match(last, /Run number 50/);
  assert.match(last, /<button disabled=""[^>]*>Next/);
  const filtered = renderRows(rows, ["sync", "hourly", 2]);
  assert.match(filtered, /Page 1 of 1/);
  assert.match(filtered, /Sync: 1/);
  assert.doesNotMatch(filtered, /Records: 50/);
  assert.doesNotMatch(renderRows([]), /<svg role="img"|Run pages/);
});

test("runs date range filters chart and table, combines with type, and resets pagination", () => {
  const now = Date.now();
  const rows = [1, 10, 40, 100].map((days) => ({ ...row, id: String(days), title: `Age ${days} days`, at: now - days * 86_400_000 }));
  rows.push({ ...rows[0], id: "sync", kind: "sync", title: "Recent sync" });
  const state: unknown[] = ["all", "daily", 2];
  const controls: Control[] = [];
  assert.match(renderRows(rows, state, controls), /Age 100 days/);
  const range = controls.find((control) => control["aria-label"] === "Run date range");
  assert.ok(range?.onValueChange, "date range dropdown is available");
  for (const [value, count] of [["7", 1], ["30", 2], ["90", 3], ["all", 4]] as const) {
    range.onValueChange(value);
    assert.equal(state[2], 0);
    const html = renderRows(rows, state);
    assert.equal((html.match(/<tr /g) ?? []).length, count + 2);
    assert.equal((html.match(/Records: 1<\/title>/g) ?? []).length, count);
  }
  range.onValueChange("7");
  controls.find((control) => control.children === "Records")!.onClick!();
  const filtered = renderRows(rows, state);
  assert.match(filtered, /Age 1 days/);
  assert.doesNotMatch(filtered, /Age 10 days|Recent sync|Sync: 1/);
  assert.match(renderRows([rows[3]], state), /No activity in this date range/);
});

test("runs loads remaining history and charts more than 100 entries without claiming partial totals are complete", () => {
  const rows = Array.from({ length: 121 }, (_, i) => ({ ...row, id: `run-${i}`, at: Date.UTC(2026, 9, 12) }));
  const loads: number[] = [];
  const partial = renderRows(rows.slice(0, 50), [], [], "CanLoadMore", loads);
  assert.deepEqual(loads, [50]);
  assert.match(text(partial), /totals are partial/);
  assert.match(partial, /Records: 50/);
  const complete = renderRows(rows);
  assert.match(complete, /Records: 121/);
  assert.match(complete, /Page 1 of 5/);
  assert.doesNotMatch(complete, /totals are partial/);
  assert.match(renderRows([], [], [], "LoadingFirstPage"), /Loading activity/);
});

test("run chart buckets are UTC calendar periods, ordered, and retain separate types", () => {
  const rows = [
    { at: Date.parse("2026-02-02T01:59:59Z"), kind: "sync" as const },
    { at: Date.parse("2026-01-31T23:59:59Z"), kind: "records" as const },
    { at: Date.parse("2026-02-01T00:00:00Z"), kind: "records" as const },
    { at: Date.parse("2026-02-02T01:00:00Z"), kind: "records" as const },
    { at: Date.parse("2026-02-02T01:00:00Z"), kind: "research" as const },
  ];
  const expected = {
    hourly: ["2026-01-31T23:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-02-02T01:00:00.000Z"],
    daily: ["2026-01-31T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"],
    weekly: ["2026-01-26T00:00:00.000Z", "2026-02-02T00:00:00.000Z"],
    monthly: ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
  };
  for (const interval of ["hourly", "daily", "weekly", "monthly"] as const) {
    const buckets = runChart.groupRuns(rows, interval);
    assert.deepEqual(buckets.map((bucket) => new Date(bucket.at).toISOString()), expected[interval]);
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.counts.records, 0), 3);
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.counts.sync, 0), 1);
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.counts.research, 0), 1);
    assert.equal(buckets.at(-1)?.counts.sync, 1);
  }
  assert.deepEqual(runChart.groupRuns([], "daily"), []);
});

test("research runs remain visible in the chart and the Research filter", () => {
  const rows = [{ ...row, kind: "research", title: "Product research", at: Date.UTC(2026, 9, 20) }];
  const html = renderRows(rows, ["research"]);
  assert.match(html, /Research: 1<\/title>/);
  assert.match(html, /Product research/);
  assert.doesNotMatch(html, /NaN|fill="undefined"/);
});
