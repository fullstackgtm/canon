import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { waterfall, waterfallFigure } from "../src/lib/waterfall.ts";

test("a waterfall walks from the start through signed steps to the end", () => {
  const w = waterfall({ label: "At the start", value: 500 }, [
    { label: "New", value: 200 }, { label: "Zero", value: 0 }, { label: "Lost", value: -150 }, { label: "Slipped", value: -100 },
  ], { label: "At the end", value: 450 });
  assert.deepEqual(w.bars.map((b) => [b.label, b.from, b.to, b.kind, b.row]), [
    ["At the start", 0, 500, "total", undefined],
    ["New", 500, 700, "up", 0],
    // A step that changed nothing draws no bar; the rows keep their own indexes for a click.
    ["Lost", 700, 550, "down", 2],
    ["Slipped", 550, 450, "down", 3],
    ["At the end", 0, 450, "total", undefined],
  ]);
  assert.equal(w.gap, null);
  assert.deepEqual([w.min, w.max], [0, 700]);
});

test("a waterfall says when its end doesn't add up, and takes the end from the steps when none is given", () => {
  const off = waterfall({ label: "Start", value: 100 }, [{ label: "Lost", value: -40 }], { label: "End", value: 80 });
  assert.equal(off.gap, 20);
  assert.equal(off.bars.at(-1)!.to, 80);
  const derived = waterfall({ label: "Start", value: 100 }, [{ label: "Lost", value: -140 }], { label: "End" });
  assert.equal(derived.gap, null);
  assert.equal(derived.bars.at(-1)!.to, -40);
  assert.equal(derived.min, -40);
});

test("a waterfall chart draws a call's steps with a start, and takes none of a grouped chart's keys", () => {
  const forecast = () => JSON.parse(readFileSync("modules/examples/forecast/module.json", "utf8"));
  assert.equal(parseModuleManifest(forecast()).ok, true);
  const m = forecast();
  const page = m.pages.findIndex((p: { path: string }) => p.path === "moved");
  const body = m.pages[page].body;
  const at = body.findIndex((n: { kind?: string }) => n.kind === "waterfall");
  delete body[at].y;
  delete body[at].start;
  body[at].series = "step";
  body.push({ c: "chart", kind: "bar", from: "moved", rows: "steps", x: "step", start: "start" });
  const out = parseModuleManifest(m);
  assert.equal(out.ok, false);
  const errors = out.ok ? [] : out.errors.filter((e) => e.startsWith(`pages[${page}]`));
  assert.deepEqual(errors.map((e) => e.split(/[ :]/)[0]).sort(), [
    `pages[${page}].body[${at}].series`, `pages[${page}].body[${at}].start`, `pages[${page}].body[${at}].y`, `pages[${page}].body[${body.length - 1}].start`,
  ].sort());
});

test("a waterfall's full money labels keep their cents; compact ones abbreviate", () => {
  const full = waterfallFigure("money", false), short = waterfallFigure("money", true);
  assert.deepEqual([full(75_000_050), full(-1_234_599), full(0), short(75_000_050), short(-1_234_599)], ["$750,000.50", "−$12,345.99", "$0.00", "$750K", "−$12.3K"]);
  assert.deepEqual([waterfallFigure("percent", false)(0.125), waterfallFigure(undefined, false)(1234.5)], ["12.5%", "1,234.5"]);
});
