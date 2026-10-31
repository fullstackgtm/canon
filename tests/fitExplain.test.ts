import assert from "node:assert/strict";
import { test } from "node:test";
import { fitUnderWeights } from "../convex/lib/recordClient.ts";
import { explainFit, parseCitation } from "../convex/lib/fitExplain.ts";
import { evidenceText } from "../convex/lib/research/agentLoop.ts";
import type { IcpWeights } from "../convex/lib/recordContract.ts";

const weights: IcpWeights = {
  industries: { "computer software": 40, internet: 30 },
  countries: { "united states": 25 },
  employeeBands: [{ min: 51, max: 200, weight: 25 }, { min: 201, max: 500, weight: 8 }],
};

test("explainFit lists the terms of the stored score and refuses a score it cannot reproduce", () => {
  const hit = { industry: "Computer Software", country: "united kingdom", employees: 120 };
  const fit = fitUnderWeights(hit, weights);
  const explained = explainFit(hit, weights, fit);
  assert.equal(explained?.total, fit * 100);
  assert.deepEqual(explained?.reasons.map((r) => [r.dimension, r.points, r.matched]), [
    ["industry", 40, true],
    ["country", 0, false],
    ["employees", 25, true],
  ]);
  // The workspace was re-scored with weights this copy has not seen: no explanation beats a wrong one.
  assert.equal(explainFit(hit, weights, 0.99), null);
  assert.equal(explainFit(hit, {}, fit), null);
});

test("parseCitation reads the quote and URL of a research fact and nothing else", () => {
  const evidence = evidenceText({ quote: 'We serve "mid-market" teams', sourceUrl: "https://acme.example/about" });
  assert.deepEqual(parseCitation(evidence), { quote: 'We serve "mid-market" teams', sourceUrl: "https://acme.example/about" });
  assert.equal(parseCitation("imported from Salesforce"), null);
  assert.equal(parseCitation('"quote"\n\nSource: javascript:alert(1)'), null);
});
