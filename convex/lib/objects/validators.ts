/**
 * Convex validators for the object layer's tables (docs/cp0-object-layer.md).
 * The shapes are owned by registry.ts and fold.ts; the type checks at the
 * bottom fail the build if a validator and its type drift apart.
 */
import { v, type Infer } from "convex/values";
import type { CustomObjectMeta, FieldValue, OrgObjectExtension, PicklistOption } from "./registry.ts";
import { FILTER_OPS } from "./listSpec.ts";
import { COMPUTED_TYPES, ROLLUP_FNS } from "./formula.ts";
import { MEASURE_FNS, REPORT_BUCKETS } from "./reportSpec.ts";
import type { EntryActor, EntryBody, EntrySource, Fact, FieldFold, FieldMeta, Lifecycle, Watermark } from "./fold.ts";

const sourceKind = v.union(
  v.literal("user"), v.literal("salesforce"), v.literal("hubspot"), v.literal("import"),
  v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("enrichment"), v.literal("pipeline"), v.literal("agent_run"), v.literal("canon_field"),
);

export const splitAllocation = v.object({ userId: v.string(), percentage: v.number(), kind: v.union(v.literal("revenue"), v.literal("overlay")) });
export const factValue = v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(splitAllocation));
export const partyFieldValue = v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()));
export const fieldValue = v.union(factValue, v.array(v.string()));

export const picklistOption = v.object({ value: v.string(), label: v.string(), active: v.boolean(), color: v.optional(v.string()) });

/** A custom field's rule (lib/objects/rules.ts). */
export const fieldRule = v.union(
  v.object({ kind: v.literal("pattern"), pattern: v.string(), message: v.string() }),
  v.object({ kind: v.literal("min"), value: v.number(), message: v.optional(v.string()) }),
  v.object({ kind: v.literal("max"), value: v.number(), message: v.optional(v.string()) }),
  v.object({ kind: v.literal("maxLength"), value: v.number(), message: v.optional(v.string()) }),
  v.object({ kind: v.literal("date"), when: v.union(v.literal("notPast"), v.literal("notFuture")), message: v.optional(v.string()) }),
  v.object({ kind: v.literal("oneOf"), values: v.array(v.string()), message: v.optional(v.string()) }),
);

/** A formula or rollup field's value type, and a rollup's source (lib/objects/formula.ts). */
export const computedType = v.union(...COMPUTED_TYPES.map((t) => v.literal(t)));
export const rollupDef = v.object({ object: v.string(), via: v.string(), fn: v.union(...ROLLUP_FNS.map((f) => v.literal(f))), field: v.optional(v.string()) });

const fieldCommon = {
  fieldId: v.string(),
  apiName: v.string(),
  label: v.string(),
  required: v.optional(v.boolean()),
  rules: v.optional(v.array(fieldRule)),
  unique: v.optional(v.boolean()),
  hidden: v.optional(v.boolean()),
  archivedAt: v.optional(v.number()),
};

export const customField = v.union(
  v.object({
    ...fieldCommon,
    type: v.union(
      v.literal("text"), v.literal("number"), v.literal("currency"), v.literal("date"), v.literal("datetime"), v.literal("checkbox"), v.literal("user"),
      v.literal("emails"), v.literal("phones"), v.literal("links"), v.literal("splits"),
    ),
  }),
  v.object({ ...fieldCommon, type: v.union(v.literal("picklist"), v.literal("multipicklist")), options: v.array(picklistOption) }),
  v.object({ ...fieldCommon, type: v.literal("lookup"), lookupTo: v.string() }),
  v.object({ ...fieldCommon, type: v.literal("formula"), formula: v.string(), returns: computedType, rollup: v.optional(rollupDef) }),
);

/** A standard object's own name in an org (registry.ts ObjectLabels). */
export const objectLabels = v.object({ label: v.string(), pluralLabel: v.string() });

/** A custom object's own definition on its `objectDefs` row (registry.ts CustomObjectMeta). */
export const customObjectMeta = v.object({
  label: v.string(), pluralLabel: v.string(), icon: v.string(), titleField: v.string(), archivedAt: v.optional(v.number()),
});

export const entrySource = v.object({ kind: sourceKind, ref: v.string() });
export const entryActor = v.union(
  v.object({ kind: v.union(v.literal("user"), v.literal("agent"), v.literal("integration"), v.literal("rule")), id: v.string() }),
  v.object({ kind: v.literal("unrecorded") }),
);

const assertion = v.object({
  fieldId: v.string(),
  value: fieldValue,
  validFrom: v.optional(v.number()),
  confidence: v.optional(v.number()),
  evidence: v.optional(v.string()),
});

export const fact = v.object({
  factId: v.string(),
  fieldId: v.string(),
  value: fieldValue,
  sourceKind,
  sourceRef: v.string(),
  observedAt: v.number(),
  validFrom: v.optional(v.number()),
  confidence: v.number(),
  evidence: v.optional(v.string()),
});

const observation = v.object({ sourceKind, sourceRef: v.string(), value: fieldValue, evidence: v.optional(v.string()) });

export const fieldFold = v.object({ candidates: v.array(fact), pending: v.array(fact), observed: v.array(observation) });

const mergedRecord = v.object({
  streamId: v.string(), recordId: v.string(), title: v.string(),
  values: v.array(v.object({ fieldId: v.string(), value: fieldValue, sourceKind: v.union(sourceKind, v.null()) })),
});

export const entryBody = v.union(
  v.object({ kind: v.literal("assert"), status: v.union(v.literal("accepted"), v.literal("proposed")), assertions: v.array(assertion), createdAt: v.optional(v.number()), partial: v.optional(v.literal(true)) }),
  v.object({ kind: v.literal("decide"), decisions: v.array(v.object({ fact, status: v.union(v.literal("accepted"), v.literal("rejected")) })) }),
  v.object({ kind: v.literal("lifecycle"), op: v.union(v.literal("create"), v.literal("delete"), v.literal("restore"), v.literal("erase")) }),
  v.object({ kind: v.literal("lifecycle"), op: v.literal("merge"), into: v.string() }),
  v.object({ kind: v.literal("lifecycle"), op: v.literal("absorb"), mergeId: v.string(), from: v.array(mergedRecord) }),
  v.object({ kind: v.literal("confirm"), fieldIds: v.array(v.string()), validFrom: v.optional(v.number()) }),
  v.object({ kind: v.literal("revert"), mergeId: v.string(), fields: v.array(v.object({ fieldId: v.string(), fold: v.union(fieldFold, v.null()) })) }),
);

const filterScalar = v.union(v.string(), v.number(), v.boolean());

export const listFilter = v.object({
  field: v.string(),
  op: v.union(...FILTER_OPS.map((op) => v.literal(op))),
  value: v.optional(v.union(filterScalar, v.array(filterScalar))),
});

export const listSort = v.object({ field: v.string(), dir: v.union(v.literal("asc"), v.literal("desc")) });

/** A saved list view: what it filters and sorts by, which columns it shows, and whether it is a table or a board. */
export const viewSpec = v.object({
  filter: v.array(listFilter),
  sort: v.optional(listSort),
  columns: v.array(v.string()),
  layout: v.union(v.literal("table"), v.literal("board")),
  /** A board's column field: a picklist apiName. */
  groupBy: v.optional(v.string()),
});

/** `bar` draws horizontal bars, `column` vertical ones (side by side, or stacked), `area` a filled line. */
export const REPORT_CHARTS = ["table", "bar", "column", "line", "area", "pie", "number"] as const;
export type ReportChart = (typeof REPORT_CHARTS)[number];

/** A saved report (CP9): an object's filters as a list view stores them, its group keys and measures (lib/objects/reportSpec.ts), and how it is drawn. */
export const reportSpec = v.object({
  object: v.string(),
  filter: v.array(listFilter),
  groupBy: v.array(v.object({
    field: v.string(),
    /** A lookup of the object (or a contact's `accountId`): the key reads the related record's field. */
    via: v.optional(v.string()),
    bucket: v.optional(v.union(...REPORT_BUCKETS.map((b) => v.literal(b)))),
  })),
  /**
   * What each group adds up to: `fn` over `field`, or `pctTrue`, the share of rows where a yes/no `field` is true.
   * `label` names it ("Pipeline"); `where` filters the rows only this metric reads (open deals for Pipeline), as
   * convex/lib/objects/metricSplit.ts answers it.
   */
  measures: v.array(v.object({
    fn: v.union(...[...MEASURE_FNS, "pctTrue" as const].map((f) => v.literal(f))),
    field: v.optional(v.string()),
    label: v.optional(v.string()),
    where: v.optional(v.array(listFilter)),
    /** Shown beside its total over the period just before the report's date range (src/lib/period-compare.ts). */
    compare: v.optional(v.literal("prev")),
  })),
  chart: v.union(...REPORT_CHARTS.map((c) => v.literal(c))),
  /** Whose records it reads, for whoever opens it: the viewer's own, or their team's (src/lib/report-scope.ts). */
  whose: v.optional(v.union(v.literal("me"), v.literal("team"))),
  /**
   * How a chart draws its values: `stacked` columns or areas, and per value (in order) its `axes` (`right`: a second
   * axis, a percent beside money) and `types` (a column chart's value drawn as a line over the bars).
   */
  display: v.optional(v.object({
    stacked: v.optional(v.boolean()),
    axes: v.optional(v.array(v.union(v.literal("left"), v.literal("right")))),
    types: v.optional(v.array(v.union(v.literal("bar"), v.literal("line")))),
    /** Per value: shown as its share of the total, a percent ("% of Reps"). */
    shares: v.optional(v.array(v.boolean())),
    /**
     * Its look, as Looker Studio's Style tab: a `palette` of the theme's hues, data `labels` on the marks, the
     * `legend`'s place, `grid` lines, and for a table `rowNumbers` and a `heatmap` of its metrics.
     */
    palette: v.optional(v.union(v.literal("canon"), v.literal("greens"), v.literal("cool"), v.literal("warm"))),
    labels: v.optional(v.boolean()),
    legend: v.optional(v.union(v.literal("top"), v.literal("bottom"), v.literal("none"))),
    grid: v.optional(v.boolean()),
    rowNumbers: v.optional(v.boolean()),
    heatmap: v.optional(v.boolean()),
  })),
});
export type ReportSpec = Infer<typeof reportSpec>;

/** A list filter as Convex carries it: a value is a scalar or a list of them. */
export type ViewFilter = Infer<typeof listFilter>;
export type ViewSpec = Infer<typeof viewSpec>;

export const watermark = v.object({ sourceKind, sourceRef: v.string(), validFrom: v.number() });

export const lifecycle = v.union(
  v.object({ status: v.literal("active") }),
  v.object({ status: v.literal("deleted"), at: v.number() }),
  v.object({ status: v.literal("merged"), at: v.number(), into: v.string() }),
  v.object({ status: v.literal("erased"), at: v.number() }),
);

export const fieldMeta = v.object({
  state: v.union(v.literal("resolved"), v.literal("contested"), v.literal("empty")),
  factId: v.union(v.string(), v.null()),
  sourceKind: v.union(sourceKind, v.null()),
});

// Each line fails to compile when a validator and its domain type disagree, in either direction.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** A domain type as a document stores it: brands dropped, arrays mutable. */
export type Stored<T> = T extends string & { readonly __brand: string } ? string
  : T extends readonly (infer U)[] ? Stored<U>[]
  : T extends object ? { -readonly [K in keyof T]: Stored<T[K]> }
  : T;
const sameShape = <T extends true>(): T | undefined => undefined;
sameShape<Same<Infer<typeof fieldValue>, Stored<FieldValue>>>();
sameShape<Same<Infer<typeof picklistOption>, Stored<PicklistOption>>>();
sameShape<Same<Infer<typeof entrySource>, Stored<EntrySource>>>();
sameShape<Same<Infer<typeof entryActor>, Stored<EntryActor>>>();
sameShape<Same<Infer<typeof lifecycle>, Stored<Lifecycle>>>();
sameShape<Same<Infer<typeof fieldMeta>, Stored<FieldMeta>>>();
sameShape<Same<Infer<typeof fact>, Stored<Fact>>>();
sameShape<Same<Infer<typeof entryBody>, Stored<EntryBody>>>();
sameShape<Same<Infer<typeof fieldFold>, Stored<FieldFold>>>();
sameShape<Same<Infer<typeof watermark>, Stored<Watermark>>>();
sameShape<Same<Infer<typeof customObjectMeta>, Stored<CustomObjectMeta>>>();
sameShape<Same<Infer<typeof customField>,Stored<OrgObjectExtension["customFields"][number]>>>();

/** Read a stored shape back as its domain type; the checks above prove they differ only in brands and readonly. */
export const fromStored = <T>(value: Stored<T>): T => value as unknown as T;
export const toStored = <T>(value: T): Stored<T> => value as unknown as Stored<T>;
