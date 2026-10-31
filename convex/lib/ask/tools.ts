/**
 * Ask Canon's tools. All READ-ONLY, and none takes an organization: `AskData`
 * is built once per request for the caller's org (see `recordAskData` and
 * convex/askCanon.ts), so the model can name records but never choose whose.
 * Adding a tool that writes, or one that accepts an org or user id, breaks the
 * contract in docs/ask-canon.md and tests/askCanon.test.ts.
 */
import { FILTER_OPS, isRegisterObject, type ListFilter, type ListRequest, type ListResponse, type ListRow, type SearchResponse } from "../objects/listSpec.ts";
import { isCustomObjectName, STANDARD_OBJECTS } from "../objects/registry.ts";
import type { ContactRow } from "../recordContract.ts";
import type { RecordClient } from "../recordClient.ts";
import { recordHref, seenKey, type AskTool, type RecordRef, type SeenRecords } from "./askLoop.ts";

/** Objects the generic list and record pages serve (ledger-stored standard objects). */
export const ASK_OBJECTS: readonly string[] = (Object.keys(STANDARD_OBJECTS) as (keyof typeof STANDARD_OBJECTS)[])
  .filter((o) => STANDARD_OBJECTS[o].storage === "ledger");

export const LIST_MAX = 25;
export const SEARCH_MAX = 20;
export const CONTACTS_MAX = 25;
export const RECEIPTS_MAX = 8;

export type FieldInfo = { fieldId: string; apiName: string; label: string; type: string; options?: Array<{ value: string; label: string; active?: boolean }> };
export type ObjectInfo = { object: string; label: string; fields: FieldInfo[] };
export type FactInfo = { attribute: string; value: unknown; state: string; sourceKind: string | null; updatedAt: number };

export type AskData = {
  describe(object: string): Promise<ObjectInfo | null>;
  list(object: string, req: ListRequest): Promise<ListResponse>;
  search(q: string, objects: readonly string[], limit: number): Promise<Array<{ object: string; id: string; title: string }>>;
  accountContacts(accountId: string): Promise<ContactRow[]>;
  /** Canonical field states of an account, contact or deal. Null for objects without a fact ledger. */
  facts(object: string, id: string): Promise<FactInfo[] | null>;
  /** Facts behind one field, newest first. Null when the record or its ledger entity isn't the caller's. */
  receipts(object: string, id: string, attribute: string): Promise<unknown | null>;
};

/**
 * Record-service backed reads, scoped to `orgId` (the record service's
 * workspace). The caller's org comes from the server (requireCaller), never
 * from the model.
 */
export function recordAskData(
  client: RecordClient,
  orgId: string,
  extras: Pick<AskData, "describe" | "facts" | "receipts">,
  /** Fields of an object the caller may not see (CP14): their facts and receipts are left out, as the client leaves their values out. */
  hidden: (object: string) => ReadonlySet<string> = () => new Set(),
): AskData {
  const list: AskData["list"] = async (object, req) =>
    isRegisterObject(object) ? client.listRegister(orgId, object, req) : client.listObjects(orgId, object, req);
  return {
    describe: extras.describe,
    async facts(object, id) {
      const facts = await extras.facts(object, id);
      const h = hidden(object);
      return facts && h.size ? facts.filter((f) => !h.has(f.attribute)) : facts;
    },
    async receipts(object, id, attribute) {
      return hidden(object).has(attribute) ? null : extras.receipts(object, id, attribute);
    },
    list,
    async search(q, objects, limit) {
      const hits: Array<{ object: string; id: string; title: string }> = [];
      // The register holds every account and contact; the search index only the worked ones.
      for (const object of objects.filter(isRegisterObject)) {
        const page = await client.listRegister(orgId, object, { filter: [{ field: "recordTitle", op: "contains", value: q }], limit });
        hits.push(...page.rows.map((r) => ({ object, id: r.id, title: r.title })));
      }
      const others = objects.filter((o) => !isRegisterObject(o));
      if (others.length) {
        const found: SearchResponse = await client.searchObjects(orgId, { q, limit, objects: others });
        hits.push(...found.hits.map((h) => ({ object: h.object, id: h.id, title: h.title })));
      }
      return hits.slice(0, limit);
    },
    async accountContacts(accountId) {
      return (await client.get(orgId, accountId))?.contacts ?? [];
    },
  };
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const objectArg = (v: unknown): string => {
  const o = str(v, 40);
  if (!ASK_OBJECTS.includes(o) && !isCustomObjectName(o)) throw new Error(`object must be one of: ${ASK_OBJECTS.join(", ")}, or a custom object (custom_<slug>)`);
  return o;
};
const limitArg = (v: unknown, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(1, Math.floor(v))) : fallback;

function filtersArg(v: unknown): ListFilter[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("filters must be an array of {field, op, value}");
  return v.slice(0, 5).map((f) => {
    const o = (f ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
    const op = o.op;
    if (typeof o.field !== "string" || typeof op !== "string" || !(FILTER_OPS as readonly string[]).includes(op)) {
      throw new Error(`each filter needs a field and an op from: ${FILTER_OPS.join(", ")}`);
    }
    const scalar = (x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
    const value = Array.isArray(o.value) ? o.value.filter(scalar).slice(0, 50) : scalar(o.value) ? o.value : undefined;
    return { field: o.field.slice(0, 80), op: op as ListFilter["op"], ...(value !== undefined ? { value } : {}) };
  });
}

/** A row's non-empty values keyed by field apiName. */
function valuesOf(info: ObjectInfo, row: ListRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of info.fields) {
    const v = row.values[f.fieldId];
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) out[f.apiName] = v;
  }
  return out;
}

function note(seen: SeenRecords, object: string, id: string, title: string): RecordRef & { link: string } {
  const ref = { object, id, title };
  seen.set(seenKey(object, id), ref);
  return { ...ref, link: recordHref(object, id) };
}

const trimFact = (f: unknown) => {
  const x = f as Record<string, unknown>;
  const evidence = typeof x.evidence === "string" ? x.evidence.slice(0, 400) : null;
  return {
    value: x.value, status: x.status, source: x.sourceKind, confidence: x.confidence,
    observedAt: x.observedAt, evidence, verification: x.verification ?? null,
  };
};

export function askTools(data: AskData): AskTool[] {
  const infos = new Map<string, Promise<ObjectInfo | null>>();
  const info = async (object: string): Promise<ObjectInfo> => {
    if (!infos.has(object)) infos.set(object, data.describe(object));
    const found = await infos.get(object)!;
    if (!found) throw new Error(`Can't read ${object} records.`);
    return found;
  };
  return [
    {
      name: "describe_object",
      description: `The fields of one object (apiName, label, type, picklist values) so you can filter and read it. Objects: ${ASK_OBJECTS.join(", ")}.`,
      args: "object",
      async run(args) {
        const o = await info(objectArg(args.object));
        return {
          object: o.object, label: o.label,
          fields: o.fields.map((f) => ({
            apiName: f.apiName, label: f.label, type: f.type,
            ...(f.options ? { options: f.options.filter((x) => x.active !== false).map((x) => x.value) } : {}),
          })),
        };
      },
    },
    {
      name: "search_records",
      description: "Find records by name (accounts and contacts by name, other objects by title), best matches first. Use to get ids.",
      args: "q (text), objects? (array of object names; default account, contact, deal), limit? (max 20)",
      async run(args, seen) {
        const q = str(args.q);
        if (!q) throw new Error("q is required");
        const objects = Array.isArray(args.objects) && args.objects.length ? [...new Set(args.objects.map((o) => objectArg(o)))] : ["account", "contact", "deal"];
        const hits = await data.search(q, objects, limitArg(args.limit, SEARCH_MAX, 10));
        return { hits: hits.map((h) => note(seen, h.object, h.id, h.title)) };
      },
    },
    {
      name: "list_records",
      description: "List records of one object, with optional filters and sort, and the total matching. Filter ops: " + FILTER_OPS.join(", ") + ". Filter on `recordTitle` for the name. Dates are YYYY-MM-DD.",
      args: "object, filters? (array of {field, op, value}), sort? ({field, dir: asc|desc}), limit? (max 25)",
      async run(args, seen) {
        const object = objectArg(args.object);
        const o = await info(object);
        const sort = args.sort as { field?: unknown; dir?: unknown } | undefined;
        const page = await data.list(object, {
          filter: filtersArg(args.filters),
          ...(sort && typeof sort.field === "string" ? { sort: { field: sort.field.slice(0, 80), dir: sort.dir === "desc" ? "desc" as const : "asc" as const } } : {}),
          limit: limitArg(args.limit, LIST_MAX, 10),
        });
        return {
          total: page.total,
          rows: page.rows.map((r) => ({ ...note(seen, object, r.id, r.title), values: valuesOf(o, r) })),
        };
      },
    },
    {
      name: "get_record",
      description: "One record by id: its field values, the canonical facts behind them (state and source), and for an account its contacts.",
      args: "object, id",
      async run(args, seen) {
        const object = objectArg(args.object);
        const id = str(args.id, 300);
        if (!id) throw new Error("id is required");
        const o = await info(object);
        const page = await data.list(object, { filter: [{ field: "id", op: "eq", value: id }], limit: 1 });
        const row = page.rows[0];
        if (!row) return { error: "No such record in this workspace." };
        const ref = note(seen, object, row.id, row.title);
        const [facts, contacts] = await Promise.all([
          data.facts(object, row.id).catch(() => null),
          object === "account" ? data.accountContacts(row.id).catch(() => []) : Promise.resolve([]),
        ]);
        return {
          ...ref,
          values: valuesOf(o, row),
          ...(facts ? { facts: facts.slice(0, 40).map((f) => ({ attribute: f.attribute, value: f.value, state: f.state, source: f.sourceKind })) } : {}),
          ...(object === "account"
            ? {
                contacts: contacts.slice(0, CONTACTS_MAX).map((c) => ({
                  ...note(seen, "contact", c.id, c.fullName), title: c.title ?? null, email: c.email ?? null,
                })),
                contactCount: contacts.length,
              }
            : {}),
        };
      },
    },
    {
      name: "get_field_receipts",
      description: "Why Canon believes a value: every fact behind one field of an account, contact or deal, newest first, with source, confidence and the verbatim evidence.",
      args: "object (account, contact or deal), id, attribute (field apiName)",
      async run(args) {
        const object = objectArg(args.object);
        const attribute = str(args.attribute, 80);
        const id = str(args.id, 300);
        if (!id || !attribute) throw new Error("id and attribute are required");
        // The record must be one the caller's list returns: its facts are no one else's to read (CP14).
        const seen = await data.list(object, { filter: [{ field: "id", op: "eq", value: id }], limit: 1 });
        if (!seen.rows[0]) return { error: "No such record in this workspace." };
        const out =(await data.receipts(object, id, attribute)) as { state: unknown; facts: unknown[] } | null;
        if (!out) return { error: "No fact history for that record or field." };
        return { current: out.state, facts: out.facts.slice(0, RECEIPTS_MAX).map(trimFact) };
      },
    },
  ];
}
