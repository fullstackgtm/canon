import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { modelSettings } from "../convex/lib/recipes.ts";
import { CALLS_FIXTURE_FILE, FIXTURE_FILE, differences, type Fixture } from "../scripts/model-check.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

test("forecast, health, lead scoring, heat, the audit and ICP fit on canon-base's settings return what origin/main's constants did", async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Fixture;
  assert.equal(fixture.cases.length, 136);
  assert.deepEqual((await differences(fixture)).map((d) => `${d.surface} ${d.name}`), []);
});

test("a model point reads the recipe enabled there, on that recipe's current revision", async () => {
  const org = "organizations:o";
  const db = memoryDb({
    recipeEnablements: [{ _id: "e1", orgId: org, point: "hygiene.policy", recipeId: "canon-base", contributionKey: "model", enabled: true, at: 1 }],
    recipeRevisions: [
      { _id: "r1", orgId: org, recipeId: "canon-base", revision: 1, settings: { hygieneStaleDealDays: 45 }, parent: null, status: "superseded", createdAt: 1 },
      { _id: "r2", orgId: org, recipeId: "canon-base", revision: 2, settings: { hygieneStaleDealDays: 60, hygieneRequireDealOwner: false, hygieneDisabledRules: ["orphan-account"], heatWindowDays: 3 }, parent: 1, status: "current", createdAt: 2 },
    ],
  });
  const hygiene = await modelSettings({ db } as never, org as never, "hygiene.policy");
  assert.deepEqual([hygiene.policy.staleDealDays, hygiene.policy.requireDealOwner, hygiene.disabledRules], [60, false, ["orphan-account"]]);
  assert.equal((await modelSettings({ db } as never, org as never, "signals.heat")).windowDays, 3, "a point with no row runs canon-base, on the same revision");
  assert.equal((await modelSettings({ db } as never, "organizations:other" as never, "signals.heat")).windowDays, 30);
});

test("the call facts prompt and call insights on canon-base's calls model return what origin/main's constants did", async () => {
  const fixture = JSON.parse(readFileSync(CALLS_FIXTURE_FILE, "utf8")) as Fixture;
  assert.equal(fixture.cases.length, 72);
  assert.deepEqual((await differences(fixture)).map((d) => `${d.surface} ${d.name}`), []);
});

test("a competitor a workspace adds to its calls model is a call insight", async () => {
  const org = "organizations:o";
  const transcript = "Rep: Who else are you talking to?\nCustomer: We had a long demo from Attio last week.";
  const competitorQuotes = async (revisions: Array<Record<string, unknown>>) => {
    const db = memoryDb({ recipeRevisions: revisions, callRecordings: [{ _id: "callRecordings:c", orgId: org, title: "Intro", transcriptText: transcript, createdAt: 1, updatedAt: 1 }] });
    const M = loadConvex(["callIntelligence.ts"]);
    await M["callIntelligence.ts"].analyzeImportedCall.handler({ db, scheduler: { runAfter: async () => null } }, { orgId: org, callId: "callRecordings:c" });
    return db.rows("callInsights").filter((i) => i.type === "competitor_mention").map((i) => i.evidence);
  };
  assert.deepEqual(await competitorQuotes([]), []);
  const added = [{ _id: "r1", orgId: org, recipeId: "canon-base", revision: 1, settings: { callCompetitorPhrases: "\\b(competitor|attio)\\b" }, parent: null, status: "current", createdAt: 1 }];
  assert.deepEqual(await competitorQuotes(added), ["We had a long demo from Attio last week."]);
});
