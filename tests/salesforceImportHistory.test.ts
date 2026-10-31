import assert from "node:assert/strict";
import test from "node:test";
import { customFieldSpecs, customValue, historyPoints } from "../engine/src/sync/salesforceImport/history.ts";

test("custom fields map to builder types, formulas stay in Salesforce, and values convert to Canon's", () => {
  const { specs, skipped } = customFieldSpecs([
    { name: "Name", label: "Name", type: "string", custom: false },
    { name: "Region__c", label: "Region", type: "picklist", custom: true, picklistValues: [{ value: "AMER" }, { value: "EMEA" }] },
    { name: "Value__c", label: "Value", type: "currency", custom: true },
    { name: "Signed_At__c", label: "Signed at", type: "datetime", custom: true },
    { name: "Score__c", label: "Score", type: "double", custom: true, calculated: true },
  ]);
  assert.deepEqual(specs, [
    { sfName: "Region__c", label: "Region", type: "picklist", options: ["AMER", "EMEA"] },
    { sfName: "Value__c", label: "Value", type: "currency" },
    { sfName: "Signed_At__c", label: "Signed at", type: "text" },
  ]);
  assert.deepEqual(skipped, [{ sfName: "Score__c", reason: "formula field; Canon computes its own" }]);
  const region = { sfName: "Region__c", apiName: "custom.region", type: "picklist" as const, options: [{ label: "EMEA", value: "emea" }] };
  assert.deepEqual([customValue("EMEA", region), customValue("", region), customValue("12.345", { ...region, type: "currency" as const })], ["emea", null, 1235]);
});

test("history becomes one dated point per moment, oldest first, with each stage placed in its process", () => {
  const points = historyPoints(
    [
      { OpportunityId: "006Sm0000000001", StageName: "Negotiation", Amount: 900, CloseDate: "2026-05-01", Probability: 75, ForecastCategory: "Commit", CreatedDate: "2026-02-01T00:00:00.000+0000" },
      { OpportunityId: "006Sm0000000001", StageName: "Prospecting", Amount: 500, CloseDate: "2026-04-01", Probability: 10, ForecastCategory: "Pipeline", CreatedDate: "2026-01-01T00:00:00.000+0000" },
    ],
    [
      { OpportunityId: "006Sm0000000001", Field: "Seats__c", NewValue: "12", CreatedDate: "2026-02-01T00:00:00.000+0000" },
      { OpportunityId: "006Sm0000000001", Field: "Amount", NewValue: "900", CreatedDate: "2026-02-01T00:00:00.000+0000" },
    ],
    {
      stageValue: (_opp, name) => (name === "Negotiation" ? "Negotiation (Renewals)" : name),
      stages: new Map([["Negotiation", { name: "Negotiation", probability: 75, forecastCategory: "commit" as const }]]),
      custom: new Map([["Seats__c", { sfName: "Seats__c", apiName: "custom.seats", type: "number" as const, options: [] }]]),
    },
  );
  assert.deepEqual(points.get("006Sm0000000001IAA"), [
    { at: Date.parse("2026-01-01T00:00:00Z"), values: { stage: "Prospecting", forecastCategory: "pipeline", isClosed: false, isWon: false, amount: 50000, closeDate: "2026-04-01", probability: 0.1 } },
    { at: Date.parse("2026-02-01T00:00:00Z"), values: { stage: "Negotiation (Renewals)", forecastCategory: "commit", isClosed: false, isWon: false, amount: 90000, closeDate: "2026-05-01", probability: 0.75, "custom.seats": 12 } },
  ]);
});

test("imported history points never count as a stage move happening now", async () => {
  const { isHistoricalSource } = await import("../convex/lib/canon/dealLedger.ts");
  assert.equal(isHistoricalSource({ kind: "salesforce", crmId: "006A", history: true }), true);
  assert.equal(isHistoricalSource({ kind: "csv", ref: "hubspot-history:deals:1:dealstage:5", actorId: "u1", validFrom: 5 }), true);
  assert.equal(isHistoricalSource({ kind: "salesforce", crmId: "006A" }), false);
  assert.equal(isHistoricalSource({ kind: "csv", ref: "csv:abc:3", actorId: "u1" }), false);
  assert.equal(isHistoricalSource({ kind: "user", userId: "u1" }), false);
});
