import assert from "node:assert/strict";
import test from "node:test";
import { arrivalNote, departureEvidence, departureNote, readJobChange } from "../convex/lib/jobChange.ts";

// Synthetic LeadMagic response for a contact who changed employers.
const moved = {
  job_change_detected: true, status: "JOB_CHANGE_DETECTED", current_company: "Example Systems",
  summary: "Riley Morgan is currently at Example Systems as Director, Global Revenue Enablement (8 months) and appears to have moved on from Northstar.",
  current_position: { title: "Director, Global Revenue Enablement", seniority: "Director", company: "Example Systems", start_date: "Feb 2026" },
};

test("a job change reads as who left, where to, and the evidence a 'no longer works here' answer rests on", () => {
  const jc = readJobChange(moved)!;
  assert.equal(departureNote("Northstar", jc), "Left Northstar. Now Director, Global Revenue Enablement at Example Systems since Feb 2026.");
  assert.equal(arrivalNote("Northstar", jc), "Previously at Northstar. Here since Feb 2026.");
  assert.match(departureEvidence(jc, "https://www.linkedin.com/in/riley-morgan"), /^"Riley Morgan is currently at Example Systems[\s\S]*Source: https:\/\/www\.linkedin\.com\/in\/riley-morgan \(LeadMagic job change check\)$/);
  assert.equal(readJobChange({ job_change_detected: false, current_company: "Northstar" })?.changed, false);
  assert.equal(readJobChange({ status: "UNKNOWN" }), null);
});
