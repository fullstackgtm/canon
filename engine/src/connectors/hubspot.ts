import {
  HUBSPOT_DEFAULT_FIELD_MAPPINGS,
  mappedField,
  mappedFields,
  readMappedValue,
  type CrmObjectType,
  type FieldMappings,
} from "../mappings.ts";
import type {
  CanonicalAccount,
  CanonicalContact,
  CanonicalDeal,
  RecordProvenance,
  CanonicalGtmSnapshot,
  CanonicalUser,
  CreateRecordPayload,
  GtmConnector,
  GtmObjectType,
  PatchOperation,
  PatchOperationResult,
  SnapshotProgress,
} from "../types.ts";
import { SNAPSHOT_PULL_STAGES, type ProgressEmitter } from "../progress.ts";
import { createHubspotPacer, type HubspotRateLimitObservation } from "./hubspotPacing.ts";

const DEFAULT_API_BASE_URL = "https://api.hubapi.com";

/**
 * A snapshot whose parts are read at once: each object's pages are fetched in parallel with the others, and a caller
 * awaits each part when it needs it, so it can write owners and companies while people and deals are still arriving.
 */
export type HubspotSnapshotPull = {
  users: Promise<CanonicalUser[]>;
  accounts: Promise<CanonicalAccount[]>;
  contacts: Promise<CanonicalContact[]>;
  deals: Promise<CanonicalDeal[]>;
};

/** The objects a sync reads page by page, and the canonical record each page holds. */
export type HubspotSyncObject = "companies" | "contacts" | "deals";
export type HubspotSyncRecord = { companies: CanonicalAccount; contacts: CanonicalContact; deals: CanonicalDeal };
export type HubspotSyncPage<T extends HubspotSyncObject> = { rows: HubspotSyncRecord[T][]; next: string | null };
/** Records last modified in [since, until), epoch milliseconds. */
export type HubspotModifiedWindow = { since: number; until: number };

export type HubspotWritableConnector = GtmConnector & Required<Pick<GtmConnector, "applyOperation" | "readField">> & {
  pullSnapshot(): HubspotSnapshotPull;
  /** The portal's owners, as canonical users. */
  fetchUsers(): Promise<CanonicalUser[]>;
  /** One page of every record (the list API, companies inline), and the cursor of the next, or null after the last. */
  readPage<T extends HubspotSyncObject>(object: T, after: string | null): Promise<HubspotSyncPage<T>>;
  /**
   * One page of the records modified in `window`, by id after `afterId` (the search API, companies read alongside).
   * Paging by id instead of search's offset never passes its 10,000-result cap, and a record modified mid-read leaves
   * the window without shifting the ones after it; the next sync's window starts before this one ended, so it is read then.
   */
  readModifiedPage<T extends HubspotSyncObject>(object: T, window: HubspotModifiedWindow, afterId: string | null): Promise<HubspotSyncPage<T>>;
  /** How many records there are, or were modified in `window`: progress totals only. */
  countRecords(object: HubspotSyncObject, window?: HubspotModifiedWindow): Promise<number | undefined>;
  /**
   * The record ids at these ranks (0-based, ascending) in id order, to split a full read into ranges of as many
   * records each; fewer when the object has fewer records. Search reads a rank at most 9,999 past an id it filters
   * from, so a rank further on is reached in hops.
   */
  idsAtRanks(object: HubspotSyncObject, ranks: readonly number[]): Promise<number[]>;
  /** The lowest record id at or above `from`, by search; undefined when there is none. */
  firstIdFrom(object: HubspotSyncObject, from: number): Promise<number | undefined>;
  /** The portal's request window as HubSpot last reported it (list and batch responses carry it; search does not). */
  rateLimitSeen(): HubspotRateLimitObservation | undefined;
};

export type HubspotConnectorOptions = {
  /** Returns a HubSpot access token (private app token or OAuth access token). */
  getAccessToken: () => string | Promise<string>;
  /** Per-org canonical-to-provider field overrides. Defaults cover standard properties. */
  fieldMappings?: FieldMappings;
  apiBaseUrl?: string;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Per-page snapshot-pull progress (presentation only — errors are swallowed). */
  onProgress?: (progress: SnapshotProgress) => void;
  /**
   * Shared progress vocabulary (src/progress.ts): the snapshot pull emits a
   * `stage` per object type and an `items` heartbeat per page. Additive
   * alongside the legacy `onProgress` callback; both are presentation-only.
   */
  progress?: ProgressEmitter;
  /** Maximum retries for HubSpot 429/5xx responses (default 5). */
  maxRetries?: number;
  /** Injectable delay for deterministic retry tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** HubSpot requests in flight at once (default 4); each also waits out a nearly spent rate-limit window. */
  maxConcurrent?: number;
};

const OBJECT_PATHS: Partial<Record<GtmObjectType, string>> = {
  account: "companies",
  contact: "contacts",
  deal: "deals",
};

const MAPPING_OBJECT_TYPES: Partial<Record<GtmObjectType, Exclude<CrmObjectType, "owners">>> = {
  account: "accounts",
  contact: "contacts",
  deal: "deals",
};

// SnapshotProgress object types → the shared SNAPSHOT_PULL_STAGES names, so
// the CLI checklist and the app StageTimeline read the same stage labels.
const PULL_STAGE_BY_TYPE: Record<SnapshotProgress["objectType"], (typeof SNAPSHOT_PULL_STAGES)[number]> = {
  user: "owners",
  account: "accounts",
  contact: "contacts",
  deal: "deals",
};

/**
 * Reference connector for HubSpot.
 *
 * Unlike sync pipelines that drop records they cannot fully resolve, the
 * connector returns every record it can read — including ownerless or
 * amountless deals — so audit rules can surface the gaps instead of hiding
 * them.
 */
export function createHubspotConnector(options: HubspotConnectorOptions): HubspotWritableConnector {
  const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 5;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const mappings = options.fieldMappings;
  const pacer = createHubspotPacer({ maxConcurrent: options.maxConcurrent ?? 4, sleep });
  // create:<Name> dedup within one connector lifetime (one apply run): the
  // search API is eventually consistent, so a just-created company is
  // invisible to search — this map is the authoritative same-run record.
  const createdCompaniesByName = new Map<string, string>();
  // Same-run dedup for `create_record` contact creates, keyed by lowercased
  // match value (email): HubSpot search is eventually consistent, so a contact
  // created earlier in this apply run is invisible to a later search.
  const createdContactsByMatch = new Map<string, string>();
  // Same-run dedup for `create_record` deal creates, keyed by
  // matchKey:matchValue (e.g. stripe_invoice_id:in_123) — same
  // eventual-consistency rationale as the contact cache.
  const createdDealsByMatch = new Map<string, string>();
  // One /crm/v3/pipelines/deals read per connector lifetime (one apply run):
  // pipeline/stage metadata doesn't change mid-run, and deal creates resolve
  // the closed-won stage from it per operation.
  let dealPipelinesCache: Promise<any[]> | undefined;
  // Custom deal dedupe properties ensured (or confirmed missing) this run.
  const ensuredDealProperties = new Map<string, boolean>();

  // Per-page snapshot-pull progress: the legacy onProgress callback plus the
  // shared emitter (stage on the first page of each object type, items per
  // page). Both are presentation-only — callers already swallow errors.
  let lastPullStage: string | undefined;
  const pullProgress = (objectType: SnapshotProgress["objectType"], fetched: number) => {
    options.onProgress?.({ objectType, fetched });
    const emitter = options.progress;
    if (!emitter) return;
    const stage = PULL_STAGE_BY_TYPE[objectType];
    if (stage !== lastPullStage) {
      lastPullStage = stage;
      emitter.stage(stage, SNAPSHOT_PULL_STAGES.indexOf(stage), SNAPSHOT_PULL_STAGES.length);
    }
    emitter.items(fetched);
  };

  async function request(path: string, init: RequestInit = {}): Promise<any> {
    let response: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const token = await options.getAccessToken();
      try {
        response = await pacer.send(() => fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
          },
        }));
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
        throw new Error(`Cannot reach HubSpot at ${baseUrl}${cause}. Check network access.`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) break;
      await response.text().catch(() => undefined);
      const retryAfter = response.headers.get("Retry-After");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : NaN;
      const delayMs = Math.min(
        30_000,
        Math.max(0, Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(dateDelay) ? dateDelay : 1_000 * 2 ** attempt),
      );
      const reason = response.status === 429 ? "rate limited" : `temporarily unavailable (${response.status})`;
      options.progress?.note(`HubSpot ${reason}; retrying in ${Math.ceil(delayMs / 1_000)}s (${attempt + 1}/${maxRetries})`);
      await sleep(delayMs);
    }
    if (!response || !response.ok) {
      // Status line only — HubSpot 4xx bodies echo submitted property values
      // (contact emails, company domains) and the request payload, and these
      // errors are persisted into scheduled-run records. Never interpolate it.
      await response?.text().catch(() => undefined);
      if (response?.status === 429) {
        throw new Error(`HubSpot rate limit (429) persisted after ${maxRetries} retries. Wait for the portal limit to reset, then retry; no CRM writes were made.`);
      }
      if (response?.status === 403) {
        const scope = hubspotScopeFor(path, init.method ?? "GET");
        throw new Error(`HubSpot API error 403 on ${init.method ?? "GET"} ${path.split("?")[0]}: the token is missing a scope${scope ? ` (likely ${scope})` : ""}.`);
      }
      throw new Error(`HubSpot API error ${response?.status ?? "unknown"} on ${init.method ?? "GET"} ${path.split("?")[0]}. Check the token scopes and request.`);
    }
    // DELETE and some association writes return 204 with an empty body.
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Map every deal stage id → its actual closed/won semantics, read from the
   * pipeline definitions. Custom pipelines use opaque stage ids (e.g.
   * "1234567"), so deriving closed/won by substring-matching the stage value
   * against "closedwon"/"closedlost" mis-reads every custom-pipeline deal as
   * open. The pipeline's own stage metadata is authoritative: `isClosed` marks
   * a closed stage and `probability` 1.0 = won, 0.0 = lost. Best-effort — if
   * the read is unavailable (e.g. missing scope) callers fall back to the
   * substring heuristic so a partial-scope token still produces a snapshot.
   */
  async function fetchDealStageClose(): Promise<Map<string, { isClosed: boolean; isWon: boolean }>> {
    try {
      return hubspotStageClose((await request("/crm/v3/pipelines/deals"))?.results ?? []);
    } catch {
      // Pipeline metadata unavailable: an empty map, and the caller falls back to the substring heuristic.
      return new Map();
    }
  }

  async function list(path: string, onPage?: (fetched: number) => void): Promise<any[]> {
    const results: any[] = [];
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      // Guard against a provider returning a repeating cursor (would loop
      // forever): stop if the same `after` is handed back twice.
      if (after) {
        if (seen.has(after)) break;
        seen.add(after);
      }
      const separator = path.includes("?") ? "&" : "?";
      const data = await request(`${path}${after ? `${separator}after=${encodeURIComponent(after)}` : ""}`);
      results.push(...(data.results ?? []));
      try {
        onPage?.(results.length);
      } catch {
        // progress is presentation-only; never let it fail a pull
      }
      after = data.paging?.next?.after;
    } while (after);
    return results;
  }

  async function fetchUsers(): Promise<CanonicalUser[]> {
    const owners = await list("/crm/v3/owners?limit=100", (fetched) => pullProgress("user", fetched));
    return owners.filter((owner) => owner.id).map((owner) => ({
      id: String(owner.id),
      provider: "hubspot",
      crmId: String(owner.id),
      identities: [{ provider: "hubspot", externalId: String(owner.id) }],
      name: [owner.firstName, owner.lastName].filter(Boolean).join(" ") || stringOrFallback(owner.email, `Owner ${owner.id}`),
      email: stringOrUndefined(owner.email),
      active: owner.archived !== true,
    }));
  }

  async function assembleSnapshot(
    fetchObjects: (
      objectType: "companies" | "contacts" | "deals",
      properties: string,
      withAssociations: boolean,
    ) => Promise<any[]>,
  ): Promise<CanonicalGtmSnapshot> {
    const users = await fetchUsers();

    const companies = await fetchObjects("companies", hubspotProperties("accounts", mappings), false);
    const accounts = companies.filter((company) => company.id).map((company) => hubspotAccount(company, mappings));
    const hubspotContacts = await fetchObjects("contacts", hubspotProperties("contacts", mappings), true);
    const contacts = hubspotContacts.filter((contact) => contact.id).map((contact) => hubspotContact(contact, mappings));
    const stageClose = await fetchDealStageClose();
    const hubspotDeals = await fetchObjects("deals", hubspotProperties("deals", mappings), true);
    const deals = hubspotDeals.filter((deal) => deal.id).map((deal) => hubspotDeal(deal, mappings, stageClose));

    // Deliver any throttled trailing items heartbeat before the pull returns.
    options.progress?.flush();

    return {
      generatedAt: new Date().toISOString(),
      provider: "hubspot",
      users,
      accounts,
      contacts,
      deals,
      // Engagement reads need additional scopes; activity staleness falls back
      // to record sync timestamps until engagements are supported.
      activities: [],
    };
  }

  const canonicalType = { companies: "account", contacts: "contact", deals: "deal" } as const;
  const listObjects = (objectType: "companies" | "contacts" | "deals", properties: string, withAssociations: boolean, onPage?: (fetched: number) => void) =>
    list(`/crm/v3/objects/${objectType}?limit=100&properties=${properties}${withAssociations ? "&associations=companies" : ""}`, onPage);

  async function fetchSnapshot(): Promise<CanonicalGtmSnapshot> {
    return assembleSnapshot((objectType, properties, withAssociations) =>
      listObjects(objectType, properties, withAssociations, (fetched) => pullProgress(canonicalType[objectType], fetched)),
    );
  }

  /** The snapshot fetchSnapshot reads, with every object's pages fetched at once (the pacer keeps them in the rate limit). */
  function pullSnapshot(): HubspotSnapshotPull {
    const settled = <T>(p: Promise<T>) => {
      // A part nobody awaits yet (the caller is still writing an earlier one) must not reject unhandled.
      p.catch(() => undefined);
      return p;
    };
    const stageClose = fetchDealStageClose();
    return {
      users: settled(fetchUsers()),
      accounts: settled(listObjects("companies", hubspotProperties("accounts", mappings), false).then((rows) => rows.filter((c) => c.id).map((c) => hubspotAccount(c, mappings)))),
      contacts: settled(listObjects("contacts", hubspotProperties("contacts", mappings), true).then((rows) => rows.filter((c) => c.id).map((c) => hubspotContact(c, mappings)))),
      deals: settled(Promise.all([stageClose, listObjects("deals", hubspotProperties("deals", mappings), true)]).then(([close, rows]) => rows.filter((d) => d.id).map((d) => hubspotDeal(d, mappings, close)))),
    };
  }

  let stageCloseCache: Promise<Map<string, { isClosed: boolean; isWon: boolean }>> | undefined;
  const PROPERTY_SET = { companies: "accounts", contacts: "contacts", deals: "deals" } as const;

  async function canonicalRows<T extends HubspotSyncObject>(object: T, records: any[]): Promise<HubspotSyncRecord[T][]> {
    const rows = records.filter((r) => r.id);
    if (object === "companies") return rows.map((r) => hubspotAccount(r, mappings)) as HubspotSyncRecord[T][];
    if (object === "contacts") return rows.map((r) => hubspotContact(r, mappings)) as HubspotSyncRecord[T][];
    const close = await (stageCloseCache ??= fetchDealStageClose());
    return rows.map((r) => hubspotDeal(r, mappings, close)) as HubspotSyncRecord[T][];
  }

  async function readPage<T extends HubspotSyncObject>(object: T, after: string | null): Promise<HubspotSyncPage<T>> {
    const data = await request(
      `/crm/v3/objects/${object}?limit=100&properties=${hubspotProperties(PROPERTY_SET[object], mappings)}${object === "companies" ? "" : "&associations=companies"}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    const next = data.paging?.next?.after;
    // A provider handing the same cursor back would loop forever.
    return { rows: await canonicalRows(object, data.results ?? []), next: next && next !== after ? String(next) : null };
  }

  /** Each record's companies as the list API's inline `associations` reads them (`<object>_to_company` is the primary). */
  async function withCompanies(object: "contacts" | "deals", records: any[]): Promise<any[]> {
    if (!records.length) return records;
    const data = await request(`/crm/v4/associations/${object}/companies/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: records.map((r) => ({ id: String(r.id) })) }),
    });
    const single = object === "contacts" ? "contact" : "deal";
    const byId = new Map<string, Array<{ id: string; type: string }>>();
    for (const result of data.results ?? []) {
      byId.set(String(result.from?.id), (result.to ?? []).map((to: any) => ({
        id: String(to.toObjectId),
        // HubSpot's primary company association (contact 1, deal 5) is labelled "Primary".
        type: (to.associationTypes ?? []).some((t: any) => t.label === "Primary" || (t.category === "HUBSPOT_DEFINED" && t.typeId === (single === "contact" ? 1 : 5)))
          ? `${single}_to_company`
          : `${single}_to_company_unlabeled`,
      })));
    }
    return records.map((r) => ({ ...r, associations: { companies: { results: byId.get(String(r.id)) ?? [] } } }));
  }

  // HubSpot holds search to five requests a second per portal and sends no rate-limit headers on it for the pacer to
  // read, so a sync's search requests start at least this far apart.
  const SEARCH_SPACING_MS = 220;
  let nextSearchAt = 0;
  async function searchSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSearchAt);
    nextSearchAt = at + SEARCH_SPACING_MS;
    if (at > now) await sleep(at - now);
  }

  async function modifiedSearch(object: HubspotSyncObject, window: HubspotModifiedWindow | undefined, afterId: string | null, limit: number) {
    const modified = MODIFIED_DATE_PROPERTIES[object];
    const filters = [
      ...(window ? [{ propertyName: modified, operator: "GTE", value: String(window.since) }, { propertyName: modified, operator: "LT", value: String(window.until) }] : []),
      ...(afterId ? [{ propertyName: "hs_object_id", operator: "GT", value: afterId }] : []),
    ];
    await searchSlot();
    return request(`/crm/v3/objects/${object}/search`, {
      method: "POST",
      body: JSON.stringify({
        ...(filters.length ? { filterGroups: [{ filters }] } : {}),
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties: hubspotProperties(PROPERTY_SET[object], mappings).split(","),
        limit,
      }),
    });
  }

  async function readModifiedPage<T extends HubspotSyncObject>(object: T, window: HubspotModifiedWindow, afterId: string | null): Promise<HubspotSyncPage<T>> {
    const SEARCH_PAGE = 200;
    const data = await modifiedSearch(object, window, afterId, SEARCH_PAGE);
    const results: any[] = data.results ?? [];
    const records = object === "companies" ? results : await withCompanies(object as "contacts" | "deals", results);
    const last = results.at(-1)?.id;
    return { rows: await canonicalRows(object, records), next: results.length === SEARCH_PAGE && last ? String(last) : null };
  }

  async function countRecords(object: HubspotSyncObject, window?: HubspotModifiedWindow): Promise<number | undefined> {
    try {
      const total = Number((await modifiedSearch(object, window, null, 1))?.total);
      return Number.isFinite(total) ? total : undefined;
    } catch {
      return undefined;
    }
  }

  async function idsAtRanks(object: HubspotSyncObject, ranks: readonly number[]): Promise<number[]> {
    // The id `offset` records past `afterId` (from the start without one), or undefined past the last.
    const idAt = async (afterId: string | null, offset: number): Promise<string | undefined> => {
      await searchSlot();
      const data = await request(`/crm/v3/objects/${object}/search`, {
        method: "POST",
        body: JSON.stringify({
          ...(afterId ? { filterGroups: [{ filters: [{ propertyName: "hs_object_id", operator: "GT", value: afterId }] }] } : {}),
          sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
          properties: ["hs_object_id"],
          limit: 1,
          after: String(offset),
        }),
      });
      const id = data?.results?.[0]?.id;
      return id === undefined ? undefined : String(id);
    };
    const HOP = 9_999;
    const ids: number[] = [];
    // `afterId` holds the record at rank `base - 1`: the ones after it start at rank `base`.
    let afterId: string | null = null;
    let base = 0;
    for (const rank of ranks) {
      while (rank - base > HOP) {
        const hop = await idAt(afterId, HOP);
        if (hop === undefined) return ids;
        afterId = hop;
        base += HOP + 1;
      }
      const id = await idAt(afterId, rank - base);
      if (id === undefined) return ids;
      ids.push(Number(id));
      afterId = id;
      base = rank + 1;
    }
    return ids;
  }

  async function firstIdFrom(object: HubspotSyncObject, from: number): Promise<number | undefined> {
    await searchSlot();
    const data = await request(`/crm/v3/objects/${object}/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "hs_object_id", operator: "GTE", value: String(from) }] }],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties: ["hs_object_id"],
        limit: 1,
      }),
    });
    const id = Number(data?.results?.[0]?.id);
    return Number.isFinite(id) ? id : undefined;
  }

  const MODIFIED_DATE_PROPERTIES = {
    companies: "hs_lastmodifieddate",
    contacts: "lastmodifieddate",
    deals: "hs_lastmodifieddate",
  } as const;

  async function searchList(
    objectType: "companies" | "contacts" | "deals",
    properties: string,
    sinceMs: number,
  ): Promise<any[]> {
    const results: any[] = [];
    let after: string | undefined;
    // HubSpot's search API hard-caps at 10,000 results (100 pages of 100) and
    // 400s past it. Stop at the boundary rather than throwing mid-sync; an
    // incremental window this large should fall back to a full snapshot.
    const MAX_PAGES = 100;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await request(`/crm/v3/objects/${objectType}/search`, {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: MODIFIED_DATE_PROPERTIES[objectType],
                  operator: "GTE",
                  value: String(sinceMs),
                },
              ],
            },
          ],
          properties: properties.split(","),
          limit: 100,
          ...(after ? { after } : {}),
        }),
      });
      results.push(...(data.results ?? []));
      const next = data.paging?.next?.after;
      if (!next || next === after) break;
      after = next;
    }
    return results;
  }

  /**
   * Records modified since `sinceIso`, via the CRM search API. HubSpot search
   * results carry no associations, so contact/deal accountIds are absent in
   * change feeds — consumers merging deltas must preserve associations from
   * the last full snapshot.
   */
  async function fetchChanges(sinceIso: string): Promise<CanonicalGtmSnapshot> {
    const sinceMs = Date.parse(sinceIso);
    if (!Number.isFinite(sinceMs)) throw new Error(`Invalid since timestamp: ${sinceIso}`);
    return assembleSnapshot((objectType, properties) =>
      searchList(objectType, properties, sinceMs),
    );
  }

  // HubSpot-defined association type ids from a task engagement to its parent.
  const TASK_ASSOCIATION_TYPE_IDS: Partial<Record<GtmObjectType, number>> = {
    contact: 204,
    account: 192,
    deal: 216,
  };

  function humanizeField(field: string): string {
    return field
      .replace(/_task$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  async function setField(operation: PatchOperation): Promise<PatchOperationResult> {
    const objectPath = OBJECT_PATHS[operation.objectType];
    const mappingType = MAPPING_OBJECT_TYPES[operation.objectType];
    if (!objectPath || !mappingType || !operation.field) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "Field writes are only supported for accounts, contacts, and deals with an explicit field.",
      };
    }
    const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
    const property = mappedField(
      mappings,
      mappingType,
      operation.field,
      defaults[operation.field] ?? operation.field,
    );
    const value =
      operation.operation === "clear_field" ? "" : String(operation.afterValue ?? "");
    const response = await request(
      `/crm/v3/objects/${objectPath}/${encodeURIComponent(operation.objectId)}`,
      { method: "PATCH", body: JSON.stringify({ properties: { [property]: value } }) },
    );
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Set ${property} on ${objectPath}/${operation.objectId}.`,
      providerData: { id: response?.id, property },
    };
  }

  async function linkRecord(operation: PatchOperation): Promise<PatchOperationResult> {
    if (operation.objectType === "account" && operation.field === "parentAccountId") {
      const parentId = String(operation.afterValue ?? "");
      if (!parentId) return { operationId: operation.id, status: "skipped", detail: "A parent link needs a target company id." };
      // HubSpot-defined association type 14 is child → parent company. The
      // inverse relationship is maintained by HubSpot; no second write needed.
      await request(
        `/crm/v4/objects/companies/${encodeURIComponent(operation.objectId)}/associations/companies/${encodeURIComponent(parentId)}`,
        {
          method: "PUT",
          body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 14 }]),
        },
      );
      return {
        operationId: operation.id,
        status: "applied",
        detail: `Linked companies/${operation.objectId} to parent company ${parentId}.`,
        providerData: { parentAccountId: parentId, associationTypeId: 14 },
      };
    }
    // Associate a deal or contact with a company (the only link the built-in
    // rules emit — missing-deal-account). afterValue is the target company id.
    const fromPath = OBJECT_PATHS[operation.objectType];
    if ((operation.objectType !== "deal" && operation.objectType !== "contact") || !fromPath) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "link_record is supported for account parent links and for deals or contacts linked to a company.",
      };
    }
    let companyId = String(operation.afterValue ?? "");
    if (!companyId) {
      return { operationId: operation.id, status: "skipped", detail: "link_record needs a target company id." };
    }
    // `create:<Name>` is resolve-first: link to an existing company when one
    // unambiguously matches, refuse on ambiguity, create only on a confirmed
    // miss — and never create the same name twice within one apply run
    // (HubSpot's search API is eventually consistent, so a just-created
    // record is invisible to search for several seconds).
    let createdCompanyName: string | null = null;
    let resolvedExisting = false;
    if (companyId.startsWith("create:")) {
      const name = companyId.slice("create:".length).trim();
      if (!name) {
        return { operationId: operation.id, status: "skipped", detail: "create: needs a company name (create:<Name>)." };
      }
      const nameKey = name.toLowerCase();
      const alreadyCreated = createdCompaniesByName.get(nameKey);
      if (alreadyCreated) {
        companyId = alreadyCreated;
        resolvedExisting = true;
      } else {
        const matches = await searchCompaniesByName(name);
        if (matches.length > 1) {
          return {
            operationId: operation.id,
            status: "skipped",
            detail: `create:${name} is ambiguous — ${matches.length} companies already named "${name}" (ids ${matches.join(", ")}). Link an explicit company id instead.`,
          };
        }
        if (matches.length === 1) {
          companyId = matches[0];
          resolvedExisting = true;
          createdCompaniesByName.set(nameKey, companyId);
        } else {
          let created;
          try {
            created = await request(`/crm/v3/objects/companies`, {
              method: "POST",
              body: JSON.stringify({
                properties: { name, hs_object_source_detail_2: `fullstackgtm create: (${operation.id})` },
              }),
            });
          } catch {
            // Some portals reject writes to source-detail properties — the
            // provenance stamp is best-effort, the create is not.
            created = await request(`/crm/v3/objects/companies`, {
              method: "POST",
              body: JSON.stringify({ properties: { name } }),
            });
          }
          companyId = String(created.id);
          createdCompanyName = name;
          createdCompaniesByName.set(nameKey, companyId);
        }
      }
    }
    await request(
      `/crm/v4/objects/${fromPath}/${encodeURIComponent(operation.objectId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
      { method: "PUT" },
    );
    return {
      operationId: operation.id,
      status: "applied",
      detail: createdCompanyName
        ? `Created company "${createdCompanyName}" (${companyId}) and linked ${fromPath}/${operation.objectId} to it.`
        : resolvedExisting
          ? `Linked ${fromPath}/${operation.objectId} to existing company ${companyId} (resolved by name, nothing created).`
          : `Linked ${fromPath}/${operation.objectId} to company ${companyId}.`,
      providerData: { companyId, ...(createdCompanyName ? { createdCompany: true } : {}) },
    };
  }

  /** Exact-value company lookup (by `name` or `domain`) for resolve-first creates. */
  async function searchCompaniesBy(property: string, value: string): Promise<string[]> {
    const data = await request(`/crm/v3/objects/companies/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
        properties: [property],
        limit: 3,
      }),
    });
    return ((data?.results ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  }
  const searchCompaniesByName = (name: string) => searchCompaniesBy("name", name);

  /** Stamp `domain` on a company only when it has none (fill-blank, never clobber). */
  async function fillCompanyDomainIfEmpty(companyId: string, domain: string): Promise<void> {
    try {
      const data = await request(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=domain`);
      const current = data?.properties?.domain;
      if (typeof current === "string" && current.trim()) return; // already has one — leave it
      await request(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: { domain } }),
      });
    } catch {
      // Best-effort: a failed domain fill must not sink the contact create.
    }
  }

  /** Exact-value contact lookup (by any searchable property) for resolve-first creates. */
  async function searchContactsBy(property: string, value: string): Promise<string[]> {
    const data = await request(`/crm/v3/objects/contacts/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
        properties: [property],
        limit: 3,
      }),
    });
    return ((data?.results ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  }

  /**
   * Resolve a company to a real account record, creating it on a confirmed miss.
   * Matches by DOMAIN first (the accurate key) and falls back to exact name;
   * creates with the domain stamped, and fills the domain on a name-matched
   * account that lacks one — so the account is signal-watchable. Returns null on
   * ambiguity (≥2 matches) so the caller skips the association rather than
   * guessing. Same-run safe via createdCompaniesByName.
   */
  async function resolveOrCreateCompany(name: string, domain: string | undefined, opId: string): Promise<string | null> {
    const cacheKey = domain ? `d:${domain.toLowerCase()}` : `n:${name.toLowerCase()}`;
    const already = createdCompaniesByName.get(cacheKey);
    if (already) return already;

    // 1. Domain-first match (accurate; an account matched here already has it).
    if (domain) {
      const byDomain = await searchCompaniesBy("domain", domain);
      if (byDomain.length > 1) return null;
      if (byDomain.length === 1) {
        createdCompaniesByName.set(cacheKey, byDomain[0]);
        return byDomain[0];
      }
    }
    // 2. Exact-name match; stamp the domain if the account has none.
    const byName = await searchCompaniesByName(name);
    if (byName.length > 1) return null;
    if (byName.length === 1) {
      if (domain) await fillCompanyDomainIfEmpty(byName[0], domain);
      createdCompaniesByName.set(cacheKey, byName[0]);
      return byName[0];
    }
    // 3. Create with name + domain (provenance is best-effort).
    const props: Record<string, string> = { name, ...(domain ? { domain } : {}) };
    let created;
    try {
      created = await request(`/crm/v3/objects/companies`, {
        method: "POST",
        body: JSON.stringify({ properties: { ...props, hs_object_source_detail_2: `fullstackgtm acquire (${opId})` } }),
      });
    } catch {
      created = await request(`/crm/v3/objects/companies`, {
        method: "POST",
        body: JSON.stringify({ properties: props }),
      });
    }
    const id = String(created.id);
    createdCompaniesByName.set(cacheKey, id);
    return id;
  }

  /** Exact-value deal lookup (by any searchable property) for resolve-first creates. */
  async function searchDealsBy(property: string, value: string): Promise<string[]> {
    const data = await request(`/crm/v3/objects/deals/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
        properties: [property],
        limit: 3,
      }),
    });
    return ((data?.results ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  }

  /**
   * Make sure the deal dedupe property (e.g. "stripe_invoice_id") exists so
   * both the resolve-first search and the stamped value are real. Best-effort
   * create on a confirmed miss; returns false when the property can neither
   * be read nor created — the caller must SKIP then (creating a deal without
   * its dedupe key would make every replay a duplicate).
   */
  async function ensureDealProperty(name: string): Promise<boolean> {
    const cached = ensuredDealProperties.get(name);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      await request(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
      ok = true;
    } catch {
      // Missing (404) or unreadable — try to create it; a failure here means
      // we cannot guarantee the dedupe key, so report false.
      try {
        await request(`/crm/v3/properties/deals`, {
          method: "POST",
          body: JSON.stringify({
            name,
            label: name,
            type: "string",
            fieldType: "text",
            groupName: "dealinformation",
            hasUniqueValue: false,
          }),
        });
        ok = true;
      } catch {
        ok = false;
      }
    }
    ensuredDealProperties.set(name, ok);
    return ok;
  }

  /**
   * Resolve the target pipeline and its closed-won stage from the portal's
   * own pipeline metadata (one read per run). The pipeline is picked by id or
   * case-insensitive label (`hint`), else the default (lowest displayOrder);
   * the closed-won stage is the one whose metadata says isClosed with
   * probability 1 — NEVER a substring guess against stage names. Returns null
   * when either is unresolvable so the caller skips instead of guessing.
   */
  async function resolveClosedWonStage(
    hint: string | undefined,
  ): Promise<{ pipelineId: string; stageId: string } | null> {
    if (!dealPipelinesCache) {
      dealPipelinesCache = request("/crm/v3/pipelines/deals").then(
        (data) => (data?.results ?? []) as any[],
      );
      // A failed read must not poison the cache for the rest of the run.
      dealPipelinesCache = dealPipelinesCache.catch(() => []);
    }
    const pipelines = await dealPipelinesCache;
    if (pipelines.length === 0) return null;
    let pipeline: any | undefined;
    if (hint) {
      const wanted = hint.trim().toLowerCase();
      pipeline = pipelines.find(
        (candidate) =>
          String(candidate?.id ?? "").toLowerCase() === wanted ||
          String(candidate?.label ?? "").trim().toLowerCase() === wanted,
      );
      if (!pipeline) return null; // an explicit hint that matches nothing is an error, not "use default"
    } else {
      pipeline = [...pipelines].sort(
        (a, b) => Number(a?.displayOrder ?? 0) - Number(b?.displayOrder ?? 0),
      )[0];
    }
    if (!pipeline?.id) return null;
    const stage = (pipeline.stages ?? []).find((candidate: any) => {
      const meta = candidate?.metadata ?? {};
      return (
        candidate?.id &&
        String(meta.isClosed).toLowerCase() === "true" &&
        Number(meta.probability) === 1
      );
    });
    if (!stage) return null;
    return { pipelineId: String(pipeline.id), stageId: String(stage.id) };
  }

  /**
   * Deal branch of create_record (backfill: one closed-won deal per paid
   * invoice). Resolve-first on the custom dedupe property (ensured to exist
   * first), stage resolved from pipeline metadata, company association
   * best-effort — same contract as the contact branch.
   */
  async function createDealRecord(
    operation: PatchOperation,
    payload: CreateRecordPayload,
    matchValue: string,
  ): Promise<PatchOperationResult> {
    const matchKey = String(payload.matchKey ?? "").trim();
    if (!matchKey) {
      return { operationId: operation.id, status: "skipped", detail: "create_record for deals needs a matchKey (the dedupe property, e.g. stripe_invoice_id)." };
    }
    const dedupeKey = `${matchKey}:${matchValue.toLowerCase()}`;
    const alreadyCreated = createdDealsByMatch.get(dedupeKey);
    if (alreadyCreated) {
      return { operationId: operation.id, status: "skipped", detail: `Deal ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: alreadyCreated, existing: true } };
    }

    // The dedupe property is usually CUSTOM — ensure it exists before the
    // search; searching a property HubSpot doesn't have 400s, and creating a
    // deal without the key stamped would defeat every future resolve-first.
    const propertyOk = await ensureDealProperty(matchKey);
    if (!propertyOk) {
      return { operationId: operation.id, status: "skipped", detail: `Deal dedupe property "${matchKey}" does not exist and could not be created; refusing to create a deal without its dedupe key.` };
    }

    const existing = await searchDealsBy(matchKey, matchValue);
    if (existing.length > 0) {
      createdDealsByMatch.set(dedupeKey, existing[0]);
      return { operationId: operation.id, status: "skipped", detail: `Deal ${matchKey}=${matchValue} already exists (${existing.join(", ")}); resolve-first declined to create.`, providerData: { id: existing[0], existing: true } };
    }

    // Stage: only the provider-neutral "closed_won" sentinel is understood,
    // and it must resolve to a real stage id from pipeline metadata.
    if (payload.dealStage !== "closed_won") {
      return { operationId: operation.id, status: "skipped", detail: 'create_record for deals needs dealStage "closed_won" (the connector resolves the real stage id from pipeline metadata).' };
    }
    const resolved = await resolveClosedWonStage(payload.dealPipeline);
    if (!resolved) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: payload.dealPipeline
          ? `Could not resolve pipeline "${payload.dealPipeline}" (by id or label) to a closed-won stage; not guessing a stage.`
          : "Could not resolve the default deal pipeline's closed-won stage (isClosed + probability 1) from pipeline metadata; not guessing a stage.",
      };
    }

    const properties: Record<string, string> = {
      ...payload.properties,
      [matchKey]: matchValue,
      pipeline: resolved.pipelineId,
      dealstage: resolved.stageId,
    };
    if (payload.ownerId && !properties.hubspot_owner_id) {
      properties.hubspot_owner_id = String(payload.ownerId);
    }
    let created;
    try {
      created = await request(`/crm/v3/objects/deals`, {
        method: "POST",
        body: JSON.stringify({ properties: { ...properties, hs_object_source_detail_2: `fullstackgtm backfill (${operation.id})` } }),
      });
    } catch {
      // Some portals reject writes to source-detail properties — the provenance
      // stamp is best-effort, the create is not.
      created = await request(`/crm/v3/objects/deals`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
    }
    const dealId = String(created.id);
    createdDealsByMatch.set(dedupeKey, dealId);

    let companyNote = "";
    if (payload.associateCompanyName) {
      try {
        const companyId = await resolveOrCreateCompany(payload.associateCompanyName, payload.associateCompanyDomain, operation.id);
        if (companyId) {
          await request(
            `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
            { method: "PUT" },
          );
          const domainNote = payload.associateCompanyDomain ? ` (${payload.associateCompanyDomain})` : "";
          companyNote = ` Linked to company "${payload.associateCompanyName}"${domainNote} (${companyId}).`;
        } else {
          companyNote = ` Company "${payload.associateCompanyName}" was ambiguous; left unlinked.`;
        }
      } catch (error) {
        // Association is best-effort — the deal create already succeeded.
        companyNote = ` (company link failed: ${error instanceof Error ? error.message : String(error)})`;
      }
    }
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Created deal ${matchKey}=${matchValue} (${dealId}) in stage ${resolved.stageId}.${companyNote}`,
      providerData: { id: dealId, created: true, pipelineId: resolved.pipelineId, stageId: resolved.stageId },
    };
  }

  /**
   * Create a NET-NEW record (a sourced lead, or a backfilled deal).
   * Resolve-first: re-checks the dedupe key against the live CRM (the
   * plan-time snapshot can be stale) and creates ONLY on a confirmed miss — a
   * record a concurrent writer already added is returned as `skipped`, never
   * duplicated. Contacts and deals can be linked to a resolved-or-created
   * company in the same step.
   */
  async function createRecord(operation: PatchOperation): Promise<PatchOperationResult> {
    const payload = operation.afterValue as CreateRecordPayload | undefined;
    if (!payload || typeof payload !== "object" || !payload.properties) {
      return { operationId: operation.id, status: "skipped", detail: "create_record needs a CreateRecordPayload afterValue." };
    }
    const objectPath = OBJECT_PATHS[operation.objectType];
    if (operation.objectType !== "contact" && operation.objectType !== "account" && operation.objectType !== "deal") {
      return { operationId: operation.id, status: "skipped", detail: "create_record supports contacts, accounts, and deals." };
    }
    const matchValue = String(payload.matchValue ?? "").trim();
    if (!matchValue) {
      return { operationId: operation.id, status: "skipped", detail: "create_record needs a non-empty matchValue to resolve-first." };
    }

    if (operation.objectType === "deal") {
      return createDealRecord(operation, payload, matchValue);
    }

    if (operation.objectType === "account") {
      const id = await resolveOrCreateCompany(matchValue, stringOrUndefined(payload.properties?.domain), operation.id);
      if (id === null) {
        return { operationId: operation.id, status: "skipped", detail: `create_record: ambiguous — multiple companies named "${matchValue}". Not creating.` };
      }
      return { operationId: operation.id, status: "applied", detail: `Resolved/created company "${matchValue}" (${id}).`, providerData: { id } };
    }

    // contact — resolve-first on the dedupe key (email by default). The match
    // key is canonical (e.g. "linkedin"); translate it to the HubSpot property
    // name ("hs_linkedin_url") before searching — HubSpot 400s on a filter
    // against a property it doesn't have (there is no property named "linkedin").
    const matchKey = payload.matchKey || "email";
    const searchProperty = HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts[matchKey] ?? matchKey;
    const matchKeyLower = `${matchKey}:${matchValue.toLowerCase()}`;
    if (createdContactsByMatch.has(matchKeyLower)) {
      return { operationId: operation.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: createdContactsByMatch.get(matchKeyLower), existing: true } };
    }
    const existing = await searchContactsBy(searchProperty, matchValue);
    if (existing.length > 0) {
      createdContactsByMatch.set(matchKeyLower, existing[0]);
      return { operationId: operation.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already exists (${existing.join(", ")}); resolve-first declined to create.`, providerData: { id: existing[0], existing: true } };
    }

    const properties: Record<string, string> = { ...payload.properties };
    // Stamp ownership at create time so the lead is never born ownerless. The
    // canonical ownerId maps to HubSpot's standard owner property.
    if (payload.ownerId && !properties.hubspot_owner_id) {
      properties.hubspot_owner_id = String(payload.ownerId);
    }
    let created;
    try {
      created = await request(`/crm/v3/objects/${objectPath}`, {
        method: "POST",
        body: JSON.stringify({ properties: { ...properties, hs_object_source_detail_2: `fullstackgtm acquire (${operation.id})` } }),
      });
    } catch {
      // Some portals reject writes to source-detail properties — the provenance
      // stamp is best-effort, the create is not.
      created = await request(`/crm/v3/objects/${objectPath}`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
    }
    const contactId = String(created.id);
    createdContactsByMatch.set(matchKeyLower, contactId);

    let companyNote = "";
    if (payload.associateCompanyName) {
      try {
        const companyId = await resolveOrCreateCompany(payload.associateCompanyName, payload.associateCompanyDomain, operation.id);
        if (companyId) {
          await request(
            `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
            { method: "PUT" },
          );
          const domainNote = payload.associateCompanyDomain ? ` (${payload.associateCompanyDomain})` : "";
          companyNote = ` Linked to company "${payload.associateCompanyName}"${domainNote} (${companyId}).`;
        } else {
          companyNote = ` Company "${payload.associateCompanyName}" was ambiguous; left unlinked.`;
        }
      } catch (error) {
        // Association is best-effort — the contact create already succeeded.
        companyNote = ` (company link failed: ${error instanceof Error ? error.message : String(error)})`;
      }
    }
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Created contact ${matchKey}=${matchValue} (${contactId}).${companyNote}`,
      providerData: { id: contactId, created: true },
    };
  }

  /** Bulk resolve-first lookup: which match values already exist (value→id). */
  async function searchContactsByValues(property: string, values: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let i = 0; i < values.length; i += 100) {
      const chunk = values.slice(i, i + 100);
      const data = await request(`/crm/v3/objects/contacts/search`, {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: property, operator: "IN", values: chunk }] }],
          properties: [property],
          limit: 100,
        }),
      });
      for (const rec of (data?.results ?? []) as Array<{ id?: string; properties?: Record<string, string> }>) {
        const v = rec?.properties?.[property];
        if (typeof v === "string" && rec.id) found.set(v.toLowerCase(), String(rec.id));
      }
    }
    return found;
  }

  /**
   * Batch create_record for contacts: bulk resolve-first (search IN), then
   * bulk-create the genuine misses (batch/create, 100/call) — two API calls per
   * ~100 leads instead of two per lead. On a batch-create rejection (e.g. an
   * email collision HubSpot 409s the whole batch over), it falls back to
   * per-record createRecord for that chunk, so one bad row never sinks the rest
   * and resolve-first is preserved. Returns one result per input op.
   */
  async function applyCreateContactsBatch(operations: PatchOperation[]): Promise<PatchOperationResult[]> {
    const byId = new Map<string, PatchOperationResult>();
    // Group by the HubSpot search property (matchKey is usually uniform across a
    // plan, but a mixed plan stays correct this way).
    const groups = new Map<string, PatchOperation[]>();
    for (const op of operations) {
      const matchKey = (op.afterValue as CreateRecordPayload | undefined)?.matchKey || "email";
      const searchProperty = HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts[matchKey] ?? matchKey;
      let arr = groups.get(searchProperty);
      if (!arr) groups.set(searchProperty, (arr = []));
      arr.push(op);
    }

    for (const [searchProperty, ops] of groups) {
      const wanted = ops
        .map((op) => String((op.afterValue as CreateRecordPayload).matchValue ?? "").trim())
        .filter(Boolean);
      const existing = await searchContactsByValues(searchProperty, [...new Set(wanted.map((v) => v.toLowerCase()))]);

      const toCreate: PatchOperation[] = [];
      const seenInBatch = new Set<string>();
      for (const op of ops) {
        const payload = op.afterValue as CreateRecordPayload;
        const matchKey = payload.matchKey || "email";
        const matchValue = String(payload.matchValue ?? "").trim();
        if (!matchValue) {
          byId.set(op.id, { operationId: op.id, status: "skipped", detail: "create_record needs a non-empty matchValue to resolve-first." });
          continue;
        }
        const lower = matchValue.toLowerCase();
        const dedupeKey = `${matchKey}:${lower}`;
        const already = createdContactsByMatch.get(dedupeKey);
        if (already) {
          byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: already, existing: true } });
          continue;
        }
        const existingId = existing.get(lower);
        if (existingId) {
          createdContactsByMatch.set(dedupeKey, existingId);
          byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already exists (${existingId}); resolve-first declined to create.`, providerData: { id: existingId, existing: true } });
          continue;
        }
        if (seenInBatch.has(lower)) {
          byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} duplicated within this batch; not duplicating.` });
          continue;
        }
        seenInBatch.add(lower);
        toCreate.push(op);
      }

      for (let i = 0; i < toCreate.length; i += 100) {
        const chunk = toCreate.slice(i, i + 100);
        const inputs = chunk.map((op) => {
          const payload = op.afterValue as CreateRecordPayload;
          const properties: Record<string, string> = { ...payload.properties };
          if (payload.ownerId && !properties.hubspot_owner_id) properties.hubspot_owner_id = String(payload.ownerId);
          properties.hs_object_source_detail_2 = `fullstackgtm acquire (${op.id})`;
          return { properties };
        });
        try {
          const data = await request(`/crm/v3/objects/contacts/batch/create`, {
            method: "POST",
            body: JSON.stringify({ inputs }),
          });
          const created = (data?.results ?? []) as Array<{ id?: string; properties?: Record<string, string> }>;
          const idByValue = new Map<string, string>();
          for (const rec of created) {
            const v = rec?.properties?.[searchProperty];
            if (typeof v === "string" && rec.id) idByValue.set(v.toLowerCase(), String(rec.id));
          }
          for (const op of chunk) {
            const payload = op.afterValue as CreateRecordPayload;
            const matchKey = payload.matchKey || "email";
            const matchValue = String(payload.matchValue).trim();
            const id = idByValue.get(matchValue.toLowerCase());
            if (id) {
              createdContactsByMatch.set(`${matchKey}:${matchValue.toLowerCase()}`, id);
              byId.set(op.id, { operationId: op.id, status: "applied", detail: `Created contact ${matchKey}=${matchValue} (${id}).`, providerData: { id, created: true } });
            } else {
              // Result didn't echo this value — resolve it per-record to be safe.
              byId.set(op.id, await createRecord(op));
            }
          }
        } catch {
          // Whole-chunk rejection (e.g. a collision). Isolate per record.
          for (const op of chunk) byId.set(op.id, await createRecord(op));
        }
      }
    }

    return operations.map(
      (op) => byId.get(op.id) ?? { operationId: op.id, status: "skipped", detail: "create_record was not processed." },
    );
  }

  async function createTask(operation: PatchOperation): Promise<PatchOperationResult> {
    const associationTypeId = TASK_ASSOCIATION_TYPE_IDS[operation.objectType];
    if (associationTypeId === undefined) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "Tasks can be attached to accounts, contacts, and deals.",
      };
    }
    const subject = operation.field ? humanizeField(operation.field) : "Follow up";
    // The operation id doubles as an idempotency token: it is stamped into
    // the task body and pre-checked so a replayed plan does not create the
    // same task twice. Fail-open — a search hiccup must not block the apply.
    const token = `fsgtm ${operation.id.replace(/^op_/, "")}`;
    try {
      const existing = await request(`/crm/v3/objects/tasks/search`, {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "hs_task_body", operator: "CONTAINS_TOKEN", value: token.split(" ")[1] }] },
          ],
          limit: 1,
        }),
      });
      const hit = (existing?.results ?? [])[0] as { id?: string } | undefined;
      if (hit?.id) {
        return {
          operationId: operation.id,
          status: "skipped",
          detail: `Task for this operation already exists (task ${hit.id}); not creating a duplicate.`,
          providerData: { id: hit.id, existing: true },
        };
      }
    } catch {
      // fall through to create
    }
    // A live CRM often already carries a human-created follow-up for the same
    // record (a previous partial run, or a rep's own task). Creating another
    // on top is duplicate noise — skip when the object already has an open
    // task, regardless of who created it. Fail-open: a lookup hiccup must
    // not block the apply.
    try {
      const objectPath = OBJECT_PATHS[operation.objectType];
      const assoc = await request(
        `/crm/v4/objects/${objectPath}/${encodeURIComponent(operation.objectId)}/associations/tasks?limit=20`,
      );
      const taskIds = ((assoc?.results ?? []) as Array<{ toObjectId?: number | string }>)
        .map((row) => String(row.toObjectId ?? ""))
        .filter(Boolean)
        .slice(0, 10);
      for (const taskId of taskIds) {
        const existingTask = await request(
          `/crm/v3/objects/tasks/${encodeURIComponent(taskId)}?properties=hs_task_status`,
        );
        const status = String(existingTask?.properties?.hs_task_status ?? "");
        if (status !== "COMPLETED" && status !== "DELETED") {
          return {
            operationId: operation.id,
            status: "skipped",
            detail: `An open task (task ${taskId}) already exists on ${operation.objectType}/${operation.objectId}; not creating a duplicate follow-up.`,
            providerData: { id: taskId, existing: true },
          };
        }
      }
    } catch {
      // fall through to create
    }
    const body = `${String(operation.afterValue ?? operation.reason ?? "")}\n\n[${token}]`;
    const response = await request(`/crm/v3/objects/tasks`, {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_task_subject: subject,
          hs_task_body: body,
          hs_task_status: "NOT_STARTED",
          hs_task_priority: "MEDIUM",
          hs_timestamp: Date.now(),
        },
        associations: [
          {
            to: { id: operation.objectId },
            types: [
              { associationCategory: "HUBSPOT_DEFINED", associationTypeId },
            ],
          },
        ],
      }),
    });
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Created task "${subject}" on ${operation.objectType}/${operation.objectId}.`,
      providerData: { id: response?.id },
    };
  }

  async function archiveRecord(operation: PatchOperation): Promise<PatchOperationResult> {
    const objectPath = OBJECT_PATHS[operation.objectType];
    if (!objectPath) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "archive_record is supported for accounts, contacts, and deals.",
      };
    }
    await request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(operation.objectId)}`, {
      method: "DELETE",
    });
    return {
      operationId: operation.id,
      status: "applied",
      detail: `Archived ${objectPath}/${operation.objectId}.`,
    };
  }

  function fieldMapping(operation: PatchOperation): { objectPath: string; property: string } | null {
    const objectPath = OBJECT_PATHS[operation.objectType];
    const mappingType = MAPPING_OBJECT_TYPES[operation.objectType];
    if (!objectPath || !mappingType || !operation.field) return null;
    const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
    return { objectPath, property: mappedField(mappings, mappingType, operation.field, defaults[operation.field] ?? operation.field) };
  }

  function normalizeHubspotReadValue(field: string | undefined, value: unknown): unknown {
    if (field === "closeDate" && typeof value === "string") return value.split("T")[0];
    return value ?? null;
  }

  function normalizeForComparison(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    return String(value);
  }

  function batchErrorIds(error: any): string[] {
    const context = error?.context ?? {};
    const ids = context.ids ?? context.id ?? error?.id ?? error?.objectId;
    if (Array.isArray(ids)) return ids.map(String);
    if (ids !== undefined && ids !== null) return [String(ids)];
    return [];
  }

  function batchErrorDetail(error: any): string {
    const category = error?.category ? `${String(error.category)}: ` : "";
    return `${category}${String(error?.message ?? "HubSpot batch row failed.")}`;
  }

  async function applySetFieldBatch(operations: PatchOperation[]): Promise<PatchOperationResult[]> {
    const out = new Map<string, PatchOperationResult>();
    const mapped = operations.map((operation) => ({ operation, mapping: fieldMapping(operation) }));
    for (const item of mapped) {
      if (!item.mapping) {
        out.set(item.operation.id, {
          operationId: item.operation.id,
          status: "skipped",
          detail: "Field writes are only supported for accounts, contacts, and deals with an explicit field.",
        });
      }
    }
    const clean = mapped.filter((item): item is { operation: PatchOperation; mapping: { objectPath: string; property: string } } => Boolean(item.mapping));
    if (clean.length === 0) return operations.map((operation) => out.get(operation.id)!);
    const objectPath = clean[0].mapping.objectPath;
    const properties = [...new Set(clean.map((item) => item.mapping.property))];
    const liveById = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(clean.map((item) => item.operation.objectId))];
    for (let i = 0; i < ids.length; i += 100) {
      const chunkIds = ids.slice(i, i + 100);
      const data = await request(`/crm/v3/objects/${objectPath}/batch/read`, {
        method: "POST",
        body: JSON.stringify({ properties, inputs: chunkIds.map((id) => ({ id })) }),
      });
      for (const row of data?.results ?? []) {
        if (row?.id) liveById.set(String(row.id), row.properties ?? {});
      }
    }

    const toWrite: Array<{ operation: PatchOperation; property: string }> = [];
    for (const { operation, mapping } of clean) {
      const props = liveById.get(operation.objectId);
      const current = normalizeHubspotReadValue(operation.field, props?.[mapping.property] ?? null);
      const expected = normalizeForComparison(operation.beforeValue);
      const found = normalizeForComparison(current);
      if (!props || expected !== found) {
        out.set(operation.id, {
          operationId: operation.id,
          status: "conflict",
          detail: `Value drifted since the plan was proposed: expected ${expected ?? "∅"}, found ${found ?? "∅"}. Re-run the audit.`,
          providerData: { currentValue: current ?? null },
        });
        continue;
      }
      toWrite.push({ operation, property: mapping.property });
    }

    // HubSpot rejects a batch that names one record twice, so every write to a record goes in one input.
    const byObjectId = new Map<string, Array<{ operation: PatchOperation; property: string }>>();
    for (const item of toWrite) byObjectId.set(item.operation.objectId, [...(byObjectId.get(item.operation.objectId) ?? []), item]);
    const groups = [...byObjectId];
    for (let i = 0; i < groups.length; i += 100) {
      const chunk = groups.slice(i, i + 100);
      const items = chunk.flatMap(([, writes]) => writes);
      let data: any;
      try {
        data = await request(`/crm/v3/objects/${objectPath}/batch/update`, {
          method: "POST",
          body: JSON.stringify({
            inputs: chunk.map(([id, writes]) => ({
              id,
              properties: Object.fromEntries(writes.map(({ operation, property }) => [property, operation.operation === "clear_field" ? "" : String(operation.afterValue ?? "")])),
            })),
          }),
        });
      } catch (error) {
        for (const { operation } of items) out.set(operation.id, { operationId: operation.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const writesById = new Map(chunk);
      for (const error of data?.errors ?? []) {
        for (const id of batchErrorIds(error)) {
          for (const { operation } of writesById.get(id) ?? []) out.set(operation.id, { operationId: operation.id, status: "failed", detail: batchErrorDetail(error) });
        }
      }
      for (const result of data?.results ?? []) {
        for (const { operation, property } of writesById.get(String(result?.id)) ?? []) {
          if (!out.has(operation.id)) out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Set ${property} on ${objectPath}/${operation.objectId}.`, providerData: { id: result?.id } });
        }
      }
      for (const { operation, property } of items) {
        if (!out.has(operation.id)) out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Set ${property} on ${objectPath}/${operation.objectId}.` });
      }
    }
    return operations.map((operation) => out.get(operation.id) ?? { operationId: operation.id, status: "failed", detail: "Batch update did not process this operation." });
  }

  async function applyArchiveBatch(operations: PatchOperation[]): Promise<PatchOperationResult[]> {
    const objectPath = OBJECT_PATHS[operations[0]?.objectType];
    if (!objectPath) return operations.map((operation) => ({ operationId: operation.id, status: "skipped", detail: "archive_record is supported for accounts, contacts, and deals." }));
    const out = new Map<string, PatchOperationResult>();
    for (let i = 0; i < operations.length; i += 100) {
      const chunk = operations.slice(i, i + 100);
      let data: any;
      try {
        data = await request(`/crm/v3/objects/${objectPath}/batch/archive`, {
          method: "POST",
          body: JSON.stringify({ inputs: chunk.map((operation) => ({ id: operation.objectId })) }),
        });
      } catch (error) {
        for (const operation of chunk) out.set(operation.id, { operationId: operation.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const opByObjectId = new Map(chunk.map((operation) => [operation.objectId, operation]));
      for (const error of data?.errors ?? []) {
        for (const id of batchErrorIds(error)) {
          const operation = opByObjectId.get(id);
          if (operation) out.set(operation.id, { operationId: operation.id, status: "failed", detail: batchErrorDetail(error) });
        }
      }
      for (const result of data?.results ?? []) {
        const operation = opByObjectId.get(String(result?.id));
        if (operation && !out.has(operation.id)) out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Archived ${objectPath}/${operation.objectId}.` });
      }
      for (const operation of chunk) {
        if (!out.has(operation.id)) out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Archived ${objectPath}/${operation.objectId}.` });
      }
    }
    return operations.map((operation) => out.get(operation.id) ?? { operationId: operation.id, status: "failed", detail: "Batch archive did not process this operation." });
  }

  async function applyBatch(operations: PatchOperation[]): Promise<PatchOperationResult[]> {
    if (operations.length === 0) return [];
    if (operations.every((operation) => (operation.operation === "set_field" || operation.operation === "clear_field") && operation.objectType === operations[0].objectType)) {
      return applySetFieldBatch(operations);
    }
    if (operations.every((operation) => operation.operation === "archive_record" && operation.objectType === operations[0].objectType)) {
      return applyArchiveBatch(operations);
    }
    return operations.map((operation) => ({ operationId: operation.id, status: "skipped", detail: "This mixed operation batch is not supported." }));
  }

  /**
   * Merge a duplicate group into the approved survivor via HubSpot's v3
   * merge API (supported for contacts, companies, deals, and tickets).
   * Merges are pairwise and IRREVERSIBLE; the survivor's values win on
   * conflict and each loser is archived by HubSpot. A loser that is already
   * gone (404 — e.g. a replayed plan) is treated as already merged.
   */
  async function mergeRecords(operation: PatchOperation): Promise<PatchOperationResult> {
    const objectPath = OBJECT_PATHS[operation.objectType];
    if (!objectPath || operation.objectType === "user" || operation.objectType === "activity") {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "merge_records is supported for accounts, contacts, and deals.",
      };
    }
    const survivorId = String(operation.afterValue ?? "");
    const groupIds = Array.isArray(operation.beforeValue)
      ? operation.beforeValue.map((id) => String(id))
      : [];
    if (!survivorId || groupIds.length < 2) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: "merge_records needs a survivor id (afterValue) and the duplicate group ids (beforeValue).",
      };
    }
    if (!groupIds.includes(survivorId)) {
      return {
        operationId: operation.id,
        status: "skipped",
        detail: `Survivor ${survivorId} is not in the duplicate group (${groupIds.join(", ")}); refusing to merge into an unrelated record.`,
      };
    }
    const losers = groupIds.filter((id) => id !== survivorId);
    const mergedIds: string[] = [];
    const alreadyGoneIds: string[] = [];
    for (const loser of losers) {
      try {
        await request(`/crm/v3/objects/${objectPath}/merge`, {
          method: "POST",
          body: JSON.stringify({ primaryObjectId: survivorId, objectIdToMerge: loser }),
        });
        mergedIds.push(loser);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(" 404")) {
          alreadyGoneIds.push(loser); // replayed plan: loser already merged/archived
          continue;
        }
        return {
          operationId: operation.id,
          status: "failed",
          detail: `Merged ${mergedIds.length} of ${losers.length} into ${survivorId}, then failed on ${loser}: ${message}`,
          providerData: { survivorId, mergedIds, alreadyGoneIds },
        };
      }
    }
    return {
      operationId: operation.id,
      status: mergedIds.length === 0 && alreadyGoneIds.length === losers.length ? "skipped" : "applied",
      detail:
        mergedIds.length === 0 && alreadyGoneIds.length === losers.length
          ? `All ${losers.length} duplicates were already merged into ${survivorId}; nothing to do.`
          : `Merged ${mergedIds.length} duplicate ${objectPath} into ${survivorId}${alreadyGoneIds.length ? ` (${alreadyGoneIds.length} already gone)` : ""}. Irreversible.`,
      providerData: { survivorId, mergedIds, alreadyGoneIds },
    };
  }

  async function applyOperation(operation: PatchOperation): Promise<PatchOperationResult> {
    try {
      switch (operation.operation) {
        case "set_field":
        case "clear_field":
          return await setField(operation);
        case "link_record":
          return await linkRecord(operation);
        case "create_task":
          return await createTask(operation);
        case "create_record":
          return await createRecord(operation);
        case "merge_records":
          return await mergeRecords(operation);
        case "archive_record":
          return await archiveRecord(operation);
        default:
          return {
            operationId: operation.id,
            status: "skipped",
            detail: `Unknown operation ${operation.operation}.`,
          };
      }
    } catch (error) {
      return {
        operationId: operation.id,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function readMapped(
    source: Record<string, unknown>,
    objectType: CrmObjectType,
    targetField: string,
    fallbackField: string,
  ) {
    return readMappedValue(source, mappings, objectType, targetField, fallbackField);
  }

  async function readField(
    objectType: GtmObjectType,
    objectId: string,
    field: string,
  ): Promise<unknown> {
    const objectPath = OBJECT_PATHS[objectType];
    const mappingType = MAPPING_OBJECT_TYPES[objectType];
    if (!objectPath || !mappingType) {
      throw new Error(`Field reads are only supported for accounts, contacts, and deals.`);
    }
    // accountId is an association in HubSpot, not a property — without this
    // branch the compare-and-set on link_record reads null and passes blind.
    if (field === "accountId" && (objectType === "deal" || objectType === "contact")) {
      const data = await request(
        `/crm/v4/objects/${objectPath}/${encodeURIComponent(objectId)}/associations/companies?limit=1`,
      );
      const first = (data?.results ?? [])[0] as { toObjectId?: number | string } | undefined;
      return first?.toObjectId !== undefined ? String(first.toObjectId) : null;
    }
    const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
    const property = mappedField(mappings, mappingType, field, defaults[field] ?? field);
    const data = await request(
      `/crm/v3/objects/${objectPath}/${encodeURIComponent(objectId)}?properties=${encodeURIComponent(property)}`,
    );
    const value = data?.properties?.[property] ?? null;
    // fetchSnapshot normalizes closeDate to a date with `?.split("T")[0]`, so the
    // value baked into an op's beforeValue is date-only ("2026-03-07"). The
    // single-object read here returns HubSpot's raw "2026-03-07T00:00:00Z", which
    // made compare-and-set see a spurious drift and refuse every date-field write.
    // Mirror the snapshot's normalization so the comparison is apples-to-apples.
    return normalizeHubspotReadValue(field, value);
  }

  return {
    provider: "hubspot",
    fetchSnapshot,
    pullSnapshot,
    fetchUsers,
    readPage,
    readModifiedPage,
    countRecords,
    idsAtRanks,
    firstIdFrom,
    rateLimitSeen: () => pacer.observed(),
    fetchChanges,
    applyOperation,
    applyCreateContactsBatch,
    applyBatch,
    applyBatchLimit: 100,
    readField,
  };
}

// Read-only record-source fields power duplicate-finding attribution
// ("all five created by integration X") — see RecordProvenance.
const PROVENANCE_PROPERTIES = "hs_object_source,hs_object_source_label,hs_object_source_id";

/** The scope a HubSpot path needs, for naming it in a 403 (paths carry no record values, so they are safe to show). */
export function hubspotScopeFor(path: string, method: string): string | null {
  const p = path.split("?")[0];
  if (p.startsWith("/crm/v3/owners")) return "crm.objects.owners.read";
  const schema = /^\/crm\/v3\/(?:properties|pipelines)\/(\w+)/.exec(p);
  if (schema) return `crm.schemas.${schema[1]}.read`;
  const object = /^\/crm\/v[34]\/(?:objects|associations)\/(\w+)/.exec(p);
  if (!object) return null;
  const write = method !== "GET" && !/\/(search|batch\/read)$/.test(p);
  return `crm.objects.${object[1]}.${write ? "write" : "read"}`;
}

/** The properties a snapshot reads for an object: its mapped fields and the record-source fields. */
export function hubspotProperties(object: "accounts" | "contacts" | "deals", mappings?: FieldMappings): string {
  return `${mappedFields(mappings, object, HUBSPOT_DEFAULT_FIELD_MAPPINGS[object]).join(",")},${PROVENANCE_PROPERTIES}`;
}

/**
 * The company a v3 record's `associations.companies` names: the primary one (type `<object>_to_company`) when
 * HubSpot marks it, else the first.
 */
function primaryCompanyId(record: any): string | undefined {
  const results: Array<{ id?: unknown; type?: unknown }> = record.associations?.companies?.results ?? [];
  const primary = results.find((r) => typeof r.type === "string" && !r.type.endsWith("_unlabeled") && r.type.endsWith("_to_company")) ?? results[0];
  return primary?.id !== undefined ? String(primary.id) : undefined;
}

/** Every deal stage id's closed and won meaning, from the pipeline definitions (`isClosed`; probability 1 is won). */
export function hubspotStageClose(pipelines: readonly any[]): Map<string, { isClosed: boolean; isWon: boolean }> {
  const map = new Map<string, { isClosed: boolean; isWon: boolean }>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline?.stages ?? []) {
      if (!stage?.id) continue;
      const meta = stage.metadata ?? {};
      const isClosed = String(meta.isClosed).toLowerCase() === "true";
      map.set(String(stage.id), { isClosed, isWon: isClosed && Number(meta.probability) === 1 });
    }
  }
  return map;
}

export function hubspotAccount(company: any, mappings?: FieldMappings): CanonicalAccount {
  const props = company.properties ?? {};
  const readMapped = (objectType: CrmObjectType, target: string, fallback: string) => readMappedValue(props, mappings, objectType, target, fallback);
  return {
    id: String(company.id),
    provider: "hubspot",
    crmId: String(company.id),
    identities: [{ provider: "hubspot", externalId: String(company.id) }],
    name: stringOrFallback(
      readMapped("accounts", "name", "name"),
      "Unknown Company",
    ),
    domain: stringOrUndefined(readMapped("accounts", "domain", "domain")),
    parentAccountId: stringOrUndefined(
      readMapped("accounts", "parentAccountId", "hs_parent_company_id"),
    ),
    industry: stringOrUndefined(readMapped("accounts", "industry", "industry")),
    employeeCount: numberOrUndefined(
      readMapped("accounts", "employeeCount", "numberofemployees"),
    ),
    annualRevenue: numberOrUndefined(
      readMapped("accounts", "annualRevenue", "annualrevenue"),
    ),
    ownerId: stringOrUndefined(
      readMapped("accounts", "ownerId", "hubspot_owner_id"),
    ),
    provenance: provenanceFrom(props),
    lastSyncAt: stringOrUndefined(company.updatedAt),
    raw: company,
  };
}

export function hubspotContact(contact: any, mappings?: FieldMappings): CanonicalContact {
  const props = contact.properties ?? {};
  const readMapped = (objectType: CrmObjectType, target: string, fallback: string) => readMappedValue(props, mappings, objectType, target, fallback);
  const companyId = primaryCompanyId(contact);
  return {
    id: String(contact.id),
    provider: "hubspot",
    crmId: String(contact.id),
    identities: [{ provider: "hubspot", externalId: String(contact.id) }],
    accountId: companyId,
    firstName: stringOrUndefined(readMapped("contacts", "firstName", "firstname")),
    lastName: stringOrUndefined(readMapped("contacts", "lastName", "lastname")),
    email: stringOrUndefined(readMapped("contacts", "email", "email")),
    phone: stringOrUndefined(readMapped("contacts", "phone", "phone")),
    title: stringOrUndefined(readMapped("contacts", "title", "jobtitle")),
    linkedin: stringOrUndefined(readMapped("contacts", "linkedin", "hs_linkedin_url")),
    ownerId: stringOrUndefined(
      readMapped("contacts", "ownerId", "hubspot_owner_id"),
    ),
    provenance: provenanceFrom(props),
    lastSyncAt: stringOrUndefined(contact.updatedAt),
    raw: contact,
  };
}

export function hubspotDeal(deal: any, mappings: FieldMappings | undefined, stageClose: ReadonlyMap<string, { isClosed: boolean; isWon: boolean }>): CanonicalDeal {
  const props = deal.properties ?? {};
  const readMapped = (objectType: CrmObjectType, target: string, fallback: string) => readMappedValue(props, mappings, objectType, target, fallback);
  const companyId = primaryCompanyId(deal);
  const stage = stringOrUndefined(readMapped("deals", "stage", "dealstage"));
  const normalizedStage = (stage ?? "").toLowerCase();
  // Prefer the pipeline stage's actual closed/won metadata; fall back to
  // the substring heuristic only when the stage isn't in the pipeline map
  // (pipelines unreadable, or a deal on a deleted stage).
  const stageMeta = stage ? stageClose.get(stage) : undefined;
  const isWon = stageMeta ? stageMeta.isWon : normalizedStage.includes("closedwon");
  const isClosed = stageMeta
    ? stageMeta.isClosed
    : isWon || normalizedStage.includes("closedlost");
  const forecastCategory = isWon ? "closed_won" : isClosed ? "closed_lost" : "pipeline";
  const lastActivityAt = stringOrUndefined(
    readMapped("deals", "lastActivityAt", "hs_last_sales_activity_timestamp"),
  );
  return {
    id: String(deal.id),
    provider: "hubspot",
    crmId: String(deal.id),
    identities: [{ provider: "hubspot", externalId: String(deal.id) }],
    accountId: companyId,
    ownerId: stringOrUndefined(readMapped("deals", "ownerId", "hubspot_owner_id")),
    provenance: provenanceFrom(props),
    name: stringOrFallback(readMapped("deals", "name", "dealname"), "Untitled Deal"),
    amount: numberOrUndefined(readMapped("deals", "amount", "amount")),
    stage,
    closeDate: stringOrUndefined(
      readMapped("deals", "closeDate", "closedate"),
    )?.split("T")[0],
    dealType: stringOrUndefined(readMapped("deals", "dealType", "dealtype")),
    // hs_deal_stage_probability is already a 0..1 fraction in HubSpot,
    // so it maps straight to the canonical 0..1 unit (no /100, unlike
    // Salesforce's 0..100 Probability field).
    probability: numberOrUndefined(
      readMapped("deals", "probability", "hs_deal_stage_probability"),
    ),
    forecastCategory,
    isClosed,
    isWon,
    // hs_last_sales_activity_timestamp is an ISO timestamp; keep the
    // date portion when it looks like one, otherwise pass through (e.g.
    // an epoch-millis string).
    lastActivityAt: lastActivityAt?.includes("T")
      ? lastActivityAt.split("T")[0]
      : lastActivityAt,
    lastSyncAt: stringOrUndefined(deal.updatedAt),
    raw: deal,
  };
}

function provenanceFrom(props: Record<string, unknown>): RecordProvenance | undefined {
  const source = stringOrUndefined(props.hs_object_source);
  const sourceLabel = stringOrUndefined(props.hs_object_source_label);
  const sourceId = stringOrUndefined(props.hs_object_source_id);
  if (!source && !sourceLabel && !sourceId) return undefined;
  return { source, sourceLabel, sourceId };
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function stringOrFallback(value: unknown, fallback: string): string {
  return stringOrUndefined(value) ?? fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}
