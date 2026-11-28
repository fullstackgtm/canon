import { companyLinkOf } from "../dealCompany.ts";
import { ConvexError } from "convex/values";
import type { RelatedCondition } from "../objects/validators.ts";
import { IN_VALUES_MAX, LIST_LIMIT_MAX, type ListFilter } from "../objects/listSpec.ts";
import type { RecordClient } from "../recordClient.ts";

export const CRM_COMPANIES_PER_CALL = 50;
export const CRM_IDS_PER_CALL = 250;
export const CRM_ROWS_PER_COMPANY = 5000;
export const CRM_IDS_PER_EVALUATION = 25000;
export const CRM_QUERY_CALLS_MAX = 2000;
export const DEAL_LIST_CALLS_MAX = 400;
export const CRM_DEAL_LIMIT_MESSAGE = "This deal condition would read more CRM-synced deals than one evaluation allows. Narrow the audience so it leaves out companies with very large numbers of CRM deals.";
export type CrmCompany = { id: string; domain?: string; stream?: string };
export type CrmContinuation = { company: CrmCompany; accountId: string; cursor: string | null; scanned: number };
export type CrmDealsPort = (companies: CrmCompany[], continuation?: CrmContinuation) => Promise<{ ids: Record<string, string[]>; over: boolean; continuation?: CrmContinuation }>;
export const refuseCrmDealLimit = (): never => { throw new ConvexError(CRM_DEAL_LIMIT_MESSAGE); };

export function assertSupportedRelated(related: readonly RelatedCondition[]) {
  if (related.length > 3) throw new ConvexError("An audience can have at most three related conditions");
}

export type RelatedPorts = {
  check(related: readonly RelatedCondition[]): void | Promise<void>;
  companiesMatching(ids: string[], filter: ListFilter[]): Promise<Set<string>>;
  companiesWithDeals(ids: string[], filter: ListFilter[]): Promise<Set<string>>;
};

export function relatedPorts(client: RecordClient, ws: string, crm?: CrmDealsPort): RelatedPorts {
  let dealCalls = 0;
  let crmIds = 0;
  let crmCalls = 0;
  const listDeals = (req: Parameters<RecordClient["listObjects"]>[2]) => {
    if (++dealCalls > DEAL_LIST_CALLS_MAX) throw new ConvexError("This deal condition needs too many deal-list reads; narrow the audience or use a more selective deal filter.");
    return client.listObjects(ws, "deal", req);
  };
  const matching = async (object: "account" | "deal", field: string, ids: string[], filter: ListFilter[]) => {
    const found = new Set<string>();
    const wanted = new Set(ids);
    let cursor: string | undefined;

    do {
      const req = { filter: [...filter, { field, op: "in" as const, value: ids }], limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) };
      const page = object === "account" ? await client.listRegister(ws, object, req) : await listDeals(req);
      for (const row of page.rows) {
        const link = companyLinkOf({ companyId: typeof row.values.companyId === "string" ? row.values.companyId : undefined });
        const id = object === "account" ? row.id : link.kind === "stored" ? link.companyId : undefined;
        if (id && wanted.has(id)) found.add(id);
      }
      if (object === "deal" && found.size === ids.length) break;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  };
  return {
    async check(related) {
      dealCalls = 0;
      crmIds = 0;
      crmCalls = 0;
      assertSupportedRelated(related);
      if (!crm && related.some((c) => c.path === "company.deals")) throw new ConvexError("CRM deal resolution is unavailable for this audience read");
      if (related.length) await client.checkReadFields?.("contact", ["accountId"]);
      for (const condition of related) await client.checkReadFields?.(condition.path === "company" ? "account" : "deal", [
        ...(condition.path === "company.deals" ? ["companyId"] : []), ...condition.filter.map((f) => f.field),
      ]);
    },
    companiesMatching: (ids, filter) => matching("account", "id", ids, filter),
    async companiesWithDeals(ids, filter) {
      const found = await matching("deal", "companyId", ids, filter);
      if (!crm) return found;
      const remaining = ids.filter((id) => !found.has(id));
      const owners = new Map<string, string[]>();
      for (let i = 0; i < remaining.length; i += CRM_COMPANIES_PER_CALL) {
        const chunk = remaining.slice(i, i + CRM_COMPANIES_PER_CALL);
        const companies = new Map<string, CrmCompany>(chunk.map((id) => [id, { id }]));
        let cursor: string | undefined;
        do {
          const page = await client.listRegister(ws, "account", { filter: [{ field: "id", op: "in", value: chunk }], limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
          for (const row of page.rows) if (companies.has(row.id)) companies.set(row.id, {
            id: row.id,
            ...(typeof row.values.domain === "string" ? { domain: row.values.domain } : {}),
            ...(row.stream ? { stream: row.stream } : {}),
          });
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        const resolveCrm = async (candidates: CrmCompany[]): Promise<void> => {
          let continuation: CrmContinuation | undefined;
          do {
            if (++crmCalls > CRM_QUERY_CALLS_MAX) refuseCrmDealLimit();
            const result = await crm(candidates, continuation);
            if (result.over) {
              if (candidates.length === 1 || continuation) refuseCrmDealLimit();
              const middle = Math.ceil(candidates.length / 2);
              await resolveCrm(candidates.slice(0, middle));
              await resolveCrm(candidates.slice(middle));
              return;
            }
            const count = new Set(Object.values(result.ids).flat()).size;
            crmIds += count;
            if (count > CRM_IDS_PER_CALL || crmIds > CRM_IDS_PER_EVALUATION) refuseCrmDealLimit();
            for (const [companyId, streams] of Object.entries(result.ids)) {
              if (!companies.has(companyId)) continue;
              for (const id of streams) owners.set(id, [...(owners.get(id) ?? []), companyId]);
            }
            if (result.continuation && (result.continuation.scanned <= (continuation?.scanned ?? 0) || result.continuation.scanned > CRM_ROWS_PER_COMPANY)) refuseCrmDealLimit();
            continuation = result.continuation;
          } while (continuation);
        };
        await resolveCrm([...companies.values()]);
      }
      const streams = [...owners.keys()];
      for (let j = 0; j < streams.length; j += IN_VALUES_MAX) {
        let cursor: string | undefined;
        do {
          const page = await listDeals({ filter: [...filter, { field: "id", op: "in", value: streams.slice(j, j + IN_VALUES_MAX) }], limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
          for (const row of page.rows) for (const companyId of owners.get(row.id) ?? []) found.add(companyId);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      return found;
    },
  };
}

export async function applyRelated<T>(rows: T[], related: readonly RelatedCondition[], ports: RelatedPorts): Promise<T[]> {
  assertSupportedRelated(related);
  await ports.check(related);
  const accountId = (row: T): string | undefined => (row as { accountId?: string }).accountId;
  let kept = rows;
  for (const condition of related) {
    const ids = [...new Set(kept.flatMap((r) => { const id = accountId(r); return id ? [id] : []; }))];
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_VALUES_MAX) {
      const matches = await (condition.path === "company" ? ports.companiesMatching : ports.companiesWithDeals)(ids.slice(i, i + IN_VALUES_MAX), condition.filter);
      for (const id of matches) found.add(id);
    }
    kept = kept.filter((r) => condition.path === "company.deals" && condition.has === "none" ? !found.has(accountId(r) ?? "") : found.has(accountId(r) ?? ""));
  }
  return kept;
}
