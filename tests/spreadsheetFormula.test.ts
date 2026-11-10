import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSpreadsheetFormula,
  formatFormulaResult,
  isFormulaValue,
  resolveSpreadsheetInputValue,
} from "../src/lib/spreadsheet.ts";

test("evaluates arithmetic with spreadsheet precedence", () => {
  assert.equal(evaluateSpreadsheetFormula("=100 + 20 * 3"), 160);
  assert.equal(evaluateSpreadsheetFormula("=(100 + 20) * 3"), 360);
  assert.equal(evaluateSpreadsheetFormula("=-10 + 4"), -6);
});

test("resolves row context references case-insensitively", () => {
  assert.equal(
    evaluateSpreadsheetFormula("=plannedAmount - actualAmount", {
      plannedAmount: "250000",
      actualAmount: "175000",
    }),
    75000,
  );
  assert.equal(
    evaluateSpreadsheetFormula("=TARGETAMOUNT*1.1", { targetAmount: 100000 }),
    110000,
  );
});

test("supports common aggregate helpers", () => {
  assert.equal(evaluateSpreadsheetFormula("=sum(10, 20, 30)"), 60);
  assert.equal(evaluateSpreadsheetFormula("=avg(10, 20, 30)"), 20);
  assert.equal(evaluateSpreadsheetFormula("=max(10, 20, 30)"), 30);
  assert.equal(evaluateSpreadsheetFormula("=round(10 / 3, 2)"), 3.33);
});

test("rejects unsafe or unknown formula input", () => {
  assert.equal(isFormulaValue("=1+1"), true);
  assert.throws(() => evaluateSpreadsheetFormula("=unknown + 1"), /Unknown reference/);
  assert.throws(() => evaluateSpreadsheetFormula("=10 / 0"), /Division by zero/);
  assert.throws(() => evaluateSpreadsheetFormula("=process.exit()"), /Unknown function/);
});

test("formats formula results for cell commit", () => {
  assert.equal(formatFormulaResult(100), "100");
  assert.equal(formatFormulaResult(10 / 4), "2.5");
  assert.equal(formatFormulaResult(1 / 3), "0.333333");
});

test("resolves formulas for shared input commits", () => {
  assert.equal(resolveSpreadsheetInputValue("750000"), "750000");
  assert.equal(
    resolveSpreadsheetInputValue("=annualQuota * attainmentPct / 100", {
      annualQuota: "900000",
      attainmentPct: 75,
    }),
    "675000",
  );
  assert.equal(resolveSpreadsheetInputValue("=1+1", {}, false), "=1+1");
});
