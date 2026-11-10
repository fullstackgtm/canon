/**
 * Model points (docs/recipes.md, "Model points"): the methodology behind a score or a policy, as data a recipe
 * contributes. A model point is exclusive. Its contribution is a set of typed settings, which the recipe declares
 * under a `{model=<point>}` heading and a workspace edits as revisions of that recipe's settings, plus any built-in
 * tables the point reads. `modelValues` turns the settings in force and the tables into the values the surface reads.
 * No recipe code runs, so queries, mutations and the browser read the same values. Pure: no Convex and no Node imports.
 */
import type { CallInsightType } from "../engine/src/calls.ts";
import { builtinAuditRules } from "../engine/src/rules.ts";
import { SENIORITY } from "../services/record-service/src/titles.ts";
import type { TableRows } from "./builtins.ts";
import type { AnyDescriptor, RECIPE_OBJECTS, RecipeDefinition, Settings } from "./kernel.ts";
import type { ExclusivePoint } from "./points.ts";
import { render, type Templates } from "./template.ts";

/**
 * The kernel's bounds on a setting a model point reads. A recipe's own limits must sit inside them. A number setting
 * added to a point after recipes already filled it has a `fallback`, which a recipe written before it reads instead.
 */
export type Bound =
  | { kind: "int" | "number"; min: number; max: number; fallback?: number } | { kind: "ints"; min: number; max: number; maxItems: number }
  | { kind: "bool" } | { kind: "phrases" } | { kind: "rules" | "levels" | "choice"; options: readonly string[] };

/** A table's rows as a recipe.md writes them, cell text by lower-cased column: how a contribution stores a table. */
export type TableCells = ReadonlyArray<Readonly<Record<string, string>>>;

type Problem = (message: string, line?: number) => void;
/** A built-in table a model point reads: its columns, and its rows read into the value the point uses. */
export type ModelTable<T> = { columns: readonly string[]; configure(rows: TableRows, problem: Problem): T };

/**
 * What a recipe contributes at a model point beyond its settings: the point's tables, as written, and the prose the
 * point reads, from `{partial=…}` headings under its `{model=…}` heading, as each partial's paragraph sources.
 */
export type ModelPart = { tables: Readonly<Record<string, TableCells>>; prose?: Templates };
/** What a model point finds in a recipe: the descriptors of the settings it reads, its tables and its prose. */
export type ModelDeclares = { settings: readonly AnyDescriptor[]; tables: Readonly<Record<string, TableCells>>; prose: Templates };

// ───────────────────────────── The values each surface reads ─────────────────────────────

export type ForecastModel = {
  /** What a deal without a probability is weighted at in the server's forecast. */
  defaultProbability: number;
  /** What an open deal in each category counts for in the Revenue page's and the pipeline route's weighted rows. */
  weights: { commit: number; best_case: number; pipeline: number };
  /** Below `commit` or `weighted` coverage the forecast recommends a review; at `onTrack` it is on track, at `watch` watched. */
  coverage: { commit: number; weighted: number; onTrack: number; watch: number; pipelineOverCommit: number };
  /** An open deal closing within this many days reads as closing soon on the Revenue page. */
  closingDays: number;
};

/** The points each part of an account's health score earns (the `canon.health` table). */
export type HealthPoints = {
  revenue: number;
  contacts: number;
  expansion: { open: number; pipeline: number; neither: number };
  owner: { yes: number; no: number };
  sync: { fresh: number; recent: number; stale: number };
  noCustomerSignal: number;
};
export type HealthModel = {
  /** A score at `healthy` or above is healthy, at `atRisk` or above at risk, below it churning. */
  bands: { healthy: number; atRisk: number };
  /** Revenue earns its points in proportion up to this, in cents; contacts up to this many. */
  revenueCap: number;
  contactTarget: number;
  /** A sync this many days old or newer is fresh, then recent, then stale. */
  sync: { freshDays: number; recentDays: number };
  /** Won ARR at `highArr` cents is high expansion potential; at `mediumArr`, or with `mediumContacts` contacts, medium. */
  expansion: { highArr: number; mediumArr: number; mediumContacts: number };
  /** An account without a renewal deal renews this many days from the scoring. */
  renewalDefaultDays: number;
  /** How many accounts one run scores, highest priority first. */
  accountsScored: number;
  points: HealthPoints;
};

export const LEAD_FIELDS = ["industry", "revenue", "employee_count", "title", "engagement"] as const;
export const LEAD_OPERATORS = ["equals", "contains", "greater_than", "less_than"] as const;
/** One rule of a lead scoring model: `greater_than` and `less_than` include the value itself. */
export type LeadRule = { field: (typeof LEAD_FIELDS)[number]; operator: (typeof LEAD_OPERATORS)[number]; value: string | number; points: number };
export type LeadModel = {
  /** What a new model grades a lead hot and warm from; cold is everything below warm. */
  thresholds: { hot: number; warm: number; cold: number };
  /** Points a lead earns when it or its account has an owner. */
  ownerPoints: number;
  /** The rules a workspace's first lead scoring model starts with (the `canon.leadRules` table). */
  rules: readonly LeadRule[];
};

export const HEAT_BUCKETS = ["job", "site", "blog", "social"] as const;
export type HeatBucket = (typeof HEAT_BUCKETS)[number];
export type HeatModel = {
  /** What a fresh signal of each kind counts for. */
  points: Record<HeatBucket, number>;
  /** A reposted role counts this many times over. */
  repostFactor: number;
  /** A signal fades in a straight line to nothing over this many days. */
  windowDays: number;
  /** The points at which heat is about 63: each extra signal adds less than the one before it. */
  saturation: number;
  /** Heat at `burning` or above is burning, at `warm` warm, at `cool` cool, else none. */
  labels: { burning: number; warm: number; cool: number };
  /** Hiring, a site change or `blogPosts` posts within `windowDays`, and profiles on `socialProfiles` networks, are growth. */
  growth: { windowDays: number; blogPosts: number; socialProfiles: number };
};

/** The weights a saved ICP's gate ranks an account with (convex/lib/researchPipeline.ts icpToWeights, lib/icps.ts specGate). */
export type FitModel = {
  /** What every account inside an ICP starts with. */
  base: number;
  /** What the ICP's industries earn by rank, its first first; every rank past the list earns the list's last. */
  industryRanks: readonly number[];
  countryRanks: readonly number[];
  /** A size band at the middle of the ICP's sizes, elsewhere inside them, or just outside them. */
  bands: { central: number; inside: number; adjacent: number };
  /** What a size band the ICP names, but Canon's band list doesn't, earns. */
  unlistedBand: number;
  /** Who a buyer is when the ICP picks no level. */
  buyerLevels: readonly string[];
};

/** The job levels a title reads as (services/record-service/src/titles.ts), the vocabulary of a levels setting. */
export const LEVEL_IDS: readonly string[] = SENIORITY.map(([id]) => id);

export const CALL_DEFINITIONS = ["nextStep", "closeDate", "otherCompany", "mentionedPeople", "opportunity"] as const;
export type CallsModel = {
  /** What each answer the call facts prompt asks for means (convex/lib/conversations/facts.ts); the kernel names the fields and keeps the rest. */
  define: Record<(typeof CALL_DEFINITIONS)[number], string>;
  /** Each insight category's keywords, a case-insensitive pattern (engine/src/calls.ts). */
  phrases: Record<CallInsightType, string>;
  /** A deal a call suggests, with no close date said, closes this many days after the meeting. */
  defaultCloseDays: number;
};

/** How a target account's engagement adds up (convex/lib/abm.ts), and the score that reads as engaged. */
export type AbmModel = {
  points: { openDeal: number; pipelinePerPoint: number; pipelineMax: number; contact: number; contactMax: number; owner: number; won: number };
  engaged: number;
};

/**
 * The pages a workspace can hide from the sidebar and the command palette (src/components/shell/nav.ts). Settings and
 * Recipes always show, so an admin can always undo a change here. The first twelve are the pages Canon can open on.
 */
export const NAV_PAGES = ["accounts", "people", "icps", "audiences", "my-work", "review", "deals", "reports", "linkedin", "dialer", "runs", "agents", "integrations", "ai-fields", "cli-pairing"] as const;
export type NavPage = (typeof NAV_PAGES)[number];
/**
 * What navHidden and navRepHidden accept: every page, and `consolidate`, which the sidebar no longer has (its fields
 * moved to each CRM's Fields tab). A customization that still lists it reads as before; the id hides nothing.
 */
const NAV_HIDEABLE = [...NAV_PAGES.slice(0, 14), "consolidate", ...NAV_PAGES.slice(14)];
export type NavModel = {
  /** Off the nav for everyone; `repHidden` also for reps and other members, while admins and managers still see them. */
  hidden: readonly NavPage[];
  repHidden: readonly NavPage[];
  /** Where /dashboard opens. */
  home: NavPage;
};

/** The GtmPolicy keys a workspace sets (engine/src/types.ts); `today` is the run's own. */
export type HygienePolicy = {
  staleDealDays: number; closingSoonDays: number; closingSoonIdleDays: number;
  staleHighDays: number; staleMediumDays: number; freshnessDays: number;
  requireDealOwner: boolean; requireAccountForDeal: boolean; requireDealAmount: boolean;
};
export type HygieneModel = { policy: HygienePolicy; disabledRules: readonly string[] };

/** The audit rules a hygiene policy can turn off: the engine's built-ins. */
export const AUDIT_RULE_IDS: readonly string[] = builtinAuditRules.map((r) => r.id);
/**
 * The most accounts one health run scores. Scoring runs in one mutation that already reads up to 2,525 rows; each
 * scored account adds a read and a write, and 200 keeps the run inside Convex's 4,096 reads.
 */
export const HEALTH_ACCOUNTS_MAX = 200;
/** The largest magnitude an int or number setting may reach, here and in a package's manifest: ARR in cents needs 10^13. */
export const SETTING_MAGNITUDE_MAX = 1e13;

// ───────────────────────────── Tables ─────────────────────────────

const POINTS_RANGE = { min: -100, max: 100 };
const pointsOf = (text: string, line: number, problem: Problem, what: string): number => {
  const n = /^-?\d+$/.test(text.trim()) ? Number(text) : NaN;
  if (!(n >= POINTS_RANGE.min && n <= POINTS_RANGE.max)) { problem(`${what}: points are a whole number from ${POINTS_RANGE.min} to ${POINTS_RANGE.max}`, line); return 0; }
  return n;
};

export const HEALTH_PARTS = ["revenue", "contacts", "expansion.open", "expansion.pipeline", "expansion.neither", "owner.yes", "owner.no", "sync.fresh", "sync.recent", "sync.stale", "noCustomerSignal"] as const;

/** `canon.health`: one row per part of the score, `| Score | Points |`, every part exactly once. */
const HEALTH_TABLE: ModelTable<HealthPoints> = {
  columns: ["score", "points"],
  configure(rows, problem) {
    const got = new Map<string, number>();
    for (const { line, cells } of rows) {
      const part = cells.score.trim();
      if (!(HEALTH_PARTS as readonly string[]).includes(part)) { problem(`${part || "(empty)"} is not a part of the health score (${HEALTH_PARTS.join(", ")})`, line); continue; }
      if (got.has(part)) { problem(`${part} is in the table twice`, line); continue; }
      got.set(part, pointsOf(cells.points, line, problem, part));
    }
    const missing = HEALTH_PARTS.filter((p) => !got.has(p));
    if (missing.length) problem(`the health score needs a row for ${missing.join(", ")}`);
    const p = (k: (typeof HEALTH_PARTS)[number]) => got.get(k) ?? 0;
    return {
      revenue: p("revenue"), contacts: p("contacts"),
      expansion: { open: p("expansion.open"), pipeline: p("expansion.pipeline"), neither: p("expansion.neither") },
      owner: { yes: p("owner.yes"), no: p("owner.no") },
      sync: { fresh: p("sync.fresh"), recent: p("sync.recent"), stale: p("sync.stale") },
      noCustomerSignal: p("noCustomerSignal"),
    };
  },
};

const LEAD_RULES_MAX = 50;
const NUMERIC_OPERATORS: readonly string[] = ["greater_than", "less_than"];

/** `canon.leadRules`: `| Field | Operator | Value | Points |`, a numeric operator's value a number. */
const LEAD_RULES_TABLE: ModelTable<LeadRule[]> = {
  columns: ["field", "operator", "value", "points"],
  configure(rows, problem) {
    if (rows.length > LEAD_RULES_MAX) problem(`a lead scoring model has at most ${LEAD_RULES_MAX} rules`);
    return rows.flatMap(({ line, cells }): LeadRule[] => {
      const field = cells.field.trim(), operator = cells.operator.trim(), value = cells.value.trim();
      if (!(LEAD_FIELDS as readonly string[]).includes(field)) { problem(`field ${field || "(empty)"} must be one of ${LEAD_FIELDS.join(", ")}`, line); return []; }
      if (!(LEAD_OPERATORS as readonly string[]).includes(operator)) { problem(`operator ${operator || "(empty)"} must be one of ${LEAD_OPERATORS.join(", ")}`, line); return []; }
      const numeric = NUMERIC_OPERATORS.includes(operator);
      if (numeric ? !/^-?\d+(\.\d+)?$/.test(value) : !value) { problem(`${field} ${operator} needs ${numeric ? "a number" : "a value"}`, line); return []; }
      return [{ field: field as LeadRule["field"], operator: operator as LeadRule["operator"], value: numeric ? Number(value) : value, points: pointsOf(cells.points, line, problem, `${field} ${operator} ${value}`) }];
    });
  },
};

// ───────────────────────────── The points ─────────────────────────────

type Getters = { num(key: string): number; bool(key: string): boolean; list(key: string): readonly string[]; ints(key: string): readonly number[]; text(key: string): string; prose(id: string): string };
type Def<V> = {
  id: string;
  title: string;
  description: string;
  reads: readonly (typeof RECIPE_OBJECTS)[number][];
  settings: Readonly<Record<string, Bound>>;
  tables?: Readonly<Record<string, ModelTable<unknown>>>;
  /** The partials it reads, each rendered against the settings in force. */
  prose?: readonly string[];
  values(s: Getters, tables: Readonly<Record<string, unknown>>): V;
};

/** A model point in the registry: exclusive, plain data, on Canon's defaults until a workspace picks another recipe. */
export type ModelPoint<V = unknown> = ExclusivePoint<ModelDeclares> & {
  kind: "model";
  settings: Readonly<Record<string, Bound>>;
  tables: Readonly<Record<string, ModelTable<unknown>>>;
  prose: readonly string[];
  /** The values its surface reads, from the settings in force and the contribution's tables and prose. */
  values(settings: Settings, part: ModelPart): V;
};

/** The rows that have every column the table reads; each one that doesn't is a problem rather than a throw in `configure`. */
const cellRows = (t: ModelTable<unknown>, cells: TableCells, problem: Problem): TableRows => cells.flatMap((c, i) => {
  const missing = t.columns.filter((col) => typeof c[col] !== "string");
  if (missing.length) { problem(`row ${i + 1} has no ${missing.join(", ")}`); return []; }
  return [{ line: 0, cells: c }];
});
const READS: Record<Bound["kind"], string> = {
  int: "a whole number", number: "a number", ints: "a list of whole numbers", bool: "a yes or no", phrases: "a pattern", rules: "a list of options", levels: "a list of job levels", choice: "one option",
};
const fits = (b: Bound, d: AnyDescriptor): string | null => {
  if (b.kind !== d.kind) return `is ${d.kind}, and the point reads ${READS[b.kind]}`;
  if ("min" in b && "min" in d && (d.min < b.min || d.max > b.max)) return `runs from ${d.min} to ${d.max}, past the kernel's ${b.min} to ${b.max}`;
  if (b.kind === "ints" && d.kind === "ints" && d.maxItems > b.maxItems) return `holds up to ${d.maxItems} values, past the kernel's ${b.maxItems}`;
  if ("options" in b && "options" in d) {
    const unknown = d.options.filter((o) => !b.options.includes(o));
    if (unknown.length) return `offers ${unknown.join(", ")}, which the point doesn't read`;
  }
  return null;
};

function modelPoint<V>(def: Def<V>): ModelPoint<V> {
  const tables = def.tables ?? {};
  const prose = def.prose ?? [];
  const keys = Object.keys(def.settings);
  const fallbacks: Settings = Object.fromEntries(Object.entries(def.settings).flatMap(([k, b]) => ("fallback" in b && b.fallback !== undefined ? [[k, b.fallback]] : [])));
  const configured = (cells: Readonly<Record<string, TableCells>>) => Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, t.configure(cellRows(t, cells[name] ?? [], () => {}), () => {})]));
  return {
    id: def.id, kind: "model", cardinality: "exclusive", title: def.title, description: def.description,
    missing: `a heading like ## ${def.title} {model=${def.id}} holds the settings it reads`,
    discover: (r) => {
      const part = r.models?.[def.id as keyof typeof r.models];
      return part ? [{ key: "model", title: def.title, declares: { settings: r.settingsSchema.filter((d) => keys.includes(d.key)), tables: part.tables, prose: part.prose ?? {} } }] : [];
    },
    problems: (declares) => {
      const out: string[] = [];
      for (const [key, bound] of Object.entries(def.settings)) {
        const d = declares.settings.find((x) => x.key === key);
        const why = d ? fits(bound, d) : null;
        if (!d && !("fallback" in bound)) out.push(`${def.title} reads the ${bound.kind} setting ${key}, which the customization doesn't declare`);
        else if (why) out.push(`setting ${key} ${why}`);
      }
      for (const [name, t] of Object.entries(tables)) {
        const cells = declares.tables[name];
        if (!cells) { out.push(`${def.title} reads a ${name} table with the columns ${t.columns.join(", ")}`); continue; }
        const problem: Problem = (message) => out.push(`${name}: ${message}`);
        t.configure(cellRows(t, cells, problem), problem);
      }
      for (const name of Object.keys(declares.tables)) if (!Object.hasOwn(tables, name)) out.push(`${def.title} reads no ${name} table`);
      for (const id of prose) if (!declares.prose[id]?.length) out.push(`${def.title} reads the prose under a {partial=${id}} heading`);
      for (const id of Object.keys(declares.prose)) if (!prose.includes(id)) out.push(`${def.title} reads no ${id} partial (${prose.join(", ") || "none"})`);
      return out.map((message) => ({ at: 0, message }));
    },
    implies: { read: def.reads },
    binds: "data",
    defaults: { unset: "canon-base", newWorkspace: "canon-base" },
    settings: def.settings,
    tables,
    prose,
    values: (settings, part) => def.values({
      num: (k) => (settings[k] ?? fallbacks[k]) as number,
      bool: (k) => settings[k] as boolean,
      list: (k) => settings[k] as readonly string[],
      ints: (k) => settings[k] as readonly number[],
      text: (k) => settings[k] as string,
      prose: (id) => render(part.prose ?? {}, id, { settings }),
    }, configured(part.tables)),
  };
}

const share = { kind: "number", min: 0, max: 1 } as const;
const days = { kind: "int", min: 0, max: 3650 } as const;
const score = { kind: "int", min: 0, max: 100 } as const;
const cents = { kind: "int", min: 0, max: SETTING_MAGNITUDE_MAX } as const;

export const FORECAST_MODEL = modelPoint<ForecastModel>({
  id: "forecast.model", title: "Forecast", reads: ["deal"],
  description: "What each deal counts for in the forecast, and the coverage of target that reads on track.",
  settings: {
    forecastDefaultProbability: share, forecastCommitWeight: share, forecastBestCaseWeight: share, forecastPipelineWeight: share,
    forecastCommitCoverage: { kind: "number", min: 0, max: 5 }, forecastWeightedCoverage: { kind: "number", min: 0, max: 5 },
    forecastOnTrack: { kind: "number", min: 0, max: 5 }, forecastWatch: { kind: "number", min: 0, max: 5 }, forecastPipelineOverCommit: { kind: "number", min: 0, max: 100 },
    forecastClosingDays: { kind: "int", min: 1, max: 365, fallback: 30 },
  },
  values: (s) => ({
    defaultProbability: s.num("forecastDefaultProbability"),
    weights: { commit: s.num("forecastCommitWeight"), best_case: s.num("forecastBestCaseWeight"), pipeline: s.num("forecastPipelineWeight") },
    coverage: { commit: s.num("forecastCommitCoverage"), weighted: s.num("forecastWeightedCoverage"), onTrack: s.num("forecastOnTrack"), watch: s.num("forecastWatch"), pipelineOverCommit: s.num("forecastPipelineOverCommit") },
    closingDays: s.num("forecastClosingDays"),
  }),
});

export const HEALTH_MODEL = modelPoint<HealthModel>({
  id: "health.model", title: "Customer health", reads: ["account", "contact", "deal"],
  description: "How an account's health score adds up, where its bands fall, and how many accounts a run scores.",
  settings: {
    healthHealthy: score, healthAtRisk: score, healthRevenueCap: { ...cents, min: 1 }, healthContactTarget: { kind: "int", min: 1, max: 1000 },
    healthSyncFreshDays: days, healthSyncRecentDays: days,
    healthExpansionHighArr: cents, healthExpansionMediumArr: cents, healthExpansionContacts: { kind: "int", min: 0, max: 1000 },
    healthRenewalDays: { kind: "int", min: 1, max: 3650 }, healthAccountsScored: { kind: "int", min: 1, max: HEALTH_ACCOUNTS_MAX },
  },
  tables: { "canon.health": HEALTH_TABLE },
  values: (s, t) => ({
    bands: { healthy: s.num("healthHealthy"), atRisk: s.num("healthAtRisk") },
    revenueCap: s.num("healthRevenueCap"), contactTarget: s.num("healthContactTarget"),
    sync: { freshDays: s.num("healthSyncFreshDays"), recentDays: s.num("healthSyncRecentDays") },
    expansion: { highArr: s.num("healthExpansionHighArr"), mediumArr: s.num("healthExpansionMediumArr"), mediumContacts: s.num("healthExpansionContacts") },
    renewalDefaultDays: s.num("healthRenewalDays"),
    accountsScored: Math.min(s.num("healthAccountsScored"), HEALTH_ACCOUNTS_MAX),
    points: t["canon.health"] as HealthPoints,
  }),
});

export const LEAD_MODEL = modelPoint<LeadModel>({
  id: "scoring.lead", title: "Lead scoring", reads: ["contact", "account"],
  description: "The rules a workspace's first lead scoring model starts with, where its grades fall, and what an owned lead earns.",
  settings: { leadHot: score, leadWarm: score, leadOwnerPoints: { kind: "int", min: -100, max: 100 } },
  tables: { "canon.leadRules": LEAD_RULES_TABLE },
  values: (s, t) => ({ thresholds: { hot: s.num("leadHot"), warm: s.num("leadWarm"), cold: 0 }, ownerPoints: s.num("leadOwnerPoints"), rules: t["canon.leadRules"] as LeadRule[] }),
});

export const HEAT_MODEL = modelPoint<HeatModel>({
  id: "signals.heat", title: "Signal heat", reads: ["account", "observations"],
  description: "What each kind of signal counts for, how fast it fades, and what reads as growth.",
  settings: {
    heatJobPoints: score, heatSitePoints: score, heatBlogPoints: score, heatSocialPoints: score,
    heatRepostFactor: { kind: "number", min: 1, max: 10 }, heatWindowDays: { kind: "int", min: 1, max: 365 }, heatSaturation: { kind: "int", min: 1, max: 1000 },
    heatBurning: score, heatWarm: score, heatCool: score,
    growthWindowDays: { kind: "int", min: 1, max: 365 }, growthBlogPosts: { kind: "int", min: 1, max: 100 }, growthSocialProfiles: { kind: "int", min: 1, max: 20 },
  },
  values: (s) => ({
    points: { job: s.num("heatJobPoints"), site: s.num("heatSitePoints"), blog: s.num("heatBlogPoints"), social: s.num("heatSocialPoints") },
    repostFactor: s.num("heatRepostFactor"), windowDays: s.num("heatWindowDays"), saturation: s.num("heatSaturation"),
    labels: { burning: s.num("heatBurning"), warm: s.num("heatWarm"), cool: s.num("heatCool") },
    growth: { windowDays: s.num("growthWindowDays"), blogPosts: s.num("growthBlogPosts"), socialProfiles: s.num("growthSocialProfiles") },
  }),
});

export const HYGIENE_MODEL = modelPoint<HygieneModel>({
  id: "hygiene.policy", title: "Hygiene audit", reads: ["deal", "account", "contact"],
  description: "When a deal reads stale or closing soon, what every open deal must have, and which audit rules run.",
  settings: {
    hygieneStaleDealDays: { kind: "int", min: 1, max: 3650 }, hygieneClosingSoonDays: days, hygieneClosingSoonIdleDays: days,
    hygieneStaleHighDays: days, hygieneStaleMediumDays: days, hygieneFreshnessDays: { kind: "int", min: 1, max: 3650 },
    hygieneRequireDealOwner: { kind: "bool" }, hygieneRequireDealAccount: { kind: "bool" }, hygieneRequireDealAmount: { kind: "bool" },
    hygieneDisabledRules: { kind: "rules", options: AUDIT_RULE_IDS },
  },
  values: (s) => ({
    policy: {
      staleDealDays: s.num("hygieneStaleDealDays"), closingSoonDays: s.num("hygieneClosingSoonDays"), closingSoonIdleDays: s.num("hygieneClosingSoonIdleDays"),
      staleHighDays: s.num("hygieneStaleHighDays"), staleMediumDays: s.num("hygieneStaleMediumDays"), freshnessDays: s.num("hygieneFreshnessDays"),
      requireDealOwner: s.bool("hygieneRequireDealOwner"), requireAccountForDeal: s.bool("hygieneRequireDealAccount"), requireDealAmount: s.bool("hygieneRequireDealAmount"),
    },
    disabledRules: s.list("hygieneDisabledRules"),
  }),
});

const weight = { kind: "int", min: 0, max: 100 } as const;
const ranks = { kind: "ints", min: 0, max: 100, maxItems: 10 } as const;

export const FIT_MODEL = modelPoint<FitModel>({
  id: "scoring.fit", title: "ICP fit", reads: ["account", "contact", "icps"],
  description: "What an account inside a saved ICP earns for its industry, country and size, and who counts as its buyer.",
  settings: {
    // At least 1, so every gate's perfect match has points: the record service refuses a gate whose max is 0.
    fitBase: { ...weight, min: 1 }, fitIndustryWeights: ranks, fitCountryWeights: ranks,
    fitBandCentral: weight, fitBandInside: weight, fitBandAdjacent: weight, fitUnlistedBand: weight,
    fitBuyerLevels: { kind: "levels", options: LEVEL_IDS },
  },
  values: (s) => ({
    base: s.num("fitBase"), industryRanks: s.ints("fitIndustryWeights"), countryRanks: s.ints("fitCountryWeights"),
    bands: { central: s.num("fitBandCentral"), inside: s.num("fitBandInside"), adjacent: s.num("fitBandAdjacent") },
    unlistedBand: s.num("fitUnlistedBand"), buyerLevels: s.list("fitBuyerLevels"),
  }),
});

const phrases = { kind: "phrases" } as const;
const INSIGHT_SETTINGS: Record<CallInsightType, string> = {
  pain_point: "callPainPhrases", objection: "callObjectionPhrases", competitor_mention: "callCompetitorPhrases", next_step: "callNextStepPhrases",
  feature_request: "callFeaturePhrases", pricing: "callPricingPhrases", decision_criteria: "callCriteriaPhrases", risk: "callRiskPhrases", coaching_moment: "callFillerPhrases",
};

export const CALLS_MODEL = modelPoint<CallsModel>({
  id: "calls.model", title: "Calls", reads: ["deal", "contact", "account"],
  description: "What a call's next step, close date, opportunity and the people it names mean, and the words that mark each kind of call insight.",
  settings: { ...Object.fromEntries(Object.values(INSIGHT_SETTINGS).map((k) => [k, phrases])), callDefaultCloseDays: { kind: "int", min: 0, max: 365, fallback: 30 } },
  prose: CALL_DEFINITIONS.map((d) => `calls.${d}`),
  values: (s) => ({
    define: Object.fromEntries(CALL_DEFINITIONS.map((d) => [d, s.prose(`calls.${d}`)])) as CallsModel["define"],
    phrases: Object.fromEntries(Object.entries(INSIGHT_SETTINGS).map(([type, key]) => [type, s.text(key)])) as CallsModel["phrases"],
    defaultCloseDays: s.num("callDefaultCloseDays"),
  }),
});

export const ABM_MODEL = modelPoint<AbmModel>({
  id: "abm.model", title: "Target accounts", reads: ["account", "contact", "deal"],
  description: "What a target account's engagement score counts, and the score that reads as engaged.",
  settings: {
    abmOpenDealPoints: score, abmPipelinePerPoint: { ...cents, min: 1 }, abmPipelineMax: score,
    abmContactPoints: score, abmContactMax: score, abmOwnerPoints: score, abmWonPoints: score, abmEngaged: score,
  },
  values: (s) => ({
    points: {
      openDeal: s.num("abmOpenDealPoints"), pipelinePerPoint: s.num("abmPipelinePerPoint"), pipelineMax: s.num("abmPipelineMax"),
      contact: s.num("abmContactPoints"), contactMax: s.num("abmContactMax"), owner: s.num("abmOwnerPoints"), won: s.num("abmWonPoints"),
    },
    engaged: s.num("abmEngaged"),
  }),
});

export const NAV_MODEL = modelPoint<NavModel>({
  id: "workspace.nav", title: "Navigation", reads: [],
  description: "Which pages the sidebar shows, to everyone and to reps, and the page Canon opens on.",
  settings: { navHome: { kind: "choice", options: NAV_PAGES.slice(0, 12) }, navHidden: { kind: "rules", options: NAV_HIDEABLE }, navRepHidden: { kind: "rules", options: NAV_HIDEABLE } },
  values: (s) => ({ hidden: s.list("navHidden") as NavPage[], repHidden: s.list("navRepHidden") as NavPage[], home: s.text("navHome") as NavPage }),
});

export const MODEL_POINTS = {
  "forecast.model": FORECAST_MODEL,
  "health.model": HEALTH_MODEL,
  "scoring.lead": LEAD_MODEL,
  "signals.heat": HEAT_MODEL,
  "hygiene.policy": HYGIENE_MODEL,
  "scoring.fit": FIT_MODEL,
  "calls.model": CALLS_MODEL,
  "abm.model": ABM_MODEL,
  "workspace.nav": NAV_MODEL,
} as const;
export type ModelPointId = keyof typeof MODEL_POINTS;
export const MODEL_POINT_IDS = Object.keys(MODEL_POINTS) as ModelPointId[];
export const isModelPoint = (id: string): id is ModelPointId => Object.hasOwn(MODEL_POINTS, id);
/** The values a model point's surface reads. */
export type ModelValues<P extends ModelPointId> = (typeof MODEL_POINTS)[P] extends ModelPoint<infer V> ? V : never;

/** A model point's values from a recipe that contributes there, on `settings` (its defaults with a workspace's revision on top). */
export function modelValues<P extends ModelPointId>(recipe: Pick<RecipeDefinition, "id" | "models">, point: P, settings: Settings): ModelValues<P> {
  const part = recipe.models[point];
  if (!part) throw new Error(`${recipe.id} contributes nothing at ${point}`);
  return (MODEL_POINTS[point] as ModelPoint<ModelValues<P>>).values(settings, part);
}
