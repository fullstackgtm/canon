import { z } from "zod";
import { FILTER_OPS, REPORT_BUCKETS, isCustomObjectName } from "../modules/kernel/reportLanguage.ts";
import { compileListRequest, LIST_LIMIT_MAX, FILTERS_MAX, listColumns, OPS_OF } from "../convex/lib/objects/listSpec.ts";
import { compileAggregateRequest } from "../convex/lib/objects/reportSpec.ts";
import { STANDARD_OBJECTS, resolveObjectDef, isLedgerObjectName, CUSTOM_FIELD_API_NAME, type ResolvedObjectDef, type StandardObjectName } from "../convex/lib/objects/registry.ts";

export const DATA_COMPONENTS = ["table", "list", "metric", "chart"] as const;
export type DataComponent = typeof DATA_COMPONENTS[number];
export const isDataComponent = (s: string): s is DataComponent => (DATA_COMPONENTS as readonly string[]).includes(s);
const scalar = /* @__PURE__ */ (() => z.union([z.string(), z.number().finite(), z.boolean()]))();
const reference = /* @__PURE__ */ (() => z.object({ record: z.string().min(1) }).strict())();
export const DATA_QUERIES = /* @__PURE__ */ (() => {
  const filter = z.object({ field: z.string().min(1), op: z.enum(FILTER_OPS), value: z.union([scalar, z.array(scalar), reference]).optional() }).strict();
  const base = z.object({
    object: z.string().refine(isLedgerObjectName, "unknown listed object"),
    filter: z.array(filter).max(FILTERS_MAX).default([]),
    sort: z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) }).strict().optional(),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(10),
  });
  const aggregate = z.discriminatedUnion("fn", [z.object({ fn: z.literal("count") }).strict(), z.object({ fn: z.enum(["sum", "avg"]), field: z.string().min(1) }).strict()]);
  const queries = {
    table: base.extend({ columns: z.array(z.string().min(1)).min(1).max(30).default(["recordTitle"]) }).strict(),
    list: base.extend({ columns: z.array(z.string().min(1)).min(1).max(30).default(["recordTitle"]) }).strict(),
    metric: base.extend({ aggregate }).strict(),
    chart: base.extend({ aggregate, groupBy: z.object({ field: z.string(), bucket: z.enum(REPORT_BUCKETS).optional() }).strict() }).strict(),
  };
  return queries;
})();
export type DataQuery = z.infer<typeof DATA_QUERIES[DataComponent]>;
export const recordReference = (v: unknown): v is { record: string } => reference.safeParse(v).success;
export function resolveQuery(q: DataQuery, record: { id: string; values: Record<string, unknown> }, fields: readonly { apiName: string; fieldId: string; hidden?: boolean }[]) {
  return { ...q, filter: q.filter.map((f) => {
    if (!recordReference(f.value)) return f as { field: string; op: typeof f.op; value?: z.infer<typeof scalar> | z.infer<typeof scalar>[] };
    const name = f.value.record;
    const field = fields.find((x) => x.apiName === name || x.fieldId === name);
    if (name !== "id" && (!field || field.hidden)) throw new Error(`Record field ${name} is unavailable`);
    const value = name === "id" ? record.id : record.values[field!.fieldId];
    if (!z.union([scalar, z.array(scalar)]).safeParse(value).success) throw new Error(`Record field ${name} has no filter value`);
    return { ...f, value: value as z.infer<typeof scalar> | z.infer<typeof scalar>[] };
  }) };
}
const standardDef = (name: string) => Object.hasOwn(STANDARD_OBJECTS, name) ? resolveObjectDef(STANDARD_OBJECTS[name as StandardObjectName]) : undefined;
export function validateDataQuery(kind: DataComponent, input: unknown, pageObject: string): DataQuery {
  const q = DATA_QUERIES[kind].parse(input);
  const def = standardDef(q.object), page = standardDef(pageObject);
  for (const f of q.filter) if (recordReference(f.value)) {
    if (f.value.record !== "id" && page && !page.byApiName.has(f.value.record) && !page.fields.some((x) => x.fieldId === (f.value as { record: string }).record) && !CUSTOM_FIELD_API_NAME.test(f.value.record)) throw new Error(`unknown record field ${f.value.record}`);
    if (f.op === "empty" || f.op === "notEmpty") throw new Error(`${f.op} takes no value`);
    const col = def && listColumns(def).get(f.field);
    if (col && !OPS_OF[col.kind].includes(f.op)) throw new Error(`${f.field} cannot be filtered with ${f.op}`);
  }
  if (def) validateQueryFields(q, def, true);
  return q;
}
export function validateQueryFields(q: DataQuery, def: ResolvedObjectDef, deferred = false): void {
  const columns = listColumns(def);
  const known = (name: string) => {
    if (columns.has(name)) return true;
    if (deferred && (CUSTOM_FIELD_API_NAME.test(name) || isCustomObjectName(q.object))) return false;
    throw new Error(`Unknown or unavailable field ${name}`);
  };
  const filters = q.filter.filter((f) => known(f.field) && !recordReference(f.value));
  if (q.sort) known(q.sort.field);
  if ("columns" in q) q.columns.forEach(known);
  compileListRequest(def, { filter: filters, ...(q.sort && columns.has(q.sort.field) ? { sort: q.sort } : {}), limit: q.limit });
  if ("aggregate" in q) {
    const measures = q.aggregate.fn === "count" || known(q.aggregate.field) ? [q.aggregate] : [{ fn: "count" as const }];
    const groupBy = "groupBy" in q && known(q.groupBy.field) ? [q.groupBy] : [];
    compileAggregateRequest(q.object, def, { filter: filters, measures, groupBy }, standardDef);
  }
}
export const DATA_QUERY_GRAMMAR = /* @__PURE__ */ (() => Object.fromEntries(DATA_COMPONENTS.map((kind) => [kind, z.toJSONSchema(DATA_QUERIES[kind])])))();
