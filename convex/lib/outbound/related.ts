import { companyLinkOf } from "../dealCompany.ts";
import { ConvexError } from "convex/values";
import type { RelatedCondition } from "../objects/validators.ts";
import { IN_VALUES_MAX, LIST_LIMIT_MAX, type ListFilter } from "../objects/listSpec.ts";
import type { RecordClient } from "../recordClient.ts";

export const DEAL_PAGES_PER_CHUNK_MAX = 25;

export const hasNegativeDealCondition = (related: readonly RelatedCondition[] = []) => related.some((c) => c.path === "company.deals" && c.has === "none");

export function assertSupportedRelated(related: readonly RelatedCondition[]) {
  if (related.length > 3) throw new ConvexError("An audience can have at most three related conditions");
  if (hasNegativeDealCondition(related)) {
    throw new ConvexError("No matching deal is unavailable until CRM-linked deals can be resolved with your access. Use has a matching deal, which currently checks explicit company links only.");
  }
}

export type RelatedPorts = {
  check(related: readonly RelatedCondition[]): void;
  companiesMatching(ids: string[], filter: ListFilter[]): Promise<Set<string>>;
  companiesWithDeals(ids: string[], filter: ListFilter[]): Promise<Set<string>>;
};

export function relatedPorts(client: RecordClient, ws: string): RelatedPorts {
  const matching = async (object: "account" | "deal", field: string, ids: string[], filter: ListFilter[]) => {
    const found = new Set<string>();
    const wanted = new Set(ids);
    let cursor: string | undefined;
    let pages = 0;
    do {
      const req = { filter: [...filter, { field, op: "in" as const, value: ids }], limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) };
      const page = object === "account" ? await client.listRegister(ws, object, req) : await client.listObjects(ws, object, req);
      for (const row of page.rows) {
        const link = companyLinkOf({ companyId: typeof row.values.companyId === "string" ? row.values.companyId : undefined });
        const id = object === "account" ? row.id : link.kind === "stored" ? link.companyId : undefined;
        if (id && wanted.has(id)) found.add(id);
      }
      if (object === "deal" && found.size === ids.length) break;
      if (object === "deal" && ++pages >= DEAL_PAGES_PER_CHUNK_MAX && page.nextCursor) {
        throw new ConvexError("This deal condition exceeds the bounded read limit; narrow the deal filter.");
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  };
  return {
    check(related) {
      assertSupportedRelated(related);
      if (related.length) client.checkReadFields?.("contact", ["accountId"]);
      for (const condition of related) client.checkReadFields?.(condition.path === "company" ? "account" : "deal", [
        ...(condition.path === "company.deals" ? ["companyId"] : []), ...condition.filter.map((f) => f.field),
      ]);
    },
    companiesMatching: (ids, filter) => matching("account", "id", ids, filter),
    companiesWithDeals: (ids, filter) => matching("deal", "companyId", ids, filter),
  };
}

export async function applyRelated<T>(rows: T[], related: readonly RelatedCondition[], ports: RelatedPorts): Promise<T[]> {
  assertSupportedRelated(related);
  ports.check(related);
  const accountId = (row: T): string | undefined => (row as { accountId?: string }).accountId;
  let kept = rows;
  for (const condition of related) {
    const ids = [...new Set(kept.flatMap((r) => { const id = accountId(r); return id ? [id] : []; }))];
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_VALUES_MAX) {
      const matches = await (condition.path === "company" ? ports.companiesMatching : ports.companiesWithDeals)(ids.slice(i, i + IN_VALUES_MAX), condition.filter);
      for (const id of matches) found.add(id);
    }
    kept = kept.filter((r) => Boolean(accountId(r) && found.has(accountId(r) ?? "")));
  }
  return kept;
}
