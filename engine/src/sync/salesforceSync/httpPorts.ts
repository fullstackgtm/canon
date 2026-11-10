// HTTP implementations of the engine ports: the record service (contract
// 1.2.0, tolerant of 1.1.0 change rows) and the Salesforce REST API (also
// served by sf-sim). fetch only, so they run in the default Convex runtime.
import { SfWriteError } from "./engine.ts";
import type { EditOptions, LocalRecord, OutboxChange, RecordPort, SfPort, SfRecord } from "./types.ts";
import type { Soql } from "./cdc.ts";

type Fetch = typeof fetch;

// ───────────────────────────── record service ─────────────────────────────

export type RecordHttpOptions = { baseUrl: string; token: string; workspaceId: string; fetchImpl?: Fetch; actorId?: string };

const STANDARD = new Set(["account", "contact"]);

export function recordServicePort(o: RecordHttpOptions): RecordPort {
  const f = o.fetchImpl ?? fetch;
  const ws = encodeURIComponent(o.workspaceId);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${o.baseUrl}/v1/workspaces/${ws}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        "x-workspace-id": o.workspaceId,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    return { status: res.status, json };
  };
  const toLocal = (object: string, row: any): LocalRecord => {
    const fields: Record<string, unknown> = object === "account" || object === "contact" ? { ...row } : { ...(row.fields ?? {}) };
    const fieldUpdatedAt: Record<string, number> = { ...(row.fieldUpdatedAt ?? {}) };
    // Pre-1.2.0 rows have no per-field timestamps: fall back to the row's updatedAt.
    for (const k of Object.keys(fields)) if (fieldUpdatedAt[k] === undefined && typeof row.updatedAt === "number") fieldUpdatedAt[k] = row.updatedAt;
    return { id: row.id, object, sfId: row.sfId, fields, fieldUpdatedAt, version: row.version ?? 0 };
  };
  return {
    async changes(after, limit) {
      const r = await call("GET", `changes?after=${after}&limit=${limit}`);
      if (r.status !== 200) throw new Error(`record service changes ${r.status}`);
      const changes: OutboxChange[] = (r.json.changes ?? []).map((c: any) => ({
        seq: c.seq,
        object: c.object,
        id: c.id,
        op: c.op,
        fields: Array.isArray(c.fields) ? c.fields : Object.keys(c.fields ?? {}),
        origin: c.origin ?? "fsgtm",
        at: c.at,
      }));
      return { changes, lastSeq: r.json.lastSeq ?? after };
    },
    async get(object, id) {
      const r = object === "account"
        ? await call("POST", "accounts/get", { id })
        : object === "contact"
          ? await call("POST", "contacts/get", { id })
          : await call("POST", `objects/${encodeURIComponent(object)}/get`, { id });
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`record service get ${object} ${r.status}`);
      const row = r.json.account ?? r.json.contact ?? r.json.record;
      return row ? toLocal(object, row) : null;
    },
    async findBySfId(object, sfId) {
      // Exact sfId filter (record service contract 1.2.1). A `q` search does
      // not cover sfId, so it never matched on the real service.
      const path = object === "account" ? "accounts/list" : object === "contact" ? "contacts/list" : `objects/${encodeURIComponent(object)}/list`;
      const r = await call("POST", path, { filter: { sfId }, limit: 5 });
      if (r.status !== 200) throw new Error(`record service list ${object} ${r.status}`);
      const row = (r.json.rows ?? []).find((x: any) => x.sfId === sfId);
      return row ? toLocal(object, row) : null;
    },
    async edit(object, id, fields, opts: EditOptions) {
      const r = STANDARD.has(object)
        ? await call("POST", "records/edit", {
            object, id, patch: fields, actorId: o.actorId ?? "salesforce-sync", idempotencyKey: opts.idempotencyKey,
            source: opts.source, sourceTimestamp: opts.sourceTimestamp,
            ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
          })
        : await call("POST", `objects/${encodeURIComponent(object)}/edit`, {
            id, fields, actor: o.actorId ?? "salesforce-sync", source: opts.source,
            ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
          });
      if (r.status !== 200) throw new Error(`record service edit ${object} ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
      return { version: r.json.version };
    },
  };
}

// ───────────────────────────── Salesforce REST ─────────────────────────────

export type SfHttpOptions = {
  instanceUrl: string;
  apiVersion?: string;
  /** force=true after a 401 must return a refreshed token. */
  getToken: (force?: boolean) => Promise<string>;
  fetchImpl?: Fetch;
  onCall?: (method: string, path: string) => void;
};

const SF_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
const SF_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export function salesforceRest(o: SfHttpOptions) {
  const f = o.fetchImpl ?? fetch;
  const v = o.apiVersion ?? "v62.0";
  const request = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      o.onCall?.(method, path);
      const res = await f(`${o.instanceUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await o.getToken(attempt > 0)}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) continue;
      return res;
    }
    throw new Error("unreachable");
  };
  const soql: Soql = async (query) => {
    const out: Array<Record<string, unknown>> = [];
    let path: string | null = `/services/data/${v}/query?q=${encodeURIComponent(query)}`;
    while (path) {
      const res = await request("GET", path);
      if (!res.ok) throw new Error(`soql ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { records: Array<Record<string, unknown>>; nextRecordsUrl?: string };
      for (const r of body.records) { const { attributes: _a, ...rest } = r as any; out.push(rest); }
      path = body.nextRecordsUrl ?? null;
    }
    return out;
  };
  const port: SfPort = {
    async fetch(sfObject, sfIds, fields) {
      if (!SF_NAME.test(sfObject)) throw new Error(`bad sobject ${sfObject}`);
      const ids = sfIds.filter((id) => SF_ID.test(id));
      const out = new Map<string, SfRecord>();
      if (!ids.length) return out;
      const cols = [...new Set(["Id", "SystemModstamp", ...fields.filter((x) => SF_NAME.test(x))])];
      const rows = await soql(`SELECT ${cols.join(", ")} FROM ${sfObject} WHERE Id IN (${ids.map((id) => `'${id}'`).join(",")})`);
      for (const r of rows) {
        const rec = { ...r, Id: String(r.Id), SystemModstamp: Date.parse(String(r.SystemModstamp)) } as SfRecord;
        out.set(rec.Id, rec);
        if (rec.Id.length === 18) out.set(rec.Id.slice(0, 15), rec);
      }
      return out;
    },
    async patch(sfObject, sfId, fields) {
      if (!SF_NAME.test(sfObject) || !SF_ID.test(sfId)) throw new SfWriteError(`bad target ${sfObject} ${sfId}`, false);
      const res = await request("PATCH", `/services/data/${v}/sobjects/${sfObject}/${sfId}`, fields);
      if (res.status === 204 || res.ok) return;
      const text = (await res.text()).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new SfWriteError(`salesforce PATCH ${res.status}: ${text}`, retryable, res.status);
    },
  };
  return { port, soql };
}
