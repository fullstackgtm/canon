import assert from "node:assert/strict";
import test from "node:test";
import { planPipelineSave, resolvePipelines, stageOf, type PipelineWrite, type StoredPipeline } from "../convex/lib/pipelines.ts";
import { resolveObjectDef, STANDARD_OBJECTS, withPicklistOption, type PicklistOption } from "../convex/lib/objects/registry.ts";

const stageOptions = (picklistOptions?: Record<string, readonly PicklistOption[]>) => {
  const field = resolveObjectDef(STANDARD_OBJECTS.deal, picklistOptions ? { registryVersion: 0, customFields: [], picklistOptions } : undefined).byApiName.get("stage")!;
  return "options" in field ? field.options : [];
};
const store = (writes: PipelineWrite[]): StoredPipeline[] =>
  writes.map((w, i) => ({ id: w.kind === "replace" ? w.id : `p${i + 1}`, name: w.name, stages: w.stages, createdAt: i }));

test("an org with no pipeline gets a default holding every stage, and keeps it when it adds a second", () => {
  const options = stageOptions();
  const [only, ...rest] = resolvePipelines(options, []);
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...only, stages: only.stages.map((s) => [s.value, s.probability, s.forecastCategory]) }, {
    id: null, name: "Sales pipeline", isDefault: true,
    stages: [["prospecting", 20, "pipeline"], ["qualification", 40, "pipeline"], ["proposal", 60, "pipeline"], ["negotiation", 80, "pipeline"], ["closed_won", 100, "closed_won"], ["closed_lost", 0, "closed_lost"]],
  });

  const plan = planPipelineSave(options, [], {
    target: { kind: "new" }, name: "Renewals",
    stages: [{ value: null, label: "Renewal due", probability: 50, forecastCategory: "commit" }, { value: null, label: "Renewed", probability: 100, forecastCategory: "closed_won" }],
  });
  assert.ok(plan.ok);
  assert.deepEqual(plan.writes.map((w) => [w.kind, w.name, w.stages.length]), [["insert", "Sales pipeline", 6], ["insert", "Renewals", 2]]);

  // A stage a CRM registers later, which no pipeline claims, joins the default.
  const later = withPicklistOption(STANDARD_OBJECTS.deal, { registryVersion: 0, customFields: [], picklistOptions: { stage: plan.options } }, "stage", "Verbal")!;
  const pipelines = resolvePipelines(stageOptions(later.picklistOptions), store(plan.writes));
  assert.deepEqual(pipelines.map((p) => [p.name, p.isDefault, p.stages.map((s) => s.value)]), [
    ["Sales pipeline", true, ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost", "Verbal"]],
    ["Renewals", false, ["renewal_due", "renewed"]],
  ]);
});

test("a stage belongs to one pipeline: a pipeline cannot take another's stage or drop its own", () => {
  const options = stageOptions();
  const first = planPipelineSave(options, [], {
    target: { kind: "new" }, name: "Renewals", stages: [{ value: null, label: "Renewed", probability: 100, forecastCategory: "closed_won" }],
  });
  assert.ok(first.ok);
  const stored = store(first.writes);
  const renewals = { kind: "existing" as const, id: "p2" };
  const renewed = { value: "renewed", label: "Renewed", probability: 100, forecastCategory: "closed_won" as const };

  assert.equal(planPipelineSave(first.options, stored, { target: renewals, name: "Renewals", stages: [renewed, { value: "proposal", label: "Proposal", probability: 60, forecastCategory: "pipeline" }] }).ok, false);
  assert.equal(planPipelineSave(first.options, stored, { target: renewals, name: "Renewals", stages: [{ value: null, label: "Lapsed", probability: 0, forecastCategory: "closed_lost" }] }).ok, false);

  const renamed = planPipelineSave(first.options, stored, { target: renewals, name: "Renewals", stages: [{ ...renewed, label: "Renewed!" }] });
  assert.ok(renamed.ok);
  assert.deepEqual(renamed.writes, [{ kind: "replace", id: "p2", name: "Renewals", stages: [{ value: "renewed", probability: 100, forecastCategory: "closed_won" }] }]);
  const pipelines = resolvePipelines(renamed.options, stored);
  assert.equal(stageOf(pipelines, "renewed")?.pipeline.name, "Renewals");
  assert.equal(stageOf(pipelines, "renewed")?.stage.label, "Renewed!");
  assert.equal(stageOf(pipelines, "proposal")?.pipeline.name, "Sales pipeline");
});
