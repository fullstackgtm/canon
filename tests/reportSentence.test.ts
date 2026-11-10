// The report builder's one-line subtitle (src/lib/report-sentence.ts): what a report measures, by what, filtered by what.
import assert from "node:assert/strict";
import test from "node:test";
import { reportSentence } from "../src/lib/report-sentence.ts";

test("a report reads as its values by its dimensions", () => {
  assert.equal(reportSentence(["Sum of Amount"], ["Stage"], []), "Sum of Amount by Stage");
  assert.equal(reportSentence(["Sum of Amount", "Count"], ["Stage", "Close date (quarter)"], []), "Sum of Amount and Count by Stage and Close date (quarter)");
});

test("filters are named once, after the shape", () => {
  assert.equal(reportSentence(["Count"], ["Owner", "Stage", "Deal type"], ["Closed", "Owner"]), "Count by Owner, Stage and Deal type · filtered by Closed and Owner");
});

test("a report with nothing picked still reads as a count", () => {
  assert.equal(reportSentence([], [], []), "Count");
});
