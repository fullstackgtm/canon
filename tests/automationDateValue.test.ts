import assert from "node:assert/strict";
import test from "node:test";
import { dateValueControl, dateControlValue } from "../src/app/dashboard/automations/date-value.ts";

test("date controls read stored offsets and write valid whole-day edits", () => {
  assert.deepEqual(dateValueControl("{today+60}"), { kind: "future", days: 60 });
  assert.deepEqual(dateValueControl("{today-30}"), { kind: "past", days: 30 });
  assert.deepEqual(dateValueControl("{today}"), { kind: "today", days: 1 });
  assert.deepEqual(dateValueControl("2026-11-16"), { kind: "date", days: 1 });
  assert.equal(dateControlValue("future", "60"), "{today+60}");
  assert.equal(dateControlValue("past", "30"), "{today-30}");
  assert.equal(dateControlValue("future", "1"), "{today+1}");
  assert.equal(dateControlValue("past", "3650"), "{today-3650}");
  assert.equal(dateControlValue("today", "60"), "{today}");
  assert.equal(dateControlValue("date", "60"), "");
  for (const raw of ["", "0", "-1", "1.5", "3651", "1e2", "NaN"]) {
    assert.equal(dateControlValue("future", raw), null);
    assert.equal(dateControlValue("past", raw), null);
  }
});
