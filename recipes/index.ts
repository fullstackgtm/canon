/**
 * The first-party recipes (docs/recipes.md), and the ref a workspace's recipe travels as. Each is a directory under
 * recipes/ holding recipe.md and any .ts files, built into _recipes.generated.ts by scripts/build-recipes.ts. A recipe
 * installed from a package is built from its manifest instead (manifest.ts); convex/lib/recipes.ts resolves either.
 */
import { FIRST_PARTY } from "./_recipes.generated.ts";
import { recipeOf } from "./compose.ts";
import { MODEL_POINTS, modelValues, type ModelPointId, type ModelValues } from "./models.ts";
import { resolveData, type BoundData, type PageSpec, type PlayCode, type Plays, type PlaysData, type RecipeDefinition, type RecipeId, type Settings } from "./kernel.ts";

export {
  BESIDE, BINDABLE, COMPONENTS, DEAL_FRAME, HOLDS, PAGE_COMPONENTS, PAGE_OBJECTS, PARTS, PARTY_COMPONENTS, PLAY_COMPONENTS, RECIPE_IDS, RECORD_COMPONENTS, REST_FIELDS, bindingsOf, checkSetting, diffSettings, groupFields, isFieldsSection, pageOf, pageProblems, panelActions, parseOverrides, resolveData, sameSetting, sectionActions, shows, showsPart,
  type AnyDescriptor, type ComponentOf, type FieldGroup, type FieldsSection, type PageComponent, type PageObject, type PageSection, type PageSpec, type PartyComponent, type PlayComponent, type RecordComponent, type PeopleField, type Permissions, type PlayCode, type Plays, type PlaysData, type RecipeDefinition, type RecipeId, type SettingValue, type Settings,
} from "./kernel.ts";
export { POINTS, POINT_IDS, contributionsOf, isPointId, isTemplatePoint, planDisable, planEnable, pointOf, pointsOf, templatePoint, type Contribution, type Point, type PointId, type PointKind, type TemplatePointId } from "./points.ts";
export { KERNEL_ACTIONS, offered, type ActionId, type Host, type LabelValues, type Offer, type PageAction } from "./actions.ts";
export type { Context } from "./conditions.ts";
export { mismatch, type EvalResult, type Expect, type RecipeEval } from "./evals.ts";
export {
  MODEL_POINTS, MODEL_POINT_IDS, isModelPoint, modelValues,
  type FitModel, type ForecastModel, type HealthModel, type HeatModel, type HygieneModel, type LeadModel, type LeadRule, type ModelPointId, type ModelValues,
} from "./models.ts";

export const RECIPES: Readonly<Record<RecipeId, RecipeDefinition>> = Object.freeze(
  Object.fromEntries(Object.entries(FIRST_PARTY).map(([id, { recipe, extensions }]) => [id, recipeOf(recipe, extensions)])) as Record<RecipeId, RecipeDefinition>,
);

/** The field sections a deal shows where its recipe names none (the enterprise page's field grid, its dialog). */
export const DEFAULT_DEAL_PAGE: PageSpec = RECIPES["canon-base"].dealPage;

/** FSGTM's enterprise recipe: what a package stored before later recipe data fills its gaps from. */
export const FSGTM_RECIPE: RecipeId = "fsgtm-enterprise-deal";

export const isFirstParty = (id: string): id is RecipeId => Object.hasOwn(RECIPES, id);

/**
 * A recipe as a workspace runs it, in a form that crosses a query or the wire: its id, the full settings in force,
 * its plays data on them, and for an installed package the bundle its code runs from.
 */
export type RecipeRef = { id: string; settings: Settings; plays: PlaysData | null; bundle: { hash: string; storageId: string } | null };

export function refOf(recipe: RecipeDefinition, settings: Settings = recipe.settings, bundle: RecipeRef["bundle"] = null): RecipeRef {
  return { id: recipe.id, settings, plays: recipe.data ? resolveData(withStoredGaps(recipe.data), settings) : null, bundle };
}

/**
 * Plays data a recipe says since packages were first stored: the research and people research cadences and limits,
 * the draft input caps and first-touch channels, and what the draft, review, account plan and buyer-fit answers hold.
 * These were the kernel's, and FSGTM's methodology, so a package stored without them runs FSGTM's until it upgrades.
 */
const SINCE_STORED = ["drafts.facts", "drafts.touches", "drafts.firstTouch", "drafts.output", "drafts.review", "research", "people.everyDays", "people.buyers", "people.fit"];
let fsgtmData: PlaysData | null = null;

function withStoredGaps(data: BoundData): BoundData {
  const at = (x: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), x);
  const gaps = SINCE_STORED.filter((p) => at(data, p) === undefined);
  if (!gaps.length) return data;
  const fsgtm = RECIPES[FSGTM_RECIPE];
  fsgtmData ??= resolveData(fsgtm.data!, fsgtm.settings);
  const out = JSON.parse(JSON.stringify(data)) as Record<string, Record<string, unknown>>;
  for (const p of gaps) {
    const [head, key] = p.split(".");
    if (key) out[head][key] = at(fsgtmData, p);
    else out[head] = at(fsgtmData, p) as Record<string, unknown>;
  }
  return out as unknown as BoundData;
}

/** A first-party recipe's ref, at its defaults unless given settings. */
export const firstPartyRef = (id: RecipeId, settings?: Settings): RecipeRef => refOf(RECIPES[id], settings);

/** A first-party recipe's code bound to `settings`, or null for any other id or a recipe without plays. */
export function firstPartyCode(id: string, settings: Settings): PlayCode | null {
  return isFirstParty(id) ? RECIPES[id].code?.(settings) ?? null : null;
}

/** A first-party recipe's data and code at its default settings, for tests and the dev seed. */
export function defaultPlays(id: RecipeId): Plays | null {
  const ref = firstPartyRef(id);
  const code = firstPartyCode(id, ref.settings);
  if (!ref.plays || !code) return null;
  const data = ref.plays;
  return {
    ...data, ...code,
    drafts: { ...data.drafts, ...code.drafts },
    research: { ...data.research, ...code.research },
    people: { ...data.people, ...code.people, capability: { ...data.people.capability, ...code.people.capability } },
  };
}

/** A model point's values where no workspace chose anything: its default recipe at that recipe's default settings. */
export function defaultModel<P extends ModelPointId>(point: P): ModelValues<P> {
  const recipe = RECIPES[MODEL_POINTS[point].defaults.unset];
  return modelValues(recipe, point, recipe.settings);
}
