"use client";

import { useEffect, useState } from "react";
import { useConvex, useQuery, type ConvexReactClient } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { IN_VALUES_MAX, listRowsInMemory, type ListResponse, type RegisterListRow } from "../../../convex/lib/objects/listSpec";
import { companyDealsData } from "../../../recipes/relationData";
import { validateQueryFields } from "../../../recipes/data";
import { relatedListQuery, type ParentRecordRelation, type RecordRelation } from "../../../recipes/recordRelations";
import type { RecordProps } from "../../../recipes/blocks";
import type { ObjectDescription } from "./fields";

export type RelationSource = { object: string; id: string; companyId?: string; version?: number };
type Client = Pick<ConvexReactClient, "action" | "query">;

export function useReadableRecordObjects(enabled: boolean) {
  const client = useConvex();
  const catalog = useQuery(api.dataModel.objects, enabled ? {} : "skip");
  const [state, setState] = useState<{ key: string; defs: ObjectDescription[] }>();
  const key = catalog ? JSON.stringify(catalog.filter((o) => !o.archived).map((o) => o.apiName)) : "";
  useEffect(() => {
    if (!key || !catalog) return;
    let live = true;
    void Promise.all(catalog.filter((o) => !o.archived).map((o) =>
      client.query(api.objects.describe, { object: o.apiName }).catch(() => null),
    )).then((defs) => {
      if (live) setState({ key, defs: defs.filter((def): def is ObjectDescription => Boolean(def?.readable)) });
    });
    return () => { live = false; };
  }, [client, catalog, key]);
  return enabled && state?.key === key ? state.defs : undefined;
}

const emptyRows = (): ListResponse => ({ rows: [], total: 0, nextCursor: null, projectedThrough: {} });

async function associatedIds(client: Client, relation: Extract<RecordRelation, { kind: "association" }>, source: RelationSource, companyId?: string) {
  if (relation.edge === "members") {
    const result = await client.action(api.dealCommittee.forDeal, { streamId: source.id });
    return result?.members.map((m) => m.contactId) ?? [];
  }
  if (source.object === "deal" && !companyId) return [];
  const object = source.object === "contact" ? "contact" : "account";
  const result = await client.action(api.associations.related, { object, id: companyId ?? source.id });
  if (!result) return [];

  if (result.object === "account") {
    return (relation.edge === "people" ? result.people : relation.edge === "children" ? result.children : []).map((row) => row.id);
  }
  return relation.edge === "companies" ? result.companies.map((row) => row.id)
    : relation.edge === "deals" ? result.deals.flatMap((row) => row.streamId ? [row.streamId] : []) : [];
}

export async function loadRecordRelation(client: Client, source: RelationSource, relation: RecordRelation, props: Partial<RecordProps<"relatedList">>, cursor?: string) {
  const desc = await client.query(api.objects.describe, { object: relation.object });
  if (!desc?.readable) throw new Error("This related object is unavailable");
  const def = indexObjectDef(desc as unknown as ObjectDef);
  const query = relatedListQuery(relation, source.id, props);
  validateQueryFields(query, def);
  const base = { desc, fields: desc.fields, query, canLink: true };
  const companyId = "viaCompany" in relation && relation.viaCompany ? source.companyId : undefined;
  if (relation.kind !== "lookup" && "viaCompany" in relation && relation.viaCompany && !companyId) return { ...base, rows: emptyRows() };
  if (relation.kind === "companyDeals") {
    const accountId = companyId ?? source.id;
    const company = (await client.action(api.objects.list, { object: "account", filter: [{ field: "id", op: "eq", value: accountId }], limit: 1 })).rows[0] as RegisterListRow | undefined;
    if (!company) return { ...base, rows: emptyRows(), canLink: false };
    const domain = typeof company.values.domain === "string" ? company.values.domain : undefined;
    const deals = await client.query(api.deals.forCompany, { companyId: accountId, ...(domain ? { domain } : {}), ...(company.stream ? { stream: company.stream } : {}) });
    const result = companyDealsData(query, deals, def, cursor);
    if ("rows" in result && result.rows) return { ...base, rows: result.rows, unlinked: result.unlinked };
    throw new Error("Expected related deal rows");
  }
  if (relation.kind === "association") {
    const ids = [...new Set(await associatedIds(client, relation, source, companyId))];
    if (!ids.length) return { ...base, rows: emptyRows() };
    if (ids.length <= IN_VALUES_MAX) {
      const { filter, sort, limit } = relatedListQuery(relation, source.id, props, ids);
      return { ...base, rows: await client.action(api.objects.list, { object: relation.object, filter, sort, limit, cursor }) };
    }
    // Each chunk supplies visible rows in the same sort order. A single merge then pages across the chunks.
    const rows: ListResponse["rows"] = [];
    for (let i = 0; i < ids.length; i += IN_VALUES_MAX) {
      const { filter } = relatedListQuery(relation, source.id, props, ids.slice(i, i + IN_VALUES_MAX));
      let next: string | undefined;
      do {
        const page = await client.action(api.objects.list, { object: relation.object, filter, limit: 200, cursor: next });
        rows.push(...page.rows);
        next = page.nextCursor ?? undefined;
      } while (next);
    }
    return { ...base, rows: listRowsInMemory(def, rows, { sort: query.sort, limit: query.limit, cursor }, {}) };
  }
  return {
    ...base,
    rows: await client.action(api.objects.list, { object: query.object, filter: query.filter, sort: query.sort, limit: query.limit, cursor }),
  };
}

export async function loadParentRecord(client: Client, source: RelationSource, relation: ParentRecordRelation, value: unknown) {
  let id: string | undefined;
  if (relation.kind === "field") id = typeof value === "string" ? value : undefined;
  else {
    const result = await client.action(api.associations.related, { object: relation.edge === "parent" ? "account" : "contact", id: source.id });
    id = result?.object === "account" ? result.parent?.id : result?.companies.find((row) => row.primary)?.id;
  }
  if (!id) return null;
  const { rows: [row] } = await client.action(api.objects.list, { object: relation.object, filter: [{ field: "id", op: "eq", value: id }], limit: 1 });
  return row ?? null;
}

export const relatedListHref = (source: RelationSource, relation: RecordRelation) =>
  `/dashboard/records/${encodeURIComponent(relation.object)}?${new URLSearchParams({ relatedObject: source.object, relatedId: source.id, relationship: relation.id })}`;
