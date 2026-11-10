import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RECIPES_FILE, generate } from "../scripts/build-recipes.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { DEFAULT_DEAL_PAGE, contributionsOf, groupFields } from "../recipes/index.ts";
import { recipeOf } from "../recipes/compose.ts";
import { fromManifest, toManifest } from "../recipes/manifest.ts";
import { STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const source = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
const velocity = readFileSync(new URL("../recipes/fsgtm-velocity-deal/recipe.md", import.meta.url), "utf8");
const dealFields = STANDARD_OBJECTS.deal.fields.map((f) => f.apiName);
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("canon-base's recipe.md parses to the default deal page, the generated module is current, and a broken copy names its lines", async () => {
  const { recipe, problems } = parseRecipe(source, { objectFields: { deal: dealFields } });
  assert.deepEqual(problems, []);
  assert.equal(recipe.meta.id, "canon-base");
  assert.deepEqual(recipe.dealPage, [
    { component: "header", title: "Deal", actions: [{ id: "archive", label: "Archive", runs: "kernel.archive" }, { id: "restore", label: "Restore", runs: "kernel.restore" }] },
    { component: "fields", title: "Overview", fields: ["name", "companyId", "amount", "currency", "closeDate", "ownerId"] },
    { component: "fields", title: "Pipeline", fields: ["stage", "probability", "forecastCategory", "dealType", "nextStep", "isClosed", "isWon"] },
    { component: "fields", title: "Notes", fields: ["description"] },
    { component: "fields", title: "More", fields: ["rest"] },
    { component: "fields", title: "System", fields: ["crmOwnerId", "createdAt", "updatedAt"], collapsed: true },
    { component: "timeline", title: "Timeline" },
    { component: "history", title: "History" },
    { component: "related", title: "Related" },
    { component: "products", title: "Products" },
    { component: "splits", title: "Credit splits" },
    { component: "apps", title: "Apps" },
  ]);
  assert.equal(readFileSync(RECIPES_FILE, "utf8"), (await generate()).recipes, "recipes/_recipes.generated.ts is stale: run scripts/build-recipes.ts");

  const broken = source
    .replace(/^version: .*$/m, "version: one")
    .replace("## Notes {section=fields}", "## Notes {section=fieldz}")
    .replace("stage, probability", "stage, probabilty")
    .replace("## History {section=history}", '## History {section=history when="stage = won"}')
    .replace("| healthAccountsScored | int | 50 | 1 to 200 |", "| healthAccountsScored | int | 50 | 1 to 500 |");
  const got = parseRecipe(broken, { objectFields: { deal: dealFields } }).problems.map(({ line, level }) => ({ line, level }));
  assert.deepEqual(got, [
    { line: lineOf(source, "version:"), level: "error" },
    { line: lineOf(source, "stage, probability"), level: "warning" },
    { line: lineOf(source, "## Notes"), level: "error" },
    { line: lineOf(source, "## History"), level: "error" },
    { line: lineOf(source, "{model=health.model}"), level: "error" },
  ]);
});

const POINTS_V3 = ["deal.page", "fields", "templates.reports", "templates.automations", "scoring.lead"];

test("contributes declares the points a recipe.md fills, each found in its body, and survives the trip to a stored manifest", () => {
  const { recipe, problems } = parseRecipe(velocity);
  assert.deepEqual(problems, []);
  assert.deepEqual([recipe.meta.contributes, recipe.meta.permissions.slots, recipe.meta.permissions.read], [POINTS_V3, POINTS_V3, ["deal", "contact", "account", "observations", "icps"]]);
  const offered = (r: Parameters<typeof contributionsOf>[0]) => contributionsOf(r).map((c) => ({ point: c.point, key: c.key, recipeId: c.recipeId, parts: Array.isArray(c.declares) ? c.declares.length : 1 }));
  const want = [
    { point: "deal.page", key: "page", recipeId: "@fsgtm/velocity-deal", parts: recipe.dealPage.length },
    { point: "scoring.lead", key: "model", recipeId: "@fsgtm/velocity-deal", parts: 1 },
    ...["still_at_company", "primary_goal", "responsible_systems", "sales_motion"].map((key) => ({ point: "fields", key, recipeId: "@fsgtm/velocity-deal", parts: 1 })),
    { point: "templates.reports", key: "velocity_by_quarter_stage", recipeId: "@fsgtm/velocity-deal", parts: 1 },
    { point: "templates.automations", key: "first_touch_today", recipeId: "@fsgtm/velocity-deal", parts: 1 },
  ];
  assert.deepEqual(offered(recipeOf(recipe, [])), want);
  assert.deepEqual(offered(fromManifest(JSON.parse(JSON.stringify(toManifest(recipe))))), want);

  const front = (from: string, to: string) => parseRecipe(source.replace(from, to)).problems.map(({ line, level }) => ({ line, level }));
  const contributes = lineOf(source, "contributes:");
  assert.deepEqual(front("contributes: [deal.page,", "contributes: [deal.page, signals,"), [{ line: contributes, level: "error" }], "a point Canon doesn't have");
  assert.deepEqual(front("contributes: [deal.page,", "contributes: [deal.page, deal.page,"), [{ line: contributes, level: "error" }]);
  assert.deepEqual(front("read: [deal, account, contact],", "read: [deal, account, contact], slots: [deal.page],"), [{ line: lineOf(source, "permissions:"), level: "error" }], "slots come from contributes");
  const pageless = source.slice(0, source.indexOf("# Deal")) + source.slice(source.indexOf("# Reports and dashboards"));
  assert.deepEqual(parseRecipe(pageless).problems.map(({ line, level }) => ({ line, level })), Array(3).fill({ line: contributes, level: "error" }), "three pages declared, and none in the body");
});

test("the Settings table and the actions parse into descriptors and actions, and a broken copy names each problem's line", () => {
  const { recipe, problems } = parseRecipe(velocity);
  assert.deepEqual(problems, []);
  assert.deepEqual(recipe.settingsSchema.slice(0, 2), [
    { key: "coreRoles", label: "Core roles", help: "The roles a multi-threaded deal needs covered. The keeper flags each one nobody holds.", group: "Keeper", kind: "roles", options: ["executive", "n1", "champion", "user", "procurement", "security", "signer"] },
    { key: "quietDays", label: "Quiet after (days)", help: "No touch either way in this many days reads as quiet.", group: "Keeper", kind: "int", min: 1, max: 365 },
  ]);
  assert.deepEqual([recipe.defaults.coreRoles, recipe.defaults.closeProbability, recipe.defaults.pitchPhrases], [
    ["champion"], 0.4, String.raw`\b(our (platform|product|solution|software|tool)|demo|features?|we help|we offer|i wanted to reach out|hope this (email )?finds you)\b`,
  ]);
  const plan = recipe.dealPage.find((s) => s.component === "plan");
  const draftIt = plan?.actions?.find((a) => a.id === "draftIt");
  assert.deepEqual(draftIt && { panel: draftIt.panel, runs: draftIt.runs, prompts: draftIt.prompts }, { panel: "draftPanel", runs: "kernel.draftStep", prompts: ["drafts.prompt", "drafts.reviewPrompt"] });

  const broken = velocity
    .replace("| quietDays | int | 5 | 1 to 365 |", "| quietDays | int | 500 | 1 to 365 |")
    .replace("| staleResearchDays | int | 30 | 1 to 365 |", "| staleResearchDays | days | 30 | 1 to 365 |")
    .replace("| subjectMaxWords | int | 8 | 5 to 20 |", "| subjectMaxWords | int | 8 | 5..20 |")
    .replace("label: Next deal\nruns: nav.nextDeal", "label: Next deal\nruns: ui.copy")
    .replace("id: markDone\nlabel: Mark done", "id: markDone\ncolour: red")
    .replace("prompt: drafts.prompt\nreview: drafts.reviewPrompt", "prompt: drafts.prompt\nreview: drafts.critique")
    .replace("runs: kernel.checkNow", "runs: kernel.dismissItem")
    .replace("shows: canEdit && picked.count > 0", "shows: canEdit && picked.count() > 0")
    .replace("label: Research account", "label: Research <role>");
  const errors = parseRecipe(broken).problems.filter((p) => p.level === "error").map((p) => `${p.line}: ${p.message}`);
  const fence = lineOf(broken, "id: markDone") - 1;
  for (const [line, says] of [
    [lineOf(broken, "| quietDays |"), "setting quietDays: the default must be between 1 and 365"],
    [lineOf(broken, "| staleResearchDays |"), "setting staleResearchDays: kind must be one of"],
    [lineOf(broken, "| subjectMaxWords |"), "setting subjectMaxWords: the limits of a int setting are <min> to <max>"],
    [lineOf(broken, "runs: ui.copy"), "action nextDeal: runs ui.copy is not a kernel action"],
    [lineOf(broken, "colour: red"), "action markDone: colour is not an action key"],
    [fence, "action markDone needs a label"],
    [lineOf(broken, "review: drafts.critique"), "action draftIt: prompt drafts.critique isn't written in this customization"],
    [lineOf(broken, "runs: kernel.dismissItem"), "action checkNow: kernel.dismissItem can't sit in keeper"],
    [lineOf(broken, "picked.count() > 0"), "action draftFirstTouches: shows \"canEdit && picked.count() > 0\", at column 12: picked.count(…): a condition can't call anything"],
    [lineOf(broken, "label: Research <role>"), "action researchAccount: <role> isn't a value this action has"],
    [lineOf(broken, "keeper: rule canon.keeper"), "canon.keeper reads the int setting staleResearchDays, which the Settings table doesn't have"],
  ] as const) assert.ok(errors.some((e) => e.startsWith(`${line}: ${says}`)), `line ${line}: ${says}\n  got ${errors.join("\n  ")}`);
});

test("a deal's fields group into the page's sections, and a custom field lands in More", () => {
  const fields = [...dealFields.filter((f) => f !== "dealType"), "renewalDate"].map((apiName) => ({ apiName }));
  const groups = groupFields(DEFAULT_DEAL_PAGE, fields).map((g) => [g.section.title, g.fields.map((f) => f.apiName)]);
  assert.deepEqual(groups, [
    ["Overview", ["name", "companyId", "amount", "currency", "closeDate", "ownerId"]],
    ["Pipeline", ["stage", "probability", "forecastCategory", "nextStep", "isClosed", "isWon"]],
    ["Notes", ["description"]],
    ["More", ["splitAllocations", "renewalDate"]],
    ["System", ["crmOwnerId", "createdAt", "updatedAt"]],
  ]);
});
