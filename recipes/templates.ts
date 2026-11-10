/**
 * Templates (docs/recipes.md, "Templates"): rows a recipe ships for a workspace to install, such as a report or a
 * paused automation. A recipe.md writes one per ```template kind=<kind> key=<key> block, and each kind is an additive
 * point, `templates.<kind>s` (recipes/points.ts). This file is the pure half of the registry: each kind's spec
 * validator, the state its rows install in, and who may install them. The installers are in convex/lib/templates.ts.
 * Pure: no Convex functions and no Node imports, so the parser runs it in the browser and at install time.
 */
import type { Capability } from "../modules/kernel/capabilities.ts";
import { v, type GenericValidator, type Infer } from "convex/values";
import { actionProblem, actionValidator, conditionValidator, conditionsProblem, isAutomationObject, scheduleProblem, triggerValidator } from "../convex/lib/automations.ts";
import { icpSpecValidator } from "../convex/lib/icpSpec.ts";
import { stepValidator as cadenceStepValidator, validateSteps } from "../convex/lib/linkedin/cadence.ts";
import { isRegisterObject, registerListDef } from "../convex/lib/objects/listSpec.ts";
import { STANDARD_OBJECTS, resolveObjectDef, type ResolvedObjectDef } from "../convex/lib/objects/registry.ts";
import { ACTIVITY_OBJECT, activityReportDef, compileAggregateRequest } from "../convex/lib/objects/reportSpec.ts";
import { reportSpec } from "../convex/lib/objects/validators.ts";
import { plainSpec } from "../convex/lib/objects/metricSplit.ts";
import { FORECAST_CATEGORIES, planPipelineSave } from "../convex/lib/pipelines.ts";

/** Where an installed row came from. Every table a template installs into carries it as `recipe`. */
export const provenanceValidator = v.object({ id: v.string(), version: v.string(), key: v.string() });
export type Provenance = Infer<typeof provenanceValidator>;

const name = v.string();
const SPECS = {
  report: v.object({ name, spec: reportSpec }),
  /** Each tile names a report template of the same recipe by its key. */
  dashboard: v.object({ name, tiles: v.array(v.object({ report: v.string(), wide: v.boolean() })) }),
  automation: v.object({ name, object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator), actions: v.array(actionValidator) }),
  icp: v.object({ name, description: v.optional(v.string()), pointOfView: v.optional(v.string()), offer: v.optional(v.string()), spec: icpSpecValidator }),
  /** Every stage is new: a template can't claim a stage another pipeline of the workspace holds. */
  pipeline: v.object({ name, stages: v.array(v.object({ label: v.string(), probability: v.number(), forecastCategory: v.union(...FORECAST_CATEGORIES.map((c) => v.literal(c))) })) }),
  cadence: v.object({ name, steps: v.array(cadenceStepValidator) }),
};

export type TemplateKind = keyof typeof SPECS;
export type TemplateSpec<K extends TemplateKind = TemplateKind> = Infer<(typeof SPECS)[K]>;
/** A template contribution: one row a recipe offers, by kind and a key unique within the recipe and kind. */
export type Template<K extends TemplateKind = TemplateKind> = { [P in K]: { kind: P; key: string; title: string; spec: TemplateSpec<P> } }[K];

/**
 * What an installed row is when it lands. `shared`: a report or dashboard everyone sees, as Canon's built-ins are.
 * `paused`: an automation, which an admin resumes. `inactive`: an ICP that changes no score until switched on, unless
 * it is the workspace's first (the first ICP is always its default). `offered`: no row yet; a cadence needs a sender,
 * so it is made when someone first starts one from the template.
 */
export type InstallState = "shared" | "paused" | "inactive" | "offered";

type KindDef<K extends TemplateKind> = {
  title: string;
  description: string;
  state: InstallState;
  /** Who may install it, past requireDecider (an admin or manager, not their agent). */
  /** What installing one takes (modules/kernel/capabilities.ts). */
  capability: Capability;
  /** Why a spec of the right shape can't be installed anywhere, given the recipe's other templates. */
  problems(spec: TemplateSpec<K>, siblings: readonly Template[]): string[];
};

const standardDef = (o: string): ResolvedObjectDef | undefined => {
  if (o === ACTIVITY_OBJECT) return activityReportDef();
  if (!Object.hasOwn(STANDARD_OBJECTS, o)) return undefined;
  const def = resolveObjectDef(STANDARD_OBJECTS[o as keyof typeof STANDARD_OBJECTS]);
  return isRegisterObject(o) ? registerListDef(o, def) : def;
};

const thrown = (f: () => void): string[] => {
  try { f(); return []; } catch (e) {
    if (e instanceof Error) return [e.message];
    throw e;
  }
};

/** A recipe can't know a workspace's ids, so a template gives tasks and records only to the record's owner. */
const ownerProblem = (a: TemplateSpec<"automation">["actions"][number]) => (a.kind !== "set_field" && a.owner.kind !== "record_owner" ? "a template gives tasks and records only to the record's owner (owner: { kind: record_owner })" : null);

export const TEMPLATE_KINDS: { [K in TemplateKind]: KindDef<K> } = {
  report: {
    title: "Reports", description: "Saved reports, shared with the workspace.", state: "shared", capability: "recipes.decide",
    // Checked against a new workspace's standard fields; the install checks the workspace's own fields again.
    problems: (t) => {
      const def = standardDef(t.spec.object);
      return def ? thrown(() => compileAggregateRequest(t.spec.object, def, plainSpec(t.spec), standardDef)) : [`${t.spec.object} is not a standard object`];
    },
  },
  dashboard: {
    title: "Dashboards", description: "Dashboards of the customization's reports, shared with the workspace.", state: "shared", capability: "recipes.decide",
    problems: (t, siblings) => t.tiles.flatMap((tile) => (siblings.some((s) => s.kind === "report" && s.key === tile.report) ? [] : [`tile ${tile.report} names no report template in this customization`])),
  },
  automation: {
    title: "Automations", description: "Automation rules. Each installs paused, acting as the admin who installed it once resumed.", state: "paused", capability: "automations.manage",
    problems: (t) => {
      const def = standardDef(t.object);
      if (!def || !isAutomationObject(t.object)) return [`rules don't run on ${t.object} records`];
      const out: Array<string | null> = [conditionsProblem(def, t.conditions), ...t.actions.flatMap((a) => [actionProblem(def, a), ownerProblem(a)])];
      if (t.trigger.kind === "schedule") out.push(scheduleProblem(t.trigger));
      if (!t.actions.length) out.push("a rule has at least one action");
      return out.filter((p): p is string => p !== null);
    },
  },
  icp: {
    title: "ICPs", description: "Ideal customer profiles. A new one is inactive, unless it is the workspace's first.", state: "inactive", capability: "recipes.decide",
    problems: () => [],
  },
  pipeline: {
    title: "Pipelines", description: "Deal pipelines, each with its own new stages.", state: "shared", capability: "recipes.decide",
    problems: (t) => {
      const plan = planPipelineSave([], [], { target: { kind: "new" }, name: t.name, stages: t.stages.map((s) => ({ ...s, value: null })) });
      return plan.ok ? [] : [plan.error];
    },
  },
  cadence: {
    title: "LinkedIn cadences", description: "Cadence steps, offered when someone starts a cadence on their own LinkedIn sender.", state: "offered", capability: "recipes.decide",
    // The most generous plan's limits; the sender's own plan is checked when the cadence is made.
    problems: (t) => { const p = validateSteps(t.steps, "sales_navigator"); return p ? [p] : []; },
  },
};

export const TEMPLATE_KIND_IDS = Object.keys(TEMPLATE_KINDS) as TemplateKind[];
export const isTemplateKind = (k: string): k is TemplateKind => Object.hasOwn(TEMPLATE_KINDS, k);
export const TEMPLATE_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Why `value` doesn't match a Convex validator, as `path: what`, or null when it does. */
export function mismatch(validator: GenericValidator, value: unknown, path: string): string | null {
  const val = validator as GenericValidator & { fields?: Record<string, GenericValidator>; element?: GenericValidator; members?: GenericValidator[]; value?: unknown; key?: GenericValidator };
  const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  switch (val.kind) {
    case "any": return null;
    case "string": case "id": return typeof value === "string" ? null : `${path} must be text`;
    case "float64": return typeof value === "number" ? null : `${path} must be a number`;
    case "int64": return typeof value === "bigint" ? null : `${path} must be an integer`;
    case "boolean": return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "null": return value === null ? null : `${path} must be null`;
    case "literal": return value === val.value ? null : `${path} must be ${JSON.stringify(val.value)}`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list`;
      for (const [i, x] of value.entries()) { const m = mismatch(val.element!, x, `${path}[${i}]`); if (m) return m; }
      return null;
    }
    case "record": {
      if (!isMap(value)) return `${path} must be a map`;
      for (const [k, x] of Object.entries(value)) { const m = mismatch(val.value as GenericValidator, x, `${path}.${k}`); if (m) return m; }
      return null;
    }
    case "object": {
      if (!isMap(value)) return `${path} must be a map`;
      for (const k of Object.keys(value)) if (!Object.hasOwn(val.fields!, k)) return `${path}.${k} is not a key (${Object.keys(val.fields!).join(", ")})`;
      for (const [k, f] of Object.entries(val.fields!)) {
        if (value[k] === undefined) { if (f.isOptional !== "optional") return `${path}.${k} is missing`; continue; }
        const m = mismatch(f, value[k], `${path}.${k}`);
        if (m) return m;
      }
      return null;
    }
    case "union": {
      const tries = val.members!.map((m) => mismatch(m, value, path));
      if (tries.some((t) => t === null)) return null;
      // A union of tagged objects says what's wrong with the member its `kind` names.
      const tagged = isMap(value) ? val.members!.findIndex((m) => (m as { fields?: Record<string, { value?: unknown }> }).fields?.kind?.value === value.kind) : -1;
      return tagged >= 0 ? tries[tagged] : `${path} must be one of ${val.members!.map((m) => ("value" in m ? JSON.stringify((m as { value: unknown }).value) : m.kind)).join(", ")}`;
    }
    default: return `${path} has a type a template can't hold`;
  }
}

/** A template from what a recipe wrote, checked, or every reason it isn't one. `siblings` are the recipe's other templates. */
export function checkTemplate(kind: string, key: string, spec: unknown, siblings: readonly Template[] = []): { ok: true; template: Template } | { ok: false; errors: string[] } {
  if (!isTemplateKind(kind)) return { ok: false, errors: [`kind=${kind} is not a template kind (${TEMPLATE_KIND_IDS.join(", ")})`] };
  if (!TEMPLATE_KEY.test(key)) return { ok: false, errors: [`key=${key} must be 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit`] };
  const shape = mismatch(SPECS[kind], spec, "spec");
  if (shape) return { ok: false, errors: [shape] };
  const typed = spec as TemplateSpec;
  const errors = (TEMPLATE_KINDS[kind].problems as (s: TemplateSpec, sib: readonly Template[]) => string[])(typed, siblings);
  if (!typed.name.trim() || typed.name.length > 80) errors.unshift("spec.name is 1 to 80 characters");
  return errors.length ? { ok: false, errors } : { ok: true, template: { kind, key, title: typed.name.trim(), spec: typed } as Template };
}
