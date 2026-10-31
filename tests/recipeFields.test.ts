// Recipe AI fields (docs/recipes.md, "Fields"): turning one on makes its researchAgents row once, with provenance;
// two recipes can't both have a slug on; people research turns on and makes the deal page recipe's people fields.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toManifest } from "../recipes/manifest.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { refOf, RECIPES } from "../recipes/index.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const admin = { _id: "admin", orgId: "org", role: "admin", name: "Ada" };
const loaded = loadConvex(["recipes.ts", "researchAgents.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => admin, requireUser: async () => admin, requireCap: async () => admin, agentClientOf: async () => null }),
});
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const FSGTM = "fsgtm-enterprise-deal";
const VELOCITY = "@fsgtm/velocity-deal";

const VELOCITY_MD = readFileSync(new URL("../recipes/fsgtm-velocity-deal/recipe.md", import.meta.url), "utf8");

function workspace(markdown = VELOCITY_MD) {
  const velocity = toManifest(parseRecipe(markdown).recipe);
  const db = memoryDb({
    organizations: [{ _id: "org" }], users: [admin],
    recipePackages: [{ _id: "pkg", orgId: "org", recipeId: VELOCITY, status: "installed", version: velocity.version, manifest: JSON.stringify(velocity), bundleHash: markdown === VELOCITY_MD ? "h" : "h2", bundleStorageId: "s", source: { kind: "github-public", owner: "fullstackgtm", repo: "canon-recipes", ref: "v2.3.0", sha: "sha" } }],
  });
  const ctx = { db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } };
  const field = (slug: string) => db.rows("researchAgents").find((r) => r.slug === slug);
  return { db, ctx, field, recipes: loaded["recipes.ts"], research: loaded["researchAgents.ts"] };
}

test("turning a recipe field on makes one row with provenance, on again makes no other, and a deleted one isn't made again", async () => {
  const w = workspace();
  const goal = { point: "fields", recipeId: FSGTM, key: "primary_goal" };
  await w.recipes.enableContribution.handler(w.ctx, goal);
  await w.recipes.disableContribution.handler(w.ctx, goal);
  await w.recipes.enableContribution.handler(w.ctx, goal);
  assert.equal(w.db.rows("researchAgents").length, 1);
  const row = w.field("primary_goal")!;
  const question = refOf(RECIPES[FSGTM]).plays!.people.fields.find((f) => f.slug === "primary_goal")!.question;
  assert.deepEqual(plain({ ...row, _id: undefined, _creationTime: undefined, agentId: undefined, createdAt: undefined, updatedAt: undefined, refreshNextAt: undefined }), {
    orgId: "org", slug: "primary_goal", label: "Primary goal", entityType: "contact", kind: "qa", question, answerType: "text", judgment: true,
    autoAcceptMinConfidence: 0.8, refreshCadence: "monthly", recipe: { id: FSGTM, version: "1.2.0", key: "primary_goal" }, createdBy: "admin",
  });
  assert.equal(w.db.rows("agents")[0].ownerUserId, "admin", "whoever turned it on owns it and pays for its refreshes");
  const listed = (await w.research.list.handler(w.ctx, {})).agents[0];
  assert.deepEqual(plain(listed.recipe), { id: FSGTM, version: "1.2.0", title: RECIPES[FSGTM].title });

  await w.research.remove.handler(w.ctx, { slug: "primary_goal" });
  await w.recipes.disableContribution.handler(w.ctx, goal);
  await w.recipes.enableContribution.handler(w.ctx, goal);
  assert.equal(w.db.rows("researchAgents").length, 0, "a field the workspace deleted stays deleted");
  const view = await w.recipes.contributions.handler(w.ctx, {});
  const shown = view.points.find((p: { id: string }) => p.id === "fields").contributions.find((c: { recipeId: string; key: string }) => c.recipeId === FSGTM && c.key === "primary_goal");
  assert.deepEqual(plain([shown.enabled, shown.install.state]), [true, "deleted"]);
});

test("two recipes can't both have a field on under one slug", async () => {
  const w = workspace();
  await w.recipes.enableContribution.handler(w.ctx, { point: "fields", recipeId: FSGTM, key: "responsible_systems" });
  await assert.rejects(w.recipes.enableContribution.handler(w.ctx, { point: "fields", recipeId: VELOCITY, key: "responsible_systems" }), /both define the AI field responsible_systems/);
  assert.equal(w.db.rows("researchAgents").length, 1);
});

test("people research on FSGTM turns on and makes its three people fields with their questions, and skips one turned off", async () => {
  const w = workspace();
  const people = refOf(RECIPES[FSGTM]).plays!.people;
  await w.recipes.disableContribution.handler(w.ctx, { point: "fields", recipeId: FSGTM, key: "still_at_company" });
  const out = await w.research.startPeopleRuns.handler(w.ctx, { orgId: "org", userId: "admin", contactIds: ["c1"] });
  assert.ok(out.skipped.some((reason: string) => reason.startsWith("Still at company (")));
  assert.equal(w.field("still_at_company"), undefined);

  await w.recipes.enableContribution.handler(w.ctx, { point: "fields", recipeId: FSGTM, key: "still_at_company" });
  await w.research.startPeopleRuns.handler(w.ctx, { orgId: "org", userId: "admin", contactIds: ["c1"] });
  const rows = people.fields.map((f) => w.field(f.slug)!);
  assert.deepEqual(plain(rows.map((r) => [r.slug, r.question, r.answerType, r.judgment ?? false, (r.recipe as { id: string }).id])),
    people.fields.map((f) => [f.slug, f.question, f.answerType, f.judgment ?? false, FSGTM]));
  const on = w.db.rows("recipeEnablements").filter((e) => e.point === "fields" && e.enabled).map((e) => e.contributionKey).sort();
  assert.deepEqual(plain(on), people.fields.map((f) => f.slug).sort());
});

test("a settings revision rewords every setting-bound field, people research's or not, unless the workspace reworded it", async () => {
  const markdown = VELOCITY_MD
    .replace("| centerMinConfidence |", "| pricingQuestion | text | Does this company publish its prices, or quote each deal? | 8 to 1000 characters | Fields | Pricing | Asked of each account. |\n| centerMinConfidence |")
    .replace("```ai-fields\n", "```ai-fields\n- slug: pricing_model\n  label: Pricing\n  object: account\n  kind: classify\n  question: { setting: pricingQuestion }\n  options:\n    - { key: published, label: Published }\n    - { key: quoted, label: Quoted }\n");
  const w = workspace(markdown);
  for (const key of ["pricing_model", "primary_goal"]) await w.recipes.enableContribution.handler(w.ctx, { point: "fields", recipeId: VELOCITY, key });
  const ours = "What does this person say they are hired to fix?";
  await w.db.patch(w.field("primary_goal")!._id, { question: ours });
  const pricing = "Does this company show a price before a buyer talks to sales?";
  await w.recipes.saveSettings.handler(w.ctx, { recipeId: VELOCITY, settings: { pricingQuestion: pricing, primaryGoalQuestion: "What is this person paid to achieve this year?" }, baseRevision: null });
  assert.deepEqual(plain([w.field("pricing_model")!.question, typeof w.field("pricing_model")!.questionSince, w.field("primary_goal")!.question]), [pricing, "number", ours]);
});
