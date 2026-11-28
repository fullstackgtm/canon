import { ConvexError } from "convex/values";
import { may, type Access } from "./access.ts";
import { IN_VALUES_MAX, LIST_LIMIT_MAX, ListRequestError, SCOPE_IDS_MAX, type CompanyPredicate, type ListFilter } from "./objects/listSpec.ts";
import { relatedPeopleField, splitPeopleFilters } from "./objects/peopleFilters.ts";
import { atLeastVersion, type RecordClient } from "./recordClient.ts";

export const PEOPLE_FILTER_DEAL_BATCH = 20;

/** Resolve relationship predicates before the contact list or aggregate applies its own scope, count and cursor. */
export function peopleFilterClient(client: RecordClient, accesses: readonly Access[], members: (streams: string[]) => Promise<string[]>): RecordClient {
  const prepare = async <T extends { filter?: readonly ListFilter[]; company?: CompanyPredicate }>(ws: string, req: T): Promise<T> => {
    if (!req.filter?.some((f) => relatedPeopleField(f.field))) return req;
    if (!accesses.every((a) => may(a, "contact", "read"))) throw new ConvexError("People filters require access to people");
    const { account, contact, deal } = splitPeopleFilters(req.filter);

    if (account.length) {
      if (!accesses.every((a) => may(a, "account", "read"))) throw new ConvexError("Company filters require access to companies");
      await client.checkReadFields?.("contact", ["accountId"]);
      await client.checkReadFields?.("account", account.map((f) => f.field));
      if (client.mode === "http" && !atLeastVersion(await client.contractVersion(), "1.51.0")) {
        throw new ListRequestError("Company filters need record service 1.51.0 or newer. Ask an admin to update the record service.");
      }
    }

    if (deal.length) {
      if (!accesses.every((a) => may(a, "deal", "read"))) throw new ConvexError("Opportunity filters require access to opportunities");
      const ids = new Set<string>();
      let cursor: string | null = null;
      let scanned = 0;
      do {
        const page = await client.listObjects(ws, "deal", { filter: deal, limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
        scanned += page.rows.length;
        if (page.total > SCOPE_IDS_MAX || scanned > SCOPE_IDS_MAX) {
          throw new ConvexError(`The filter matches more than ${SCOPE_IDS_MAX} opportunities. Narrow the opportunity filters.`);
        }
        for (let i = 0; i < page.rows.length; i += PEOPLE_FILTER_DEAL_BATCH) {
          const streams = page.rows.slice(i, i + PEOPLE_FILTER_DEAL_BATCH).map((r) => r.id);
          for (const id of await members(streams)) ids.add(id);
          if (ids.size > IN_VALUES_MAX) {
            throw new ConvexError(`The matching opportunities include more than ${IN_VALUES_MAX} people. Narrow the opportunity filters.`);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      // Register ids are nonempty. An empty match set must still add a predicate.
      contact.push(ids.size ? { field: "id", op: "in", value: [...ids].sort() } : { field: "id", op: "eq", value: "" });
    }

    return {
      ...req,
      filter: contact,
      ...(account.length ? { company: { fields: ["fit", "icpIds"], ...req.company, filter: [...(req.company?.filter ?? []), ...account] } } : {}),
    };
  };

  return {
    ...client,
    async listRegister(ws, object, req) {
      return client.listRegister(ws, object, object === "contact" ? await prepare(ws, req) : req);
    },
    async aggregate(ws, object, req) {
      return client.aggregate(ws, object, object === "contact" ? await prepare(ws, req) : req);
    },
  };
}
