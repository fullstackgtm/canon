/**
 * An installed recipe as Canon stores it (docs/recipes.md, "The package"). A package is `recipe.md`, and
 * `dist/recipe.js` when it has TypeScript; an install reads the markdown into this manifest, everything Canon reads
 * without running the recipe's code: its settings, deal page, evals and the plays data with bindings to settings.
 * `parseManifest` checks one strictly; `fromManifest` turns a checked one into a recipe definition whose code is the
 * package's bundle.
 */
import { themeDeclProblems, type ThemeDecl } from "./theme.ts";
import { DEAL_ROLES } from "../convex/lib/objects/registry.ts";
import { DEAL_STAGES, PLAY_CHANNELS } from "../convex/lib/plays/model.ts";
import { REFRESH_CADENCES } from "../convex/lib/research/runPlan.ts";
import { ACTION_IDS, PANELS, actionProblems, placements, type Host } from "./actions.ts";
import {
  CEILINGS, COMPONENTS, OUTPUTS, PARTS, RECIPE_FORMAT, PAGE_KEYS, PAGE_OBJECTS, RECIPE_OBJECTS, RECIPE_SOURCES, bindingProblems, checkSetting, pageOf, resolveData,
  type AnyDescriptor, type PageObject, type PageSpec, type Permissions, type RecipeDefinition, type Settings,
} from "./kernel.ts";
import type { CompiledRecipe } from "./md/parse.ts";
import type { RecipeEval } from "./evals.ts";
import { fieldProblems, type RecipeField } from "./fields.ts";
import { LEVEL_IDS, MODEL_POINTS, SETTING_MAGNITUDE_MAX as MAG, isModelPoint, type ModelPart } from "./models.ts";
import { POINTS, POINT_IDS } from "./points.ts";
import { TEMPLATE_KIND_IDS, checkTemplate, type Template } from "./templates.ts";
import { PLAY_FNS } from "./run.ts";
import { slowPattern } from "./regex.ts";

export const RECIPE_FILE = "customization.md";
export const BUNDLE_FILE = "dist/customization.js";
/** What a package published before customizations were named was called: read when it has no RECIPE_FILE. */
export const LEGACY_FILES = { markdown: "recipe.md", bundle: "dist/recipe.js" } as const;
export const RECIPE_MAX_BYTES = 256 * 1024;
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const BUNDLE_MAX_BYTES = 1024 * 1024;

export type Manifest = {
  /** Namespaced, so an installed recipe can't take a first-party id: `@fsgtm/velocity-deal`. */
  id: string;
  version: string;
  title: string;
  description: string;
  author: { org: string; kind: "agency" };
  /** The recipe format its recipe.md was written in. A package stored under an earlier one keeps running as stored. */
  engines: { canon: string };
  permissions: Permissions;
  settingsSchema: readonly AnyDescriptor[];
  defaults: Settings;
  dealPage: PageSpec;
  /** The workspace theme it contributes; absent in every manifest stored before themes. */
  theme?: ThemeDecl;
  /** Absent from a package stored before account and contact pages were points, and from one that lays out neither. */
  accountPage?: PageSpec;
  contactPage?: PageSpec;
  /** What it contributes at model points; absent from a manifest stored before model points. */
  models?: Partial<Record<string, ModelPart>>;
  /** Absent from a package stored before recipes shipped templates. */
  templates?: readonly Template[];
  /** Absent from a package stored before recipes shipped AI fields; its inline people fields are its fields then. */
  fields?: readonly RecipeField[];
  evals: readonly RecipeEval[];
  /** Null only for a workspace recipe copied from one without plays; a package from GitHub has plays (checkPackage). */
  data: RecipeDefinition["data"];
};

export const PACKAGE_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b`. Both are plain semver (no pre-release). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
export const isVersion = (v: string) => SEMVER.test(v);

// A small checker: each Check pushes "<path> must be <what>" for what it refuses.
type Check = (x: unknown, path: string, errors: string[]) => void;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const must = (errors: string[], path: string, what: string) => { errors.push(`${path} must be ${what}`); };
const str = (min: number, max: number, re?: RegExp, what?: string): Check => (x, p, e) => {
  if (typeof x !== "string" || x.length < min || x.length > max || (re && !re.test(x))) must(e, p, what ?? `text of ${min} to ${max} characters`);
};
const oneOf = (values: readonly string[]): Check => (x, p, e) => { if (typeof x !== "string" || !values.includes(x)) must(e, p, `one of ${values.join(", ")}`); };
const num = (min: number, max: number, whole = false): Check => (x, p, e) => {
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max || (whole && !Number.isInteger(x))) must(e, p, `a ${whole ? "whole " : ""}number from ${min} to ${max}`);
};
const bool: Check = (x, p, e) => { if (typeof x !== "boolean") must(e, p, "true or false"); };
const list = (item: Check, max: number, min = 0): Check => (x, p, e) => {
  if (!Array.isArray(x) || x.length < min || x.length > max) return must(e, p, `a list of ${min} to ${max} items`);
  x.forEach((v, i) => item(v, `${p}[${i}]`, e));
};
const subset = (values: readonly string[]): Check => (x, p, e) => {
  list(oneOf(values), values.length)(x, p, e);
  if (Array.isArray(x) && new Set(x).size !== x.length) must(e, p, "a list without repeats");
};
const obj = (shape: Record<string, Check>, optional: readonly string[] = []): Check => (x, p, e) => {
  if (!isRecord(x)) return must(e, p, "an object");
  for (const k of Object.keys(x)) if (!Object.hasOwn(shape, k)) e.push(`${p}.${k} is not a known key`);
  for (const [k, check] of Object.entries(shape)) {
    if (x[k] === undefined) { if (!optional.includes(k)) e.push(`${p}.${k} is missing`); } else check(x[k], `${p}.${k}`, e);
  }
};
const dict = (value: Check, max: number): Check => (x, p, e) => {
  if (!isRecord(x) || Object.keys(x).length > max) return must(e, p, `an object of at most ${max} keys`);
  for (const [k, v] of Object.entries(x)) value(v, `${p}.${k}`, e);
};
const json = (maxBytes: number): Check => (x, p, e) => { if (!isRecord(x) || JSON.stringify(x).length > maxBytes) must(e, p, `a JSON object of at most ${maxBytes} bytes`); };
const any: Check = () => {};

const SETTING_KEY = str(1, 40, /^[a-zA-Z][a-zA-Z0-9_]*$/, "a name of letters, digits and _");
const SLUG = str(1, 40, /^[a-z][a-z0-9_]*$/, "a slug of a-z, 0-9 and _");
const about = { key: SETTING_KEY, label: str(1, 80), help: str(0, 300), group: str(1, 40) };
/** A settings descriptor by kind: the same shapes the kernel's settings form and checkSetting read. */
const DESCRIPTOR: Record<AnyDescriptor["kind"], Check> = {
  int: obj({ ...about, kind: any, min: num(-MAG, MAG, true), max: num(-MAG, MAG, true) }),
  number: obj({ ...about, kind: any, min: num(-MAG, MAG), max: num(-MAG, MAG), step: num(1e-6, MAG) }),
  roles: obj({ ...about, kind: any, options: subset(DEAL_ROLES) }),
  channels: obj({ ...about, kind: any, options: subset(PLAY_CHANNELS) }),
  phrases: obj({ ...about, kind: any, maxLength: num(1, 2000, true) }),
  text: obj({ ...about, kind: any, minLength: num(0, 4000, true), maxLength: num(1, 4000, true) }),
  bool: obj({ ...about, kind: any }),
  rules: obj({ ...about, kind: any, options: list(str(1, 60, /^[a-z][a-z0-9-]*$/, "a rule id"), 50, 1) }),
  ints: obj({ ...about, kind: any, min: num(-MAG, MAG, true), max: num(-MAG, MAG, true), maxItems: num(1, 20, true) }),
  levels: obj({ ...about, kind: any, options: subset(LEVEL_IDS) }),
  color: obj({ ...about, kind: any }),
  choice: obj({ ...about, kind: any, options: list(str(1, 40), 20, 1) }),
};
const descriptor: Check = (x, p, e) => {
  if (!isRecord(x) || typeof x.kind !== "string" || !Object.hasOwn(DESCRIPTOR, x.kind)) return must(e, `${p}.kind`, `one of ${Object.keys(DESCRIPTOR).join(", ")}`);
  DESCRIPTOR[x.kind as AnyDescriptor["kind"]](x, p, e);
  const [lo, hi] = x.kind === "text" ? [x.minLength, x.maxLength] : [x.min, x.max];
  if (typeof lo === "number" && typeof hi === "number" && lo > hi) must(e, p, "a range whose low end is at most its high end");
};

const stage = obj({ label: str(1, 80), exit: str(1, 300) });
const output = (prompt: keyof typeof OUTPUTS) => obj(Object.fromEntries(OUTPUTS[prompt].map((k) => [k, str(1, 600)])));
const capped = (path: keyof typeof CEILINGS, min: number) => num(min, CEILINGS[path], true);
const question = obj({ type: oneOf(["choice", "noul"]), instructions: str(1, 4000), criteria: dict(str(1, 500), 10) }, ["criteria"]);
/** PlaysData once its bindings are resolved: what queries, mutations and the kernel's actions read. */
const PLAYS_DATA = obj({
  terms: list(obj({ key: SLUG, label: str(1, 100), rule: str(1, 300), severity: oneOf(["high", "medium", "low"]) }), 30),
  qualification: obj({ name: str(1, 80), lines: list(obj({ key: SLUG, group: str(1, 80), label: str(1, 100) }), 50, 1) }),
  coreRoles: subset(DEAL_ROLES),
  quietDays: num(1, 365, true),
  stages: obj(Object.fromEntries(DEAL_STAGES.map((s) => [s, stage]))),
  drafts: obj({
    channels: subset(PLAY_CHANNELS), reviewed: subset(PLAY_CHANNELS), perCheck: num(0, 10, true), aheadDays: num(0, 365, true),
    facts: capped("drafts.facts", 0), touches: capped("drafts.touches", 0), firstTouch: subset(PLAY_CHANNELS),
    output: output("drafts.prompt"), review: output("drafts.reviewPrompt"),
  }),
  research: obj({
    everyDays: num(1, 365, true), newQuestionsAfterDays: num(0, 365, true),
    searches: capped("research.searches", 1), readsPerSearch: capped("research.readsPerSearch", 1), pages: capped("research.pages", 1),
    output: output("research.briefPrompt"),
  }),
  people: obj({
    fields: list(obj({ slug: SLUG, label: str(1, 80), kind: oneOf(["qa"]), answerType: oneOf(["text", "boolean"]), question: str(8, 1000), judgment: bool, replaces: list(str(8, 1000), 10) }, ["judgment", "replaces"]), 10),
    refresh: oneOf(REFRESH_CADENCES),
    slugs: obj({ employed: SLUG, goal: SLUG, systems: SLUG }),
    center: question,
    centerMinConfidence: num(0, 1),
    capability: obj({ tool: str(1, 64, /^[a-zA-Z0-9_-]+$/, "a tool name of letters, digits, _ and -"), schema: json(16_384) }),
    everyDays: num(1, 365, true),
    buyers: capped("people.buyers", 1),
    fit: question,
  }),
}, ["qualification", "terms"]);

const text = (max: number) => str(1, max);
const ACTION = obj({
  id: str(1, 40, /^[a-z][A-Za-z0-9]*$/, "an id of letters and digits"), label: text(120), runs: oneOf(ACTION_IDS), labelAfter: text(120), panel: oneOf(Object.keys(PANELS)),
  shows: text(400), enabled: text(400), prompts: list(text(80), 10), fields: list(text(40), 10),
  llm: text(600), gate: text(600), done: text(300), note: text(600),
}, ["labelAfter", "panel", "shows", "enabled", "prompts", "fields", "llm", "gate", "done", "note"]);

/** An object's page: sections of its own components; only a deal's sections pick stages. */
const pageCheck = (object: PageObject, min: number) => list(obj({
  component: oneOf(COMPONENTS[object]), title: str(1, 80), fields: list(str(1, 80, /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, "a field name"), 200),
  ...(object === "deal" ? { when: obj({ stage: subset(DEAL_STAGES), notStage: subset(DEAL_STAGES) }, ["stage", "notStage"]) } : {}), collapsed: bool, show: subset([...new Set(Object.values(PARTS).flat())]), actions: list(ACTION, 30),
}, ["title", "fields", "when", "collapsed", "show", "actions"]), 30, min);

const MANIFEST = obj({
  id: str(3, 104, PACKAGE_ID, "a namespaced id like @agency/customization-name"),
  version: str(5, 32, SEMVER, "a version like 1.2.0"),
  title: str(1, 80),
  description: str(1, 600),
  author: obj({ org: str(1, 40, /^[a-z0-9][a-z0-9-]*$/, "an org name of a-z, 0-9 and -"), kind: oneOf(["agency"]) }),
  engines: obj({ canon: oneOf([RECIPE_FORMAT]) }),
  permissions: obj({ read: subset(RECIPE_OBJECTS), slots: subset(POINT_IDS), llm: oneOf(["owner", "none"]), sources: subset(RECIPE_SOURCES) }),
  settingsSchema: list(descriptor, 100),
  defaults: dict(any, 100),
  dealPage: pageCheck("deal", 0),
  accountPage: pageCheck("account", 0),
  contactPage: pageCheck("contact", 0),
  models: dict(obj({ tables: dict(list(dict(str(0, 600), 10), 100), 10), prose: dict(list(str(1, 4000), 20), 20) }, ["prose"]), 20),
  evals: list(obj({
    name: str(1, 120), description: str(0, 500), expect: any,
    call: obj({ fn: oneOf(PLAY_FNS), input: list(any, 20), with: dict(obj({ call: num(0, 100, true), field: str(1, 80) }), 10) }, ["with"]),
  }), 50),
  theme: any,
  templates: list(obj({ kind: oneOf(TEMPLATE_KIND_IDS), key: str(1, 63), title: str(1, 80), spec: any }), 100),
  fields: list(any, 50),
  data: any,
}, ["accountPage", "contactPage", "models", "templates", "fields", "theme"]);

/** What Jev's buyer-fit question answers: the kernel orders buyers by it. */
export const FIT_CHOICES = ["left", "right", "tie"];

/** Why plays data, its bindings resolved, isn't the shape queries and the kernel's actions read. */
export function playsDataErrors(resolved: unknown): string[] {
  const errors: string[] = [];
  PLAYS_DATA(resolved, "data", errors);
  if (errors.length) return errors;
  const terms = (resolved as { terms?: Array<{ key: string }> }).terms ?? [];
  if (new Set(terms.map((t) => t.key)).size !== terms.length) errors.push("data.terms keys must be unique");
  const people = (resolved as { people: { fields: Array<{ slug: string }>; slugs: Record<string, string>; fit: { type: string; criteria?: object } } }).people;
  const slugs = people.fields.map((f) => f.slug);
  for (const [role, slug] of Object.entries(people.slugs)) if (!slugs.includes(slug)) errors.push(`data.people.slugs.${role} names "${slug}", which is not in data.people.fields`);
  if (people.fit.type !== "choice" || Object.keys(people.fit.criteria ?? {}).sort().join() !== FIT_CHOICES.join()) errors.push(`data.people.fit must be a choice of ${FIT_CHOICES.join(", ")}`);
  return errors;
}

/** Why the manifest's settings, data and deal page don't hold together, once each has its right shape. */
function crossChecks(m: Manifest, errors: string[]) {
  const keys = m.settingsSchema.map((d) => d.key);
  if (new Set(keys).size !== keys.length) errors.push("settingsSchema describes a setting twice");
  for (const k of Object.keys(m.defaults)) if (!keys.includes(k)) errors.push(`defaults.${k} is not in settingsSchema`);
  for (const d of m.settingsSchema) {
    if (!Object.hasOwn(m.defaults, d.key)) { errors.push(`defaults.${d.key} is missing`); continue; }
    const checked = checkSetting(d, m.defaults[d.key]);
    if (!checked.ok) errors.push(`defaults.${d.key} must be ${checked.error}`);
    else if (d.kind === "phrases" && slowPattern(String(checked.value))) errors.push(`defaults.${d.key} takes too long on a long draft`);
  }
  if (m.data !== null) errors.push(...bindingProblems(m.data, m.settingsSchema));
  if (errors.length) return;
  if (m.data !== null) errors.push(...playsDataErrors(resolveData(m.data, m.defaults)));
  if (errors.length) return;
  for (const object of PAGE_OBJECTS) {
    const key = PAGE_KEYS[object], page = pageOf(m, object);
    page.forEach((s, i) => {
      if ((s.component === "fields") !== ("fields" in s)) errors.push(`${key}[${i}] must list fields when, and only when, it is a fields section`);
      if (s.component === "fields" && !s.title) errors.push(`${key}[${i}].title is missing`);
    });
    if (!errors.length) for (const p of POINTS[`${object}.page`].problems(page)) errors.push(`${key}[${p.at}]: ${p.message}`);
    page.forEach((s, i) => s.actions?.forEach((a, j) => {
      const at = `${key}[${i}].actions[${j}]`;
      const host = (a.panel ?? s.component) as Host;
      if (!placements().some((p) => p.object === object && p.host === host)) return errors.push(`${at}: a ${s.component} section has no actions`);
      if (a.panel && PANELS[a.panel] !== s.component) return errors.push(`${at}: the ${a.panel} sits in a ${PANELS[a.panel]} section`);
      for (const p of actionProblems(a, host, object)) errors.push(`${at}.${p.key}: ${p.message}`);
    }));
    if (page.length && !m.permissions.slots.includes(`${object}.page`)) errors.push(`permissions.slots must list ${object}.page for a customization with a ${key}`);
  }
  for (const [point, part] of Object.entries(m.models ?? {})) {
    if (!isModelPoint(point)) { errors.push(`models.${point} is not a model point`); continue; }
    if (!m.permissions.slots.includes(point)) errors.push(`permissions.slots must list ${point} for a customization with models.${point}`);
    const [offer] = MODEL_POINTS[point].discover({ dealPage: m.dealPage, theme: m.theme ?? null, models: { [point]: part }, settingsSchema: m.settingsSchema, templates: m.templates ?? [], fields: m.fields ?? [], data: m.data });
    for (const p of MODEL_POINTS[point].problems(offer.declares)) errors.push(`models.${point}: ${p.message}`);
  }
  const templates = m.templates ?? [];
  templates.forEach((t, i) => {
    if (templates.findIndex((x) => x.kind === t.kind && x.key === t.key) !== i) return errors.push(`templates[${i}]: ${t.kind} ${t.key} is there twice`);
    const checked = checkTemplate(t.kind, t.key, t.spec, templates);
    if (!checked.ok) errors.push(...checked.errors.map((e) => `templates[${i}].${e}`));
    else if (checked.template.title !== t.title) errors.push(`templates[${i}].title must be its spec's name`);
  });
  const slugs = new Set<string>();
  (m.fields ?? []).forEach((f, i) => {
    const problems = fieldProblems(f, m.settingsSchema);
    if (problems.length) return errors.push(...problems.map((e) => `fields[${i}]: ${e}`));
    if (slugs.has(f.slug)) return errors.push(`fields[${i}]: ${f.slug} is there twice`);
    slugs.add(f.slug);
  });
  if (m.theme !== undefined) {
    for (const message of themeDeclProblems(m.theme, m.settingsSchema)) errors.push(`theme: ${message}`);
    if (!m.permissions.slots.includes("workspace.theme")) errors.push("permissions.slots must list workspace.theme for a customization with a theme");
  }
}

/** The manifest, checked, or every reason it isn't one. */
export function parseManifest(raw: unknown): { ok: true; manifest: Manifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  MANIFEST(raw, "manifest", errors);
  if (!errors.length) crossChecks(raw as Manifest, errors);
  return errors.length ? { ok: false, errors: errors.map((e) => e.replace(/^manifest\./, "")) } : { ok: true, manifest: raw as Manifest };
}

/** A recipe as its package's manifest describes it. `code` is null: the bundle is its code, and runs only in the runtime. */
export function fromManifest(m: Manifest): RecipeDefinition {
  return Object.freeze({
    id: m.id, version: m.version, title: m.title, description: m.description, author: m.author, permissions: m.permissions,
    settings: m.defaults, settingsSchema: m.settingsSchema, dealPage: m.dealPage, theme: m.theme ?? null, accountPage: m.accountPage ?? [], contactPage: m.contactPage ?? [], models: m.models ?? {}, templates: m.templates ?? [], fields: m.fields ?? [], data: m.data, code: null, evals: m.evals,
  });
}

/**
 * The manifest an install stores for a package's recipe.md, parsed with no errors. Check it with parseManifest. Every
 * section lists its actions, none for an action-free one: a manifest without them was stored before recipes placed
 * actions (convex/lib/recipes.ts).
 */
export function toManifest(r: CompiledRecipe): Manifest {
  return {
    id: r.meta.id, version: r.meta.version, title: r.meta.title, description: r.meta.description, author: r.meta.author as Manifest["author"], engines: { canon: RECIPE_FORMAT },
    permissions: r.meta.permissions, settingsSchema: r.settingsSchema, defaults: r.defaults, evals: r.evals, data: r.data, templates: r.templates, fields: r.fields, ...(Object.keys(r.models).length ? { models: r.models } : {}),
    dealPage: r.dealPage.map((s) => ({ ...s, actions: s.actions ?? [] })),
    ...(r.accountPage.length ? { accountPage: r.accountPage.map((s) => ({ ...s, actions: s.actions ?? [] })) } : {}),
    ...(r.contactPage.length ? { contactPage: r.contactPage.map((s) => ({ ...s, actions: s.actions ?? [] })) } : {}),
    ...(r.theme ? { theme: r.theme } : {}),
  };
}
