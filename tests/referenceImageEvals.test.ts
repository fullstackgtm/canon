import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkflow } from "../convex/lib/workflowAgent.ts";
import { standInWorkflow } from "../convex/lib/workflowStandIn.ts";
import { apply, type LayoutOp } from "../recipes/md/edit.ts";
import { referenceExpectation, scoreReferencePage } from "../scripts/reference-image-score.ts";
import { fixtureInput } from "../scripts/workflow-evals.ts";

const expected = referenceExpectation.parse(JSON.parse(readFileSync(
  new URL("./fixtures/reference-images/lightning-style-opportunity.json", import.meta.url), "utf8",
)));
const input = fixtureInput("Make this look like a Salesforce opportunity page.");
const proposal = checkWorkflow(input, standInWorkflow(input));
const markdown = proposal.targets[0].markdown;
const score = (text: string, summary = proposal.summary) => scoreReferencePage(text, "deal", summary, expected);

function edit(text: string, op: LayoutOp) {
  const result = apply(text, op);
  if ("error" in result) throw new Error(result.error);
  return result.markdown;
}

test("reference scoring reads order, grouping and equivalent column ratios from the layout tree", () => {
  assert.equal(score(markdown).total, 100);
  const widths = (widths: number[]) => edit(markdown, {
    op: "setContainerProps", object: "deal", container: "recordColumns", props: { widths },
  });
  assert.equal(score(widths([4, 2])).total, 100);
  assert.deepEqual(score(widths([1, 2])).criteria.arrangement.missed, ["Column widths"]);
  const moved = edit(markdown, {
    op: "moveSection", object: "deal", section: { component: "quickLinks" }, before: { component: "path" },
  });
  assert.deepEqual(score(moved).criteria.arrangement.missed, ["Top strip order"]);
  const flattened = edit(markdown, { op: "unwrap", object: "deal", container: "recordTabs" });
  assert.equal(score(flattened).criteria.coverage.earned, 40);
  assert.deepEqual(score(flattened).criteria.arrangement.missed, ["Separate details and activity tabs in the left column"]);
  const regrouped = edit(markdown, {
    op: "moveIntoContainer", object: "deal", section: { component: "relatedRecord" }, container: "recordMain", before: null,
  });
  assert.deepEqual(score(regrouped).criteria.arrangement.missed, ["Left and right column groups"]);
});

test("reference scoring accepts nearby blue accents and reports the wrong style tokens", () => {
  assert.equal(score(edit(markdown, {
    op: "setPageStyle", object: "deal", style: { density: "compact", surface: "bordered", headerBand: "tinted", accent: "#244fc9" },
  })).total, 100);
  assert.deepEqual(score(edit(markdown, {
    op: "setPageStyle", object: "deal", style: { density: "comfortable", surface: "raised", headerBand: "none", accent: "#b44724" },
  })).criteria.style.missed, ["Density", "Surface", "Header band", "Accent hue"]);
});

test("honesty credits a named omission without treating a text stand-in as an activity block", () => {
  const removed = edit(markdown, { op: "removeSection", object: "deal", section: { component: "activity" } });
  const omission = "The proposal omitted the activity block.";
  assert.deepEqual(score(removed, omission).criteria.coverage.missed, ["activity"]);
  assert.equal(score(removed, omission).criteria.honesty.earned, 10);
  assert.equal(score(removed, "Activity is included. Other regions were omitted.").criteria.honesty.earned, 0);
  const simulated = edit(removed, {
    op: "addSection", object: "deal", component: "richText", title: "Activity", before: null, props: { markdown: "Call logged." },
  });
  assert.equal(score(simulated, omission).criteria.honesty.earned, 0);
  assert.equal(score("").total, 0);
});

test("the default CLI scores the Lightning-style stand-in and validates the remaining cases without remote access", () => {
  const output = execFileSync(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("../scripts/reference-image-evals.ts", import.meta.url)),
  ], {
    encoding: "utf8",
    env: { ...process.env, RECIPE_AGENT_REAL_MODEL: "", WORKFLOW_EVAL_CONVEX_URL: "never-used", WORKFLOW_EVAL_AUTH_TOKEN: "never-used" },
  });
  assert.match(output, /lightning-style-opportunity.*stand-in.*100/);
  for (const name of ["hub-style-deal", "attio-style-record", "linear-style-issue"]) {
    assert.match(output, new RegExp(`${name}.*schema only`));
  }
});
