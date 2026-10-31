import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MODULE_FILE, SKILL_FILE, generate } from "../scripts/build-layout-skill.ts";
import { NO_PLAN } from "../convex/lib/recipeAgent.ts";
import { handle, type Loader } from "../services/recipe-runtime/src/index.ts";
import { loadConvex } from "./convexHandlers.ts";

const BASE = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8");
const RENAMED = BASE.replace("label: Check now", "label: Run the keeper");
const caller = { orgId: "org", userId: "user", name: "Dana", role: "member", access: {} };

const importCode = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
const loader: Loader = { get: (_id, code) => ({ getEntrypoint: () => ({ run: async (s, c) => (await importCode((await code()).modules["recipe.js"])).run(s, c) as unknown[] }) }) };

/** A model that gives `answers` in turn, through the real forcedToolCall, and records each prompt it was sent. */
function fakeModel(answers: Array<{ markdown: string; summary: string }>) {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    prompts.push(JSON.parse(String(init.body)).messages[0].content);
    const answer = answers.shift();
    if (!answer) throw new Error("the model was called more often than the test expects");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(answer) } }] } }] }), { status: 200 });
  }) as typeof fetch;
  return { prompts, llm: { provider: "openai", apiKey: "test", model: "fake", fetchImpl } };
}

/** proposeEdit as an action, with `llm` as the caller's plan; every write it tries is counted. */
function harness(llm: unknown) {
  const { "recipeAgent.ts": fn } = loadConvex(["recipeAgent.ts"], { "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: async () => llm }) });
  const writes: string[] = [];
  const ctx = {
    runQuery: async (ref: unknown) => { assert.equal(String(ref), "internal.records.callerContext"); return caller; },
    runMutation: async (ref: unknown) => { writes.push(String(ref)); },
    runAction: async (ref: unknown) => { writes.push(String(ref)); },
  };
  return { writes, propose: (args: Record<string, unknown>) => fn.proposeEdit.handler(ctx, args) };
}

test("the layout skill and its Convex module are current with the registries", () => {
  const out = generate();
  assert.equal(readFileSync(SKILL_FILE, "utf8"), out.skill, "recipes/skills/canon-layout/SKILL.md is stale: run scripts/build-layout-skill.ts");
  assert.equal(readFileSync(MODULE_FILE, "utf8"), out.module, "recipes/skills/canon-layout/skill.generated.ts is stale: run scripts/build-layout-skill.ts");
});

test("proposeEdit sends the parser's line errors back once, returns the valid recipe with its diff and evals, and writes nothing", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => handle(new Request(url, init), { LOADER: loader, RECIPE_RUNTIME_SECRET: "test-secret" })) as typeof fetch;
  Object.assign(process.env, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-secret" });
  t.after(() => { globalThis.fetch = real; delete process.env.RECIPE_RUNTIME_URL; delete process.env.RECIPE_RUNTIME_SECRET; });

  const broken = RENAMED.replace("runs: kernel.checkNow", "runs: kernel.checkNoww");
  const model = fakeModel([{ markdown: broken, summary: "Renamed it." }, { markdown: RENAMED, summary: "Renamed Check now to Run the keeper." }]);
  const { writes, propose } = harness(model.llm);
  const out = await propose({ recipeId: "@fsgtm/velocity-deal", baseMarkdown: BASE, request: "rename Check now to Run the keeper", object: "deal" });

  assert.equal(model.prompts.length, 2, "one retry");
  assert.ok(model.prompts[1].includes("line 352") && model.prompts[1].includes(" 352 | runs: kernel.checkNoww"), "the retry names the line and shows it");
  assert.deepEqual(JSON.parse(JSON.stringify({ markdown: out.markdown === RENAMED, problems: out.problems, attempts: out.attempts, writes })), { markdown: true, problems: [], attempts: 2, writes: [] });
  assert.equal(out.diff, [
    "--- a/recipe.md", "+++ b/recipe.md", "@@ -348,7 +348,7 @@", " ", " ```action", " id: checkNow", "-label: Check now", "+label: Run the keeper", " runs: kernel.checkNow", " prompt: drafts.prompt", " shows: canEdit && play.started", "",
  ].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(out.evals.map((e: { name: string; ok: boolean }) => [e.name, e.ok]))), [
    ["Clean email passes", true], ["70 words is too long", true], ["Pitch fails", true], ["Draft prompt names the word cap", true], ["A replied deal at 40% is closing", true], ["No champion is flagged", true],
  ]);
});

test("proposeEdit refuses without a connected ChatGPT plan, before any model call", async () => {
  const model = fakeModel([]);
  const { writes, propose } = harness(null);
  await assert.rejects(propose({ recipeId: "@fsgtm/velocity-deal", baseMarkdown: BASE, request: "hide the Redraft button" }), (e: { data?: unknown }) => e.data === NO_PLAN);
  assert.deepEqual([model.prompts.length, writes.length], [0, 0]);
});

test("Ask Canon's Accept puts the proposal in the draft and saves nothing; a follow-up asks about the accepted draft", async () => {
  const { draftReducer, isDirty, openDraft } = await import("../src/app/dashboard/customization/editor-draft.ts");
  const result = { markdown: RENAMED, summary: "Renamed Check now.", diff: "@@", problems: [], evals: [], evalsNotRun: null, attempts: 1, tokens: 10, model: "local:stand-in" };
  let s = draftReducer(openDraft(3, BASE), { kind: "edit", draft: `${BASE}\n` });
  s = draftReducer(s, { kind: "ask", request: "rename Check now" });
  assert.equal(s.asking?.from, `${BASE}\n`, "the request is about the unsaved draft");
  s = draftReducer(draftReducer(s, { kind: "proposed", result }), { kind: "accept" });
  assert.equal(s.draft, RENAMED);
  assert.deepEqual(s.base, { revision: 3, markdown: BASE }, "accepting saves nothing");
  assert.equal(isDirty(s), true);
  assert.deepEqual(s.log, [{ request: "rename Check now", outcome: "accepted", note: "Renamed Check now." }]);
  assert.equal(draftReducer(s, { kind: "ask", request: "fold Activity" }).asking?.from, RENAMED);
  assert.equal(draftReducer(draftReducer(draftReducer(s, { kind: "ask", request: "x" }), { kind: "proposed", result: { ...result, markdown: "other" } }), { kind: "discard" }).draft, RENAMED);
});

test("merging upstream keeps what was typed while the upstream was being fetched", async () => {
  const { draftReducer, openDraft } = await import("../src/app/dashboard/customization/editor-draft.ts");
  const base = "a\nb\nc\nd\ne\n";
  let s = draftReducer(openDraft(1, base), { kind: "edit", draft: "a\nb\nc\nd\ne\n" });
  s = draftReducer(s, { kind: "edit", draft: "a\nb\nc\nd\nE typed while fetching\n" });
  s = draftReducer(s, { kind: "merged", base, theirs: "A from upstream\nb\nc\nd\ne\n", version: "1.2.0" });
  assert.equal(s.draft, "A from upstream\nb\nc\nd\nE typed while fetching\n");
  assert.equal(s.merging, "1.2.0");
});

test("Visual's undo outlasts a switch to Markdown and back; a real change from elsewhere ends it", async () => {
  const { draftReducer, openDraft } = await import("../src/app/dashboard/customization/editor-draft.ts");
  let s = draftReducer(draftReducer(openDraft(1, "a"), { kind: "layout", draft: "b" }), { kind: "layout", draft: "c" });
  s = draftReducer(s, { kind: "landed", revision: 1, markdown: "a" });
  assert.deepEqual([s.draft, s.undo], ["c", ["a", "b"]], "a mode switch or a landed save of nothing keeps the history");
  s = draftReducer(s, { kind: "undo" });
  assert.deepEqual([s.draft, s.undo], ["b", ["a"]]);
  assert.deepEqual(draftReducer(s, { kind: "edit", draft: "typed" }).undo, []);
  assert.deepEqual(draftReducer(s, { kind: "reset" }).undo, []);
});
