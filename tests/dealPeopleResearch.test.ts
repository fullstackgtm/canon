import assert from "node:assert/strict";
import { test } from "node:test";
import { PEOPLE_RESEARCH_WAIT_MS, employment, peopleResearchDue } from "../convex/lib/plays/peopleResearch.ts";
import { researchDue } from "../convex/lib/plays/runs.ts";
import { RECIPES, defaultPlays, refOf } from "../recipes/index.ts";

const { capability, productContext } = defaultPlays("fsgtm-enterprise-deal")!.people;

test("the recipe's cadences decide when the keeper researches a deal's account and its people, and a stuck run stops blocking it", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-13T09:00:00Z");
  const done = (daysAgo: number) => ({ status: "done", startedAt: now - daysAgo * DAY - 60_000, finishedAt: now - daysAgo * DAY });
  const recipe = RECIPES["fsgtm-enterprise-deal"];
  const due = (settings: Record<string, number>) => {
    const plays = refOf(recipe, { ...recipe.settings, ...settings }).plays!;
    return [2, 4, 8].map((d) => [researchDue(done(d), false, now, plays), researchDue(done(d), true, now, plays), peopleResearchDue(done(d), now, plays.people.everyDays)]);
  };
  assert.deepEqual(due({}), [[false, true, false], [false, true, false], [true, true, true]]);
  assert.deepEqual(due({ researchEveryDays: 3, newQuestionsAfterDays: 5, peopleResearchEveryDays: 3 }), [[false, false, false], [true, true, true], [true, true, true]]);
  const plays = refOf(recipe).plays!;
  assert.equal(peopleResearchDue(null, now, plays.people.everyDays), true);
  assert.equal(peopleResearchDue({ status: "running", startedAt: now - PEOPLE_RESEARCH_WAIT_MS }, now, plays.people.everyDays), false);
  assert.equal(peopleResearchDue({ status: "running", startedAt: now - 3 * PEOPLE_RESEARCH_WAIT_MS }, now, plays.people.everyDays), true);
});

test("capabilities need a product, keep only people asked about, and treat empty as none", () => {
  assert.equal(productContext({ context: null }, null), null);
  const product = productContext({ context: "Canon keeps a CRM clean." }, { icpName: "Revenue leaders", text: "Forecasts get rebuilt by hand.", offer: "A free audit" })!;
  assert.match(product, /Canon keeps a CRM clean\.\nPoint of view for Revenue leaders: Forecasts get rebuilt by hand\.\nWhat a first touch may offer: A free audit/);
  const prompt = capability.prompt({ company: "Northstar", product, people: [{ contactId: "a", name: "Priya", title: "VP RevOps", goal: null, systems: "Salesforce" }] });
  assert.match(prompt, /<person contactId="a">\nName: Priya, VP RevOps\nGoal: unknown\nSystems: Salesforce\n<\/person>/);
  const out = capability.clean({ people: [{ contactId: "a", capability: "  Trust the   forecast. " }, { contactId: "b", capability: "" }, { contactId: "x", capability: "Not asked" }] }, ["a", "b"]);
  assert.deepEqual([...out], [["a", "Trust the forecast."], ["b", null]]);
  assert.equal(capability.clean("garbage", ["a"]).size, 0);
});

test("only a quoted answer says someone left or is still there; Jev's inference from silence says nothing", () => {
  assert.equal(employment({ value: false, evidence: "Joined Acme as CTO.\n\nSource: https://example.com/p" }), false);
  assert.equal(employment({ value: true, evidence: "Head of Data at Northstar.\n\nSource: https://example.com/p (search result)" }), true);
  assert.equal(employment({ value: false, evidence: "Inferred by Jev (0.74): no page read states it outright. What it read: ..." }), null);
  assert.equal(employment({ value: false, evidence: "Their title.\n\nSource: https://example.com/p (inferred by Jev)" }), null);
  assert.equal(employment({ value: "unknown", evidence: "x" }), null);
  assert.equal(employment(undefined), null);
});
