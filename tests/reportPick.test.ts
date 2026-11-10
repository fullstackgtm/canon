// A clicked chart mark as a list request (src/components/reports/pick-filter.ts): the records panel lists exactly
// the records the report counted in that group.
import assert from "node:assert/strict";
import test from "node:test";
import { bucketEnd, keyFilters, keyKindOf, pickFilters } from "../src/components/reports/pick-filter.ts";

test("a bucket ends the day after its last day, in UTC", () => {
  assert.equal(bucketEnd("2026-01-31", "day"), "2026-02-01");
  assert.equal(bucketEnd("2026-10-19", "week"), "2026-10-26");
  assert.equal(bucketEnd("2026-12-01", "month"), "2027-01-01");
  assert.equal(bucketEnd("2026-10-01", "quarter"), "2027-01-01");
  assert.equal(bucketEnd("2026-01-01", "year"), "2027-01-01");
});

test("key kinds follow the field type; created and modified are datetimes", () => {
  assert.equal(keyKindOf("closeDate", "date"), "day");
  assert.equal(keyKindOf("createdAt", undefined), "instant");
  assert.equal(keyKindOf("lastCall", "datetime"), "instant");
  assert.equal(keyKindOf("due", "formula", "date"), "day");
  assert.equal(keyKindOf("stage", "picklist"), "value");
});

test("a key's filter: empty for no value, a range for a date bucket, equality otherwise", () => {
  assert.deepEqual(keyFilters("stage", "value", undefined, null), [{ field: "stage", op: "empty" }]);
  assert.deepEqual(keyFilters("isWon", "value", undefined, true), [{ field: "isWon", op: "eq", value: true }]);
  assert.deepEqual(keyFilters("closeDate", "day", "month", "2026-03-01"), [
    { field: "closeDate", op: "gte", value: "2026-03-01" },
    { field: "closeDate", op: "lt", value: "2026-04-01" },
  ]);
  assert.deepEqual(keyFilters("createdAt", "instant", "quarter", "2026-07-01"), [
    { field: "createdAt", op: "gte", value: Date.UTC(2026, 6, 1) },
    { field: "createdAt", op: "lt", value: Date.UTC(2026, 9, 1) },
  ]);
});

test("a mark keeps the report's filters, then each picked key's", () => {
  const spec = {
    filter: [{ field: "isClosed", op: "eq" as const, value: true }],
    groupBy: [{ field: "closeDate", bucket: "month" as const }, { field: "isWon" }],
  };
  assert.deepEqual(pickFilters(spec, ["day", "value"], ["2026-05-01", false]), [
    { field: "isClosed", op: "eq", value: true },
    { field: "closeDate", op: "gte", value: "2026-05-01" },
    { field: "closeDate", op: "lt", value: "2026-06-01" },
    { field: "isWon", op: "eq", value: false },
  ]);
  // A category alone (a line point, or a bar without a split) filters by its first key only.
  assert.equal(pickFilters(spec, ["day", "value"], ["2026-05-01"])?.length, 3);
});

test("a key that reads a related record can't be listed", () => {
  const spec = { filter: [], groupBy: [{ field: "recordTitle", via: "accountId" }] };
  assert.equal(pickFilters(spec, ["value"], ["Acme"]), null);
});
