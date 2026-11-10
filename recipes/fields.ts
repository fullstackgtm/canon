/**
 * AI fields a recipe ships (docs/recipes.md, "Fields"): questions Canon researches on accounts or contacts, each one a
 * `researchAgents` row and a `custom.<slug>` attribute once a workspace turns it on. A recipe.md lists them in one
 * ```ai-fields block, and each is a contribution to the additive `fields` point, keyed by its slug (recipes/points.ts).
 * People research reads some of them by slug from its ```people block. Pure: no Convex functions and no Node imports.
 */
import { v, type Infer } from "convex/values";
import { MAX_OPTIONS, UNKNOWN } from "../convex/lib/research/agentLoop.ts";
import { REFRESH_CADENCES } from "../convex/lib/research/runPlan.ts";
import type { AnyDescriptor, BoundData, Settings } from "./kernel.ts";
import { mismatch } from "../modules/kernel/mismatch.ts";

/** A field's slug is its attribute, `custom.<slug>`: the same rule a workspace's own fields follow. */
export const FIELD_SLUG = /^[a-z][a-z0-9_]{0,47}$/;
/** What an admin's install starts auto-accepting at, when the recipe suggests a threshold. */
export const AUTO_ACCEPT_RANGE = [0.5, 1] as const;

const bound = v.union(v.string(), v.object({ setting: v.string() }));
export const recipeFieldValidator = v.object({
  slug: v.string(),
  label: v.string(),
  object: v.union(v.literal("account"), v.literal("contact")),
  kind: v.union(v.literal("classify"), v.literal("qa")),
  /** The question, or `{ setting }`: the workspace's value of a text setting, so an admin can reword it. */
  question: bound,
  /** A classify field's answers. */
  options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))),
  /** A qa field's answer: text when absent. */
  answerType: v.optional(v.union(v.literal("text"), v.literal("number"), v.literal("boolean"))),
  /** No page states it outright, so it is answered as a cited inference. */
  judgment: v.optional(v.boolean()),
  /** How often its answers are asked again; never when absent. */
  refresh: v.optional(v.union(...REFRESH_CADENCES.map((c) => v.literal(c)))),
  /** The Jev confidence an admin's install auto-accepts answers at. A manager's install reviews every answer. */
  autoAccept: v.optional(v.number()),
  /** Earlier default questions: a workspace field still asking one moves to `question`; a question someone wrote stays. */
  replaces: v.optional(v.array(v.string())),
});
/** A field as a recipe declares it, its question perhaps bound to a setting. */
export type RecipeField = Infer<typeof recipeFieldValidator>;
/** A field with its question resolved on a workspace's settings: what an install writes. */
export type ResolvedField = Omit<RecipeField, "question"> & { question: string };

const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why a field a recipe wrote can't be installed anywhere, given the recipe's settings. Empty when it can. */
export function fieldProblems(raw: unknown, schema: readonly AnyDescriptor[]): string[] {
  const shape = mismatch(recipeFieldValidator, raw, "field");
  if (shape) return [shape];
  const f = raw as RecipeField;
  const out: string[] = [];
  if (!FIELD_SLUG.test(f.slug)) out.push(`slug ${f.slug} is 1 to 48 of a-z, 0-9 and _, starting with a letter`);
  if (!f.label.trim() || f.label.length > 80) out.push("label is 1 to 80 characters");
  if (typeof f.question === "string") {
    if (f.question.trim().length < 8 || f.question.length > 1000) out.push("question is 8 to 1,000 characters");
  } else {
    const d = schema.find((s) => s.key === (f.question as { setting: string }).setting);
    if (!d) out.push(`question binds "${f.question.setting}", which is not a setting`);
    else if (d.kind !== "text" || d.minLength < 8 || d.maxLength > 1000) out.push(`question binds "${f.question.setting}", which must be a text setting of 8 to 1,000 characters`);
  }
  if (f.kind === "classify") {
    const options = f.options ?? [];
    if (options.length < 2 || options.length > MAX_OPTIONS) out.push(`a classify field has 2 to ${MAX_OPTIONS} options`);
    const keys = options.map((o) => o.key);
    if (keys.some((k) => !KEY.test(k) || k.length > 40 || k === UNKNOWN) || new Set(keys).size !== keys.length) out.push(`options have distinct keys of a-z, 0-9 and -, and "${UNKNOWN}" is Canon's`);
    if (options.some((o) => !o.label.trim() || o.label.length > 80 || (o.description?.length ?? 0) > 300)) out.push("an option's label is 1 to 80 characters and its description at most 300");
    if (f.answerType) out.push("answer is for a qa field; a classify field answers with its options");
  } else if (f.options) out.push("options are for a classify field");
  if (f.autoAccept !== undefined && !(f.autoAccept >= AUTO_ACCEPT_RANGE[0] && f.autoAccept <= AUTO_ACCEPT_RANGE[1])) out.push(`autoAccept is from ${AUTO_ACCEPT_RANGE[0]} to ${AUTO_ACCEPT_RANGE[1]}`);
  if (f.replaces && (f.replaces.length > 10 || f.replaces.some((q) => q.length < 8 || q.length > 1000))) out.push("replaces lists at most 10 questions of 8 to 1,000 characters");
  return out;
}

/**
 * Every field a recipe offers: its ```ai-fields block, then any people research field written inline in its ```people
 * block, as recipes did before fields were their own point. Such a field asks about contacts, refreshes on people
 * research's cadence and auto-accepts at Canon's default, as people research always made it.
 */
export function fieldsOf(recipe: { fields: readonly RecipeField[]; data: BoundData | null }): RecipeField[] {
  const declared = new Set(recipe.fields.map((f) => f.slug));
  const people = recipe.data?.people;
  const inline = (people?.fields ?? []).filter((f) => !declared.has(f.slug)).map((f): RecipeField => ({
    slug: f.slug, label: typeof f.label === "string" ? f.label : f.slug, object: "contact", kind: "qa", question: f.question as RecipeField["question"], answerType: f.answerType,
    ...(f.judgment ? { judgment: true } : {}), refresh: people!.refresh, autoAccept: 0.8, ...(f.replaces ? { replaces: [...f.replaces] } : {}),
  }));
  return [...recipe.fields, ...inline];
}

/** A field with its question on `settings`, the workspace's settings for its recipe. */
export const resolveField = (f: RecipeField, settings: Settings): ResolvedField =>
  ({ ...f, question: typeof f.question === "string" ? f.question : String(settings[f.question.setting] ?? "") });
