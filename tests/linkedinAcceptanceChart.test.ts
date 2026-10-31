import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as acceptance from "../convex/lib/linkedin/acceptance.ts";
import * as cadence from "../convex/lib/linkedin/cadence.ts";

const DAY = 86_400_000;
const start = Date.UTC(2026, 9, 1);
const rows: acceptance.Timed[] = [
  { state: "connected", invitedAt: start + 1000, connectedAt: start + 3 * DAY, acceptedAt: start + 2 * DAY },
  { state: "withdrawn", invitedAt: start + 2000 },
  { state: "connected", invitedAt: start + 2 * DAY, connectedAt: start + 3 * DAY },
  { state: "connected", connectedAt: start },
  { state: "queued" },
  { state: "invited", invitedAt: start + 10 * DAY },
];

test("daily cumulative counts use event dates, carry idle days, and exclude unsent invites and existing connections", () => {
  assert.deepEqual(acceptance.cumulativeAcceptance(rows, start + 4 * DAY), [
    { at: start, invited: 2, accepted: 0 },
    { at: start + DAY, invited: 2, accepted: 0 },
    { at: start + 2 * DAY, invited: 3, accepted: 1 },
    { at: start + 3 * DAY, invited: 3, accepted: 2 },
    { at: start + 4 * DAY, invited: 3, accepted: 2 },
  ]);
  assert.deepEqual(acceptance.cumulativeAcceptance([], start), []);
});

const require = createRequire(import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/linkedin/cadence-insights.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exports: {
  AcceptanceCharts?: React.ComponentType<{ rows: acceptance.Timed[]; timezone: string; now: number }>;
  CadenceActivity?: React.ComponentType<{ cadences: { acceptanceDays: acceptance.AcceptanceDay[]; funnelTruncated: boolean }[] }>;
} = {};
runInNewContext(outputText, { exports, require: (id: string) => {
  if (id.endsWith("/acceptance")) return acceptance;
  if (id.endsWith("/cadence")) return cadence;
  if (id === "@/lib/utils") return { cn: (...args: unknown[]) => args.filter(Boolean).join(" ") };
  return require(id);
} });
const render = (data: acceptance.Timed[], now: number) => renderToStaticMarkup(createElement(exports.AcceptanceCharts!, { rows: data, now, timezone: "UTC" }));

test("overview sums cadences on a shared UTC calendar and discloses incomplete scans", () => {
  const cadences = [
    { acceptanceDays: acceptance.cumulativeAcceptance(rows, start + 4 * DAY), funnelTruncated: false },
    { acceptanceDays: acceptance.cumulativeAcceptance([{ state: "connected", invitedAt: start + DAY, connectedAt: start + 2 * DAY }], start + 4 * DAY), funnelTruncated: false },
    { acceptanceDays: [], funnelTruncated: false },
  ];
  const renderActivity = () => renderToStaticMarkup(createElement(exports.CadenceActivity!, { cadences }));
  const html = renderActivity();
  assert.match(html, /4 invites sent and 3 acceptances/);
  assert.match(html, /Oct 1: 2 invites sent/);
  assert.match(html, /Oct 2: 3 invites sent/);
  assert.match(html, /Oct 3: 2 acceptances/);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.doesNotMatch(html, /Partial totals/);
  cadences[2].funnelTruncated = true;
  assert.match(renderActivity(), /Partial totals/);
  cadences.length = 0;
  assert.doesNotMatch(renderActivity(), /<svg/);
});

test("campaign charts stay compact and use theme colors in overview and cadence detail", () => {
  const charts = [
    render(rows, start + 4 * DAY),
    renderToStaticMarkup(createElement(exports.CadenceActivity!, { cadences: [
      { acceptanceDays: acceptance.cumulativeAcceptance(rows, start + 4 * DAY), funnelTruncated: false },
    ] })),
  ];
  for (const html of charts) {
    assert.match(html, /<figure aria-label="Cumulative campaign performance" class="w-full max-w-\[720px\]"/);
    assert.match(html, /<svg[^>]*class="mt-2 w-full text-muted-foreground"/);
    for (const color of ["var(--primary)", "var(--muted-foreground)"]) {
      assert.ok(html.includes(`stroke="${color}"`));
      assert.ok(html.includes(`fill="${color}"`));
      assert.ok(html.includes(`border-color:${color}`));
    }
    assert.match(html, /stroke-dasharray="5 3"/);
  }
});

test("cadence acceptance section renders both cumulative lines and handles empty and single-day histories", () => {
  const html = render(rows, start + 4 * DAY);
  assert.match(html, /aria-label="Cumulative campaign performance"/);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.match(html, /3 invites sent and 2 acceptances/);
  assert.match(html, /Oct 1/);
  assert.match(html, /Oct 5/);
  assert.doesNotMatch(render([], start), /<svg/);
  const single = render([{ state: "invited", invitedAt: start }], start);
  assert.match(single, /<circle/);
  assert.doesNotMatch(single, /NaN|Infinity/);
});
