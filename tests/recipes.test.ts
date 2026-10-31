import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as values from "convex/values";
import * as model from "../convex/lib/plays/model.ts";
import * as validators from "../convex/lib/plays/validators.ts";
import * as peopleResearch from "../convex/lib/plays/peopleResearch.ts";
import * as runs from "../convex/lib/plays/runs.ts";
import * as playState from "../convex/lib/plays/state.ts";
import * as intake from "../convex/lib/conversations/intake.ts";
import * as recipes from "../convex/lib/recipes.ts";
import * as recipeRuntime from "../convex/lib/recipeRuntime.ts";
import * as integrations from "../convex/lib/integrationsAvailable.ts";
import * as registry from "../recipes/index.ts";
import type { AdditivePoint } from "../recipes/points.ts";
import { slowPattern, unsafePattern } from "../recipes/regex.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const require = createRequire(import.meta.url);
type Fn = { handler: (ctx: unknown, args: unknown) => Promise<unknown> };
const exports: Record<string, Fn> = {};
const register = (definition: unknown) => definition;
const user = { _id: "user", orgId: "org", role: "admin" };
const caller = { orgId: "org", userId: "user", access: {} };
const stubs: Record<string, unknown> = {
  "./lib/integrationsAvailable.ts": integrations,
  "convex/values": values,
  "./_generated/server": { action: register, internalMutation: register, internalQuery: register },
  "./_generated/api": { api: {}, internal: { dealPlays: { load: "load", apply: "apply" }, dealCommittee: { dealPeople: "dealPeople" } } },
  "./records": { requireCaller: async () => caller, callerClient: () => ({}) },
  "./lib": { withRole: async (_ctx: unknown, u: unknown) => u },
  "./lib/access": { may: () => true, isRestricted: () => false },
  "./permissions": { dealVisible: () => true },
  "./dealCommittee": { dealOfStream: async () => ({ _id: "deal", name: "Northstar" }), mayEdit: () => true },
  "./associations": {}, "./activityTargets": {}, "./lib/linkedin/cadence": {}, "./lib/icpGates": {}, "./lib/plays/prospectSelection": {},
  "./lib/segments/jev": {},
  "./lib/plays/model": model, "./lib/plays/validators": validators, "./lib/plays/peopleResearch": peopleResearch, "./lib/plays/runs": runs, "./lib/plays/state": playState, "./lib/conversations/intake": intake, "./lib/recipes": recipes, "./lib/recipeRuntime": recipeRuntime,
};
const { outputText } = ts.transpileModule(readFileSync(new URL("../convex/dealPlays.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
runInNewContext(outputText, { exports, process, require: (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)) });

/** An action context whose queries run dealPlays' own `load` against a workspace on `dealPageRecipe`. */
function workspace(dealPageRecipe?: string) {
  const db = {
    get: async (id: string) => (id === "user" ? user : id === "org" ? { _id: "org", ...(dealPageRecipe ? { dealPageRecipe } : {}) } : null),
    query: () => ({ withIndex: () => ({ unique: async () => null, take: async () => [], order: () => ({ async *[Symbol.asyncIterator]() {} }) }) }),
  };
  const applied: unknown[] = [];
  const ctx = {
    runQuery: async (ref: string, args: unknown) => (ref === "load" ? exports.load.handler({ db }, args) : { members: [] }),
    runMutation: async (_ref: string, args: unknown) => { applied.push(args); return null; },
  };
  return { ctx, applied };
}

test("a workspace whose recipe has no plays reads no plane and refuses every play change", async () => {
  const base = workspace("canon-base");
  assert.equal(await exports.get.handler(base.ctx, { streamId: "deal" }), null);
  await assert.rejects(exports.setBrief.handler(base.ctx, { streamId: "deal", whyNow: "Budget lock" }), (error: unknown) => recipes.isNoPlays(error));
  assert.deepEqual(base.applied, []);

  const fsgtm = workspace();
  await exports.setBrief.handler(fsgtm.ctx, { streamId: "deal", whyNow: "Budget lock" });
  assert.equal(fsgtm.applied.length, 1, "a workspace that never picked keeps FSGTM's plays");
});

const SERVICE_ISSUER = "https://canon.test/service";
process.env.CANON_SERVICE_JWT_ISSUER = SERVICE_ISSUER;

/**
 * convex/recipes.ts against an in-memory workspace with one AI field, called by an admin in the dashboard, or by
 * their agent over /mcp once `as("agent")`. `act` is an action context whose queries and mutations run here too.
 */
function settingsWorkspace() {
  const loaded = loadConvex(["recipes.ts", "lib/recipes.ts", "researchAgents.ts"], { "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }) });
  const db = memoryDb({
    organizations: [{ _id: "org" }], users: [user],
    researchAgents: [{ _id: "field", orgId: "org", slug: "primary_goal", question: registry.RECIPES["fsgtm-enterprise-deal"].settings.primaryGoalQuestion }],
    facts: [{ _id: "answer", entityId: "person", attribute: "custom.primary_goal", observedAt: 1, status: "accepted", value: "Hit the plan" }],
  });
  let identity: Record<string, string> | null = null;
  const auth = { getUserIdentity: async () => identity };
  const ctx = { db, auth };
  const fn = loaded["recipes.ts"];
  const byRef = (ref: unknown) => fn[String(ref).split(".").pop()!];
  const act = { auth, runQuery: (ref: unknown, args: unknown) => byRef(ref).handler(ctx, args), runMutation: (ref: unknown, args: unknown) => byRef(ref).handler(ctx, args) };
  const as = (who: "user" | "agent") => { identity = who === "agent" ? { issuer: SERVICE_ISSUER, subject: "user", azp: "claude-code" } : null; };
  const orgRecipe = loaded["lib/recipes.ts"].orgRecipe as unknown as (ctx: unknown, orgId: string) => Promise<{ ref: registry.RecipeRef }>;
  /** The org's plays data from orgRecipe, with the draft code bound to the same settings. */
  const plays = async () => {
    const { ref } = await orgRecipe(ctx, "org");
    return { ...ref.plays!, drafts: { ...ref.plays!.drafts, ...registry.firstPartyCode(ref.id, ref.settings)!.drafts } };
  };
  const revisions = () => db.rows("recipeRevisions").map((r) => [r.revision, r.parent, r.status, { ...(r.settings as object) }]);
  const skipped = async () => [...await loaded["researchAgents.ts"].skippedEntities.handler(ctx, { agentId: "field", entityIds: ["person"], attribute: "custom.primary_goal" }) as string[]];
  return { fn, ctx, act, as, db, plays, revisions, skipped };
}

const EMAIL_70 = `Hi Dana,\n\n${Array.from({ length: 5 }, (_, i) => `Sentence ${i} has exactly fourteen words in it so the email runs long here.`).join(" ")}\n\nRyan`;

test("a saved setting reaches every play surface through orgRecipe, and an edited question reaches its AI field and re-asks", async () => {
  const w = settingsWorkspace();
  const defaults = registry.RECIPES["fsgtm-enterprise-deal"].settings;
  const before = await w.plays();
  assert.equal(before.drafts.check("email", "a short subject", EMAIL_70).find((c) => c.key === "length")?.ok, true);
  assert.deepEqual(await w.skipped(), ["person"], "an answered person is skipped");

  const primaryGoalQuestion = "What does this person most need to get done this year?";
  await w.fn.saveSettings.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal", baseRevision: null, settings: { ...defaults, emailMaxWords: 60, primaryGoalQuestion } });
  assert.deepEqual(w.revisions(), [[1, null, "current", { emailMaxWords: 60, primaryGoalQuestion }]]);

  const after = await w.plays();
  assert.deepEqual({ ...after.drafts.check("email", "a short subject", EMAIL_70).find((c) => c.key === "length") }, { key: "length", label: "Reads without scrolling on a phone", ok: false, note: "5 sentences, 70 words" });
  const prompt = after.drafts.prompt({ channel: "email", stepTitle: "First touch", company: "Acme", sender: "Ryan", person: { name: "Dana", title: null, role: "champion" }, context: null, pointOfView: null, offer: null, facts: [], history: [] } as never);
  assert.match(prompt, /and 60 words between the greeting/);
  assert.equal((await w.db.get("field"))?.question, primaryGoalQuestion);
  assert.deepEqual(await w.skipped(), [], "an answer to the old question no longer stops research asking the new one");
});

test("a workspace's theme follows its saved colours, and a save that would be hard to read is refused without writing", async () => {
  const w = settingsWorkspace();
  const ledger = registry.RECIPES["canon-ledger"].settings;
  const theme = async () => (await w.fn.theme.handler(w.ctx, {})) as Record<string, string>;
  assert.equal((await theme())["--primary"], "#1e4d3a", "an unset workspace runs Ledger");

  await w.fn.saveSettings.handler(w.ctx, { recipeId: "canon-ledger", baseRevision: null, settings: { ...ledger, primary: "#3d2a6b", headings: "sans" } });
  const saved = await theme();
  assert.deepEqual([saved["--primary"], saved["--primary-foreground"], saved["--heading-font"].includes("plex-sans")], ["#3d2a6b", "#ffffff", true]);

  await assert.rejects(w.fn.saveSettings.handler(w.ctx, { recipeId: "canon-ledger", baseRevision: 1, settings: { ...ledger, ink: "#b0b0b0" } }), /hard to read: body text needs 7:1/);
  await assert.rejects(w.fn.saveSettings.handler(w.ctx, { recipeId: "canon-ledger", baseRevision: 1, settings: { ...ledger, primary: "1e4d3a" } }), /colour like #1e4d3a/);
  assert.deepEqual(w.revisions(), [[1, null, "current", { primary: "#3d2a6b", headings: "sans" }]]);
});

test("saveSettings refuses a stale base or an invalid value without writing, and revert writes a new revision", async () => {
  const w = settingsWorkspace();
  const save = (baseRevision: number | null, settings: Record<string, unknown>) => w.fn.saveSettings.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal", baseRevision, settings });
  await save(null, { emailMaxWords: 60 });
  await save(1, { emailMaxWords: 70 });
  await assert.rejects(save(1, { emailMaxWords: 80 }), /changed these settings since you opened them/);
  await assert.rejects(save(2, { pitchPhrases: "(demo" }), /Pitch phrases must be a valid pattern/);
  await assert.rejects(save(2, { emailMaxWords: 5000 }), /Email max words must be between 20 and 400/);
  assert.equal(w.revisions().length, 2);

  assert.deepEqual({ ...(await w.fn.revertTo.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal", revision: 1 }) as object) }, { revision: 3, changed: true });
  assert.deepEqual(w.revisions(), [
    [1, null, "superseded", { emailMaxWords: 60 }], [2, 1, "superseded", { emailMaxWords: 70 }], [3, 2, "current", { emailMaxWords: 60 }],
  ]);
  assert.equal((await w.plays()).drafts.check("email", "a short subject", EMAIL_70).find((c: { key: string }) => c.key === "length")?.ok, false);
});

test("fit model revisions invalidate in the writing transaction and coalesce until reconciliation", async () => {
  const w = settingsWorkspace();
  const scheduled: unknown[] = [];
  const ctx = { ...w.ctx, scheduler: { runAfter: async (ms: number, ref: unknown, args: unknown) => { scheduled.push(plain([ms, String(ref), args])); } } };
  const save = (baseRevision: number | null, settings: Record<string, unknown>) => w.fn.saveSettings.handler(ctx, { recipeId: "canon-base", baseRevision, settings });
  await save(null, { fitIndustryWeights: [60, 34, 30] });
  await save(1, { fitIndustryWeights: [60, 34, 30], forecastCommitWeight: 0.9 });
  assert.equal(w.db.rows("fitReconciliations")[0].revision, 1);
  assert.equal(scheduled.length, 1);
  await w.fn.revertTo.handler(ctx, { recipeId: "canon-base", revision: 0 });
  assert.equal(w.db.rows("fitReconciliations")[0].revision, 2);
  assert.equal(scheduled.length, 1, "reverting to the defaults joins the queued reconciliation");
});

const ICM_QUESTION = "Which incentive compensation management vendor does this person's company use today, and when is its renewal? Cite sources; say unknown where unsupported.";
const FSGTM = "fsgtm-enterprise-deal";
/** A value from the loaded modules' realm, comparable with deepStrictEqual. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

test("an agent's proposal stores its eval results and waits, and the agent can't decide it or change settings itself", async () => {
  const w = settingsWorkspace();
  w.as("agent");
  const out = await w.fn.proposeSettings.handler(w.act, { changes: { primaryGoalQuestion: ICM_QUESTION }, note: "Ask about their current ICM vendor" });
  assert.equal(out.revision, 1);
  const [row] = w.db.rows("recipeRevisions");
  assert.deepEqual(plain({ status: row.status, parent: row.parent, author: row.author, settings: row.settings }), {
    status: "proposed", parent: null, author: { kind: "mcp", id: "user", client: "claude-code" }, settings: { primaryGoalQuestion: ICM_QUESTION },
  });
  const evals = (row.proposal as { evals: Array<{ name: string; ok: boolean }> }).evals;
  assert.deepEqual(plain(evals.map((e) => [e.name, e.ok])), registry.RECIPES[FSGTM].evals.map((e) => [e.name, true]));

  for (const [name, args] of [
    ["approveProposal", { recipeId: FSGTM, revision: 1 }], ["rejectProposal", { recipeId: FSGTM, revision: 1 }],
    ["saveSettings", { recipeId: FSGTM, baseRevision: null, settings: { primaryGoalQuestion: ICM_QUESTION } }], ["revertTo", { recipeId: FSGTM, revision: 0 }],
  ] as const) {
    await assert.rejects(w.fn[name].handler(w.ctx, args), /An agent can't/, `${name} refuses an agent acting for an admin`);
  }
  assert.equal(w.db.rows("recipeRevisions").length, 1);
  assert.notEqual((await w.plays()).people.fields.find((f) => f.slug === "primary_goal")?.question, ICM_QUESTION);
});

test("approval refuses a moved base and failing evals unless accepted, and an approved proposal is what orgRecipe reads", async () => {
  const w = settingsWorkspace();
  w.as("agent");
  await w.fn.proposeSettings.handler(w.act, { changes: { primaryGoalQuestion: ICM_QUESTION }, note: "Ask about their current ICM vendor" });
  const short = await w.fn.proposeSettings.handler(w.act, { changes: { emailMaxWords: 20 }, note: "Shorter emails" });
  assert.deepEqual(plain(short.evals.filter((e: { ok: boolean }) => !e.ok)), [{ name: "Clean email passes", ok: false, detail: "result[length].ok is false, expected true (4 sentences, 34 words)" }]);

  w.as("user");
  await assert.rejects(w.fn.approveProposal.handler(w.ctx, { recipeId: FSGTM, revision: 2 }), /1 eval failed/);
  assert.deepEqual(plain(await w.fn.approveProposal.handler(w.ctx, { recipeId: FSGTM, revision: 1 })), { revision: 3 });
  await assert.rejects(w.fn.approveProposal.handler(w.ctx, { recipeId: FSGTM, revision: 2, acceptFailingEvals: true }), /Settings changed since this was proposed; ask for a fresh proposal/);
  await w.fn.rejectProposal.handler(w.ctx, { recipeId: FSGTM, revision: 2, reason: "Too short" });

  assert.deepEqual(w.revisions(), [
    [1, null, "superseded", { primaryGoalQuestion: ICM_QUESTION }], [2, null, "rejected", { emailMaxWords: 20 }], [3, null, "current", { primaryGoalQuestion: ICM_QUESTION }],
  ]);
  assert.equal(w.db.rows("recipeRevisions")[2].note, "Approved proposal #1: Ask about their current ICM vendor");
  assert.equal((await w.plays()).people.fields.find((f) => f.slug === "primary_goal")?.question, ICM_QUESTION);
  assert.equal((await w.db.get("field"))?.question, ICM_QUESTION, "the AI field asks the approved question");
});

test("a phrase pattern that can backtrack catastrophically is refused before it's saved or proposed", () => {
  const cases: Array<[string, boolean]> = [
    ["(a+)+", false], ["(a*)*", false], ["(a?)+", false], ["^(\\w+\\s?)*$", false], ["(.*a){12}", false], ["(?=(a+)+)b", false],
    ["(a|ab)+", false], ["(\\w|\\d)+", false], ["(a|)+", false], [".*.*", false], ["\\w+\\s?\\w+", false], ["(a)\\1", false],
    ["(a|b)+", true], ["\\w+ \\w+", true], ["book.*call", true], ["\\b(demo|features?)\\b", true], ["hope this (email )?finds you", true],
  ];
  assert.deepEqual(cases.map(([p]) => [p, unsafePattern(p) === null]), cases);
  const recipe = registry.RECIPES[FSGTM];
  for (const d of recipe.settingsSchema.filter((x) => x.kind === "phrases")) assert.equal(unsafePattern(String(recipe.settings[d.key])), null, `${d.key} default`);
  assert.deepEqual(registry.parseOverrides(recipe, { pitchPhrases: "(demo+)+" }).errors.map((e) => e.key), ["pitchPhrases"]);
  assert.equal(slowPattern(".*.*.*x"), true);
});

test("a Clerk workspace starts on plain fields with default modules, and an untouched workspace keeps FSGTM's", async () => {
  const loaded = loadConvex(["organizations.ts", "lib/recipes.ts"]);
  const db = memoryDb({ organizations: [{ _id: "existing", clerkOrgId: "org_existing", name: "Old", slug: "old" }] });
  const scheduled: Array<[number, string, unknown]> = [];
  const publications: typeof scheduled = [];
  const ctx = { db, scheduler: { runAfter: async (delay: number, ref: unknown, args: unknown) => {
    const name = String(ref);
    if (["internal.modules.installShipped", "internal.modules.importStep", "internal.moduleDefaults.reconcile"].includes(name)) scheduled.push([delay, name, args]);
    else { assert.equal(name, "internal.moduleActivityPublications.run", "Unknown workspace task"); publications.push([delay, name, args]); }
  } } };
  const created = await loaded["organizations.ts"].upsertFromClerk.handler(ctx, { clerkOrgId: "org_new", name: "New", slug: "new" });
  await loaded["organizations.ts"].upsertFromClerk.handler(ctx, { clerkOrgId: "org_existing", name: "Old", slug: "old" });
  const orgRecipe = loaded["lib/recipes.ts"].orgRecipe as unknown as (ctx: unknown, orgId: string) => Promise<{ recipe: { id: string } }>;
  assert.equal((await orgRecipe({ db }, created)).recipe.id, "canon-base");
  assert.equal((await orgRecipe({ db }, "existing")).recipe.id, "fsgtm-enterprise-deal");
  assert.deepEqual(plain(scheduled), [
    [0, "internal.modules.installShipped", { orgId: created, moduleId: "@canon/reports" }],
    [0, "internal.modules.importStep", { orgId: created, moduleId: "@canon/reports", name: "reports.legacy", cursor: null }],
    [0, "internal.moduleDefaults.reconcile", { orgId: created }],
  ]);
  assert.deepEqual(plain(publications), [[0, "internal.moduleActivityPublications.run", { orgId: created }]]);
  // Work ships server code (0.2.0), so the scheduled reconcile above installs it with its bundle, not workspace creation.
  assert.deepEqual(db.rows("modulePackages").map((p) => [p.orgId, p.moduleId, p.status]), [[created, "@canon/reports", "installed"]]);
});

test("switching the deal page leaves exactly one recipe on, an additive point keeps many and refuses a conflict, and an agent can't switch", async () => {
  const w = settingsWorkspace();
  const page = async () => (await w.fn.forOrg.handler(w.ctx, {})).dealPage.id;
  const enable = (recipeId: string) => w.fn.enableContribution.handler(w.ctx, { point: "deal.page", recipeId, key: "page" });
  await w.db.patch("org", { dealPageRecipe: "canon-base" });
  assert.equal(await page(), "canon-base", "a workspace from before the table keeps its field's recipe");
  await enable("fsgtm-enterprise-deal");
  await enable("canon-base");
  assert.deepEqual(w.db.rows("recipeEnablements").map((r) => [r.recipeId, r.enabled]), [["fsgtm-enterprise-deal", false], ["canon-base", true]]);
  await enable("fsgtm-enterprise-deal");
  assert.equal(await page(), "fsgtm-enterprise-deal");
  await assert.rejects(w.fn.disableContribution.handler(w.ctx, { point: "deal.page", recipeId: "fsgtm-enterprise-deal", key: "page" }), "an exclusive point is switched, not turned off");
  await assert.rejects(enable("@nobody/not-installed"));
  w.as("agent");
  await assert.rejects(enable("canon-base"));
  w.as("user");
  assert.deepEqual(w.db.rows("recipeEnablements").map((r) => [r.recipeId, r.enabled]), [["fsgtm-enterprise-deal", true], ["canon-base", false]]);

  const fields: AdditivePoint<{ slug: string }> = {
    id: "fields", kind: "fields", cardinality: "additive", title: "Fields", description: "", missing: "", binds: "data", implies: { read: [] },
    discover: () => [], problems: () => [], conflict: (a, b) => (a.declares.slug === b.declares.slug ? `both define ${a.declares.slug}` : null),
  };
  const field = (recipeId: string, slug: string) => ({ point: "fields" as never, recipeId, recipeTitle: recipeId, key: slug, title: slug, declares: { slug } });
  const on = [field("@a/x", "goal")];
  assert.deepEqual(registry.planEnable(fields as never, on, field("@b/y", "systems")), { ok: true, off: [] });
  on.push(field("@b/y", "systems"));
  assert.equal(registry.planEnable(fields as never, on, field("@c/z", "goal")).ok, false, "two recipes defining one field slug");
  assert.deepEqual(registry.planEnable(registry.pointOf("deal.page"), on.slice(0, 1), field("@b/y", "systems")), { ok: true, off: [on[0]] });
});
