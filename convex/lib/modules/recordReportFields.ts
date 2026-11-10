/**
 * Canon's own objects as module report sources (docs/modules.md, "Reports and charts"): the report fields of a Canon
 * object from its list definition, as Canon's report builder offers them (src/components/reports/report-builder.tsx),
 * and a module report's spec over one as Canon's report engine reads it. The kernel's report types are in
 * modules/kernel/reports.ts; what every workspace has is snapshotted there (standardRecordFields).
 *
 * Pure, with no Node-only imports: Convex, the browser, tests and scripts/sync-object-core.ts import it.
 */
import { listColumns, listViewDef, ListRequestError, type ListFilter } from "../objects/listSpec.ts";
import { activityReportDef, groupableField, measurableField, relationsOf, type ReportGroup, type ReportMeasure } from "../objects/reportSpec.ts";
import { resolveObjectDef, STANDARD_OBJECTS, type ResolvedObjectDef, type StandardObjectName } from "../objects/registry.ts";
import { ACTIVITY_OBJECT, type ModuleFieldType } from "../../../modules/kernel/reportLanguage.ts";
import { DEAL_ACCOUNT, unfilterable, WEIGHTED_AMOUNT, type ReportField } from "../../../modules/kernel/reports.ts";

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

/**
 * The fields of a Canon source every workspace has: what modules/kernel/standardRecordFields.generated.ts holds
 * (scripts/sync-object-core.ts writes it), which a manifest's declared report is checked against. Null for a custom object.
 */
export function computeStandardRecordFields(object: string): ReportField[] | null {
  const def = standardListDef(object);
  return def ? recordReportFields(object, def, standardListDef) : null;
}

/** Every object standardListDef knows: the activity report object and the registry's standard objects. */
export const STANDARD_REPORT_OBJECTS: readonly string[] = [ACTIVITY_OBJECT, ...Object.keys(STANDARD_OBJECTS)];

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
