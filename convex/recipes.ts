/**
 * The workspace's recipes (docs/recipes.md): which one lays out deal pages (R1), and the workspace's settings for
 * each, kept as revisions an admin or manager writes and can revert (R2). A member or their agent can propose a
 * revision, which runs the recipe's evals on it and waits for an admin or manager to approve or reject it (R4). An
 * admin or manager installs a recipe from a GitHub repo, public or private through Canon's GitHub App, pinned to a
 * commit, and upgrades it with a three-way settings diff (R5). Agents preview installs and upgrades; only a person installs, upgrades or uninstalls.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { invalidateFit } from "./lib/fitInvalidation";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { contributionIn, currentRevision, enabledFor, enabledRows, enablementRow, modelSettings, orgConnections, orgRecipe, orgSettings, orgTheme, packageRecipe, packageRow, recipeIdValidator, recipeIn, requireRecipe, storedOverrides, upstreamChange, type FoundRecipe } from "./lib/recipes";
import { runEvals as evaluate, runSettled, targetOf } from "./lib/recipeRuntime";
import { installContribution, installView, type InstallView } from "./lib/templates";
import { ensureField } from "./researchAgents";
import { fieldsOf, resolveField, type RecipeField } from "../recipes/fields.ts";
import { checkRef, openSource, parseSource, resolveSource, sameRepo, sourceText, type Connection, type PinnedSource, type SourceReader } from "./lib/recipeSources";
import { BUILTINS_BUNDLE } from "../recipes/_bundles.generated.ts";
import { codeNames, markdownBundle, partsOf, type Part } from "../recipes/compose.ts";
import { DEAL_FRAME, PAGE_OBJECTS, POINT_IDS, RECIPES, contributionsOf, diffSettings, isFirstParty, isPointId, isTemplatePoint, pageOf, parseOverrides, planDisable, planEnable, pointOf, pointsOf, refOf, type Contribution, type EvalResult, type PointId, type RecipeDefinition, type Settings, type SettingValue } from "../recipes/index.ts";
import type { RecipeAbout } from "../recipes/kernel.ts";
import { BUNDLE_FILE, RECIPE_MAX_BYTES, compareVersions, fromManifest, isVersion, parseManifest, toManifest, type Manifest } from "../recipes/manifest.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { WORKSPACE_SCOPE, isWorkspaceId } from "../recipes/workspace.ts";
import { upgradeDiff, upgradedOverrides, type UpgradeLine } from "../recipes/upgrade.ts";
import { slowPattern } from "../recipes/regex.ts";
import { declaredTheme, themeProblems } from "../recipes/theme.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

const REVISIONS_SHOWN = 20;
const NOTE_MAX = 300;
/** Open proposals per workspace and recipe: past this, someone has to decide some first. */
const MAX_OPEN = 10;
const PACKAGES_SHOWN = 50;
const ERRORS_SHOWN = 8;

const AGENT_REFUSED = "An agent can't change package settings, approve or reject proposals, or install packages. Propose the change with canon_customization propose, and an admin or manager approves it on the Customization page.";

const settingValue = v.union(v.number(), v.string(), v.boolean(), v.array(v.string()), v.array(v.number()));
const evalResult = v.object({ name: v.string(), ok: v.boolean(), detail: v.union(v.string(), v.null()) });
const repoFields = { owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() };
const pinnedSource = v.union(v.object({ kind: v.literal("github-public"), ...repoFields }), v.object({ kind: v.literal("github-app"), installationId: v.number(), ...repoFields }));
type Diff = Array<{ key: string; from: SettingValue; to: SettingValue }>;
type PackageView = Pick<Doc<"recipePackages">, "_id" | "manifest" | "bundleHash" | "bundleStorageId" | "source" | "version">;

/** A recipe as the Recipes page and /mcp list it: the points it contributes to, and for an installed one the commit it runs. */
const card = ({ recipe: r, pkg }: FoundRecipe) => ({
  id: r.id, version: r.version, title: r.title, description: r.description, author: r.author, hasPlays: r.data !== null, permissions: r.permissions, contributes: pointsOf(r),
  source: pkg ? sourceCard(pkg) : null,
});

/** Where an installed recipe came from: a GitHub repo pinned to a commit, or the workspace's own copy of a recipe. */
function sourceCard(pkg: Doc<"recipePackages">) {
  const s = pkg.source;
  if (s.kind === "workspace") return { text: `copy of ${s.forkedFrom.id} v${s.forkedFrom.version}`, ref: "", sha: s.markdownHash, installedAt: pkg.installedAt, private: false, workspace: true };
  return { text: sourceText(s), ref: s.ref, sha: s.sha, installedAt: pkg.installedAt, private: s.kind === "github-app", workspace: false };
}
const mayEdit = (user: Doc<"users">) => can(user, "recipes.decide");

/** Who is asking: a person, or their agent (lib.ts agentClientOf), which may read and propose but never decide. */
type Caller = { user: Doc<"users">; agent: string | null };

export async function callerOf(ctx: QueryCtx | MutationCtx): Promise<Caller | null> {
  const user = await getCurrentUser(ctx);
  return user ? { user, agent: await agentClientOf(ctx) } : null;
}

export const mayDecide = (c: Caller) => c.agent === null && mayEdit(c.user);

async function requireEditor(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!mayEdit(user)) throw new ConvexError(refusal("recipes.decide"));
  return user;
}

/** The one gate on every write to a workspace's recipes (settings, proposals, installs): an admin or manager, not their agent. */
export async function requireDecider(ctx: MutationCtx) {
  const user = await requireEditor(ctx);
  if (await agentClientOf(ctx)) throw new ConvexError(AGENT_REFUSED);
  return user;
}

const revisionAt = (ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, recipeId: string, revision: number) =>
  ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId).eq("revision", revision)).unique();

const openProposals = (ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, recipeId: string) =>
  ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_status", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId).eq("status", "proposed")).order("desc").take(MAX_OPEN);

/** The recipe `recipeId` names, else the deal page recipe. */
async function chosen(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, recipeId: string | undefined): Promise<FoundRecipe> {
  return recipeId === undefined ? orgRecipe(ctx, orgId) : requireRecipe(ctx, orgId, recipeId);
}

/** Each revision as the settings panel and /mcp show it: who wrote it, its note and its diff against its parent. */
async function revisionViews(ctx: QueryCtx, orgId: Id<"organizations">, recipe: RecipeDefinition, rows: Doc<"recipeRevisions">[]) {
  const byNumber = new Map(rows.map((r) => [r.revision, r]));
  const names = new Map<string, string>();
  const nameOf = async (author: Doc<"recipeRevisions">["author"]) => {
    if (!names.has(author.id)) {
      const who = await ctx.db.get(author.id);
      const name = (who && ("label" in who ? who.label : who.name)) || "Someone";
      names.set(author.id, name);
    }
    return author.kind === "mcp" ? `${names.get(author.id)}'s agent` : names.get(author.id)!;
  };
  return Promise.all(rows.map(async (row) => {
    const parent = row.parent === null ? null : byNumber.get(row.parent) ?? await revisionAt(ctx, orgId, recipe.id, row.parent);
    return {
      revision: row.revision, parent: row.parent, status: row.status, note: row.note ?? null, createdAt: row.createdAt,
      author: { kind: row.author.kind, name: await nameOf(row.author) },
      diff: diffSettings(recipe, storedOverrides(recipe, parent), storedOverrides(recipe, row)) as Diff,
      evals: row.proposal?.evals ?? [],
      decision: row.proposal?.decision ? { kind: row.proposal.decision.kind, at: row.proposal.decision.at, reason: row.proposal.decision.kind === "rejected" ? row.proposal.decision.reason ?? null : null } : null,
    };
  }));
}

/**
 * A workspace's settings for one recipe: what's in force, the schema the form is built from, the latest revisions
 * with their diffs, and the open proposals with their eval results. Proposals stay out of the history: only a
 * revision that was in force is in it.
 */
async function settingsView(ctx: QueryCtx, orgId: Id<"organizations">, found: FoundRecipe) {
  const { recipe } = found;
  const rows = await ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipe.id)).order("desc").take(REVISIONS_SHOWN);
  const revision = (await currentRevision(ctx, orgId, recipe.id))?.revision ?? null;
  const revisions = await revisionViews(ctx, orgId, recipe, rows.filter((r) => !r.proposal));
  const proposals = (await revisionViews(ctx, orgId, recipe, await openProposals(ctx, orgId, recipe.id))).map((p) => ({ ...p, stale: p.parent !== revision }));
  const ref = await orgSettings(ctx, orgId, found);
  // Recipe data the browser shows; recipe code never runs there (docs/recipes.md, R3).
  const peopleFields = ref.plays?.people.fields ?? [];
  return { recipeId: recipe.id, schema: recipe.settingsSchema, defaults: recipe.settings, settings: ref.settings, theme: recipe.theme, peopleFields, revision, revisions, proposals };
}

/** The packages a workspace has installed, newest first. */
async function installedPackages(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">): Promise<FoundRecipe[]> {
  const rows = await ctx.db.query("recipePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "installed")).order("desc").take(PACKAGES_SHOWN);
  return rows.map((pkg) => ({ recipe: packageRecipe(pkg), pkg }));
}

/** Every recipe the workspace can run: the first-party ones, always installed, then the packages it installed. */
async function availableRecipes(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">): Promise<FoundRecipe[]> {
  return [...Object.values(RECIPES).map((recipe): FoundRecipe => ({ recipe, pkg: null })), ...await installedPackages(ctx, orgId)];
}

/** Each point's contributions from the workspace's recipes, and which are on: what the Recipes page and /mcp show. */
async function pointViews(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, recipes: readonly FoundRecipe[]) {
  return Promise.all(POINT_IDS.map(async (id) => {
    const point = pointOf(id);
    const on = await enabledFor(ctx, orgId, id);
    const isOn = (recipeId: string, key: string) => on.some((e) => e.recipe.id === recipeId && e.contribution.key === key);
    const offered = recipes.flatMap(({ recipe }) => contributionsOf(recipe).filter((c) => c.point === id).map((c) => ({ recipe, c })));
    return {
      id, kind: point.kind, cardinality: point.cardinality, title: point.title, description: point.description, binds: point.binds,
      contributions: await Promise.all(offered.map(async ({ recipe, c }) => ({
        recipeId: c.recipeId, key: c.key, title: c.title, recipeTitle: c.recipeTitle, hasPlays: recipe.data !== null, enabled: isOn(c.recipeId, c.key),
        version: recipe.version, install: isTemplatePoint(id) ? await installView(ctx, orgId, id, c) : id === "fields" ? await fieldInstallView(ctx, orgId, c) : null,
      }))),
    };
  }));
}

/**
 * Where a recipe field stands in the workspace: the row under its slug, from this recipe or another, or deleted (its
 * agent's ledger key outlives it). Null when there is neither, so the Recipes page offers it as a switch.
 */
async function fieldInstallView(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, c: Contribution): Promise<InstallView | null> {
  const row = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", c.key)).unique();
  if (row) {
    const by = row.recipe && row.recipe.id !== c.recipeId ? (await recipeIn(ctx, orgId, row.recipe.id))?.recipe.title ?? row.recipe.id : undefined;
    return { state: "installed", version: row.recipe?.version ?? "", row: { name: row.label, href: `/dashboard/fields#${row.slug}` }, ...(by ? { by } : {}) };
  }
  const deleted = await ctx.db.query("agents").withIndex("by_orgId_and_ledgerKey", (q) => q.eq("orgId", orgId).eq("ledgerKey", `research:${c.key}`)).first();
  return deleted ? { state: "deleted", version: "" } : null;
}

/** The first version of each recipe whose deal page places its own header, products, splits and apps (C1). */
const FRAME_SINCE: Readonly<Record<string, string>> = { "canon-base": "1.5.0", "fsgtm-enterprise-deal": "1.2.0", "@fsgtm/velocity-deal": "3.1.0" };
/**
 * Whether the deal page was written before a recipe could place the header, products, splits and apps, so the page
 * draws them where they always were. A page from a version that could, and that leaves them out, means it.
 */
function oldFrame(found: FoundRecipe): boolean {
  if (found.recipe.dealPage.some((s) => DEAL_FRAME.includes(s.component))) return false;
  const source = found.pkg?.source;
  const [id, version] = source?.kind === "workspace" ? [source.forkedFrom.id, source.forkedFrom.version] : [found.recipe.id, found.recipe.version];
  const since = FRAME_SINCE[id];
  return !since || compareVersions(version, since) < 0;
}

export const forOrg = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const orgId = caller.user.orgId;
    const found = await orgRecipe(ctx, orgId);
    const available = await availableRecipes(ctx, orgId);
    return {
      dealPage: { ...card(found), sections: found.recipe.dealPage, oldFrame: oldFrame(found), ref: found.ref, coreRoles: found.plays?.coreRoles ?? [], settings: await settingsView(ctx, orgId, found) },
      available: await Promise.all(available.map(async (f) => ({
        ...card(f), hasSettings: f.recipe.settingsSchema.length > 0,
        revision: (await currentRevision(ctx, orgId, f.recipe.id))?.revision ?? null, proposals: (await openProposals(ctx, orgId, f.recipe.id)).length,
        upstream: f.pkg?.source.kind === "workspace" ? await upstreamChange(ctx, orgId, f.pkg.source.forkedFrom) : null,
      }))),
      points: await pointViews(ctx, orgId, available),
      canEdit: mayDecide(caller),
    };
  },
});

/** The sections of the account or contact page the workspace has on (account.page, contact.page), in the recipe's order. */
export const recordPage = query({
  args: { object: v.union(v.literal("account"), v.literal("contact")) },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const [{ recipe }] = await enabledFor(ctx, caller.user.orgId, `${args.object}.page`);
    return { recipeId: recipe.id, sections: pageOf(recipe, args.object) };
  },
});

/** Every contribution point, what the workspace's recipes offer at each, and which are on. Read-only, for /mcp too. */
export const contributions = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    return { points: await pointViews(ctx, caller.user.orgId, await availableRecipes(ctx, caller.user.orgId)), canEdit: mayDecide(caller) };
  },
});

export const settings = query({
  args: { recipeId: recipeIdValidator },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    return caller ? { ...(await settingsView(ctx, caller.user.orgId, await requireRecipe(ctx, caller.user.orgId, args.recipeId))), canEdit: mayDecide(caller) } : null;
  },
});

/** The installed recipe as an agent authoring a change reads it: its manifest, settings in force, evals and open proposals. */
export const describe = query({
  args: { recipeId: v.optional(recipeIdValidator) },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const found = await chosen(ctx, caller.user.orgId, args.recipeId);
    const { recipe } = found;
    const view = await settingsView(ctx, caller.user.orgId, found);
    return {
      ...card(found), dealPage: recipe.dealPage,
      schema: recipe.settingsSchema, defaults: recipe.settings, settings: view.settings, revision: view.revision,
      evals: recipe.evals.map((e) => ({ name: e.name, description: e.description })),
      openProposals: view.proposals.map(({ revision, author, note, diff, evals, stale }) => ({ revision, author: author.name, note, diff, evals, stale })),
      canDecide: mayDecide(caller),
    };
  },
});

/** Open proposals and the latest decided ones, newest first. */
export const listProposals = query({
  args: { recipeId: v.optional(recipeIdValidator) },
  handler: async (ctx, args) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const orgId = caller.user.orgId;
    const { recipe } = await chosen(ctx, orgId, args.recipeId);
    const recent = await ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipe.id)).order("desc").take(REVISIONS_SHOWN);
    const decided = recent.filter((r) => r.proposal && r.status !== "proposed");
    const views = await revisionViews(ctx, orgId, recipe, [...await openProposals(ctx, orgId, recipe.id), ...decided]);
    return { recipeId: recipe.id, proposals: views.map(({ status, ...p }) => ({ ...p, status: p.decision?.kind ?? (status === "proposed" ? "open" : status) })) };
  },
});

const contributionArgs = { point: v.string(), recipeId: recipeIdValidator, key: v.string() };

/** The point and the contribution a decider named, or why the workspace has neither. */
async function namedContribution(ctx: MutationCtx, orgId: Id<"organizations">, args: { point: string; recipeId: string; key: string }) {
  if (!isPointId(args.point)) throw new ConvexError(`${args.point} is not a contribution point (${POINT_IDS.join(", ")}).`);
  const found = await contributionIn(ctx, orgId, args.point, args.recipeId, args.key);
  if (!found) throw new ConvexError(`This workspace has no ${args.recipeId} contribution ${args.key} at ${args.point}. Install the package first.`);
  return { point: args.point as PointId, found };
}

async function setEnabled(ctx: MutationCtx, user: Doc<"users">, point: PointId, recipeId: string, key: string, enabled: boolean) {
  const row = await enablementRow(ctx, user.orgId, point, recipeId, key);
  const change = { enabled, by: user._id, at: Date.now() };
  if (row) { if (row.enabled !== enabled) await ctx.db.patch(row._id, change); }
  else await ctx.db.insert("recipeEnablements", { orgId: user.orgId, point, recipeId, contributionKey: key, ...change });
}

/**
 * Turn a contribution on at its point. At an exclusive point (the deal page) it replaces the one in force; at an
 * additive point it joins the others, unless the point says it conflicts with one of them.
 */
export const enableContribution = mutation({
  args: contributionArgs,
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { point, found } = await namedContribution(ctx, user.orgId, args);
    const fitBefore = point === "scoring.fit" ? JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit")) : null;
    const { enabled, stale } = await enabledRows(ctx, user.orgId, point);
    const plan = planEnable(pointOf(point), enabled.map((e) => e.contribution), found.contribution);
    if (!plan.ok) throw new ConvexError(plan.error);
    for (const c of [...plan.off, ...stale.map((r) => ({ recipeId: r.recipeId, key: r.contributionKey }))]) await setEnabled(ctx, user, point, c.recipeId, c.key, false);
    await setEnabled(ctx, user, point, found.recipe.id, found.contribution.key, true);
    // Enabling a template installs it, once: turning it off and on again never makes a second row.
    if (isTemplatePoint(point)) await installContribution(ctx, user, found, found.contribution, { decided: true });
    if (point === "scoring.fit" && JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit")) !== fitBefore) await invalidateFit(ctx, user.orgId);
    // Enabling a field makes its row unless the workspace has one under the slug. A field someone deleted stays deleted.
    if (point === "fields") {
      const ref = await orgSettings(ctx, user.orgId, found);
      const made = await ensureField(ctx, user, found.recipe, resolveField(found.contribution.declares as RecipeField, ref.settings));
      if (!made.ok && made.why !== "deleted") throw new ConvexError(`Can't turn on ${made.message}.`);
    }
    return null;
  },
});

/** Turn a contribution off at an additive point. An exclusive point is switched with enableContribution instead. */
export const disableContribution = mutation({
  args: contributionArgs,
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { point, found } = await namedContribution(ctx, user.orgId, args);
    const plan = planDisable(pointOf(point));
    if (!plan.ok) throw new ConvexError(plan.error);
    await setEnabled(ctx, user, point, found.recipe.id, found.contribution.key, false);
    return null;
  },
});

async function nextRevision(ctx: MutationCtx, orgId: Id<"organizations">, recipeId: string): Promise<number> {
  const latest = await ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc").first();
  return (latest?.revision ?? 0) + 1;
}

/**
 * Make `overrides` the workspace's settings for `recipe` as a new current revision. Nothing changes when they equal
 * what's in force, unless `upgradedFrom` names the version they were read against: an upgrade always records one.
 * A field question that changed with them also changes the workspace's AI field asking it, unless someone made
 * that field ask something else.
 */
async function writeRevision(ctx: MutationCtx, user: Doc<"users">, recipe: RecipeDefinition, overrides: Settings, note: string | undefined, upgradedFrom?: RecipeDefinition, priorFit?: string): Promise<{ revision: number | null; changed: boolean }> {
  if (recipe.theme) {
    const problems = themeProblems(declaredTheme(recipe.theme, { ...recipe.settings, ...overrides }));
    if (problems.length) throw new ConvexError(`This theme would be hard to read: ${problems.map((p) => p.message).join("; ")}.`);
  }
  const current = await currentRevision(ctx, user.orgId, recipe.id);
  const was = upgradedFrom ?? recipe;
  const before = storedOverrides(was, current);
  if (!upgradedFrom && !diffSettings(recipe, before, overrides).length) return { revision: current?.revision ?? null, changed: false };
  const fitBefore = priorFit ?? JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit"));
  const revision = await nextRevision(ctx, user.orgId, recipe.id);
  if (current) await ctx.db.patch(current._id, { status: "superseded" });
  await ctx.db.insert("recipeRevisions", {
    orgId: user.orgId, recipeId: recipe.id, revision, settings: overrides, parent: current?.revision ?? null,
    author: { kind: "user", id: user._id }, ...(note?.trim() ? { note: note.trim().slice(0, NOTE_MAX) } : {}), status: "current", createdAt: Date.now(),
  });
  await syncFieldQuestions(ctx, user.orgId, questionsOf(was, { ...was.settings, ...before }), questionsOf(recipe, { ...recipe.settings, ...overrides }));
  if (JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit")) !== fitBefore) await invalidateFit(ctx, user.orgId);
  return { revision, changed: true };
}

/** Each AI field a recipe offers, with its question on `settings`: its ai-fields block and inline people fields alike. */
const questionsOf = (recipe: RecipeDefinition, settings: Settings) => new Map(fieldsOf(recipe).map((f) => [f.slug, resolveField(f, settings).question]));

async function syncFieldQuestions(ctx: MutationCtx, orgId: Id<"organizations">, from: Map<string, string>, to: Map<string, string>) {
  for (const [slug, question] of to) {
    const old = from.get(slug);
    if (old === undefined || old === question) continue;
    const agent = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
    if (agent?.question === old) await ctx.db.patch(agent._id, { question, questionSince: Date.now(), updatedAt: Date.now() });
  }
}

/** The workspace's theme as CSS variables, for the dashboard shell; null when nobody is signed in to a workspace. */
export const theme = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? orgTheme(ctx, user.orgId) : null;
  },
});

/** The pages hidden from the signed-in member's nav and the page Canon opens on (workspace.nav); null when signed out. */
export const nav = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const { hidden, repHidden, home } = await modelSettings(ctx, user.orgId, "workspace.nav");
    return { hidden: user.role === "admin" || user.role === "manager" ? hidden : [...hidden, ...repHidden], home };
  },
});

export const saveSettings = mutation({
  args: {
    recipeId: recipeIdValidator,
    /** The settings to run on; a key left out, or set to its default, takes the recipe's default. */
    settings: v.record(v.string(), settingValue),
    note: v.optional(v.string()),
    /** The revision the editor opened, null for the defaults: a save on top of someone else's refuses. */
    baseRevision: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { recipe } = await requireRecipe(ctx, user.orgId, args.recipeId);
    const current = await currentRevision(ctx, user.orgId, recipe.id);
    if ((current?.revision ?? null) !== args.baseRevision) throw new ConvexError("Someone changed these settings since you opened them. Reload to see their change.");
    const { overrides, errors } = parseOverrides(recipe, args.settings);
    if (errors.length) throw new ConvexError(errors.map((e) => e.error).join(". "));
    return writeRevision(ctx, user, recipe, overrides, args.note);
  },
});

/** Put an earlier revision's settings back in force, as a new revision. Revision 0 is the recipe's defaults. */
export const revertTo = mutation({
  args: { recipeId: recipeIdValidator, revision: v.number() },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { recipe } = await requireRecipe(ctx, user.orgId, args.recipeId);
    if (args.revision === 0) return writeRevision(ctx, user, recipe, {}, "Reverted to the customization defaults");
    const row = await revisionAt(ctx, user.orgId, recipe.id, args.revision);
    if (!row || row.proposal) throw new ConvexError("No such revision");
    return writeRevision(ctx, user, recipe, storedOverrides(recipe, row), `Reverted to revision ${row.revision}`);
  },
});

const packageView = (pkg: Doc<"recipePackages"> | null): PackageView | null =>
  pkg && { _id: pkg._id, manifest: pkg.manifest, bundleHash: pkg.bundleHash, bundleStorageId: pkg.bundleStorageId, source: pkg.source, version: pkg.version };

/** The recipe a view names, rebuilt in an action: a first-party one by id, an installed one from its manifest. */
const recipeOfView = (recipeId: string, pkg: PackageView | null): RecipeDefinition => (pkg ? packageRecipe(pkg) : RECIPES[recipeId as keyof typeof RECIPES]);

type Base = { recipeId: string; parent: number | null; overrides: Settings; pkg: PackageView | null };

/** What a proposal starts from: the caller's workspace's revision in force for the recipe, and its package. */
export const proposalBase = internalQuery({
  args: { recipeId: v.optional(recipeIdValidator) },
  handler: async (ctx, args): Promise<Base> => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    const found = await chosen(ctx, user.orgId, args.recipeId);
    const current = await currentRevision(ctx, user.orgId, found.recipe.id);
    return { recipeId: found.recipe.id, parent: current?.revision ?? null, overrides: storedOverrides(found.recipe, current), pkg: packageView(found.pkg) };
  },
});

/**
 * `changes` on top of the settings in force, checked against the recipe's schema and timed on worst-case text, with
 * the recipe's evals run on the result in the recipe runtime.
 */
async function trial(ctx: ActionCtx, args: { recipeId?: string; changes: Record<string, unknown> }) {
  const base: Base = await ctx.runQuery(internal.recipes.proposalBase, { recipeId: args.recipeId });
  const recipe = recipeOfView(base.recipeId, base.pkg);
  const { overrides, errors } = parseOverrides(recipe, { ...base.overrides, ...args.changes });
  if (errors.length) throw new ConvexError(errors.map((e) => e.error).join(". "));
  const diff = diffSettings(recipe, base.overrides, overrides) as Diff;
  const slow = recipe.settingsSchema.filter((d) => d.kind === "phrases" && diff.some((x) => x.key === d.key) && slowPattern(String(overrides[d.key])));
  if (slow.length) throw new ConvexError(`${slow.map((d) => d.label).join(", ")} took too long on a long draft. Use a simpler pattern.`);
  const ref = refOf(recipe, { ...recipe.settings, ...overrides }, base.pkg ? { hash: base.pkg.bundleHash, storageId: base.pkg.bundleStorageId } : null);
  const evals: EvalResult[] = await evaluate(targetOf(ctx, ref), recipe.evals);
  return { recipeId: base.recipeId, parent: base.parent, settings: overrides, diff, evals };
}

/** The recipe's evals on the settings in force with `changes` on top. Stores nothing. */
export const runEvals = action({
  args: { recipeId: v.optional(recipeIdValidator), changes: v.record(v.string(), settingValue) },
  handler: async (ctx, args): Promise<{ recipeId: string; revision: number | null; diff: Diff; evals: EvalResult[] }> => {
    const t = await trial(ctx, args);
    return { recipeId: t.recipeId, revision: t.parent, diff: t.diff, evals: t.evals };
  },
});

/**
 * Propose `changes` on top of the settings in force as a revision an admin or manager approves. An action, because
 * the evals run in the recipe runtime, which only an action may call; storeProposal then records the result.
 */
export const proposeSettings = action({
  args: { recipeId: v.optional(recipeIdValidator), changes: v.record(v.string(), settingValue), note: v.string() },
  handler: async (ctx, args): Promise<{ revision: number; diff: Diff; evals: EvalResult[]; next: string }> => {
    const t = await trial(ctx, args);
    if (!t.diff.length) throw new ConvexError("These changes match the settings in force: there is nothing to propose.");
    const revision: number = await ctx.runMutation(internal.recipes.storeProposal, { recipeId: t.recipeId, parent: t.parent, settings: t.settings as Record<string, number | string | string[]>, note: args.note, evals: t.evals });
    const failing = t.evals.filter((e) => !e.ok).length;
    return {
      revision, diff: t.diff, evals: t.evals,
      next: `Proposal #${revision} waits for an admin or manager to approve it in Settings.${failing ? ` ${failing} eval${failing === 1 ? "" : "s"} failed, so they'll have to accept that too.` : ""}`,
    };
  },
});

export const storeProposal = internalMutation({
  args: { recipeId: recipeIdValidator, parent: v.union(v.number(), v.null()), settings: v.record(v.string(), settingValue), note: v.string(), evals: v.array(evalResult) },
  handler: async (ctx, args): Promise<number> => {
    const user = await requireUser(ctx);
    const agent = await agentClientOf(ctx);
    const note = args.note.trim().slice(0, NOTE_MAX);
    if (!note) throw new ConvexError("A proposal needs a note: what it changes and why.");
    const { recipe } = await requireRecipe(ctx, user.orgId, args.recipeId);
    const current = await currentRevision(ctx, user.orgId, recipe.id);
    if ((current?.revision ?? null) !== args.parent) throw new ConvexError("The settings changed while the evals ran. Propose again on the new settings.");
    const { overrides, errors } = parseOverrides(recipe, args.settings);
    if (errors.length) throw new ConvexError(errors.map((e) => e.error).join(". "));
    if ((await openProposals(ctx, user.orgId, recipe.id)).length >= MAX_OPEN) {
      throw new ConvexError(`This package already has ${MAX_OPEN} open proposals. An admin or manager has to approve or reject some first.`);
    }
    const revision = await nextRevision(ctx, user.orgId, recipe.id);
    await ctx.db.insert("recipeRevisions", {
      orgId: user.orgId, recipeId: recipe.id, revision, settings: overrides, parent: args.parent,
      author: agent ? { kind: "mcp", id: user._id, client: agent } : { kind: "user", id: user._id },
      note, status: "proposed", proposal: { evals: args.evals }, createdAt: Date.now(),
    });
    return revision;
  },
});

async function openProposal(ctx: MutationCtx, orgId: Id<"organizations">, recipeId: string, revision: number) {
  const row = await revisionAt(ctx, orgId, recipeId, revision);
  if (!row || row.status !== "proposed" || !row.proposal) throw new ConvexError(`No open proposal #${revision}`);
  return { ...row, proposal: row.proposal };
}

/**
 * Make a proposal the settings in force, as a new revision. Refuses when the settings changed since it was
 * proposed, and when an eval failed unless the approver accepts that.
 */
export const approveProposal = mutation({
  args: { recipeId: recipeIdValidator, revision: v.number(), acceptFailingEvals: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { recipe } = await requireRecipe(ctx, user.orgId, args.recipeId);
    const row = await openProposal(ctx, user.orgId, recipe.id, args.revision);
    const current = await currentRevision(ctx, user.orgId, recipe.id);
    if ((current?.revision ?? null) !== row.parent) throw new ConvexError("Settings changed since this was proposed; ask for a fresh proposal.");
    const failing = row.proposal.evals.filter((e) => !e.ok);
    if (failing.length && !args.acceptFailingEvals) {
      throw new ConvexError(`${failing.length} eval${failing.length === 1 ? "" : "s"} failed (${failing.map((e) => e.name).join(", ")}). Approve again accepting the failures to go ahead.`);
    }
    const { revision, changed } = await writeRevision(ctx, user, recipe, storedOverrides(recipe, row), `Approved proposal #${row.revision}: ${row.note}`);
    if (!changed || revision === null) throw new ConvexError("This proposal changes nothing on the settings in force. Reject it instead.");
    await ctx.db.patch(row._id, { status: "superseded", proposal: { ...row.proposal, decision: { kind: "approved", as: revision, by: user._id, at: Date.now() } } });
    return { revision };
  },
});

export const rejectProposal = mutation({
  args: { recipeId: recipeIdValidator, revision: v.number(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const { recipe } = await requireRecipe(ctx, user.orgId, args.recipeId);
    const row = await openProposal(ctx, user.orgId, recipe.id, args.revision);
    const reason = args.reason?.trim().slice(0, NOTE_MAX);
    await ctx.db.patch(row._id, { status: "rejected", proposal: { ...row.proposal, decision: { kind: "rejected", by: user._id, at: Date.now(), ...(reason ? { reason } : {}) } } });
    return null;
  },
});

// ───────────────────────────── Installs (R5) ─────────────────────────────

export type CheckedPackage = { manifest: Manifest; manifestText: string; code: string; hash: string; parts: Part[]; hasCode: boolean };

/**
 * A package's recipe.md read into the manifest an install stores, with the code it runs: its dist/recipe.js, or for
 * a markdown-only package Canon's built-ins bundle carrying its recipe. A shipped bundle must have been built from
 * this recipe.md and register exactly the names it uses, which the runtime answers for (`recipe.about`).
 */
export async function checkPackage(markdown: string, shipped: string | null): Promise<CheckedPackage> {
  const refuse = (why: string): never => { throw new ConvexError(`customization.md isn't a package Canon can install: ${why}.`); };
  const listed = (errors: string[]) => `${errors.slice(0, ERRORS_SHOWN).join("; ")}${errors.length > ERRORS_SHOWN ? ` (and ${errors.length - ERRORS_SHOWN} more)` : ""}`;
  const { recipe, problems } = parseRecipe(markdown);
  const errors = problems.filter((p) => p.level === "error").map((p) => `line ${p.line}: ${p.message}`);
  if (errors.length) refuse(listed(errors));
  if (isFirstParty(recipe.meta.id)) throw new ConvexError(`${recipe.meta.id} is a first-party package id.`);
  if (isWorkspaceId(recipe.meta.id)) throw new ConvexError(`${WORKSPACE_SCOPE} is the scope of a workspace's own packages; publish this one under your own scope.`);
  if (!recipe.data) refuse("it has no plays (no ```logic blocks and no prompts)");
  const manifest = toManifest(recipe);
  const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!parsed.ok) refuse(listed(parsed.errors));
  const markdownHash = await bundleHash(markdown);
  const names = codeNames(recipe).map((n) => `${n.kind} ${n.name}`);
  let code = shipped;
  if (code === null) {
    if (names.length || recipe.code.length) refuse(`it names code (${names.join(", ") || "its ```ts blocks"}) and the package has no ${BUNDLE_FILE}; build one with Canon's scripts/recipe-package.ts`);
    code = markdownBundle(BUILTINS_BUNDLE, recipe, markdownHash);
  }
  const hash = await bundleHash(code);
  if (shipped !== null) {
    const [about] = await runSettled({ id: manifest.id, settings: manifest.defaults, installed: { hash, code: async () => shipped } }, [{ fn: "recipe.about", input: [] }]);
    if (!about.ok) throw new ConvexError(`${BUNDLE_FILE} wasn't built by Canon's scripts/recipe-package.ts (${about.error.message}).`);
    const got = about.value as RecipeAbout;
    if (got.markdown !== markdownHash) throw new ConvexError(`${BUNDLE_FILE} was built from another customization.md. Build the package again.`);
    const registered = got.names.map((n) => `${n.kind} ${n.name}`);
    const missing = names.filter((n) => !registered.includes(n)), unused = registered.filter((n) => !names.includes(n));
    if (missing.length) refuse(`it uses ${missing.join(", ")}, which ${BUNDLE_FILE} doesn't register`);
    if (unused.length) refuse(`${BUNDLE_FILE} registers ${unused.join(", ")}, which it never uses`);
  }
  return { manifest, manifestText: JSON.stringify(manifest), code, hash, parts: partsOf(recipe), hasCode: shipped !== null };
}

/** A package at a pinned commit, fetched and checked. */
async function fetchChecked(reader: SourceReader, sha: string): Promise<CheckedPackage> {
  const { markdown, code } = await reader.fetchPackage(sha);
  return checkPackage(markdown, code);
}

/** The package's evals on `settings`, in the recipe runtime: the bundle isn't stored yet, so its code is in hand. */
const packageEvals = (manifest: Manifest, hash: string, code: string, settings: Settings) =>
  evaluate({ id: manifest.id, settings, installed: { hash, code: async () => code } }, manifest.evals);

type InstallState = { canDecide: boolean; installed: Array<{ recipeId: string; source: PinnedSource; version: string }>; connections: Connection[] };

/** Whether the caller may install, what their workspace has installed, and the GitHub accounts it connected. */
export const installState = internalQuery({
  args: {},
  handler: async (ctx): Promise<InstallState> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const rows = await installedPackages(ctx, caller.user.orgId);
    return {
      canDecide: mayDecide(caller),
      installed: rows.flatMap(({ pkg }) => (pkg!.source.kind === "workspace" ? [] : [{ recipeId: pkg!.recipeId, source: pkg!.source, version: pkg!.version }])),
      connections: await orgConnections(ctx, caller.user.orgId),
    };
  },
});

/**
 * What installing `source` would do, as the install screen shows it: the recipe at the commit the ref names now,
 * what it asks for, which of its parts are markdown and which are code, the settings it exposes and its evals run in
 * the recipe runtime. Stores nothing. A pasted `markdown` previews the same way, for an author checking a recipe.md
 * before they publish it; it has no source to pin, so it can't be installed.
 */
export const previewInstall = action({
  args: { source: v.optional(v.string()), markdown: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if ((args.source === undefined) === (args.markdown === undefined)) throw new ConvexError("Preview a source or a pasted customization.md, not both.");
    const state: InstallState = await ctx.runQuery(internal.recipes.installState, {});
    let from: { source: string; pinned: PinnedSource; private: boolean } | null = null;
    let pkg: CheckedPackage;
    if (args.markdown !== undefined) {
      if (args.markdown.length > RECIPE_MAX_BYTES) throw new ConvexError(`A customization.md is at most ${RECIPE_MAX_BYTES / 1024} KB.`);
      pkg = await checkPackage(args.markdown, null);
    } else {
      const source = await resolveSource(parseSource(args.source!), state.connections);
      const reader = await openSource(source, state.connections);
      const sha = await reader.resolveSha();
      pkg = await fetchChecked(reader, sha);
      from = { source: sourceText(source), pinned: { ...source, sha }, private: source.kind === "github-app" };
    }
    const { manifest: m } = pkg;
    const evals = await packageEvals(m, pkg.hash, pkg.code, m.defaults);
    const existing = state.installed.find((p) => p.recipeId === m.id) ?? null;
    return {
      source: from?.source ?? null, pinned: from?.pinned ?? null, private: from?.private ?? false, bundleHash: pkg.hash, bundleBytes: pkg.code.length, hasCode: pkg.hasCode, parts: pkg.parts,
      id: m.id, version: m.version, title: m.title, description: m.description, author: m.author, permissions: m.permissions,
      dealPage: m.dealPage, accountPage: m.accountPage ?? [], contactPage: m.contactPage ?? [], schema: m.settingsSchema, defaults: m.defaults, evals,
      installed: existing && { version: existing.version, sha: existing.source.sha, source: sourceText(existing.source), sameSource: from ? sameRepo(existing.source, from.pinned) : false },
      canInstall: state.canDecide && from !== null,
    };
  },
});

/** Install the recipe a preview showed: fetched again at its pinned commit, refused if the bundle isn't the one previewed. */
export const install = action({
  args: { source: v.string(), sha: v.string(), bundleHash: v.string() },
  handler: async (ctx, args): Promise<{ recipeId: string; version: string }> => {
    const state: InstallState = await ctx.runQuery(internal.recipes.installState, {});
    if (!state.canDecide) throw new ConvexError(AGENT_REFUSED);
    const source = await resolveSource(parseSource(args.source), state.connections);
    const pkg = await fetchChecked(await openSource(source, state.connections), args.sha);
    if (pkg.hash !== args.bundleHash) throw new ConvexError("The package at this commit isn't the one you previewed. Preview it again.");
    const storageId = await ctx.storage.store(new Blob([pkg.code], { type: "text/javascript" }));
    try {
      await ctx.runMutation(internal.recipes.storePackage, {
        recipeId: pkg.manifest.id, source: { ...source, sha: args.sha }, version: pkg.manifest.version, manifest: pkg.manifestText, bundleHash: pkg.hash, storageId,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
    return { recipeId: pkg.manifest.id, version: pkg.manifest.version };
  },
});

export const storePackage = internalMutation({
  args: { recipeId: v.string(), source: pinnedSource, version: v.string(), manifest: v.string(), bundleHash: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    if (isFirstParty(args.recipeId) || isWorkspaceId(args.recipeId)) throw new ConvexError(`${args.recipeId} isn't an id a package from GitHub can take.`);
    const row = await packageRow(ctx, user.orgId, args.recipeId);
    const was = row?.source;
    if (was?.kind === "workspace") throw new ConvexError(`${args.recipeId} is this workspace's own package.`);
    if (row?.status === "installed" && was) {
      throw new ConvexError(sameRepo(was, args.source)
        ? `${args.recipeId} is already installed (v${row.version}). Check it for updates instead.`
        : `${args.recipeId} is already installed from ${sourceText(was)}. Uninstall it before installing another customization with that id.`);
    }
    const fitBefore = JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit"));
    const fields = {
      source: args.source, version: args.version, manifest: args.manifest, bundleHash: args.bundleHash, bundleStorageId: args.storageId,
      installedBy: user._id, installedAt: Date.now(), status: "installed" as const,
    };
    if (row) {
      await ctx.db.patch(row._id, fields);
      if (row.bundleStorageId !== args.storageId) await ctx.storage.delete(row.bundleStorageId);
    } else {
      await ctx.db.insert("recipePackages", { orgId: user.orgId, recipeId: args.recipeId, ...fields });
    }
    if (JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit")) !== fitBefore) await invalidateFit(ctx, user.orgId);
    return null;
  },
});

/** Remove an installed recipe from the workspace's pickers. Its settings revisions stay, for a reinstall. */
export const uninstall = mutation({
  args: { recipeId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireDecider(ctx);
    const row = await packageRow(ctx, user.orgId, args.recipeId);
    if (row?.status !== "installed") throw new ConvexError(`${args.recipeId} isn't installed.`);
    for (const point of POINT_IDS) {
      if ((await enabledFor(ctx, user.orgId, point)).some((e) => e.recipe.id === row.recipeId)) throw new ConvexError(`${pointOf(point).title} runs on this package. Pick another one there first.`);
    }
    await ctx.db.patch(row._id, { status: "uninstalled" });
    return null;
  },
});

type UpgradeBase = { pkg: PackageView & { source: PinnedSource }; overrides: Settings; revision: number | null; connections: Connection[] };

/** An installed package, the workspace's overrides on it and its GitHub connections, for an upgrade. */
export const upgradeBase = internalQuery({
  args: { recipeId: v.string() },
  handler: async (ctx, args): Promise<UpgradeBase> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const found = await requireRecipe(ctx, caller.user.orgId, args.recipeId);
    if (!found.pkg) throw new ConvexError(`${args.recipeId} is a first-party package; it updates with Canon.`);
    const { source } = found.pkg;
    if (source.kind === "workspace") throw new ConvexError(`${args.recipeId} is this workspace's own copy; it changes when you edit it.`);
    const current = await currentRevision(ctx, caller.user.orgId, found.recipe.id);
    return { pkg: { ...packageView(found.pkg)!, source }, overrides: storedOverrides(found.recipe, current), revision: current?.revision ?? null, connections: await orgConnections(ctx, caller.user.orgId) };
  },
});

const TAG = /^(v?)(\d+\.\d+\.\d+)$/;

/** The commit an upgrade moves to: the newest higher version tag for a tag pin, the ref's new commit for a branch. */
async function newer(reader: SourceReader, source: PinnedSource): Promise<{ ref: string; sha: string } | null> {
  const pinned = TAG.exec(source.ref);
  if (!pinned) {
    const sha = await reader.resolveSha();
    return sha === source.sha ? null : { ref: source.ref, sha };
  }
  const later = (await reader.tags()).flatMap((t) => {
    const m = TAG.exec(t.name);
    return m && m[1] === pinned[1] && isVersion(m[2]) && compareVersions(m[2], pinned[2]) > 0 ? [{ ref: t.name, sha: t.sha, version: m[2] }] : [];
  });
  return later.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

const added = <T>(from: readonly T[], to: readonly T[]) => to.filter((x) => !from.includes(x));
const permissionsOf = (r: RecipeDefinition) => [
  ...r.permissions.read.map((x) => `reads ${x}`), ...r.permissions.slots.map((x) => `fills ${x}`),
  ...r.permissions.sources.map((x) => `uses ${x}`), ...(r.permissions.llm === "owner" ? ["runs prompts on the rep's model plan"] : []),
];

/** What an upgrade from `from` to `to` changes, besides settings: permissions and page sections, an account's or contact's named by its page. */
function changes(from: RecipeDefinition, to: RecipeDefinition) {
  const a = permissionsOf(from), b = permissionsOf(to);
  const sections = (r: RecipeDefinition) => PAGE_OBJECTS.flatMap((o) => pageOf(r, o).map((s) => (o === "deal" ? s.component : `${o}.${s.component}`)));
  const sa = sections(from), sb = sections(to);
  return { permissions: { added: added(a, b), removed: added(b, a) }, sections: { added: added(sa, sb), removed: added(sb, sa) } };
}

/**
 * Whether an installed recipe has a newer version, and what upgrading to it would do: the three-way settings diff,
 * the permissions and sections it adds or drops, and its evals on the settings it would leave (conflicts kept).
 */
export const checkUpgrade = action({
  args: { recipeId: v.string() },
  handler: async (ctx, args) => {
    const base: UpgradeBase = await ctx.runQuery(internal.recipes.upgradeBase, { recipeId: args.recipeId });
    const from = { version: base.pkg.version, ref: base.pkg.source.ref, sha: base.pkg.source.sha, revision: base.revision };
    const reader = await openSource(base.pkg.source, base.connections);
    const target = await newer(reader, base.pkg.source);
    if (!target) return { recipeId: args.recipeId, from, to: null, lines: [], labels: {} as Record<string, string>, permissions: { added: [], removed: [] }, sections: { added: [], removed: [] }, evals: [], parts: [] as Part[], hasCode: false };
    const next = await fetchChecked(reader, target.sha);
    if (next.manifest.id !== args.recipeId) throw new ConvexError(`${sourceText({ ...base.pkg.source, ref: target.ref })} is now ${next.manifest.id}, a different package.`);
    const was = packageRecipe(base.pkg), now = fromManifest(next.manifest);
    const lines: UpgradeLine[] = upgradeDiff(was, now, base.overrides);
    const keep = Object.fromEntries(lines.filter((l) => l.kind === "conflict").map((l) => [l.key, "keep" as const]));
    const { overrides } = parseOverrides(now, upgradedOverrides(lines, keep).overrides);
    const labels = Object.fromEntries([...was.settingsSchema, ...now.settingsSchema].map((d) => [d.key, d.label]));
    return {
      recipeId: args.recipeId, from, to: { version: next.manifest.version, ref: target.ref, sha: target.sha, bundleHash: next.hash },
      lines, labels, ...changes(was, now), evals: await packageEvals(next.manifest, next.hash, next.code, { ...now.settings, ...overrides }),
      parts: next.parts, hasCode: next.hasCode,
    };
  },
});

/** Upgrade to the version checkUpgrade showed, with a keep or take for each conflict. Fetched again and hash-checked. */
export const upgrade = action({
  args: {
    recipeId: v.string(), ref: v.string(), sha: v.string(), bundleHash: v.string(), choices: v.record(v.string(), v.union(v.literal("keep"), v.literal("take"))),
    /** What checkUpgrade showed the upgrade from: the installed commit and the settings revision in force. */
    fromSha: v.string(), fromRevision: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<{ version: string; revision: number | null }> => {
    const state: InstallState = await ctx.runQuery(internal.recipes.installState, {});
    if (!state.canDecide) throw new ConvexError(AGENT_REFUSED);
    const base: UpgradeBase = await ctx.runQuery(internal.recipes.upgradeBase, { recipeId: args.recipeId });
    const source = { ...base.pkg.source, ref: checkRef(args.ref) };
    const next = await fetchChecked(await openSource(source, base.connections), args.sha);
    if (next.hash !== args.bundleHash) throw new ConvexError("The package at this commit isn't the one you checked. Check for updates again.");
    if (next.manifest.id !== args.recipeId) throw new ConvexError(`That commit holds ${next.manifest.id}, a different package.`);
    const storageId = await ctx.storage.store(new Blob([next.code], { type: "text/javascript" }));
    try {
      return await ctx.runMutation(internal.recipes.applyUpgrade, {
        recipeId: args.recipeId, source: { ...source, sha: args.sha }, version: next.manifest.version, manifest: next.manifestText, bundleHash: next.hash, storageId, choices: args.choices,
        fromSha: args.fromSha, fromRevision: args.fromRevision,
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
  },
});

export const applyUpgrade = internalMutation({
  args: {
    recipeId: v.string(), source: pinnedSource, version: v.string(), manifest: v.string(), bundleHash: v.string(), storageId: v.id("_storage"),
    choices: v.record(v.string(), v.union(v.literal("keep"), v.literal("take"))), fromSha: v.string(), fromRevision: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<{ version: string; revision: number | null }> => {
    const user = await requireDecider(ctx);
    const found = await recipeIn(ctx, user.orgId, args.recipeId);
    if (!found?.pkg) throw new ConvexError(`${args.recipeId} isn't installed.`);
    if (found.pkg.source.kind === "workspace") throw new ConvexError(`${args.recipeId} is this workspace's own copy; it changes when you edit it.`);
    if (!sameRepo(found.pkg.source, args.source)) throw new ConvexError(`${args.recipeId} is installed from ${sourceText(found.pkg.source)}, not ${sourceText(args.source)}.`);
    const was = found.recipe;
    const current = await currentRevision(ctx, user.orgId, was.id);
    if (found.pkg.source.sha !== args.fromSha || (current?.revision ?? null) !== args.fromRevision) {
      throw new ConvexError("The package or its settings changed since you checked for updates. Check again.");
    }
    const now = fromManifest(JSON.parse(args.manifest) as Manifest);
    const lines = upgradeDiff(was, now, storedOverrides(was, current));
    const { overrides, unchosen } = upgradedOverrides(lines, args.choices);
    if (unchosen.length) throw new ConvexError(`Choose keep or take for ${unchosen.join(", ")}: the settings changed since you checked.`);
    const old = found.pkg.bundleStorageId;
    const fitBefore = JSON.stringify(await modelSettings(ctx, user.orgId, "scoring.fit"));
    await ctx.db.patch(found.pkg._id, { source: args.source, version: args.version, manifest: args.manifest, bundleHash: args.bundleHash, bundleStorageId: args.storageId });
    if (old !== args.storageId) await ctx.storage.delete(old);
    const { revision } = await writeRevision(ctx, user, now, parseOverrides(now, overrides).overrides, `Upgraded to v${args.version}`, was, fitBefore);
    return { version: args.version, revision };
  },
});
