import assert from "node:assert/strict";
import test from "node:test";
import type { Pipeline } from "../convex/lib/pipelines.ts";
import { dealStagePath } from "../src/components/records/deal-stage-path.ts";

const prospecting = { value: "prospecting", label: "Prospecting", active: true, probability: 10, forecastCategory: "pipeline" } as const;
const discovery = { ...prospecting, value: "discovery", label: "Discovery", active: false };
const proposal = { ...prospecting, value: "proposal", label: "Proposal" };
const won = { ...prospecting, value: "won", label: "Closed won", probability: 100, forecastCategory: "closed_won" } as const;
const lost = { ...prospecting, value: "lost", label: "Closed lost", probability: 0, forecastCategory: "closed_lost" } as const;
const pipeline: Pipeline = { id: "sales", name: "Sales", isDefault: true, stages: [prospecting, discovery, proposal, won, lost] };

function path(value: string, stages = pipeline.stages) {
  return dealStagePath([{ ...pipeline, stages }], value).steps;
}

test("an active open deal stage marks only the preceding open stages as passed", () => {
  const steps = path("proposal");
  assert.deepEqual(steps.map(({ value, selected, passed }) => [value, selected, passed]), [
    ["prospecting", false, true], ["proposal", true, false], ["won", false, false], ["lost", false, false],
  ]);
});

test("a won deal marks its outcome without marking open stages as passed", () => {
  const steps = path("won");
  assert.equal(steps.find((step) => step.selected)?.value, "won");
  assert.ok(steps.every((step) => !step.passed && !step.lost));
});

test("a lost deal marks its destructive outcome without marking any stages as passed", () => {
  const steps = path("lost");
  assert.deepEqual(steps.filter((step) => step.selected || step.lost).map(({ value, selected, lost }) => [value, selected, lost]), [
    ["lost", true, true],
  ]);
  assert.ok(steps.every((step) => !step.passed));
});

test("the inactive current stage retains its relative open position and carries an inactive label", () => {
  const steps = path("discovery");
  assert.deepEqual(steps.map((step) => step.value), ["prospecting", "discovery", "proposal", "won", "lost"]);
  assert.deepEqual(steps.find((step) => step.selected), {
    value: "discovery", label: "Discovery", active: false, selected: true, passed: false, lost: false, note: "Inactive",
  });
  assert.ok(steps.every((step) => !step.passed));
});

test("an unknown current stage appears immediately before closed stages and cannot be selected from the dropdown", () => {
  const steps = path("Legacy discovery");
  assert.deepEqual(steps.map((step) => step.value), ["prospecting", "proposal", "Legacy discovery", "won", "lost"]);
  assert.deepEqual(steps.find((step) => step.selected), {
    value: "Legacy discovery", label: "Legacy discovery", active: false, selected: true, passed: false, lost: false, note: "Not in this pipeline",
  });
  assert.ok(steps.every((step) => !step.passed));
});

test("closed stages stored among open ones come last and retain their relative order", () => {
  const steps = path("discovery", [prospecting, lost, proposal, won, discovery]);
  assert.deepEqual(steps.map((step) => step.value), ["prospecting", "proposal", "discovery", "lost", "won"]);
  assert.deepEqual(steps.filter((step) => step.active && !step.selected).map((step) => step.value), ["prospecting", "proposal", "lost", "won"]);
  assert.ok(steps.every((step) => !step.passed));
});
