import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_PARTY_MARKDOWN } from "../recipes/_bundles.generated.ts";
import { defaultModel, modelValues } from "../recipes/index.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { accountStatus, engagementScore } from "../convex/lib/abm.ts";

test("abm.model scores a target account on canon-base's numbers, each part capped", () => {
  const m = defaultModel("abm.model");
  const busy = { openDeals: 2, openPipeline: 250_000, contacts: 9, owned: true, won: false };
  assert.equal(engagementScore(m, busy), 62, "35 open deal + 2.5 pipeline + 16 contacts (capped) + 8 owner, rounded");
  assert.equal(accountStatus(m, { score: 62, ...busy }), "opportunity");
  const quiet = { openDeals: 0, openPipeline: 0, contacts: 3, owned: true, won: false };
  assert.equal(engagementScore(m, quiet), 20);
  assert.equal(accountStatus(m, { score: 20, ...quiet }), "target");
  assert.equal(accountStatus({ ...m, engaged: 20 }, { score: 20, ...quiet }), "engaged");
});

test("a copy of canon-base made before a model setting existed still parses and reads the setting's fallback", () => {
  const older = FIRST_PARTY_MARKDOWN["canon-base"].split("\n").filter((l) => !/^\| (forecastClosingDays|callDefaultCloseDays) \|/.test(l)).join("\n");
  const { recipe, problems } = parseRecipe(older);
  assert.deepEqual(problems, []);
  assert.equal(modelValues({ id: "canon-base", models: recipe.models }, "forecast.model", recipe.defaults).closingDays, 30);
  assert.equal(modelValues({ id: "canon-base", models: recipe.models }, "calls.model", recipe.defaults).defaultCloseDays, 30);
});
