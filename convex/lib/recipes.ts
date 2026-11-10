/**
 * The workspace's recipes (docs/recipes.md), read in one place. A workspace runs a first-party recipe or a package
 * it installed (recipePackages), and `recipeIn` is the one lookup for both. `enabledFor` is the one read of what a
 * workspace has on at a contribution point. `orgRecipe` binds the deal page recipe to the workspace's current
 * settings revision. Every play surface (the control plane, its changes, research,
 * people research, the keeper and the plays list) reaches the plays through it, so each runs on the same settings,
 * and a workspace on a recipe without plays gets none of them.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { FSGTM_RECIPE, POINT_IDS, RECIPES, contributionsOf, isFirstParty, modelValues, parseOverrides, pointOf, refOf, type Contribution, type ModelPointId, type ModelValues, type PlaysData, type PointId, type RecipeDefinition, type RecipeRef, type Settings } from "../../recipes/index.ts";
import { fromManifest, type Manifest } from "../../recipes/manifest.ts";
import { resolveTheme, themeVars } from "../../recipes/theme.ts";
import type { Connection } from "./recipeSources";

export const NO_PLAYS = "This workspace's deal page package has no plays. An admin or manager can pick one on the Customization page.";

type Db = Pick<QueryCtx, "db">;

/** A recipe a workspace can run, and the package it came from when it isn't first-party. */
export type FoundRecipe = { recipe: RecipeDefinition; pkg: Doc<"recipePackages"> | null };

const PARSED_KEPT = 64;
const parsed = new Map<string, RecipeDefinition>();

/**
 * A package installed before recipes placed their actions (#440) stored no `actions` on any section; one installed
 * since stores them on every section, empty when it has none. The old one's deal page showed FSGTM's buttons and
 * folds, which were code, so each of its play sections keeps those of FSGTM's section of the same kind.
 */
function withLegacyActions(m: Manifest, recipe: RecipeDefinition): RecipeDefinition {
  if (m.dealPage.some((s) => "actions" in s)) return recipe;
  const fsgtm = RECIPES[FSGTM_RECIPE].dealPage;
  const dealPage = recipe.dealPage.map((s) => {
    const from = s.component === "fieldGrid" ? undefined : fsgtm.find((f) => f.component === s.component);
    return from ? { ...s, ...(from.actions ? { actions: from.actions } : {}), ...(from.collapsed ? { collapsed: true } : {}) } : s;
  });
  return Object.freeze({ ...recipe, dealPage });
}

/** What an installed recipe runs, as one string: a GitHub package's commit, or a workspace recipe's markdown in force. */
export const pinOf = (source: Doc<"recipePackages">["source"]) => (source.kind === "workspace" ? source.markdownHash : source.sha);

/** An installed package's recipe. Its manifest was checked on install, so it's only parsed here, once per version. */
export function packageRecipe(row: Pick<Doc<"recipePackages">, "_id" | "manifest" | "bundleHash" | "source">): RecipeDefinition {
  const key = `${row._id}:${pinOf(row.source)}:${row.bundleHash}`;
  let recipe = parsed.get(key);
  if (!recipe) {
    const m = JSON.parse(row.manifest) as Manifest;
    recipe = withLegacyActions(m, fromManifest(m));
    parsed.set(key, recipe);
    if (parsed.size > PARSED_KEPT) parsed.delete(parsed.keys().next().value!);
  }
  return recipe;
}

export const packageRow = (ctx: Db, orgId: Id<"organizations">, recipeId: string) =>
  ctx.db.query("recipePackages").withIndex("by_orgId_and_recipeId", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).unique();

/** The GitHub accounts this workspace connected Canon's App to: the only installations its reads may use. */
export async function orgConnections(ctx: Db, orgId: Id<"organizations">): Promise<Connection[]> {
  const rows = await ctx.db.query("githubRecipeConnections").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "connected")).take(20);
  return rows.map((r) => ({ installationId: r.installationId, login: r.account.login, repos: r.repos }));
}

/** The recipe `recipeId` names in this workspace: first-party, or a package it has installed. Null for neither. */
export async function recipeIn(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<FoundRecipe | null> {
  if (isFirstParty(recipeId)) return { recipe: RECIPES[recipeId], pkg: null };
  const pkg = await packageRow(ctx, orgId, recipeId);
  return pkg?.status === "installed" ? { recipe: packageRecipe(pkg), pkg } : null;
}

export async function requireRecipe(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<FoundRecipe> {
  const found = await recipeIn(ctx, orgId, recipeId);
  if (!found) throw new ConvexError(`This workspace has no package ${recipeId}. Install it on the Customization page first.`);
  return found;
}

/** The revision in force for a workspace and recipe, or null when it runs the defaults. */
export async function currentRevision(ctx: Db, orgId: Id<"organizations">, recipeId: string): Promise<Doc<"recipeRevisions"> | null> {
  for await (const row of ctx.db.query("recipeRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc")) {
    if (row.status === "current") return row;
  }
  return null;
}

/** A revision's stored overrides, checked again: a value the schema no longer accepts falls back to its default. */
export function storedOverrides(recipe: RecipeDefinition, row: Pick<Doc<"recipeRevisions">, "settings" | "revision" | "orgId"> | null): Settings {
  if (!row) return {};
  const { overrides, errors } = parseOverrides(recipe, row.settings);
  for (const e of errors) console.warn(`customization ${recipe.id} revision ${row.revision} (${row.orgId}): ${e.key} ignored, ${e.error}`);
  return overrides;
}

/** A workspace's ref for a recipe it runs: the defaults with the current revision's overrides on top, and its bundle. */
export async function orgSettings(ctx: Db, orgId: Id<"organizations">, { recipe, pkg }: FoundRecipe): Promise<RecipeRef> {
  const overrides = storedOverrides(recipe, await currentRevision(ctx, orgId, recipe.id));
  return refOf(recipe, { ...recipe.settings, ...overrides }, pkg ? { hash: pkg.bundleHash, storageId: pkg.bundleStorageId } : null);
}

export const enablementRow = (ctx: Db, orgId: Id<"organizations">, point: PointId, recipeId: string, key: string) =>
  ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_recipeId_and_contributionKey", (q) => q.eq("orgId", orgId).eq("point", point).eq("recipeId", recipeId).eq("contributionKey", key)).unique();

/** A contribution in force, with the recipe it comes from. `row` is null for a point's default, which nobody chose. */
export type Enabled = FoundRecipe & { contribution: Contribution; row: Doc<"recipeEnablements"> | null };

const ENABLED_READ = 100;
/** Before recipeEnablements, a workspace's deal page recipe was this field; a workspace with no row still runs it. */
const LEGACY: Partial<Record<PointId, (org: Doc<"organizations">) => string | undefined>> = { "deal.page": (org) => org.dealPageRecipe };

/** The contribution `recipeId` makes at `point` under `key` (any key when absent), if the workspace has that recipe. */
export async function contributionIn(ctx: Db, orgId: Id<"organizations">, point: PointId, recipeId: string, key?: string): Promise<(FoundRecipe & { contribution: Contribution }) | null> {
  const found = await recipeIn(ctx, orgId, recipeId);
  const contribution = found && contributionsOf(found.recipe).find((c) => c.point === point && (key === undefined || c.key === key));
  return found && contribution ? { ...found, contribution } : null;
}

const firstAt = (recipe: RecipeDefinition, point: PointId) => contributionsOf(recipe).find((c) => c.point === point)!;

/**
 * What a workspace has on at `point`: the one read every surface uses (docs/recipes.md, "Install and enable"). An
 * exclusive point gives exactly one: the enabled row, else for a workspace from before the table its legacy field,
 * else the point's default. An additive point gives every enabled row. A row whose recipe is gone is skipped with a
 * warning: uninstalling refuses an enabled contribution, so it is a broken row, and pages show the default rather
 * than fail. Layering per point is Canon's default, the installed package, then the workspace's settings
 * revisions; a rep layer would read here too, after the workspace's row.
 */
export async function enabledFor(ctx: Db, orgId: Id<"organizations">, point: PointId): Promise<Enabled[]> {
  const { enabled: out, stale } = await enabledRows(ctx, orgId, point);
  for (const row of stale) console.warn(`org ${orgId}: ${point} names ${row.recipeId}:${row.contributionKey}, which it doesn't have`);
  const def = pointOf(point);
  if (def.cardinality === "additive") {
    // A default-on recipe's contributions are on until someone turns one off, which leaves a row.
    for (const recipeId of def.defaultOn ?? []) {
      for (const contribution of contributionsOf(RECIPES[recipeId]).filter((c) => c.point === point)) {
        if (!(await enablementRow(ctx, orgId, point, recipeId, contribution.key))) out.push({ recipe: RECIPES[recipeId], pkg: null, contribution, row: null });
      }
    }
    return out;
  }
  if (out.length) return out.slice(0, 1);
  const org = await ctx.db.get(orgId);
  const legacy = org && LEGACY[point]?.(org);
  const fallback = legacy ? await contributionIn(ctx, orgId, point, legacy) : null;
  if (legacy && !fallback) console.warn(`org ${orgId}: ${point} customization ${legacy} is not installed; showing ${def.defaults.unset}`);
  if (fallback) return [{ ...fallback, row: null }];
  const recipe = RECIPES[def.defaults.unset];
  return [{ recipe, pkg: null, contribution: firstAt(recipe, point), row: null }];
}

/** The enabled rows at `point`, split into those whose contribution the workspace has and those it no longer has. */
export async function enabledRows(ctx: Db, orgId: Id<"organizations">, point: PointId): Promise<{ enabled: Enabled[]; stale: Doc<"recipeEnablements">[] }> {
  const rows = await ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_enabled", (q) => q.eq("orgId", orgId).eq("point", point).eq("enabled", true)).take(ENABLED_READ);
  const enabled: Enabled[] = [], stale: Doc<"recipeEnablements">[] = [];
  for (const row of rows) {
    const found = await contributionIn(ctx, orgId, point, row.recipeId, row.contributionKey);
    if (found) enabled.push({ ...found, row });
    else stale.push(row);
  }
  return { enabled, stale };
}

/** A new workspace's rows: each exclusive point on the recipe a new workspace starts on. */
export async function seedEnablements(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">, at: number) {
  for (const point of POINT_IDS) {
    const def = pointOf(point);
    if (def.cardinality !== "exclusive") continue;
    const contribution = firstAt(RECIPES[def.defaults.newWorkspace], point);
    await ctx.db.insert("recipeEnablements", { orgId, point, recipeId: contribution.recipeId, contributionKey: contribution.key, enabled: true, at });
  }
}

/**
 * What a model point's surface reads for a workspace (docs/recipes.md, "Model points"): the enabled recipe's tables on
 * that recipe's current settings revision, else canon-base's at its defaults. The one read every model surface's
 * server code makes; the browser gets the values from that surface's query.
 */
export async function modelSettings<P extends ModelPointId>(ctx: Db, orgId: Id<"organizations">, point: P): Promise<ModelValues<P>> {
  const [{ recipe }] = await enabledFor(ctx, orgId, point);
  return modelValues(recipe, point, { ...recipe.settings, ...storedOverrides(recipe, await currentRevision(ctx, orgId, recipe.id)) });
}

/** The workspace's deal page recipe on its settings. */
export async function orgRecipe(ctx: Db, orgId: Id<"organizations">): Promise<FoundRecipe & { ref: RecipeRef; plays: PlaysData | null }> {
  const [{ recipe, pkg }] = await enabledFor(ctx, orgId, "deal.page");
  const ref = await orgSettings(ctx, orgId, { recipe, pkg });
  return { recipe, pkg, ref, plays: ref.plays };
}

/** The workspace's theme as CSS variables (recipes/theme.ts): the enabled theme recipe on its current settings. */
export async function orgTheme(ctx: Db, orgId: Id<"organizations">): Promise<Record<string, string>> {
  const [{ recipe, pkg }] = await enabledFor(ctx, orgId, "workspace.theme");
  const ref = await orgSettings(ctx, orgId, { recipe, pkg });
  return themeVars(recipe.theme ? resolveTheme(recipe.theme, ref.settings) : {});
}

/** A recipe's plays data on the settings `ref` carries, or a ConvexError carrying NO_PLAYS. */
export function playsFor(ref: RecipeRef): PlaysData {
  if (!ref.plays) throw new ConvexError(NO_PLAYS);
  return ref.plays;
}

/** The workspace's recipe on its settings once it is known to have plays, else a ConvexError carrying NO_PLAYS. */
export async function requirePlays(ctx: Db, orgId: Id<"organizations">): Promise<RecipeRef> {
  const { ref } = await orgRecipe(ctx, orgId);
  playsFor(ref);
  return ref;
}

/** Whether `error` is requirePlays refusing, as it arrives in an action from a query it ran. */
export const isNoPlays = (error: unknown): boolean => (error as { data?: unknown } | null)?.data === NO_PLAYS;

/** A first-party recipe id or an installed package's; the handler checks which with recipeIn. */
export const recipeIdValidator = v.string();

/** The recipe a copy came from, when it is at another version than the copy took: Canon shipped one, or the package upgraded. */
export async function upstreamChange(ctx: Db, orgId: Id<"organizations">, forkedFrom: { id: string; version: string }): Promise<{ id: string; title: string; version: string; from: string } | null> {
  const found = await recipeIn(ctx, orgId, forkedFrom.id);
  return found && found.recipe.version !== forkedFrom.version ? { id: forkedFrom.id, title: found.recipe.title, version: found.recipe.version, from: forkedFrom.version } : null;
}

export { termsFor } from "../../recipes/terms.ts";

/** Qualification is recipe data; older installed packages keep BANT+ until customized. */
export function qualificationFor(plays: PlaysData) {
  return plays.qualification ?? {
    name: "BANT+", lines: [
      {"key": "budget", "group": "Budget", "label": "Budget"},
      {"key": "alternatives", "group": "Budget", "label": "Alternatives"},
      {"key": "economic_buyer", "group": "Authority", "label": "Economic buyer"},
      {"key": "decision_criteria", "group": "Authority", "label": "Decision criteria"},
      {"key": "decision_process", "group": "Authority", "label": "Decision process"},
      {"key": "paper_process", "group": "Authority", "label": "Paper process"},
      {"key": "champion", "group": "Authority", "label": "Champion"},
      {"key": "situation", "group": "Need", "label": "Situation"},
      {"key": "problem", "group": "Need", "label": "Problem"},
      {"key": "metrics", "group": "Need", "label": "Metrics"},
      {"key": "deadlines", "group": "Timeline", "label": "Deadlines"},
      {"key": "urgency_drivers", "group": "Timeline", "label": "Urgency drivers"},
      {"key": "engagement", "group": "Timeline", "label": "Engagement"},
    ],
  };
}
