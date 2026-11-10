import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { breakingChanges, expectedSpec, SPEC_FILE } from "../scripts/build-openapi.ts";

test("docs/openapi.json is the document the record API's contract and registry generate", () => {
  assert.equal(readFileSync(SPEC_FILE, "utf8"), expectedSpec(), "docs/openapi.json is stale: run node --experimental-strip-types scripts/build-openapi.ts");
});

test("a removed stable operation or field, a newly required one and a dropped enum value are breaking; an added field is not", () => {
  const doc = JSON.parse(expectedSpec());
  const next = structuredClone(doc);
  delete next.paths["/records/lead"].get;
  delete next.components.schemas.LeadValues.properties.company;
  next.components.schemas.LeadCreate.required.push("company");
  next.components.schemas.LeadValues.properties.status.enum = next.components.schemas.LeadValues.properties.status.enum.filter((v: unknown) => v !== "new");
  next.components.schemas.LeadValues.properties.rating = { type: "number" };
  assert.deepEqual(breakingChanges(doc, next), [
    "GET /records/lead was removed",
    "LeadValues.company was removed",
    'LeadValues.status no longer takes "new"',
    "LeadCreate.company is newly required",
  ]);
});
