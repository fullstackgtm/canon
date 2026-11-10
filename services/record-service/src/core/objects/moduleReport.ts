// GENERATED from convex/lib/objects/moduleReport.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * Module reports (docs/modules.md, "Reports and charts"): a module collection's docs projected into the record
 * service, and the report requests Canon sends it. A collection that declares `report` is a report object whose
 * fields are its declared dimensions and measures, typed from its schema, so a module report is a Canon report
 * (reportSpec.ts) over that object: the same filters, group keys, buckets, measures and response.
 *
 * The record service stores each doc as it is (`module_docs`) and answers a report with SQL over it, admitting only
 * the docs the request's scope names (services/record-service/src/moduleDocs.ts). Canon compiles that scope from the
 * caller's read scope in one place (convex/lib/modules/scope.ts `reportPlan`). The Convex fake reads the docs through
 * the module's scope instead and folds them with `moduleListRow` and reportSpec's `aggregateRowsInMemory`.
 *
 * Pure: no database access, no Node-only imports. The record service imports a generated copy
 * (scripts/sync-object-core.ts).
 */
import { indexObjectDef, type FieldDef, type FieldId, type ResolvedObjectDef } from "./registry.ts";
import type { ListRow } from "./listSpec.ts";
import type { AggregateRequest } from "./reportSpec.ts";

/** A report field's type, as Canon's reports read it. A `picklist` carries the labels of its values. */
export type ModuleFieldType = "text" | "picklist" | "user" | "number" | "currency" | "date" | "datetime" | "checkbox";
export type ModuleReportField = { name: string; label: string; type: ModuleFieldType; options?: readonly { value: string; label: string }[] };

/** A value a row condition compares with. */
export type ModuleScalar = string | number | boolean | null;
/** A row condition (modules/kernel/manifest.ts RowWhere), every ref naming its collection. */
export type ModuleWhere =
  | { field: string; in: readonly ModuleScalar[] } | { field: string; neq: ModuleScalar }
  | { all: readonly ModuleWhere[] } | { ref: string; collection: string; where: ModuleWhere };
/**
 * Which docs of one collection a caller reads: those whose owner is one of `owners` (any when null) and that pass
 * `where`; and for a set collection, only docs of its parent's live generation, whose parent the parent's own scope
 * admits.
 */
export type ModuleDocScope = { owners: readonly string[] | null; where: ModuleWhere | null; setOf: { parent: string; scope: ModuleDocScope } | null };

/** One doc as Canon projects it: its key, its parent and generation in a set, a parent's live generations, its owner. */
export type ModuleDocRow = {
  collection: string; key: string; parentKey: string | null; gen: number | null; gens: Record<string, number> | null;
  owner: string | null; data: Record<string, unknown>; version: number; createdAt: number; updatedAt: number;
};
/** Package rows survive uninstall; epoch advances on reinstall. Generation advances on each derived rebuild. */
export type ModuleProjection = { packageId: string; epoch: number; generation: number; collections: readonly string[] };
export function sameProjection(a: ModuleProjection | null | undefined, b: ModuleProjection | null | undefined) {
  return !!a && !!b && a.packageId === b.packageId && a.epoch === b.epoch && a.generation === b.generation
    && JSON.stringify(a.collections) === JSON.stringify(b.collections);
}
export type ModuleProjectionWork =
  | { kind: "keys"; keys: readonly { collection: string; key: string; job: string; seq: number }[] }
  | { kind: "rebuild"; collection: string; job: string; seq: number; complete: boolean };
/** Versioned delivery owns the projection; timestamp sweeps remain available only to untouched legacy clients. */
export type ModuleSyncRequest = { module: string; upserts: readonly ModuleDocRow[]; deletes: readonly { collection: string; key: string }[] } & (
  | { projection: ModuleProjection; work: ModuleProjectionWork; sweep?: never }
  | { projection?: undefined; work?: undefined; sweep?: { collection: string; before: number } }
);
export type ModuleSyncResponse = { at: number; upserted: number; deleted: number; receipt?: { projection: ModuleProjection; work: ModuleProjectionWork; accepted: boolean; retryAfter?: number } };
/** A report over one collection's docs, as the caller reads them. */
export type ModuleAggregateRequest = AggregateRequest & { module: string; collection: string; fields: readonly ModuleReportField[]; docScope: ModuleDocScope | null; projection?: ModuleProjection };

/** Independently scoped activity docs, unioned with the ledger before aggregation. Internal callers only. */
export type ModuleActivityReportSource = {
  module: string; collection: string; kind: string; owner: string | null;
  scopes: readonly ModuleDocScope[]; projection: ModuleProjection;
};
export type ActivityAggregateRequest = AggregateRequest & { moduleActivities?: readonly ModuleActivityReportSource[] };
export type ActivityAggregateReceipt = { moduleActivities: readonly ModuleActivityReportSource[] };

/** The most docs one sync carries, and the bytes of its docs. */
export const MODULE_SYNC_MAX = 500;
export const MODULE_SYNC_BYTES = 4_000_000;
/** A report's fields, and how deep a scope's refs and parents nest. */
export const MODULE_FIELDS_MAX = 40;
export const MODULE_SCOPE_DEPTH = 4;

const FIELD_TYPE: Record<Exclude<ModuleFieldType, "picklist">, "text" | "user" | "number" | "currency" | "date" | "datetime" | "checkbox"> = {
  text: "text", user: "user", number: "number", currency: "currency", date: "date", datetime: "datetime", checkbox: "checkbox",
};

/** The report object a collection is: its fields, each listed by its name, with createdAt and updatedAt as every object's. */
export function moduleReportDef(collection: string, fields: readonly ModuleReportField[]): ResolvedObjectDef {
  return indexObjectDef({
    apiName: collection, label: collection, pluralLabel: collection, kind: "custom", residency: "all", storage: "ledger", registryVersion: 1,
    titleFieldId: (fields[0]?.name ?? "createdAt") as FieldId,
    fields: [
      ...fields.map((f): FieldDef => {
        const base = { fieldId: f.name as FieldId, apiName: f.name, label: f.label };
        return f.type === "picklist" ? { ...base, type: "picklist", options: (f.options ?? []).map((o) => ({ ...o, active: true })) } : { ...base, type: FIELD_TYPE[f.type] };
      }),
      { fieldId: "createdAt" as FieldId, apiName: "createdAt", label: "Created", type: "datetime", system: true },
      { fieldId: "updatedAt" as FieldId, apiName: "updatedAt", label: "Last modified", type: "datetime", system: true },
    ],
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A field's value as the report reads it, as the record service's SQL does: text and members as text, numbers as
 * numbers, a date only as `YYYY-MM-DD`, true/false only as itself; anything else empty.
 */
export function moduleCell(type: ModuleFieldType, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "text": case "picklist": case "user": return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    case "number": case "currency": case "datetime": return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "date": return typeof value === "string" && DATE.test(value) ? value : null;
    case "checkbox": return typeof value === "boolean" ? value : null;
  }
}

/** A doc as a list row of its report object, for the fake's in-memory report. */
export function moduleListRow(collection: string, fields: readonly ModuleReportField[], doc: Pick<ModuleDocRow, "key" | "data" | "version" | "createdAt" | "updatedAt">): ListRow {
  return {
    id: doc.key, object: collection, version: doc.version, status: "active", title: doc.key, createdAt: doc.createdAt, updatedAt: doc.updatedAt, deletedAt: null,
    values: Object.fromEntries(fields.map((f) => [f.name, moduleCell(f.type, doc.data[f.name])])),
  };
}
