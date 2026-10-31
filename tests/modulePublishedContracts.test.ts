import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calls } from "../modules/examples/monthly-goals/server.ts";
import type { CallContext, MissingRead, ReadDoc } from "../modules/kernel/calls.ts";
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

test("Monthly goals returns published won revenue and renders money, zero and an uncounted month distinctly", async () => {
  const out = await calls.progress(ctx, {
    goals: [doc("nov", { month: "2026-11", rep: "rep1", won: 2 }), doc("dec", { month: "2026-12", rep: "rep1", won: 1 }), doc("jan", { month: "2027-01", rep: "rep1", won: 1 })],
    tallies: [doc("t1", { month: "2026-11", rep: "rep1", won: 3, amount: 123450 }), doc("t2", { month: "2026-12", rep: "rep1", won: 0, amount: 0 }), doc("t3", { month: "2026-11", rep: "rep2", won: 9, amount: 999999 })],
  });
  const rows = (out.value as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.month, r.rep, r.goal, r.won, r.amount]), [
    ["2026-11", "rep1", 2, "3", 123450],
    ["2026-12", "rep1", 1, "0", 0],
  ]);
  assert.equal(rows.length, 3);
  assert.equal(typeof rows[2].amount, "string");
  assert.notEqual(rows[2].won, "0");
  const result = manifest("monthly-goals").calls!.progress.result;
  assert.equal(result?.kind, "table");
  if (result?.kind !== "table") throw new Error("Expected progress table");
  const rendered = rows.map((r, i) => result.columns.map((c) => renderText(c.value, { binds: {}, row: doc(String(i), r), currency: "USD", members: new Map([["rep1", "Ria"]]) })));
  assert.deepEqual(rendered.slice(0, 2).map((r) => r.slice(0, 5)), [
    ["2026-11", "Ria", "2", "3", "$1,234.50"],
    ["2026-12", "Ria", "1", "0", "$0.00"],
  ]);
  assert.equal(rendered[2][4], rows[2].amount);

});

test("Monthly goals explains each missing provider state instead of showing zero revenue", async () => {
  const messages = [];
  for (const missing of ["not_installed", "off", "not_provided"] as MissingRead["missing"][]) {
    messages.push((await calls.progress(ctx, { goals: [doc("nov", { month: "2026-11", rep: "rep1", won: 2 })], tallies: { missing } })).value);
  }
  for (const value of messages as Array<{ rows: unknown[]; message: string }>) {
    assert.deepEqual(value.rows, []);
    assert.ok(value.message.length > 0);
  }
  assert.equal(new Set((messages as Array<{ message: string }>).map((v) => v.message)).size, 3);

});
