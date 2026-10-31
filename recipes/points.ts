/**
 * Contribution points (docs/recipes.md, "Points"): the named places a recipe package adds to Canon. A package
 * declares the points it contributes to in its frontmatter (`contributes: [deal.page]`), and each point finds the
 * package's contributions in its parsed form by convention, the way pi finds a package's skills in `skills/`.
 * Installing a package makes its contributions available; a workspace then enables them per point
 * (convex/lib/recipes.ts, `enabledFor`). Pure: no Convex and no Node imports, so it runs in queries and the browser.
 */
import type { ThemeDecl } from "./theme.ts";
import { PAGE_KEYS, pageOf, pageProblems, type PageObject, type PageSpec, type RECIPE_OBJECTS, type RecipeDefinition, type RecipeId } from "./kernel.ts";
import { fieldsOf, type RecipeField } from "./fields.ts";
import { MODEL_POINTS } from "./models.ts";
import { TEMPLATE_KINDS, TEMPLATE_KIND_IDS, type Template, type TemplateKind } from "./templates.ts";

/** What a point holds. Pages, the theme, models, fields and templates are registered; the rest are the planned points' kinds (docs/recipes.md). */
export type PointKind = "page" | "theme" | "fields" | "signals" | "model" | "rules" | "templates";

/** The part of a recipe a point reads its contributions from. A recipe.md compiles to it, and so does a stored manifest. */
export type RecipeParts = Pick<RecipeDefinition, "dealPage" | "models" | "settingsSchema" | "templates" | "fields" | "data"> & Partial<Pick<RecipeDefinition, (typeof PAGE_KEYS)[PageObject] | "theme">>;

/** One thing a recipe offers at a point. `key` is unique within the recipe and point: a page's is `page`, a field's its slug. */
export type Offer<D> = { key: string; title: string; declares: D };
export type Contribution<D = unknown> = Offer<D> & { point: PointId; recipeId: string; recipeTitle: string };

type Common<D> = {
  id: string;
  kind: PointKind;
  title: string;
  description: string;
  /** How a recipe.md writes its part for this point, for the error when it declares the point without one. */
  missing: string;
  /** What a recipe declares here, found in its parsed form; none when it has no such part. */
  discover(recipe: RecipeParts): Offer<D>[];
  /**
   * Why a declaration doesn't hold together, past the shape the parser and parseManifest check: each problem with the
   * index of the part it is about (a page's section), which the parser turns into a line and a manifest into a path.
   */
  problems(declares: D): Array<{ at: number; message: string }>;
  /** What contributing here reads, added to the permissions a recipe lists; the install screen also shows the point it fills. */
  implies: { read: readonly (typeof RECIPE_OBJECTS)[number][] };
  /** "code": a contribution may bind recipe code, which runs in the isolate. "data": plain data only. */
  binds: "data" | "code";
};

/** One contribution in force per workspace: the one a decider enabled, else `unset`. A new workspace starts on `newWorkspace`. */
export type ExclusivePoint<D> = Common<D> & { cardinality: "exclusive"; defaults: { unset: RecipeId; newWorkspace: RecipeId } };
/**
 * Any number in force at once, unless `conflict` says two can't be: two fields with one slug. The contributions of
 * the `defaultOn` recipes are on in every workspace that hasn't turned them off.
 */
export type AdditivePoint<D> = Common<D> & { cardinality: "additive"; conflict(a: Contribution<D>, b: Contribution<D>): string | null; defaultOn?: readonly RecipeId[] };
export type Point<D = unknown> = ExclusivePoint<D> | AdditivePoint<D>;

/** The point a record's page is: its sections, found under the recipe's {page=<object>} heading (the deal's need none). */
const pagePoint = (object: PageObject, about: Pick<ExclusivePoint<PageSpec>, "title" | "description" | "missing" | "defaults">): ExclusivePoint<PageSpec> => ({
  id: `${object}.page`,
  kind: "page",
  cardinality: "exclusive",
  ...about,
  discover: (r) => (pageOf(r, object).length ? [{ key: "page", title: about.title, declares: pageOf(r, object) }] : []),
  problems: (page) => pageProblems(page).map((p) => ({ at: p.section, message: p.message })),
  implies: { read: [object] },
  binds: "code",
});

/**
 * AI fields (recipes/fields.ts): each one a contribution keyed by its slug, which is its attribute. Two recipes can't
 * both have a field on under one slug; the same slug from one recipe after another is the same field, on purpose, so
 * a workspace's answers stay when it switches recipes.
 */
const FIELDS: AdditivePoint<RecipeField> = {
  id: "fields",
  kind: "fields",
  cardinality: "additive",
  title: "AI fields",
  description: "Questions Canon researches on accounts or contacts. Turning one on adds it to AI fields, owned by whoever turned it on.",
  missing: "an ```ai-fields block lists them",
  discover: (r) => fieldsOf(r).map((f) => ({ key: f.slug, title: f.label, declares: f })),
  problems: () => [],
  conflict: (a, b) => (a.key === b.key && a.recipeId !== b.recipeId ? `both define the AI field ${a.key}` : null),
  implies: { read: [] },
  binds: "data",
};

export type TemplatePointId = `templates.${TemplateKind}s`;
export const templatePoint = (kind: TemplateKind): TemplatePointId => `templates.${kind}s`;

/** One additive point per template kind (recipes/templates.ts). Canon's built-in reports and dashboards are canon-base's. */
const templatePoints = Object.fromEntries(TEMPLATE_KIND_IDS.map((kind): [TemplatePointId, AdditivePoint<Template>] => [templatePoint(kind), {
  id: templatePoint(kind),
  kind: "templates",
  cardinality: "additive",
  title: TEMPLATE_KINDS[kind].title,
  description: TEMPLATE_KINDS[kind].description,
  missing: `a \`\`\`template kind=${kind} key=<key> block holds each one`,
  discover: (r) => r.templates.filter((t) => t.kind === kind).map((t) => ({ key: t.key, title: t.title, declares: t })),
  problems: () => [],
  // Keys are per recipe, so two recipes' templates never collide.
  conflict: () => null,
  implies: { read: [] },
  binds: "data",
  ...(kind === "report" || kind === "dashboard" ? { defaultOn: ["canon-base"] as const } : {}),
}])) as Record<TemplatePointId, AdditivePoint<Template>>;

const WORKSPACE_THEME: ExclusivePoint<ThemeDecl> = {
  id: "workspace.theme",
  kind: "theme",
  cardinality: "exclusive",
  title: "Theme",
  description: "The workspace's colours, heading type and corners, on every page of the app.",
  missing: "a ```theme block maps keys like primary to a colour or { setting: key }",
  discover: (r) => (r.theme ? [{ key: "theme", title: "Theme", declares: r.theme }] : []),
  // The parser and the manifest check the block (themeDeclProblems); a workspace's values are checked on save.
  problems: () => [],
  implies: { read: [] },
  binds: "data",
  defaults: { unset: "canon-ledger", newWorkspace: "canon-ledger" },
};

export const POINTS = {
  "deal.page": pagePoint("deal", {
    title: "Deal page", description: "What every deal page shows, and whether Canon keeps a play on each deal.",
    missing: "a heading like ## Overview {section=fields} starts its sections",
    // Workspaces made before recipes keep FSGTM's play until a human-run migration sets them explicitly.
    defaults: { unset: "fsgtm-enterprise-deal", newWorkspace: "canon-base" },
  }),
  "account.page": pagePoint("account", {
    title: "Account page", description: "What every company's page shows: its fit, fields, signals, deals and people, and what a person can do there.",
    missing: "a heading like # Account {page=account}, with sections such as ## Details {section=fields} under it",
    defaults: { unset: "canon-base", newWorkspace: "canon-base" },
  }),
  "contact.page": pagePoint("contact", {
    title: "Contact page", description: "What every person's page shows: their fields, AI fields, companies and deals, calls, email and timeline.",
    missing: "a heading like # Contact {page=contact}, with sections such as ## Details {section=fields} under it",
    defaults: { unset: "canon-base", newWorkspace: "canon-base" },
  }),
  "workspace.theme": WORKSPACE_THEME,
  ...MODEL_POINTS,
  fields: FIELDS,
  ...templatePoints,
} as const;
export type PointId = keyof typeof POINTS;
export const POINT_IDS = Object.keys(POINTS) as PointId[];
export const isPointId = (id: string): id is PointId => Object.hasOwn(POINTS, id);
export const pointOf = (id: PointId): Point => POINTS[id] as Point;
export const isTemplatePoint = (id: PointId): id is TemplatePointId => id.startsWith("templates.");

/** Every contribution a recipe makes, point by point, in registry order. */
export function contributionsOf(recipe: RecipeParts & Pick<RecipeDefinition, "id" | "title">): Contribution[] {
  return POINT_IDS.flatMap((point) => pointOf(point).discover(recipe).map((o) => ({ ...o, point, recipeId: recipe.id, recipeTitle: recipe.title })));
}

/** The points a recipe's parts contribute to. */
export const pointsOf = (recipe: RecipeParts): PointId[] => POINT_IDS.filter((p) => pointOf(p).discover(recipe).length > 0);

/** A recipe's permissions with what its points imply added: the reads each needs, and the points as the slots it fills. */
export function withImplied<P extends { read: readonly string[] }>(permissions: P, points: readonly PointId[]): P & { slots: PointId[] } {
  const { read: listed, ...rest } = permissions;
  const read = [...listed];
  for (const p of points) for (const r of pointOf(p).implies.read) if (!read.includes(r)) read.push(r);
  return { read, slots: [...points], ...rest } as unknown as P & { slots: PointId[] };
}

const same = (a: Pick<Contribution, "recipeId" | "key">, b: Pick<Contribution, "recipeId" | "key">) => a.recipeId === b.recipeId && a.key === b.key;

/**
 * What enabling `next` turns off among the contributions enabled at its point now, or why it can't be enabled. An
 * exclusive point turns off whatever else is on; an additive one refuses a conflict and turns off nothing.
 */
export function planEnable(point: Point, on: readonly Contribution[], next: Contribution): { ok: true; off: Contribution[] } | { ok: false; error: string } {
  if (point.cardinality === "exclusive") return { ok: true, off: on.filter((c) => !same(c, next)) };
  for (const c of on) {
    if (same(c, next)) continue;
    const why = point.conflict(c, next);
    if (why) return { ok: false, error: `${next.recipeTitle} can't be on with ${c.recipeTitle} at ${point.title}: ${why}.` };
  }
  return { ok: true, off: [] };
}

/** Whether a contribution can be turned off. An exclusive point always has one in force, so it is switched instead. */
export function planDisable(point: Point): { ok: true } | { ok: false; error: string } {
  return point.cardinality === "exclusive" ? { ok: false, error: `${point.title} always has one customization in force. Pick another one instead.` } : { ok: true };
}
