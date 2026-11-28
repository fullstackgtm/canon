import { DATA_QUERIES } from "./data.ts";
import type { RecordProps } from "./blocks.ts";

type Relation =
  | { kind: "lookup"; field: string }
  | { kind: "companyDeals"; viaCompany?: boolean }
  | { kind: "association"; edge: "people" | "companies" | "deals" | "children" | "members"; viaCompany?: boolean };

export type RecordRelation = Relation & { id: string; object: string; label: string };
type ModelObject = {
  apiName: string; pluralLabel: string;
  fields: readonly { apiName: string; type: string; lookupTo?: string; hidden?: boolean; archivedAt?: number }[];
};

const builtIn: Record<string, RecordRelation[]> = {
  account: [
    { id: "companyPeople", label: "People", object: "contact", kind: "association", edge: "people" },
    { id: "companyDeals", label: "Opportunities", object: "deal", kind: "companyDeals" },
    { id: "childCompanies", label: "Child companies", object: "account", kind: "association", edge: "children" },
  ],
  contact: [
    { id: "contactCompanies", label: "Companies", object: "account", kind: "association", edge: "companies" },
    { id: "contactDeals", label: "Opportunities", object: "deal", kind: "association", edge: "deals" },
  ],
  deal: [
    { id: "dealPeople", label: "People on this opportunity", object: "contact", kind: "association", edge: "members" },
    { id: "companyPeople", label: "People at this account", object: "contact", kind: "association", edge: "people", viaCompany: true },
    { id: "companyDeals", label: "Opportunities at this account", object: "deal", kind: "companyDeals", viaCompany: true },
  ],
};

export function recordRelations(source: string, objects: readonly ModelObject[]): RecordRelation[] {
  const readable = new Set(objects.map((object) => object.apiName));
  return [
    ...(Object.hasOwn(builtIn, source) ? builtIn[source] : []).filter((r) => readable.has(r.object)),
    ...objects.flatMap((object): RecordRelation[] => object.fields.flatMap((field) =>
      field.type === "lookup" && field.lookupTo === source && !field.hidden && field.archivedAt === undefined &&
      !(source === "account" && object.apiName === "deal" && field.apiName === "companyId")
        ? [{ id: `${object.apiName}:${field.apiName}`, object: object.apiName, label: object.pluralLabel, kind: "lookup", field: field.apiName }]
        : [],
    )),
  ];
}

export function relatedListQuery(relation: RecordRelation, sourceId: string, props: Partial<RecordProps<"relatedList">>, ids?: string[]) {
  const filter: { field: string; op: "eq" | "in"; value: string | string[] }[] = relation.kind === "lookup" ? [{ field: relation.field, op: "eq", value: sourceId }]
    : ids?.length ? [{ field: "id", op: "in", value: ids }] : [];
  const query = DATA_QUERIES.table.parse({
    object: relation.object,
    ...(relation.kind === "companyDeals" ? { from: "companyDeals" } : {}),
    filter,
    columns: props.columns ?? ["recordTitle"],
    sort: props.sort,
    limit: props.limit ?? 5,
  });
  return { ...query, filter };
}

export const relatedCount = (total: number) => total > 99 ? "99+" : String(total);
