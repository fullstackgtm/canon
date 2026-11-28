import assert from "node:assert/strict";
import { test } from "node:test";
import { customizationSuggestionContext, standInSuggestions } from "../convex/lib/customizeSuggestions.ts";
import { fixtureInput } from "../scripts/workflow-evals.ts";
import { matchingPrompts, promptCompletionKey } from "../src/components/customize/prompt-completion.ts";
import { loadConvex } from "./convexHandlers.ts";

test("account page suggestions use the Deals relation and visible stage field", () => {
  const fixture = fixtureInput("");
  const scope = { target: "account" };
  const suggestions = standInSuggestions(customizationSuggestionContext(fixture, scope));
  assert.ok(suggestions.some((prompt) => /chart.*Deals.*stage/i.test(prompt)));
  assert.ok(suggestions.every((prompt) => prompt.length < 90));

  fixture.objects = fixture.objects.map((def) => def.apiName === "deal"
    ? { ...def, fields: def.fields.filter((field) => field.apiName !== "stage") }
    : def);
  const limited = standInSuggestions(customizationSuggestionContext(fixture, scope));
  assert.ok(limited.every((prompt) => !/stage/i.test(prompt)));
});

test("section suggestions focus on the pinned Timeline instead of Deals", () => {
  const suggestions = standInSuggestions(customizationSuggestionContext(fixtureInput(""), { target: "account", sectionId: "timeline#0" }));
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((prompt) => /Timeline/i.test(prompt) && !/Deals/i.test(prompt)));
});

test("deal suggestions expose play blocks only when the deal play is available", () => {
  const fixture = fixtureInput("");
  const scope = { target: "deal" };
  const unavailable = customizationSuggestionContext(fixture, scope);
  assert.ok(!Object.hasOwn(unavailable.context.blocks, "stageRail"));
  assert.ok(!unavailable.pages[0].addable.includes("stageRail"));

  fixture.pages.find((p) => p.target === "deal")!.dealPlay = { available: true, stage: "in" };
  const available = customizationSuggestionContext(fixture, scope);
  assert.ok(Object.hasOwn(available.context.blocks, "stageRail"));
  assert.ok(available.pages[0].addable.includes("stageRail"));
});

test("suggest refuses a missing plan before reading the object catalog or calling a model", async () => {
  const fn = loadConvex(["pageCustomize.ts"], {
    "lib/recipeAgentStandIn.ts": (real) => ({ ...real, recipeAgentStandIn: () => false }),
    "lib/llmResolver.ts": (real) => ({
      ...real,
      resolveLlm: async (_ctx: unknown, userId: string, options: { refresh: boolean }) => {
        assert.equal(userId, "user");
        assert.equal(options.refresh, false);
        return null;
      },
    }),
    "../engine/src/llm.ts": (real) => ({ ...real, forcedToolCall: () => assert.fail("model call") }),
  })["pageCustomize.ts"];
  await assert.rejects(fn.suggest.handler({
    runQuery: async (ref: unknown) => {
      assert.equal(String(ref), "internal.workspaceRecipes.workflowBases");
      return { userId: "user", pages: fixtureInput("").pages };
    },
    runMutation: () => assert.fail("write"),
  }, { scope: { target: "account" } }), /ChatGPT plan/);
});

test("completion accepts a prefix without consuming ordinary keyboard navigation", () => {
  const suggestions = ["Fold Timeline by default", "Fold Details by default", "Add a deals chart"];
  const value = "fold";
  const matches = matchingPrompts(value, suggestions);
  assert.deepEqual(matches, suggestions.slice(0, 2));
  assert.deepEqual(matchingPrompts("fold nowhere", suggestions), []);
  assert.deepEqual(matchingPrompts(suggestions[0], suggestions), []);
  const key = { key: "Tab", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false };
  const input = { value, selectionStart: 4, selectionEnd: 4 };
  assert.equal(promptCompletionKey(key, input, matches.length), "accept");
  assert.equal(promptCompletionKey(key, input, 0), undefined);
  assert.equal(promptCompletionKey({ ...key, shiftKey: true }, input, matches.length), undefined);
  assert.equal(promptCompletionKey({ ...key, isComposing: true }, input, matches.length), undefined);
  assert.equal(promptCompletionKey({ ...key, key: "ArrowRight" }, input, matches.length), "accept");
  assert.equal(promptCompletionKey({ ...key, key: "ArrowRight" }, { ...input, selectionStart: 1 }, matches.length), undefined);
  assert.equal(promptCompletionKey({ ...key, key: "ArrowDown" }, input, matches.length), "next");
  assert.equal(promptCompletionKey({ ...key, key: "ArrowUp" }, input, matches.length), "previous");
  assert.equal(promptCompletionKey({ ...key, key: "Enter" }, input, matches.length), undefined);
});
