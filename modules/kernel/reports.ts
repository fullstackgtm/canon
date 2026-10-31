/**
 * Module reports (docs/modules.md, "Reports and charts"): what a collection's `report` declares, read as Canon's
 * reports read an object. Each dimension and measure is a field of the collection, typed from its schema: a choice
 * by its labels, a member, a deal, team or doc ref (shown by what it names), true/false, a number (money and times by
 * their hints) or text (a date by its hint). Pure: Convex, the browser and tests import it.
 */
import type { AggregateRead, CollectionDecl, ModuleManifest, ReportReadFilter, RowWhere } from "./manifest.ts";
import type { AggregateReadValue } from "./calls.ts";
import { choiceLabels, coreOf, literalChoices, type FieldSpec, type RefTo } from "./schema.ts";
import type { ModuleFieldType, ModuleReportField } from "../../convex/lib/objects/moduleReport.ts";
import { listColumns, listViewDef, ListRequestError } from "../../convex/lib/objects/listSpec.ts";
import { ACTIVITY_OBJECT, activityReportDef, groupableField, measurableField, relationsOf, type ReportGroup, type ReportMeasure } from "../../convex/lib/objects/reportSpec.ts";
import { isCustomObjectName, resolveObjectDef, STANDARD_OBJECTS, type ResolvedObjectDef, type StandardObjectName } from "../../convex/lib/objects/registry.ts";
import type { ListFilter } from "../../convex/lib/objects/listSpec.ts";

/**
 * A collection's report: the fields a report groups and filters by, and the number fields it sums. `members`: a member
 * ref among its dimensions whose member each doc's measures roll onto in a report over Canon's members: a rep's visits'
 * minutes summed on their row ("Visits: Minutes"), as the caller reads the docs.
 */
export type ReportDecl = { dimensions: readonly string[]; measures?: readonly string[]; members?: string; memberLatest?: MemberLatest };
/**
 * Dimensions a collection whose report rolls onto members (`members`) also puts on them: each member's value of each
 * of `fields` is the one on their latest doc, the doc with the greatest `by` (a date, time or text dimension), among
 * the docs `where` keeps (at most 5 filters over its own dimensions) and, with `upTo: "today"`, whose `by` is not
 * after today. A member with no such doc has none. Two latest docs that disagree give the value more of them hold.
 */
export type MemberLatest = { by: string; fields: readonly string[]; upTo?: "today"; where?: ReadonlyArray<{ field: string; op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "empty" | "notEmpty"; value?: string | number | boolean | ReadonlyArray<string | number | boolean> }> };
export const MAX_DIMENSIONS = 20;
export const MAX_MEASURES = 10;

/**
 * A report field as a page shows it: its type, and for a ref, what it names (its labels come with the result). A
 * joined dimension (`deal.stage`, `rep.team`) groups by a field of what a ref names: `join` says which.
 */
export type ReportField = ModuleReportField & { ref?: { to: RefTo; collection?: string }; join?: ReportJoin; rollup?: MemberRollup; related?: RelatedField };
/**
 * A Canon record's field read through one of its lookups (a person's company's industry): the record service follows
 * `via` and groups by the related record's `field`, as Canon's own report builder does. It groups, it doesn't filter.
 */
export type RelatedField = { via: string; field: string };
/**
 * A member field of a Canon members report from a module collection: its docs' `field` per member `member` names, summed,
 * or with `latest`, the value on the member's latest doc (`report.memberLatest`).
 */
export type MemberRollup = { collection: string; field: string; member: string; latest?: Omit<MemberLatest, "fields"> };
/** A joined dimension: the ref field `via`, what it names, and the field of that record a report groups by. */
export type ReportJoin = { via: string; field: string; to: RefTo; collection?: string };

/**
 * The fields of a deal, a member, a team, a company or a person a report may group by, with their types. A member's
 * `team` is the first team, by name, that they belong to or manage.
 */
export const JOINED_FIELDS: Record<Exclude<RefTo, "doc">, Record<string, ModuleFieldType>> = {
  deals: { name: "text", stage: "text", dealType: "text", revenueType: "text", forecastCategory: "text", ownerId: "user", closeDate: "date", isWon: "checkbox", isClosed: "checkbox", currency: "text", crmProvider: "text" },
  users: { name: "text", managerId: "user", title: "text", department: "text", role: "text", isActive: "checkbox", team: "text" },
  senders: { name: "text", address: "text", status: "text", ownerId: "user" },
  teams: { name: "text", managerId: "user" },
  companies: { name: "text", industry: "text", country: "text", city: "text", status: "text", ownerId: "user" },
  people: { name: "text", title: "text", lifecycleStage: "text", ownerId: "user" },
};

const JOINED_LABELS: Record<string, string> = { isActive: "Active", managerId: "Manager", ownerId: "Owner", isWon: "Won", isClosed: "Closed", dealType: "Deal type", closeDate: "Close date", lifecycleStage: "Lifecycle stage" };

/**
 * A joined dimension `<ref>.<field>` of a collection, checked: the ref field, and a field of what it names that a
 * report groups by (a deal's or a member's only as the install grants it; a doc's, one of its own). Else why not.
 */
export function joinedDimension(m: Pick<ModuleManifest, "collections" | "reads">, c: CollectionDecl, name: string): (ReportJoin & { type: ModuleFieldType }) | string {
  const [via, field] = name.split(".");
  const spec = c.schema.value[via];
  const core = spec ? coreOf(spec.fieldType) : null;
  if (!core || core.type !== "ref") return `${via} is not a ref field`;
  if (core.to === "doc") {
    const target = m.collections[core.collection ?? ""]?.schema.value[field];
    const t = target ? reportType(target) : null;
    return t && !t.ref ? { via, field, to: "doc", collection: core.collection, type: t.type } : `${field} is not a field of ${core.collection} a report groups by`;
  }
  const type = JOINED_FIELDS[core.to][field];
  if (!type) return `a ${core.to === "people" ? "person" : core.to === "companies" ? "company" : core.to.replace(/s$/, "")}'s ${field} is not a field a report groups by`;
  const granted = core.to === "senders" ? ((m.reads?.senders ?? []) as readonly string[]).includes(field) : core.to === "teams" ? true : field === "name" || (core.to === "users" && field === "team") || ((m.reads?.[core.to] ?? []) as readonly string[]).includes(field);
  return granted ? { via, field, to: core.to, type } : `reads.${core.to} doesn't grant ${field}`;
}

/** A field's report type, or null for a shape no report reads (a list, an object). */
export function reportType(spec: FieldSpec): { type: ModuleFieldType; ref?: { to: RefTo; collection?: string } } | null {
  const core = coreOf(spec.fieldType);
  if (literalChoices(core)?.every((v) => typeof v === "string")) return { type: "picklist" };
  switch (core.type) {
    case "string": return { type: spec.widget === "date" ? "date" : "text" };
    case "number": return { type: spec.widget === "money" ? "currency" : spec.widget === "time" ? "datetime" : "number" };
    case "boolean": return { type: "checkbox" };
    case "ref": return core.to === "users" ? { type: "user" } : { type: "text", ref: { to: core.to, ...(core.collection ? { collection: core.collection } : {}) } };
    default: return null;
  }
}

const labelOf = (name: string, spec: FieldSpec) => spec.label ?? name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

/** The fields of a collection's report, dimensions then measures, each once. Empty when it declares none. */
export function reportFields(c: CollectionDecl | undefined, m?: Pick<ModuleManifest, "collections" | "reads">): ReportField[] {
  if (!c?.report) return [];
  const names = [...new Set([...c.report.dimensions, ...(c.report.measures ?? [])])];
  return names.flatMap((name): ReportField[] => {
    if (name.includes(".")) {
      const j = m ? joinedDimension(m, c, name) : null;
      if (!j || typeof j === "string") return [];
      const viaSpec = c.schema.value[j.via];
      const { type, ...join } = j;
      const field = JOINED_LABELS[j.field] ?? labelOf(j.field, { fieldType: { type: "string" }, optional: true });
      return [{ name, label: `${labelOf(j.via, viaSpec)}: ${field}`, type, join }];
    }
    const spec = c.schema.value[name];
    const t = spec ? reportType(spec) : null;
    if (!spec || !t) return [];
    const labels = choiceLabels(coreOf(spec.fieldType)) ?? {};
    const options = t.type === "picklist" ? (literalChoices(coreOf(spec.fieldType)) as string[]).map((v) => ({ value: v, label: labels[v] ?? v })) : undefined;
    return [{ name, label: labelOf(name, spec), type: t.type, ...(options ? { options } : {}), ...(t.ref ? { ref: t.ref } : {}) }];
  });
}

/**
 * Canon's own records a module report reads as a source (docs/modules.md, "Reports and charts"): deals, members
 * and ledger stage history, each as the caller sees them. A builder names one in `sources`, a chart or a call's
 * report read as its `collection`.
 */
export const CANON_SOURCES = { "canon.deals": "Deals", "canon.members": "Team", "canon.stageHistory": "Stage history" } as const;
export type CanonSource = keyof typeof CANON_SOURCES;
export const isCanonSource = (s: string): s is CanonSource => Object.hasOwn(CANON_SOURCES, s);
/** A deal's amount weighted by its probability: the record service sums `amount` weighted by `probability`. */
export const WEIGHTED_AMOUNT = "weightedAmount";
/** A deal's account by name: Canon groups by the name of the company the deal's `companyId` names. It groups, never filters. */
export const DEAL_ACCOUNT = "companyName";
/** Whether a report field only groups (an account, a related record's field) or only sums (a weighted amount): a builder offers no filter on it. */
export const unfilterable = (f: Pick<ReportField, "name" | "related">) => f.name === WEIGHTED_AMOUNT || f.name === DEAL_ACCOUNT || f.related !== undefined;

/** A Canon source's own fields: name, label, type, and the fields of its read grant it needs. */
const CANON_SOURCE_FIELDS: Record<CanonSource, ReadonlyArray<readonly [string, string, ModuleFieldType, readonly string[]]>> = {
  "canon.deals": [
    ["ownerId", "Owner", "user", ["ownerId"]], [DEAL_ACCOUNT, "Account", "text", ["companyName"]], ["stage", "Stage", "picklist", ["stage"]], ["dealType", "Deal type", "picklist", ["dealType"]],
    ["forecastCategory", "Forecast category", "picklist", ["forecastCategory"]], ["closeDate", "Close date", "date", ["closeDate"]],
    ["isWon", "Won", "checkbox", ["isWon"]], ["isClosed", "Closed", "checkbox", ["isClosed"]], ["currency", "Currency", "text", ["currency"]],
    ["amount", "Amount", "currency", ["amount"]], ["probability", "Probability", "number", ["probability"]],
    [WEIGHTED_AMOUNT, "Weighted amount", "currency", ["amount", "probability"]],
  ],
  "canon.stageHistory": [
    ["deal", "Deal", "text", ["deal"]], ["stage", "To stage", "picklist", ["stage"]], ["fromStage", "From stage", "picklist", ["fromStage"]],
    ["changedAt", "Changed at", "datetime", ["changedAt"]], ["leftAt", "Left at", "datetime", ["leftAt"]],
    ["daysInStage", "Days in stage (finished)", "number", ["daysInStage"]], ["daysSoFar", "Days in stage so far", "number", ["daysSoFar"]],
    ["current", "In stage now", "checkbox", ["current"]], ["ownerId", "Owner", "user", ["ownerId"]],
  ],
  "canon.members": [
    ["member", "Member", "user", []], ["team", "Team", "text", []], ["role", "Role", "text", ["role"]], ["title", "Title", "text", ["title"]],
    ["department", "Department", "text", ["department"]], ["managerId", "Manager", "user", ["managerId"]], ["isActive", "Active", "checkbox", ["isActive"]],
    ["startDate", "Start date", "date", ["startDate"]],
  ],
};

/**
 * The fields of a Canon source a module's report reads: those whose Canon fields the install grants, and for deals,
 * the owner's member fields (`ownerId.team`, `ownerId.managerId`) as a deal ref's joined ones are. Empty when the
 * module reads none of it.
 */
export function canonSourceFields(m: Pick<ModuleManifest, "reads"> & Partial<Pick<ModuleManifest, "collections">>, source: CanonSource): ReportField[] {
  const granted = new Set<string>(source === "canon.stageHistory" ? m.reads?.stageHistory ?? [] : source === "canon.deals" ? m.reads?.deals ?? [] : m.reads?.users ?? []);
  if (source === "canon.members" && !m.reads?.users) return [];
  const own = CANON_SOURCE_FIELDS[source].filter(([, , , needs]) => needs.every((f) => granted.has(f))).map(([name, label, type]): ReportField => ({ name, label, type }));
  if (source === "canon.members") return [...own, ...memberRollups(m)];
  if (source !== "canon.deals" || !granted.has("ownerId")) return own;
  const users = new Set<string>(m.reads?.users ?? []);
  const joined = Object.entries(JOINED_FIELDS.users).filter(([f]) => f === "team" || (f !== "name" && users.has(f))).map(([field, type]): ReportField => (
    { name: `ownerId.${field}`, label: `Owner: ${JOINED_LABELS[field] ?? labelOf(field, { fieldType: { type: "string" }, optional: true })}`, type, join: { via: "ownerId", field, to: "users" } }));
  return [...own, ...joined];
}

/**
 * Every Canon object as a report source (docs/modules.md, "Reports and charts"), granted by `reads.records`: each
 * source and the Canon object it reads. A custom object is `canon.custom_<slug>`. `canon.deals` reads deals this way
 * only when `reads.records` grants them; without it, it is the fixed deal palette `reads.deals` grants.
 */
export const RECORD_SOURCES = {
  "canon.deals": "deal", "canon.companies": "account", "canon.people": "contact", "canon.leads": "lead", "canon.activities": ACTIVITY_OBJECT,
  "canon.tasks": "task", "canon.calls": "call", "canon.meetings": "meeting", "canon.notes": "note", "canon.products": "product",
} as const;
export function reportSource(object: string): string | null {
  return Object.entries(RECORD_SOURCES).find(([, name]) => name === object)?.[0]
    ?? (isCustomObjectName(object) ? `canon.${object}` : recordObjectName(object) ? object : null);
}

/** What `reads.records` lists: a source's name without `canon.`, a custom object's apiName, or `*` for every object. */
export const RECORD_GRANTS = Object.keys(RECORD_SOURCES).map((s) => s.slice("canon.".length));
export const RECORD_GRANT = /^(\*|deals|companies|people|leads|activities|tasks|calls|meetings|notes|products|custom_[a-z][a-z0-9_]{0,39})$/;
/** A report builder's `sources` entry for every Canon object the module may report on, the workspace's custom ones too. */
export const EVERY_CANON_SOURCE = "canon.*";

/** The Canon object a source reads, granted or not: a registered one, or a custom object's apiName. Null for any other name. */
export function recordObjectName(source: string): string | null {
  if (Object.hasOwn(RECORD_SOURCES, source)) return RECORD_SOURCES[source as keyof typeof RECORD_SOURCES];
  const name = source.startsWith("canon.") ? source.slice("canon.".length) : "";
  return isCustomObjectName(name) ? name : null;
}
/** The Canon object a source reads when the module's `reads.records` grants it, else null. */
export function recordObjectOf(m: Pick<ModuleManifest, "reads">, source: string): string | null {
  const records = m.reads?.records;
  const object = records ? recordObjectName(source) : null;
  return object && (records!.includes("*") || records!.includes(source.slice("canon.".length))) ? object : null;
}
/** A custom object's source name: `canon.custom_<slug>`. */
export const customSource = (apiName: string) => `canon.${apiName}`;

/**
 * A builder's sources with `canon.*` put as every Canon source the page has a palette for, in Canon's order (deals,
 * companies, people, leads, activities and their kinds, products, the team, stage history, then custom objects by name), each once.
 */
export function expandSources(sources: readonly string[], available: readonly string[]): string[] {
  const order = [...Object.keys(RECORD_SOURCES), "canon.members", "canon.stageHistory"];
  const canon = available.filter((s) => order.includes(s)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const custom = available.filter((s) => recordObjectName(s) !== null && !order.includes(s)).sort();
  return [...new Set(sources.flatMap((s) => (s === EVERY_CANON_SOURCE ? [...canon, ...custom] : [s])))];
}

const RECORD_SYSTEM_LABELS: Record<string, string> = { recordTitle: "Name", createdAt: "Created", updatedAt: "Last modified" };

/** A Canon field's report type, from its list column and its definition. */
function recordFieldType(def: ResolvedObjectDef, name: string): ModuleFieldType {
  const col = listColumns(def).get(name)!;
  const f = def.byApiName.get(name);
  const type = f?.type === "formula" ? f.returns : f?.type;
  if (type === "picklist" || type === "user" || type === "currency" || type === "date") return type;
  if (col.kind === "checkbox") return "checkbox";
  if (col.kind === "date") return "date";
  if (col.kind === "number") return measurableField(def, name) ? "number" : "datetime";
  return "text";
}

/** One field of a Canon object as a report field: its label, type and a picklist's options with the workspace's labels. */
function recordField(def: ResolvedObjectDef, name: string): ReportField {
  const f = def.byApiName.get(name);
  const type = recordFieldType(def, name);
  const options = f && "options" in f && type === "picklist" ? f.options.map((o) => ({ value: o.value, label: o.label })) : undefined;
  return { name, label: RECORD_SYSTEM_LABELS[name] ?? f?.label ?? name, type, ...(options ? { options } : {}) };
}

/**
 * What a report over a Canon object offers, as Canon's report builder offers it (src/components/reports/report-builder.tsx):
 * the fields it groups by (lookups left out, to be followed instead; a company's or person's created date left out, as it
 * reads as last modified) and the number fields it sums, then each lookup's related record's fields, named
 * `<via>.<field>` and labelled `<lookup>: <field>`. `def` is the object's list definition; `related` gives a related
 * object's. `hidden` gives the fields of an object the caller's role hides (CP14): they are not offered. Deals add the
 * account (`companyName`) and a weighted amount, as the fixed deal palette has them.
 */
export function recordReportFields(object: string, def: ResolvedObjectDef, related: (object: string) => ResolvedObjectDef | null | undefined, hidden: (object: string) => ReadonlySet<string> = () => new Set()): ReportField[] {
  const register = object === "account" || object === "contact";
  const groupable = (d: ResolvedObjectDef, n: string, onRegister: boolean) =>
    groupableField(d, n) && !(onRegister && n === "createdAt") && d.byApiName.get(n)?.type !== "lookup" && !d.byApiName.get(n)?.hidden && !hidden(d.apiName).has(n);
  const names = [...listColumns(def).keys()];
  const own = names.filter((n) => groupable(def, n, register) || (measurableField(def, n) && !hidden(object).has(n))).map((n) => recordField(def, n));
  const extra: ReportField[] = [];
  if (object === "deal") {
    const shown = (n: string) => listColumns(def).has(n) && !hidden("deal").has(n);
    if (shown("companyId")) extra.push({ name: DEAL_ACCOUNT, label: "Account", type: "text" });
    if (shown("amount") && shown("probability")) extra.push({ name: WEIGHTED_AMOUNT, label: "Weighted amount", type: "currency" });
  }
  const joined = relationsOf(object, def).filter((r) => r.via === "accountId" || !hidden(object).has(r.via)).flatMap((r) => {
    const d = related(r.object);
    if (!d) return [];
    return [...listColumns(d).keys()].filter((n) => groupable(d, n, r.object === "account" || r.object === "contact"))
      .map((n): ReportField => ({ ...recordField(d, n), name: `${r.via}.${n}`, label: `${r.label}: ${RECORD_SYSTEM_LABELS[n] ?? d.byApiName.get(n)?.label ?? n}`, related: { via: r.via, field: n } }));
  });
  return [...own, ...extra, ...joined];
}

/** A Canon object's list definition as every workspace has it, before an admin adds a field: null for a custom object. */
export function standardListDef(object: string): ResolvedObjectDef | null {
  if (object === ACTIVITY_OBJECT) return activityReportDef();
  return Object.hasOwn(STANDARD_OBJECTS, object) ? listViewDef(object, resolveObjectDef(STANDARD_OBJECTS[object as StandardObjectName])) : null;
}

/** The fields of a Canon source every workspace has, which a manifest's declared report is checked against. Null for a custom object. */
export function standardRecordFields(object: string): ReportField[] | null {
  const def = standardListDef(object);
  return def ? recordReportFields(object, def, standardListDef) : null;
}

/** What Canon's report engine reads for a module's report over a Canon object (convex/reports.ts `run`). */
export type CanonReportRequest<F extends ListFilter = ListFilter> = { filter: F[]; groupBy: ReportGroup[]; measures: ReportMeasure[] };
/**
 * A module report's spec over a Canon object as Canon's report engine reads it: each field one the caller is offered
 * (`fields`, so a hidden one is refused), a related record's field followed through its lookup, the account through the
 * deal's company, a weighted amount as the amount weighted by its probability. Throws ListRequestError, in words.
 */
export function canonReportRequest<F extends ListFilter>(spec: { filter: readonly F[]; groupBy: readonly ReportGroup[]; measures: readonly { fn: ReportMeasure["fn"]; field?: string }[] }, fields: readonly ReportField[], title: string): CanonReportRequest<F> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const known = (name: string) => {
    // Every record's created and modified times, as every report object has them (a builder's date range falls back to Created).
    const f = byName.get(name) ?? (name === "createdAt" || name === "updatedAt" ? { name, label: RECORD_SYSTEM_LABELS[name], type: "datetime" as const } : undefined);
    if (!f) throw new ListRequestError(`${name} is not a field of ${title} you can report on`);
    return f;
  };
  for (const x of spec.filter) if (unfilterable(known(x.field))) throw new ListRequestError(`${known(x.field).label} groups ${title.toLowerCase()}, it doesn't filter them: group by it instead`);
  const groupBy = spec.groupBy.map((g): ReportGroup => {
    if (g.via) {
      if (!fields.some((f) => f.related?.via === g.via && f.related?.field === g.field)) throw new ListRequestError(`${g.via}.${g.field} is not a related field of ${title} you can report on`);
      return { ...g };
    }
    const f = known(g.field);
    const bucket = g.bucket ? { bucket: g.bucket } : {};
    if (f.name === DEAL_ACCOUNT) return { field: "name", via: "companyId" };
    return f.related ? { field: f.related.field, via: f.related.via, ...bucket } : { field: f.name, ...bucket };
  });
  const measures = spec.measures.map((m): ReportMeasure => {
    if (m.field === undefined) return { fn: m.fn };
    known(m.field);
    return m.field === WEIGHTED_AMOUNT ? { fn: m.fn, field: "amount", weight: "probability" } : { fn: m.fn, field: m.field };
  });
  return { filter: [...spec.filter], groupBy, measures };
}

/** The name a member rollup goes by in a members report: `<collection>__<field>`. */
export const rollupName = (collection: string, field: string) => `${collection}__${field}`;
/** Each measure of a collection whose report rolls onto members, as a members report's number field. */
function memberRollups(m: Partial<Pick<ModuleManifest, "collections">>): ReportField[] {
  return Object.entries(m.collections ?? {}).flatMap(([name, c]) => {
    if (!c.report?.members) return [];
    const of = c.label ?? labelOf(name, { fieldType: { type: "string" }, optional: true });
    const fields = reportFields(c);
    const sums = fields.filter((f) => isMeasure(f) && !f.ref && c.report!.measures?.includes(f.name))
      .map((f): ReportField => ({ name: rollupName(name, f.name), label: `${of}: ${f.label}`, type: f.type, rollup: { collection: name, field: f.name, member: c.report!.members! } }));
    const latest = c.report.memberLatest;
    if (!latest) return sums;
    const { fields: picked, ...rule } = latest;
    const dims = picked.flatMap((p) => fields.filter((f) => f.name === p && !f.ref && !f.join))
      .map((f): ReportField => ({ ...f, name: latestName(name, f.name), label: `${of} (latest): ${f.label}`, rollup: { collection: name, field: f.name, member: c.report!.members!, latest: rule } }));
    return [...sums, ...dims];
  });
}
/** The name a member's latest value of a collection's dimension goes by in a members report: `<collection>__latest_<field>`. */
export const latestName = (collection: string, field: string) => `${collection}__latest_${field}`;

/**
 * Each member's latest value of a dimension (`report.memberLatest`) from groups by member, `by` and the dimension, with
 * their counts: the value on the member's greatest `by`; when the docs there disagree, the value more of them hold,
 * then the lowest. Pure: Convex runs it on a report's groups, tests on their own.
 */
export function latestByMember(groups: ReadonlyArray<{ keys: ReadonlyArray<unknown>; values: ReadonlyArray<number | null> }>): Record<string, string | number | boolean | null> {
  const best = new Map<string, { by: string | number; value: unknown; count: number }>();
  const rank = (x: unknown) => (typeof x === "number" ? x : String(x ?? ""));
  for (const g of groups) {
    const [member, by, value] = g.keys;
    if (typeof member !== "string" || by === null || by === undefined) continue;
    const at = rank(by), count = g.values[0] ?? 0, was = best.get(member);
    const later = !was || at > was.by;
    const tie = was && at === was.by && (count > was.count || (count === was.count && String(value ?? "") < String(was.value ?? "")));
    if (later || tie) best.set(member, { by: at, value, count });
  }
  return Object.fromEntries([...best].map(([m, b]) => [m, (b.value ?? null) as string | number | boolean | null]));
}

/**
 * The fields a report over `collection` reads: a module collection's report, or a Canon source's. A Canon object the
 * module reads through `reads.records` gives the fields every workspace has (its own add more at run time); a custom
 * object, which no manifest can know, gives null.
 */
export function sourceFields(m: Pick<ModuleManifest, "collections" | "reads">, collection: string): ReportField[] | null {
  const object = recordObjectOf(m, collection);
  if (object) return standardRecordFields(object);
  return isCanonSource(collection) ? canonSourceFields(m, collection) : reportFields(m.collections[collection], m);
}
/** Whether the module may report on a Canon source at all: a record source `reads.records` grants, or deals or members its reads grant. */
export const grantsSource = (m: Pick<ModuleManifest, "collections" | "reads">, source: string) =>
  recordObjectOf(m, source) !== null || (isCanonSource(source) && canonSourceFields(m, source).length > 0);
/** Whether a report builder reads `source`: its collection, one of its sources, or a Canon one `canon.*` stands for. */
export const reportReads = (m: Pick<ModuleManifest, "collections" | "reads">, n: { collection: string; sources?: readonly string[] }, source: string) =>
  n.collection === source || (n.sources ?? []).includes(source) || ((n.sources ?? []).includes(EVERY_CANON_SOURCE) && source.startsWith("canon.") && grantsSource(m, source));

/** Whether a report field is one a measure sums. */
export const isMeasure = (f: Pick<ModuleReportField, "type">) => f.type === "number" || f.type === "currency";

/** The collections a row condition reads besides its own: each `ref`'s. */
function whereCollections(m: ModuleManifest, collection: string, w: RowWhere, out: Set<string>) {
  if ("all" in w) return w.all.forEach((x) => whereCollections(m, collection, x, out));
  if (!("ref" in w)) return;
  const spec = m.collections[collection]?.schema.value[w.ref];
  const core = spec ? coreOf(spec.fieldType) : null;
  const target = w.collection ?? (core?.type === "ref" && core.to === "doc" ? core.collection : undefined);
  if (!target || !m.collections[target]) return;
  out.add(target);
  whereCollections(m, target, w.where, out);
}

/**
 * The collections Canon projects into the record service: each one with a report or activity, and every collection their read
 * scopes read (a set's parent, a related doc a condition tests), so the service can judge a scope on its own.
 */
export function projectedCollections(m: ModuleManifest): Set<string> {
  const out = new Set<string>();
  const add = (name: string) => {
    if (out.has(name) || !m.collections[name]) return;
    out.add(name);
    const c = m.collections[name];
    if (c.setOf) add(c.setOf.parent);
    for (const scope of Object.values(c.access)) {
      if (typeof scope === "string" || !scope || "members" in scope) continue;
      const reads = new Set<string>();
      whereCollections(m, name, "where" in scope ? scope.where : scope.or, reads);
      reads.forEach(add);
    }
  };
  for (const [name, c] of Object.entries(m.collections)) if (c.report || c.activity) add(name);
  return out;
}

/** A team aggregate as Canon runs it: the read, its filter's values computed from the call, and its collection's owner field. */
export type AggregateSpec = { collection: string; owner: string; values: AggregateRead["values"]; filter: Array<{ field: string; op: ReportReadFilter["op"]; value?: string | number | boolean | Array<string | number | boolean> }>; minOwners: number };

/** What Canon asks the record service for a team aggregate: a count, then a sum of each field its values name, by owner. */
export function aggregateMeasures(spec: Pick<AggregateSpec, "values">): Array<{ fn: "count" } | { fn: "sum"; field: string }> {
  const fields = [...new Set(spec.values.flatMap((v) => (v.fn !== "count" && v.field ? [v.field] : [])))];
  return [{ fn: "count" }, ...fields.map((field) => ({ fn: "sum" as const, field }))];
}

/**
 * A team aggregate folded from its groups by owner (docs/modules.md, "Team aggregates"): the one place its value is
 * made, so the module's code never sees a group. Withheld unless the docs belong to at least `minOwners` people (docs
 * with no owner count toward the figures but no one's share); then the count, and each value in order, an average
 * being the sum over the docs counted.
 */
export function teamAggregate(spec: Pick<AggregateSpec, "values" | "minOwners">, groups: ReadonlyArray<{ keys: ReadonlyArray<unknown>; values: ReadonlyArray<number | null> }>): AggregateReadValue {
  const measures = aggregateMeasures(spec);
  const owners = new Set(groups.filter((g) => typeof g.keys[0] === "string" && (g.values[0] ?? 0) > 0).map((g) => g.keys[0]));
  if (owners.size < spec.minOwners) return { withheld: true, minOwners: spec.minOwners };
  const sums = measures.map((_, i) => groups.reduce((n, g) => n + (g.values[i] ?? 0), 0));
  const count = sums[0];
  const at = (field: string | undefined) => measures.findIndex((x) => x.fn === "sum" && x.field === field);
  const values = spec.values.map((v) => (v.fn === "count" ? count : v.fn === "sum" ? sums[at(v.field)] : count ? sums[at(v.field)] / count : null));
  return { withheld: false, owners: owners.size, count, values };
}

/** Canon retires its Reports entry only after this installed contract finishes adopting legacy rows. */
export function reportsTakeover(pkg: { moduleId: string; manifest: string; imports?: Record<string, { done: boolean }> }): boolean {
  return pkg.moduleId === "@canon/reports" && !!(JSON.parse(pkg.manifest) as { imports?: string[] }).imports?.includes("reports.legacy") && pkg.imports?.["reports.legacy"]?.done === true;
}
