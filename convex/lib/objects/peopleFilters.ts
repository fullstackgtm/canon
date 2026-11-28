import { compileListRequest, FILTERS_MAX, ListRequestError, type ListFilter, type ListRequest } from "./listSpec.ts";
import type { ResolvedObjectDef } from "./registry.ts";

export const PEOPLE_FILTER_RELATIONS = [
  { prefix: "company", object: "account", label: "Company" },
  { prefix: "deal", object: "deal", label: "Opportunity" },
] as const;

export type PeopleFilterRelation = (typeof PEOPLE_FILTER_RELATIONS)[number];
export type PeopleFilterDefs = Partial<Record<PeopleFilterRelation["object"], ResolvedObjectDef>>;

export function relatedPeopleField(field: string) {
  const relation = PEOPLE_FILTER_RELATIONS.find(({ prefix }) => field.startsWith(`${prefix}.`));
  return relation && { relation, field: field.slice(relation.prefix.length + 1) };
}

export function splitPeopleFilters(filters: readonly ListFilter[]) {
  if (filters.length > FILTERS_MAX) throw new ListRequestError(`at most ${FILTERS_MAX} filters`);
  const parts = { contact: [] as ListFilter[], account: [] as ListFilter[], deal: [] as ListFilter[] };
  for (const filter of filters) {
    const related = relatedPeopleField(filter.field);
    if (related && (!related.field || related.field === "id" || related.field === "recordTitle")) {
      throw new ListRequestError(`unknown field ${filter.field}`);
    }
    if (related) parts[related.relation.object].push({ ...filter, field: related.field });
    else parts.contact.push(filter);
  }
  return parts;
}

/** Validate saved views and People URL filters using the same field definitions as the list. */
export function validateViewListRequest(def: ResolvedObjectDef, req: ListRequest, related: PeopleFilterDefs = {}) {
  if (def.apiName !== "contact") {
    compileListRequest(def, req);
    return;
  }
  const parts = splitPeopleFilters(req.filter ?? []);
  compileListRequest(def, { ...req, filter: parts.contact });
  for (const { object, label } of PEOPLE_FILTER_RELATIONS) {
    if (!parts[object].length) continue;
    const target = related[object];
    if (!target) throw new ListRequestError(`${label} filters are unavailable`);
    compileListRequest(target, { filter: parts[object] });
  }
}
