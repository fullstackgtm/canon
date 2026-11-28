import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflow, proposeWorkflow, workflowContext } from "../convex/lib/workflowAgent.ts";
import { fixtureInput, workflowCases, checkExpectation } from "../scripts/workflow-evals.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { standInWorkflow as standIn } from "../convex/lib/workflowStandIn.ts";
import { loadConvex } from "./convexHandlers.ts";

test("workflow adds a Stage rail below the deal header on Canon defaults without a play", async () => {
  const input = fixtureInput("Add a stage rail below the deal header to show deal progress through stages");
  input.pages.find((page) => page.target === "deal")!.dealPlay = { available: false, reason: "Canon defaults has no deal play." };
  const proposal = await proposeWorkflow(input, { skill: "test", charge: () => {}, call: async () => standIn(input) });
  assert.deepEqual(proposal.dropped, []);
  assert.deepEqual(proposal.targets.map((target) => target.target), ["deal"]);
  const { recipe } = parseRecipe(proposal.targets[0].markdown);
  assert.deepEqual(recipe.dealPage.slice(0, 2).map((section) => section.component), ["header", "stageRail"]);
});

test("workflow treats archived deals as record-only even with plays enabled", async () => {
  const request = "Add the Prep section";
  const input = fixtureInput(request);
  input.pages.find((p) => p.target === "deal")!.dealPlay = { available: true };
  const fn = loadConvex(["pageCustomize.ts"], {
    "lib/recipeAgentStandIn.ts": (real) => ({
      ...real,
      recipeAgentStandIn: () => true,
      standInWorkflow: () => ({
        plan: [{ target: "deal", why: "See what must happen before the deal moves." }],
        ops: { deal: [{ op: "addSection", object: "deal", component: "prep", title: "Prep", before: null }] },
        summary: "Added Prep.",
      }),
    }),
  })["pageCustomize.ts"];
  const proposal = await fn.workflow.handler({
    runQuery: async (ref: unknown) => {
      switch (String(ref)) {
        case "internal.workspaceRecipes.workflowBases": return { userId: "user", pages: input.pages };
        case "api.dataModel.objects": return [];
        case "api.objects.get": return { object: "deal", lifecycle: { status: "deleted" } };
        default: assert.fail(`unexpected query ${String(ref)}`);
      }
    },
    runAction: () => assert.fail("an archived record cannot mount its play"),
  }, { request, dealId: "archived-deal" });
  assert.equal(proposal.targets.length, 0);
  assert.match(proposal.summary, /Prep requires a deal play.*unavailable on this record/i);
});

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
test("an image-backed workflow explains when a reference has no matching block", async () => {
  const input = { ...fixtureInput("Make this look like the reference"), imageReference: { currentTarget: "deal" } };
  const summary = "There is no registered block for the calendar in the reference.";
  const out = await proposeWorkflow(input, { skill: "test", charge: () => {}, call: async (prompt) => {
    assert.match(prompt, /images as visual references for layout, density, grouping, and emphasis/);
    assert.match(prompt, /current page target is "deal"/);
    return { plan: [], ops: {}, summary };
  } });
  assert.deepEqual(out.targets, []);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.summary, summary);
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
