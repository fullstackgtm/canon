import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflow, proposeWorkflow, workflowContext } from "../convex/lib/workflowAgent.ts";
import { fixtureInput, workflowCases, checkExpectation } from "../scripts/workflow-evals.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { loadConvex } from "./convexHandlers.ts";
const modules = loadConvex(["lib/recipeAgentStandIn.ts"]);
const standIn = modules["lib/recipeAgentStandIn.ts"].standInWorkflow as unknown as (input: ReturnType<typeof fixtureInput>) => unknown;

for (const c of workflowCases.filter((c) => c.canonical)) test(`stand-in ${c.request} satisfies workflow structure`, () => {
  const input = fixtureInput(c.request);
  const out = checkWorkflow(input, standIn(input));
  assert.deepEqual(checkExpectation(c, out), []);
  if (c.request.includes("SDR")) {
    const { recipe } = parseRecipe(out.targets.find((t) => t.target === "contact")!.markdown);
    assert.ok(recipe.contactPage.some((s) => s.component === "fields" && s.collapsed));
    assert.ok(recipe.contactPage.some((s) => s.component === "form" && s.actions?.some((a) => a.runs === "kernel.logActivity")));
  }
});
test("eval catalog is twenty distinct realistic cases", () => {
  assert.equal(workflowCases.length, 20);
  assert.equal(new Set(workflowCases.map((c) => c.request)).size, 20);
  assert.equal(workflowCases.filter((c) => c.canonical).length, 2);
});
test("workflow feeds back invalid query ops, drops them after two retries and keeps valid edits", async () => {
  const input = fixtureInput("Fold contact history");
  input.objects = input.objects.map((o) => o.apiName === "contact" ? { ...o, fields: o.fields.filter((f) => f.apiName !== "email") } : o);
  const bad = { plan: [{ target: "contact", why: "Focus" }], ops: { contact: [{ op: "setCollapsed", object: "contact", section: { component: "history" }, collapsed: true }, { op: "addSection", object: "contact", component: "table", title: "Bad", before: null, query: { object: "contact", filter: [], columns: ["email"], limit: 10 } }] }, summary: "Folded" };
  const prompts: string[] = [];
  const out = await proposeWorkflow(input, { skill: "test", charge: () => {}, call: async (p) => { prompts.push(p); return bad; } });
  assert.equal(out.attempts, 3);
  assert.equal(out.dropped.length, 1);
  assert.match(prompts[1], /contact op 2/);
  assert.match(out.summary, /Dropped:/);
  assert.equal(out.targets.length, 1);
  assert.ok(!out.targets[0].markdown.includes('title="Bad"'));
});
test("context includes layouts and field metadata, never records or row values", () => {
  const input = fixtureInput("test");
  Object.assign(input.pages[0], { recordValues: { confidential: "PRIVATE_RECORD_VALUE" } });
  const context = workflowContext(input);
  assert.ok(context.pages.every((p) => !("error" in p.layout)));
  assert.ok(context.objects.find((o) => o.object === "deal")?.fields.some((f) => f.name === "closeDate"));
  assert.ok(JSON.stringify(context).includes("asQuery"));
  assert.ok(!JSON.stringify(context).includes("PRIVATE_RECORD_VALUE"));
  assert.ok(!JSON.stringify(context).includes('"values":'));
  assert.ok(!JSON.stringify(context).includes('"baseMarkdown":'));
});
test("standalone references and cross-target ops cannot change drafts", () => {
  const input = fixtureInput("test");
  const out = checkWorkflow(input, { plan: [{ target: "queue", create: { slug: "queue", title: "Queue" }, why: "test" }], ops: { queue: [{ op: "setCollapsed", object: "contact", section: { component: "history" }, collapsed: true }, { op: "addSection", object: "queue", component: "table", title: "Bad", before: null, query: { object: "contact", filter: [{ field: "id", op: "eq", value: { record: "id" } }], columns: ["name"], limit: 10 } }] }, summary: "test" });
  assert.equal(out.dropped.length, 2);
});
test("workflow refuses without a plan before any model call or metadata reads", async () => {
  let calls = 0;
  const fn = loadConvex(["pageCustomize.ts"], {
    "lib/recipeAgentStandIn.ts": (real) => ({ ...real, recipeAgentStandIn: () => false }),
    "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: async () => null }),
    "../engine/src/llm.ts": (real) => ({ ...real, forcedToolCall: () => { calls++; throw new Error("paid call"); } }),
  })["pageCustomize.ts"];
  await assert.rejects(fn.workflow.handler({ runQuery: async (ref: unknown) => {
    assert.equal(String(ref), "internal.workspaceRecipes.workflowBases");
    return { userId: "user", pages: fixtureInput("test").pages };
  } }, { request: "Renewals desk" }), /ChatGPT plan/);
  assert.equal(calls, 0);
});
