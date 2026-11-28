import type { DataQuery } from "./data.ts";
import { listRowsInMemory, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { aggregateRowsInMemory, compileAggregateRequest } from "../convex/lib/objects/reportSpec.ts";
import type { FieldValue, ResolvedObjectDef } from "../convex/lib/objects/registry.ts";

export type CompanyDealRow = {
  dealId: string; streamId: string | null; name?: string; stage?: string | null;
  amount?: number | null; currency?: string; closeDate?: string; isClosed?: boolean; isWon?: boolean; createdAt?: number;
};
const AVAILABLE = new Set(["id", "recordTitle", "name", "stage", "amount", "currency", "closeDate", "isClosed", "isWon", "createdAt"]);

/** forCompany has already applied the viewer's record and field permissions. Never fill missing values from another source. */
export function companyDealsData(query: DataQuery, deals: readonly CompanyDealRow[], def: ResolvedObjectDef, cursor?: string) {
  const used = [...query.filter.map((f) => f.field), ...(query.sort ? [query.sort.field] : []), ...("columns" in query ? query.columns : []), ...("aggregate" in query && query.aggregate.fn !== "count" ? [query.aggregate.field] : []), ...("groupBy" in query ? [query.groupBy.field] : [])];
  for (const name of used) if (!AVAILABLE.has(name)) throw new Error(`companyDeals does not provide field ${name}`);
  const rows: ListRow[] = deals.map((deal) => ({
    id: deal.streamId ?? deal.dealId, object: "deal", version: 0, status: "active",
    title: deal.name ?? "", createdAt: deal.createdAt ?? 0, updatedAt: 0, deletedAt: null,
    values: Object.fromEntries(def.fields.flatMap((f) => {
      const value = deal[f.apiName as keyof CompanyDealRow];
      return AVAILABLE.has(f.apiName) && value != null ? [[f.fieldId, value as FieldValue]] : [];
    })),
  }));
  if ("aggregate" in query) {
    const compiled = compileAggregateRequest("deal", def, { filter: query.filter, measures: [query.aggregate], groupBy: "groupBy" in query ? [query.groupBy] : [] }, () => undefined);
    return { aggregate: aggregateRowsInMemory(compiled, rows, () => new Map(), {}) };
  }
  return {
    rows: listRowsInMemory(def, rows, { filter: query.filter, ...(query.sort ? { sort: query.sort } : {}), limit: query.limit, cursor }, {}),
    unlinked: deals.filter((d) => !d.streamId).map((d) => d.dealId),
  };
}
