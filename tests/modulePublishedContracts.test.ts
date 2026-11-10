import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calls } from "../modules/examples/monthly-goals/server.ts";
import type { CallContext, ReadDoc } from "../modules/kernel/calls.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { renderText } from "../modules/kernel/text.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";

function manifest(slug: string) {
  const parsed = parseModuleManifest(JSON.parse(readFileSync(`modules/examples/${slug}/module.json`, "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.manifest;
}

function publishedFixture() {
  const m = manifest("reports");
  m.collections.tallies = {
    schema: { type: "object", value: {
      month: { fieldType: { type: "string" }, optional: false },
      rep: { fieldType: { type: "string" }, optional: false },
      amount: { fieldType: { type: "number" }, optional: false },
      ytd: { fieldType: { type: "number" }, optional: false },
    } },
    key: "auto", indexes: { byMonth: ["month"] }, access: { manager: "all", rep: "all" },
  };
  m.views["tallies.forMonths"] = { kind: "list", collection: "tallies", args: { months: "string[]" }, index: "byMonth", eq: [{ arg: "months" }] };
  m.provides = { "tallies.v1": { view: "tallies.forMonths", fields: ["month", "rep", "amount"] } };
  const parsed = parseModuleManifest(m);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.manifest;
}

test("an upgrade cannot make a published required field optional", () => {
  const from = publishedFixture(), to = structuredClone(from);
  to.collections.tallies.schema.value.amount.optional = true;
  assert.equal(planUpgrade(from, defaultSlots(from), to).problems.length, 1);
});

test("an upgrade cannot remap a published view to another collection with the same schema", () => {
  const from = publishedFixture(), to = structuredClone(from);
  to.collections.otherTallies = structuredClone(to.collections.tallies);
  to.views["tallies.forMonths"].collection = "otherTallies";
  assert.equal(planUpgrade(from, defaultSlots(from), to).problems.length, 1);
});

test("an upgrade can change unpublished fields and published field presentation", () => {
  const from = publishedFixture(), to = structuredClone(from);
  to.collections.tallies.schema.value.ytd.optional = true;
  Object.assign(to.collections.tallies.schema.value.amount, { label: "Won revenue", help: "Revenue in minor units", widget: "money" });
  to.views["tallies.presentation"] = to.views["tallies.forMonths"];
  to.provides!["tallies.v1"].view = "tallies.presentation";
  assert.deepEqual(planUpgrade(from, defaultSlots(from), to).problems, []);
});

test("a new interface version can use a new collection beside unchanged v1", () => {
  const from = publishedFixture(), to = structuredClone(from);
  to.collections.otherTallies = structuredClone(to.collections.tallies);
  to.collections.otherTallies.schema.value.amount.optional = true;
  to.views["tallies.revised"] = { ...to.views["tallies.forMonths"], collection: "otherTallies" };
  to.provides!["tallies.v2"] = { ...to.provides!["tallies.v1"], view: "tallies.revised" };
  assert.deepEqual(planUpgrade(from, defaultSlots(from), to).problems, []);
});

const ctx: CallContext = { now: 0, caller: { userId: "manager", role: "manager" }, args: {}, workspace: { currency: "USD", fiscalYearStartMonth: 1 } };
const doc = (key: string, data: Record<string, unknown>): ReadDoc => ({ key, data, version: 1, owner: "rep1", parentKey: null, createdAt: 0, updatedAt: 0 });

test("Monthly goals counts each rep's won deals by month and renders money, zero and an uncounted month distinctly", async () => {
  const now = Date.UTC(2026, 11, 15);
  const deal = (ownerId: string, closeDate: string, amount: number, isWon = true) => ({ id: `${ownerId}-${closeDate}`, ownerId, closeDate, amount, isWon });
  const out = await calls.progress({ ...ctx, now }, {
    goals: [doc("nov", { month: "2026-11", rep: "rep1", won: 2 }), doc("dec", { month: "2026-12", rep: "rep1", won: 1 }), doc("jan", { month: "2027-01", rep: "rep1", won: 1 }), doc("old", { month: "2025-01", rep: "rep1", won: 1 })],
    deals: [deal("rep1", "2026-11-03", 100000), deal("rep1", "2026-11-20", 23450), deal("rep1", "2026-11-21", 999, false), deal("rep2", "2026-11-04", 999999)],
  });
  const rows = (out.value as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows.map((r) => [r.month, r.won, r.amount, r.status]), [
    ["2026-11", "2", 123450, "Met"],
    ["2026-12", "0", 0, "1 to go"],
    ["2027-01", "Not counted", "Not counted", "Not started"],
    ["2025-01", "Not counted", "Not counted", "More than a year ago"],
  ]);
  const result = manifest("monthly-goals").calls!.progress.result;
  assert.equal(result?.kind, "table");
  if (result?.kind !== "table") throw new Error("Expected progress table");
  const rendered = rows.map((r, i) => result.columns.map((c) => renderText(c.value, { binds: {}, row: doc(String(i), r), currency: "USD", members: new Map([["rep1", "Ria"]]) })));
  assert.deepEqual(rendered.slice(0, 3).map((r) => r.slice(0, 5)), [
    ["2026-11", "Ria", "2", "2", "$1,234.50"],
    ["2026-12", "Ria", "1", "0", "$0.00"],
    ["2027-01", "Ria", "1", "Not counted", "Not counted"],
  ]);
});
