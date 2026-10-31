/**
 * The HubSpot reads a portal import makes (CP12, docs/core-crm-parity.md). Read-only: every request is a GET or a
 * batch *read*, so an import never writes to HubSpot. A 403 means the token lacks the object's scope; it surfaces as
 * `HubspotScopeError` so the import skips that object with a visible reason instead of failing.
 *
 * Pure apart from `fetch`: no Node-only imports (Convex default runtime). Tokens never appear in errors.
 */

export const HUBSPOT_API = "https://api.hubapi.com";

export type HsRecordObject = "companies" | "contacts" | "deals";
export type HsEngagementObject = "calls" | "meetings" | "notes" | "tasks" | "emails";
export type HsObject = HsRecordObject | HsEngagementObject;

export type HsHistoryEntry = { value: string; timestamp: string; sourceType?: string };
export type HsRecord = {
  id: string;
  /** v3's associations on a list read, when asked for: `{ companies: { results: [{ id, type }] } }`. */
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
  properties: Record<string, string | null | undefined>;
  propertiesWithHistory?: Record<string, HsHistoryEntry[]>;
  createdAt?: string;
  updatedAt?: string;
};
export type HsPage = { results: HsRecord[]; after: string | null };
export type HsOwner = { id: string; email?: string; firstName?: string; lastName?: string; archived?: boolean };
export type HsStage = { id: string; label: string; displayOrder?: number; archived?: boolean; metadata?: { probability?: string; isClosed?: string } };
export type HsPipeline = { id: string; label: string; displayOrder?: number; archived?: boolean; stages: HsStage[] };
/** A property definition. `hubspotDefined` ones are HubSpot's own; the rest are the portal's custom properties. */
export type HsProperty = {
  name: string; label: string; type: string; fieldType: string; hubspotDefined?: boolean; calculated?: boolean; hidden?: boolean; archived?: boolean;
  options?: Array<{ label: string; value: string; hidden?: boolean }>;
};
export type HsAssociationType = { category: string; typeId: number; label: string | null };
export type HsAssociation = { toObjectId: string; associationTypes: HsAssociationType[] };

export class HubspotScopeError extends Error {
  readonly object: string;
  constructor(object: string) {
    super(`The HubSpot token cannot read ${object}`);
    this.object = object;
  }
}

export interface HubspotImportClient {
  owners(): Promise<HsOwner[]>;
  dealPipelines(): Promise<HsPipeline[]>;
  /** One page of an object's records with these properties, and the history of `history` (HubSpot then pages by 50). */
  page(object: HsObject, opts: { after: string | null; properties: readonly string[]; history?: readonly string[]; associations?: readonly HsRecordObject[] }): Promise<HsPage>;
  /** An object's property definitions. */
  properties(object: HsRecordObject): Promise<HsProperty[]>;
  /** How many records of an object the portal holds (a search's total; a search is a read). */
  count(object: HsRecordObject): Promise<number>;
  /** Attachments' names and links, by file id (the Files API; a 403 is a HubspotScopeError). */
  files(ids: readonly string[]): Promise<Map<string, { name: string; url: string | null }>>;
  /** Each record's associations to `to`, by the record's id. */
  associations(from: HsObject, to: HsRecordObject, ids: readonly string[]): Promise<Map<string, HsAssociation[]>>;
}

export type HubspotClientOptions = {
  getAccessToken: () => string | Promise<string>;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const PAGE = 100;
const HISTORY_PAGE = 50;

export function createHubspotImportClient(o: HubspotClientOptions): HubspotImportClient {
  const base = (o.apiBaseUrl ?? HUBSPOT_API).replace(/\/$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const maxRetries = o.maxRetries ?? 5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(object: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${await o.getAccessToken()}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.ok) return (await res.json()) as T;
      await res.text().catch(() => undefined);
      if (res.status === 403) throw new HubspotScopeError(object);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) throw new Error(`HubSpot API error ${res.status} reading ${object}`);
      const after = Number(res.headers.get("Retry-After"));
      await sleep(Math.min(30_000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt));
    }
  }

  async function all<T>(object: string, path: string): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    do {
      const page = await call<{ results?: T[]; paging?: { next?: { after?: string } } }>(object, `${path}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      out.push(...(page.results ?? []));
      after = page.paging?.next?.after;
    } while (after);
    return out;
  }

  return {
    async owners() {
      const [active, archived] = await Promise.all([
        all<HsOwner>("owners", `/crm/v3/owners?limit=${PAGE}&archived=false`),
        all<HsOwner>("owners", `/crm/v3/owners?limit=${PAGE}&archived=true`),
      ]);
      return [...active, ...archived.map((x) => ({ ...x, archived: true }))];
    },
    async dealPipelines() {
      return (await call<{ results?: HsPipeline[] }>("pipelines", "/crm/v3/pipelines/deals")).results ?? [];
    },
    async page(object, opts) {
      const q = new URLSearchParams({ limit: String(opts.history?.length ? HISTORY_PAGE : PAGE), archived: "false" });
      if (opts.properties.length) q.set("properties", opts.properties.join(","));
      if (opts.history?.length) q.set("propertiesWithHistory", opts.history.join(","));
      if (opts.associations?.length) q.set("associations", opts.associations.join(","));
      if (opts.after) q.set("after", opts.after);
      const page = await call<{ results?: HsRecord[]; paging?: { next?: { after?: string } } }>(object, `/crm/v3/objects/${object}?${q}`);
      return { results: page.results ?? [], after: page.paging?.next?.after ?? null };
    },
    async files(ids) {
      const out = new Map<string, { name: string; url: string | null }>();
      for (const id of ids) {
        const f = await call<{ name?: string; extension?: string; url?: string }>("files", `/files/v3/files/${encodeURIComponent(id)}`);
        out.set(id, { name: [f.name, f.extension].filter(Boolean).join(".") || `file ${id}`, url: f.url ?? null });
      }
      return out;
    },
    async properties(object) {
      return (await call<{ results?: HsProperty[] }>(object, `/crm/v3/properties/${object}?archived=false`)).results ?? [];
    },
    async count(object) {
      return (await call<{ total?: number }>(object, `/crm/v3/objects/${object}/search`, { limit: 1, filterGroups: [] })).total ?? 0;
    },
    async associations(from, to, ids) {
      const out = new Map<string, HsAssociation[]>();
      for (let i = 0; i < ids.length; i += PAGE) {
        const inputs = ids.slice(i, i + PAGE).map((id) => ({ id }));
        const res = await call<{ results?: Array<{ from: { id: string }; to: HsAssociation[] }> }>(from, `/crm/v4/associations/${from}/${to}/batch/read`, { inputs });
        for (const r of res.results ?? []) out.set(String(r.from.id), r.to.map((t) => ({ ...t, toObjectId: String(t.toObjectId) })));
      }
      return out;
    },
  };
}
