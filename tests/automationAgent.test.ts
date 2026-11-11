import assert from "node:assert/strict";
import test from "node:test";
import { askForRule, MAX_ATTEMPTS, type RuleDocLike } from "../convex/lib/automationAgent.ts";

const DOC: RuleDocLike = { name: "Follow up", object: "deal", trigger: { kind: "created" }, conditions: [], actions: [{ kind: "create_task", subject: "Call", dueInDays: 1, owner: { kind: "record_owner" } }] };

test("Ask Canon sends Canon's problem back until the check takes the rule, and stops after its last try", async () => {
  const prompts: string[] = [];
  const answers = [{ summary: "no rule" }, { rule: { ...DOC, object: "invoice" }, summary: "wrong object" }, { rule: DOC, summary: "A task for each new deal." }];
  const check = async (doc: RuleDocLike) => (doc.object === "deal" ? { ok: true as const, sentence: "When a deal is created: create a task." } : { ok: false as const, problem: "Rules do not run on invoice records yet" });
  const deps = { call: async (prompt: string) => (prompts.push(prompt), answers.shift()), check, charge: () => {} };
  const out = await askForRule({ vocabulary: "V", workspace: "W", request: "a task for new deals" }, deps);
  assert.deepEqual(out, { ok: true, doc: DOC, sentence: "When a deal is created: create a task.", summary: "A task for each new deal.", attempts: 3 });
  assert.match(prompts[2]!, /Rules do not run on invoice records yet/, "the last refusal goes back to the model");

  let calls = 0;
  const never = await askForRule({ vocabulary: "V", workspace: "W", request: "x" }, { call: async () => (calls++, { rule: { ...DOC, object: "invoice" }, summary: "" }), check, charge: () => {} });
  assert.deepEqual([never.ok, calls, never.attempts], [false, MAX_ATTEMPTS, MAX_ATTEMPTS]);
});
