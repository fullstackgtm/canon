import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCallInsights,
  parseTranscript,
  summarizeInsights,
} from "../convex/lib/callInsightExtraction.ts";

test("parseTranscript groups speaker-prefixed transcript lines", () => {
  const segments = parseTranscript(`Rep: What is hard right now?\nCustomer: We are struggling with manual CRM updates.\nThis also takes too long.`);

  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, "Rep");
  assert.equal(segments[0].speakerRole, "rep");
  assert.equal(segments[1].speaker, "Customer");
  assert.equal(segments[1].speakerRole, "customer");
  assert.match(segments[1].text, /takes too long/);
});

test("extractCallInsights finds GTM operating signals", () => {
  const transcript = `Rep: What is making this urgent?\nCustomer: We are struggling with manual updates and the forecast is messy. Pricing is a concern because we have no budget. We evaluated Gong and Clari. The next step is to schedule a security review next Tuesday.`;
  const insights = extractCallInsights(transcript);
  const types = new Set(insights.map((insight) => insight.type));

  assert.ok(types.has("pain_point"));
  assert.ok(types.has("pricing"));
  assert.ok(types.has("competitor_mention"));
  assert.ok(types.has("next_step"));

  const summary = summarizeInsights(insights);
  assert.equal(summary.total, insights.length);
  assert.ok(summary.highImportance >= 2);
});
