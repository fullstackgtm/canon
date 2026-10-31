// Salesforce API simulator for sync tests.
//
// Serves: OAuth token refresh, describeGlobal, describe, REST query (SOQL
// subset, 2000-row pages), sobject GET/POST/PATCH/DELETE, composite/sobjects,
// Bulk API 2.0 query jobs (CSV results with Sforce-Locator paging) and ingest
// jobs, limits, and `GET /sim/cdc?replayId=` with ChangeEventHeader-shaped
// change events. Every request is recorded in calls(); writeCount() counts
// mutating requests, so read-only mode can assert zero writes.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { buildSchema, SALES_PROCESSES, seedRecords, type ObjectDef, type SfObject } from "./schema.ts";
import { parseSoql, runQuery, SoqlError } from "./soql.ts";
import { makeId, parseCsv, prng, sfDateTime, toCsv } from "./util.ts";

export type { ObjectDef, SfObject, SfField } from "./schema.ts";
export { parseCsv, toCsv, to18, makeId } from "./util.ts";

export type SfSimOptions = {
  seed?: number;
  accounts?: number;
  contacts?: number;
  leads?: number;
  opportunities?: number;
  users?: number;
  customObjects?: ObjectDef[];
  customRecords?: number;
  /** Emails for the first users, so an import can map them to members. */
  userEmails?: string[];
  /** Serve /sim/cdc (true) or 404 it so clients fall back to polling (false). Default true. */
  cdc?: boolean;
  /** Fraction of API requests answered 503 SERVER_UNAVAILABLE (deterministic). */
  failRate?: number;
  /** Bulk query result page size when the client sends no maxRecords. Default 10000. */
  bulkPageSize?: number;
  port?: number;
};

export type SimCall = { method: string; path: string; status: number; at: number; write: boolean };
export type CdcEvent = {
  replayId: number;
  payload: {
    ChangeEventHeader: {
      entityName: string;
      recordIds: string[];
      changeType: "CREATE" | "UPDATE" | "DELETE" | "UNDELETE";
      changedFields: string[];
      commitTimestamp: number;
      commitNumber: number;
      commitUser: string;
      transactionKey: string;
      sequenceNumber: number;
      changeOrigin: string;
    };
    [field: string]: unknown;
  };
};

export type SfSim = {
  baseUrl: string;
  token: string;
  refreshToken: string;
  apiVersion: string;
  stop(): Promise<void>;
  /** A Salesforce-side edit (as a user in the Salesforce UI): updates the record and emits a change event. Not counted as an API write. */
  edit(object: string, id: string, fields: Record<string, unknown>): Record<string, unknown>;
  /** Direct record access for assertions. */
  get(object: string, id: string): Record<string, unknown> | undefined;
  records(object: string): Record<string, unknown>[];
  calls(): SimCall[];
  writeCount(): number;
  /** Invalidate the current access token (the next API call gets 401 until the client refreshes). */
  expireToken(): void;
  /** Toggle CDC at runtime. */
  setCdc(on: boolean): void;
  cdcEvents(): CdcEvent[];
};

const API_RE = /^\/services\/data\/(v\d+\.\d+)(\/.*)?$/;

/** Whether a request would mutate org data (a Bulk query job or token refresh does not). */
export function isMutating(method: string, path: string): boolean {
  if (method === "GET" || path.startsWith("/sim/") || path === "/services/oauth2/token") return false;
  if (method === "POST" && /\/jobs\/query$/.test(path)) return false;
  return /^\/services\/data\//.test(path);
}

class ApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export async function startSfSim(opts: SfSimOptions = {}): Promise<SfSim> {
  const now = Date.now();
  const schema = buildSchema(opts.customObjects ?? []);
  const data = seedRecords(schema, {
    seed: opts.seed ?? 1, accounts: opts.accounts ?? 50, contacts: opts.contacts ?? 150, leads: opts.leads ?? 20, opportunities: opts.opportunities ?? 20,
    users: opts.users ?? 5, customRecords: opts.customRecords ?? 25, userEmails: opts.userEmails,
  }, now);
  const counters = new Map<string, number>();
  for (const [name, m] of data) counters.set(name, m.size + 1_000_000);
  let token = randomBytes(24).toString("hex");
  const refreshToken = `simrefresh-${randomBytes(8).toString("hex")}`;
  let cdcOn = opts.cdc ?? true;
  const failRnd = prng((opts.seed ?? 1) ^ 0x5eed);
  const callLog: SimCall[] = [];
  const events: CdcEvent[] = [];
  let commitNumber = 0;
  const queryCursors = new Map<string, { rows: Record<string, unknown>[]; fields: string[]; object: string; offset: number; total: number }>();
  type QueryJob = { id: string; object: string; query: string; rows: Record<string, string>[]; header: string[]; state: string; polls: number; createdDate: string };
  const queryJobs = new Map<string, QueryJob>();
  type IngestJob = {
    id: string; object: string; operation: string; externalIdFieldName?: string; state: string; csv: string[];
    ok: Array<Record<string, string>>; failed: Array<Record<string, string>>; header: string[]; lineEnding: string;
  };
  const ingestJobs = new Map<string, IngestJob>();
  let jobCounter = 0;
  const apiVersion = "v67.0";

  const sobj = (name: string): SfObject => {
    const o = schema.get(name) ?? [...schema.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!o) throw new ApiError(404, "NOT_FOUND", `The requested resource does not exist: ${name}`);
    return o;
  };
  const canonical = (o: SfObject) => (f: string) => {
    const hit = o.fields.find((x) => x.name.toLowerCase() === f.toLowerCase());
    if (!hit) throw new ApiError(400, "INVALID_FIELD", `No such column '${f}' on entity '${o.name}'.`);
    return hit.name;
  };
  const store = (o: SfObject) => {
    if (!o.queryable) throw new ApiError(400, "INVALID_TYPE", `sObject type '${o.name}' is not supported.`);
    return data.get(o.name)!;
  };

  const emit = (entity: string, changeType: CdcEvent["payload"]["ChangeEventHeader"]["changeType"], id: string, fields: Record<string, unknown>, origin: string, ts: number) => {
    commitNumber++;
    events.push({
      replayId: events.length + 1,
      payload: {
        ChangeEventHeader: {
          entityName: entity, recordIds: [id], changeType, changedFields: Object.keys(fields), commitTimestamp: ts, commitNumber, commitUser: "005SmSIMUSER0AAA",
          transactionKey: `tx-${commitNumber}`, sequenceNumber: 1, changeOrigin: origin,
        },
        ...fields,
      },
    });
  };

  const validateWrite = (o: SfObject, fields: Record<string, unknown>, creating: boolean) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "attributes" || k === "Id" || k === "id") continue;
      const f = o.fields.find((x) => x.name.toLowerCase() === k.toLowerCase());
      if (!f) throw new ApiError(400, "INVALID_FIELD", `No such column '${k}' on sobject of type ${o.name}`);
      if (creating ? !f.createable : !f.updateable) throw new ApiError(400, "INVALID_FIELD_FOR_INSERT_UPDATE", `Unable to create/update fields: ${f.name}.`);
      out[f.name] = v === "" ? null : f.type === "int" || f.type === "double" || f.type === "currency" || f.type === "percent" ? (v === null ? null : Number(v))
        : f.type === "boolean" ? v === true || v === "true" : v;
    }
    return out;
  };

  /** Apply an update; returns the changed fields. */
  const update = (o: SfObject, id: string, fields: Record<string, unknown>, origin: string) => {
    const rec = store(o).get(id);
    if (!rec) throw new ApiError(404, "NOT_FOUND", "Provided external ID field does not exist or is not accessible: " + id);
    const vals = validateWrite(o, fields, false);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) if (JSON.stringify(rec[k] ?? null) !== JSON.stringify(v ?? null)) changed[k] = v;
    const ts = Date.now();
    Object.assign(rec, vals, { LastModifiedDate: sfDateTime(ts), SystemModstamp: sfDateTime(ts) });
    if (Object.keys(changed).length) emit(o.name, "UPDATE", id, { ...changed, LastModifiedDate: rec.LastModifiedDate }, origin, ts);
    return rec;
  };
  const create = (o: SfObject, fields: Record<string, unknown>, origin: string) => {
    const vals = validateWrite(o, fields, true);
    if (o.fields.some((f) => f.name === "Name") && !o.fields.find((f) => f.name === "Name")!.nillable && !vals.Name && o.name !== "Contact" && o.name !== "Lead")
      throw new ApiError(400, "REQUIRED_FIELD_MISSING", "Required fields are missing: [Name]");
    if ((o.name === "Contact" || o.name === "Lead") && !vals.LastName) throw new ApiError(400, "REQUIRED_FIELD_MISSING", "Required fields are missing: [LastName]");
    const n = counters.get(o.name)! + 1;
    counters.set(o.name, n);
    const ts = Date.now();
    const id = makeId(o.keyPrefix!, n);
    const rec: Record<string, unknown> = { Id: id, IsDeleted: false, CreatedDate: sfDateTime(ts), LastModifiedDate: sfDateTime(ts), SystemModstamp: sfDateTime(ts), ...vals };
    if ((o.name === "Contact" || o.name === "Lead") && !("Name" in vals)) rec.Name = [rec.FirstName, rec.LastName].filter(Boolean).join(" ");
    store(o).set(id, rec);
    emit(o.name, "CREATE", id, vals, origin, ts);
    return rec;
  };
  const remove = (o: SfObject, id: string, origin: string) => {
    if (!store(o).delete(id)) throw new ApiError(404, "ENTITY_IS_DELETED", "entity is deleted");
    emit(o.name, "DELETE", id, {}, origin, Date.now());
  };

  const restRecord = (o: SfObject, rec: Record<string, unknown>, fields?: string[]) => ({
    attributes: { type: o.name, url: `/services/data/${apiVersion}/sobjects/${o.name}/${rec.Id}` },
    ...(fields ? Object.fromEntries(fields.map((f) => [f, rec[f] ?? null])) : rec),
  });

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const json = (text: string) => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, "JSON_PARSER_ERROR", "invalid JSON");
    }
  };

  const restOrigin = `com/salesforce/api/rest/${apiVersion.slice(1)}`;

  async function route(req: IncomingMessage, url: URL, res: ServerResponse): Promise<{ status: number; body?: unknown; text?: string; headers?: Record<string, string>; write: boolean }> {
    const method = req.method ?? "GET";
    const p = url.pathname;
    // OAuth refresh (form-encoded, like login.salesforce.com).
    if (p === "/services/oauth2/token" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== refreshToken)
        return { status: 400, body: { error: "invalid_grant", error_description: "expired access/refresh token" }, write: false };
      token = randomBytes(24).toString("hex");
      return { status: 200, body: { access_token: token, instance_url: baseUrl, token_type: "Bearer", issued_at: String(Date.now()), scope: "api refresh_token" }, write: false };
    }
    if (p === "/sim/calls" && method === "GET") {
      return { status: 200, body: { calls: callLog.length, writes: callLog.filter((c) => c.write).length }, write: false };
    }
    if (p === "/sim/cdc" && method === "GET") {
      if (!cdcOn) throw new ApiError(404, "NOT_FOUND", "CDC is not enabled for this org");
      const after = Number(url.searchParams.get("replayId") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 5000);
      const out = events.slice(after, after + limit);
      return { status: 200, body: { events: out, latestReplayId: events.length }, write: false };
    }
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!auth || auth[1] !== token) return { status: 401, body: [{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }], write: false };
    if (p === "/services/oauth2/userinfo") return { status: 200, body: { organization_id: "00DSm0000000SIMAAA", username: "sim@sim.example" }, write: false };
    const m = API_RE.exec(p);
    if (!m) throw new ApiError(404, "NOT_FOUND", "The requested resource does not exist");
    const rest = m[2] ?? "/";
    if (opts.failRate && failRnd() < opts.failRate) return { status: 503, body: [{ message: "Server unavailable", errorCode: "SERVER_UNAVAILABLE" }], write: isMutating(method, p) };
    let mm: RegExpExecArray | null;

    if (rest === "/limits") return { status: 200, body: { DailyApiRequests: { Max: 15000, Remaining: 15000 - callLog.length }, DailyBulkV2QueryJobs: { Max: 10000, Remaining: 10000 - queryJobs.size } }, write: false };
    if (rest === "/sobjects" || rest === "/sobjects/") {
      return {
        status: 200, write: false,
        body: {
          encoding: "UTF-8", maxBatchSize: 200,
          sobjects: [...schema.values()].map((o) => ({
            name: o.name, label: o.label, labelPlural: o.labelPlural, keyPrefix: o.keyPrefix, custom: o.custom, queryable: o.queryable,
            createable: o.createable, updateable: o.updateable, deletable: o.deletable, retrieveable: o.queryable, searchable: o.queryable,
            deprecatedAndHidden: false, layoutable: o.queryable, customSetting: false,
          })),
        },
      };
    }
    if ((mm = /^\/sobjects\/([A-Za-z0-9_]+)\/describe\/?$/.exec(rest))) {
      const o = sobj(mm[1]);
      return {
        status: 200, write: false,
        body: {
          name: o.name, label: o.label, labelPlural: o.labelPlural, keyPrefix: o.keyPrefix, custom: o.custom, queryable: o.queryable, createable: o.createable,
          updateable: o.updateable, deletable: o.deletable, fields: o.fields,
          recordTypeInfos: [
            ...(o.name === "Opportunity" ? SALES_PROCESSES.map((p) => ({ name: p.recordTypeName, developerName: p.developerName, recordTypeId: p.recordTypeId, master: false, active: true, available: true })) : []),
            { name: "Master", recordTypeId: "012000000000000AAA", master: true, active: true, available: true },
          ],
          childRelationships: [],
        },
      };
    }
    // A note's body, as a blob field's sub-resource returns it (base64 fields are not queryable in bulk).
    if ((mm = /^\/sobjects\/ContentNote\/([A-Za-z0-9]{15,18})\/Content$/.exec(rest)) && method === "GET") {
      const note = data.get("ContentNote")!.get(mm[1]);
      if (!note) throw new ApiError(404, "NOT_FOUND", "The requested resource does not exist");
      return { status: 200, text: Buffer.from(String(note.Content ?? ""), "base64").toString("utf8"), headers: { "content-type": "text/plain" }, write: false };
    }
    // UI API: the StageName values a record type's sales process allows.
    if ((mm = /^\/ui-api\/object-info\/Opportunity\/picklist-values\/([A-Za-z0-9]{15,18})\/StageName$/.exec(rest))) {
      const process = SALES_PROCESSES.find((p) => p.recordTypeId === mm![1]);
      if (!process) throw new ApiError(404, "NOT_FOUND", "The requested resource does not exist");
      return { status: 200, body: { defaultValue: null, url: rest, values: process.stages.map((s) => ({ label: s, value: s, validFor: [], attributes: null })) }, write: false };
    }
    if (rest === "/query" || rest === "/queryAll") {
      const q = url.searchParams.get("q") ?? "";
      const parsed = parseSoql(q);
      const o = sobj(parsed.object);
      const r = runQuery(parsed, store(o).values(), canonical(o));
      if (parsed.count) return { status: 200, body: { totalSize: r.total, done: true, records: [] }, write: false };
      return { status: 200, body: page({ rows: r.rows, fields: r.fields, object: o.name, offset: 0, total: r.rows.length }), write: false };
    }
    if ((mm = /^\/query\/([A-Za-z0-9-]+)$/.exec(rest))) {
      const cur = queryCursors.get(mm[1]);
      if (!cur) throw new ApiError(400, "INVALID_QUERY_LOCATOR", "invalid query locator");
      return { status: 200, body: page(cur), write: false };
    }
    if (rest === "/composite/sobjects") {
      if (method === "DELETE") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        return {
          status: 200, write: true,
          body: ids.map((id) => {
            const o = [...schema.values()].find((x) => x.keyPrefix && id.startsWith(x.keyPrefix));
            try {
              if (!o) throw new ApiError(400, "MALFORMED_ID", "bad id");
              remove(o, id, restOrigin);
              return { id, success: true, errors: [] };
            } catch (e) {
              return { id, success: false, errors: [{ statusCode: (e as ApiError).errorCode ?? "UNKNOWN", message: (e as Error).message, fields: [] }] };
            }
          }),
        };
      }
      const body = json(await readBody(req)) as { allOrNone?: boolean; records?: Array<Record<string, unknown>> };
      const recs = body.records ?? [];
      if (recs.length > 200) throw new ApiError(400, "EXCEEDED_ID_LIMIT", "record limit is 200");
      return {
        status: 200, write: true,
        body: recs.map((r) => {
          const type = (r.attributes as { type?: string } | undefined)?.type ?? "";
          try {
            const o = sobj(type);
            const rec = method === "PATCH" ? update(o, String(r.id ?? r.Id), r, restOrigin) : create(o, r, restOrigin);
            return { id: rec.Id, success: true, errors: [] };
          } catch (e) {
            return { id: (r.id ?? r.Id ?? null) as string | null, success: false, errors: [{ statusCode: (e as ApiError).errorCode ?? "UNKNOWN", message: (e as Error).message, fields: [] }] };
          }
        }),
      };
    }
    if ((mm = /^\/sobjects\/([A-Za-z0-9_]+)\/?$/.exec(rest)) && method === "POST") {
      const o = sobj(mm[1]);
      const rec = create(o, json(await readBody(req)), restOrigin);
      return { status: 201, body: { id: rec.Id, success: true, errors: [] }, write: true };
    }
    if ((mm = /^\/sobjects\/([A-Za-z0-9_]+)\/([A-Za-z0-9]{15,18})$/.exec(rest))) {
      const o = sobj(mm[1]);
      const id = mm[2].length === 15 ? [...store(o).keys()].find((k) => k.startsWith(mm![2])) ?? mm[2] : mm[2];
      if (method === "GET") {
        const rec = store(o).get(id);
        if (!rec) throw new ApiError(404, "NOT_FOUND", "The requested resource does not exist");
        const fields = url.searchParams.get("fields")?.split(",").map(canonical(o));
        return { status: 200, body: restRecord(o, rec, fields), write: false };
      }
      if (method === "PATCH") {
        update(o, id, json(await readBody(req)), restOrigin);
        return { status: 204, write: true };
      }
      if (method === "DELETE") {
        remove(o, id, restOrigin);
        return { status: 204, write: true };
      }
    }
    // ---------- Bulk API 2.0 query ----------
    if (rest === "/jobs/query" && method === "POST") {
      const b = json(await readBody(req)) as { operation?: string; query?: string };
      if (b.operation !== "query" && b.operation !== "queryAll") throw new ApiError(400, "INVALIDJOB", "operation must be query");
      const parsed = parseSoql(b.query ?? "");
      if (parsed.count) throw new ApiError(400, "INVALIDJOB", "COUNT() is not supported in Bulk API 2.0 queries");
      const o = sobj(parsed.object);
      const r = runQuery(parsed, store(o).values(), canonical(o));
      const id = `750Sm${String(++jobCounter).padStart(10, "0")}`;
      const rows = r.rows.map((rec) => Object.fromEntries(r.fields.map((f) => [f, csvValue(rec[f])])));
      const job: QueryJob = { id, object: o.name, query: b.query!, rows, header: r.fields, state: "UploadComplete", polls: 0, createdDate: sfDateTime(Date.now()) };
      queryJobs.set(id, job);
      return { status: 200, body: jobInfo(job), write: false };
    }
    if ((mm = /^\/jobs\/query\/([A-Za-z0-9]+)$/.exec(rest)) && method === "GET") {
      const job = queryJobs.get(mm[1]);
      if (!job) throw new ApiError(404, "NOT_FOUND", "job not found");
      // InProgress on the first poll, JobComplete after: clients must poll.
      job.polls++;
      job.state = job.polls >= 2 ? "JobComplete" : "InProgress";
      return { status: 200, body: jobInfo(job), write: false };
    }
    if ((mm = /^\/jobs\/query\/([A-Za-z0-9]+)\/results$/.exec(rest)) && method === "GET") {
      const job = queryJobs.get(mm[1]);
      if (!job) throw new ApiError(404, "NOT_FOUND", "job not found");
      if (job.state !== "JobComplete") throw new ApiError(400, "INVALIDJOBSTATE", "job is not complete");
      const start = Number(url.searchParams.get("locator") ? Buffer.from(url.searchParams.get("locator")!, "base64url").toString() : 0);
      const max = Number(url.searchParams.get("maxRecords") ?? opts.bulkPageSize ?? 10_000);
      const slice = job.rows.slice(start, start + max);
      const next = start + slice.length < job.rows.length ? Buffer.from(String(start + slice.length)).toString("base64url") : "null";
      return { status: 200, text: toCsv(job.header, slice), headers: { "content-type": "text/csv", "sforce-locator": next, "sforce-numberofrecords": String(slice.length) }, write: false };
    }
    // ---------- Bulk API 2.0 ingest ----------
    if (rest === "/jobs/ingest" && method === "POST") {
      const b = json(await readBody(req)) as { object?: string; operation?: string; externalIdFieldName?: string; lineEnding?: string };
      const o = sobj(b.object ?? "");
      if (!["insert", "update", "upsert", "delete"].includes(b.operation ?? "")) throw new ApiError(400, "INVALIDJOB", "unsupported operation");
      const id = `750Sm${String(++jobCounter).padStart(10, "0")}`;
      const job: IngestJob = { id, object: o.name, operation: b.operation!, externalIdFieldName: b.externalIdFieldName, state: "Open", csv: [], ok: [], failed: [], header: [], lineEnding: b.lineEnding === "CRLF" ? "\r\n" : "\n" };
      ingestJobs.set(id, job);
      return { status: 200, body: ingestInfo(job), write: true };
    }
    if ((mm = /^\/jobs\/ingest\/([A-Za-z0-9]+)\/batches$/.exec(rest)) && method === "PUT") {
      const job = ingestJobs.get(mm[1]);
      if (!job || job.state !== "Open") throw new ApiError(400, "INVALIDJOBSTATE", "job is not open");
      job.csv.push(await readBody(req));
      return { status: 201, write: true };
    }
    if ((mm = /^\/jobs\/ingest\/([A-Za-z0-9]+)$/.exec(rest))) {
      const job = ingestJobs.get(mm[1]);
      if (!job) throw new ApiError(404, "NOT_FOUND", "job not found");
      if (method === "PATCH") {
        const b = json(await readBody(req)) as { state?: string };
        if (b.state === "Aborted") job.state = "Aborted";
        else if (b.state === "UploadComplete") processIngest(job);
        return { status: 200, body: ingestInfo(job), write: true };
      }
      if (method === "GET") return { status: 200, body: ingestInfo(job), write: false };
    }
    if ((mm = /^\/jobs\/ingest\/([A-Za-z0-9]+)\/(successfulResults|failedResults)$/.exec(rest)) && method === "GET") {
      const job = ingestJobs.get(mm[1]);
      if (!job) throw new ApiError(404, "NOT_FOUND", "job not found");
      const ok = mm[2] === "successfulResults";
      const rows = ok ? job.ok : job.failed;
      const header = [...(ok ? ["sf__Id", "sf__Created"] : ["sf__Id", "sf__Error"]), ...job.header];
      return { status: 200, text: toCsv(header, rows), headers: { "content-type": "text/csv" }, write: false };
    }
    void res;
    throw new ApiError(404, "NOT_FOUND", `The requested resource does not exist: ${method} ${rest}`);
  }

  function csvValue(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  }

  function page(cur: { rows: Record<string, unknown>[]; fields: string[]; object: string; offset: number; total: number }) {
    const size = 2000;
    const o = sobj(cur.object);
    const slice = cur.rows.slice(cur.offset, cur.offset + size);
    const nextOffset = cur.offset + slice.length;
    let nextRecordsUrl: string | undefined;
    if (nextOffset < cur.rows.length) {
      const loc = `01gSm${randomBytes(6).toString("hex")}-${nextOffset}`;
      queryCursors.set(loc, { ...cur, offset: nextOffset });
      nextRecordsUrl = `/services/data/${apiVersion}/query/${loc}`;
    }
    return {
      totalSize: cur.total, done: !nextRecordsUrl, ...(nextRecordsUrl ? { nextRecordsUrl } : {}),
      records: slice.map((r) => restRecord(o, r, cur.fields)),
    };
  }

  function jobInfo(job: QueryJob) {
    return {
      id: job.id, operation: "query", object: job.object, createdById: "005SmSIMUSER0AAA", createdDate: job.createdDate, state: job.state,
      concurrencyMode: "Parallel", contentType: "CSV", apiVersion: Number(apiVersion.slice(1)), lineEnding: "LF", columnDelimiter: "COMMA",
      numberRecordsProcessed: job.state === "JobComplete" ? job.rows.length : 0, retries: 0, totalProcessingTime: 1,
    };
  }
  function ingestInfo(job: IngestJob) {
    return {
      id: job.id, operation: job.operation, object: job.object, state: job.state, contentType: "CSV", apiVersion: Number(apiVersion.slice(1)),
      externalIdFieldName: job.externalIdFieldName, numberRecordsProcessed: job.ok.length + job.failed.length, numberRecordsFailed: job.failed.length,
    };
  }
  function processIngest(job: IngestJob) {
    const o = sobj(job.object);
    const origin = `com/salesforce/api/bulk/${apiVersion.slice(1)}`;
    for (const text of job.csv) {
      const rows = parseCsv(text);
      if (rows.length && !job.header.length) job.header = Object.keys(rows[0]);
      for (const row of rows) {
        const vals: Record<string, unknown> = {};
        // Bulk 2.0: an empty cell leaves the field unchanged; #N/A sets it to null.
        for (const [k, v] of Object.entries(row)) if (k !== "Id" && v !== "") vals[k] = v === "#N/A" ? null : v;
        try {
          let rec: Record<string, unknown>;
          let created = false;
          if (job.operation === "insert") (rec = create(o, vals, origin)), (created = true);
          else if (job.operation === "update") rec = update(o, row.Id, vals, origin);
          else if (job.operation === "delete") {
            remove(o, row.Id, origin);
            rec = { Id: row.Id };
          } else {
            const ext = job.externalIdFieldName ?? "Id";
            const key = ext === "Id" ? row.Id : row[ext];
            const hit = ext === "Id" ? store(o).get(key) : [...store(o).values()].find((r) => String(r[ext] ?? "") === key);
            if (hit) {
              const { [ext]: _drop, ...rest } = vals;
              rec = update(o, String(hit.Id), ext === "Id" ? vals : rest, origin);
            } else (rec = create(o, vals, origin)), (created = true);
          }
          job.ok.push({ sf__Id: String(rec.Id), sf__Created: String(created), ...row });
        } catch (e) {
          job.failed.push({ sf__Id: row.Id ?? "", sf__Error: `${(e as ApiError).errorCode ?? "UNKNOWN"}:${(e as Error).message}`, ...row });
        }
      }
    }
    job.state = "JobComplete";
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://sim");
    const method = req.method ?? "GET";
    let status = 500;
    let write = false;
    try {
      const out = await route(req, url, res);
      status = out.status;
      write = out.write;
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body)));
    } catch (e) {
      const err = e instanceof ApiError ? e : e instanceof SoqlError ? new ApiError(400, e.errorCode, e.message) : new ApiError(500, "UNKNOWN_EXCEPTION", String((e as Error)?.message ?? e));
      status = err.status;
      write = isMutating(method, url.pathname);
      res.writeHead(err.status, { "content-type": "application/json" });
      res.end(JSON.stringify([{ message: err.message, errorCode: err.errorCode }]));
    } finally {
      callLog.push({ method, path: url.pathname + url.search, status, at: Date.now(), write });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    baseUrl,
    get token() {
      return token;
    },
    refreshToken,
    apiVersion,
    stop: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
    edit(object, id, fields) {
      const o = sobj(object);
      const rec = store(o).get(id);
      if (!rec) throw new Error(`no ${object} ${id}`);
      const ts = Date.now();
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        const f = canonical(o)(k);
        if (JSON.stringify(rec[f] ?? null) !== JSON.stringify(v ?? null)) changed[f] = v;
      }
      Object.assign(rec, changed, { LastModifiedDate: sfDateTime(ts), SystemModstamp: sfDateTime(ts) });
      if (Object.keys(changed).length) emit(o.name, "UPDATE", id, { ...changed, LastModifiedDate: rec.LastModifiedDate }, "com/salesforce/ui", ts);
      return rec;
    },
    get: (object, id) => data.get(sobj(object).name)?.get(id),
    records: (object) => [...(data.get(sobj(object).name)?.values() ?? [])],
    calls: () => [...callLog],
    writeCount: () => callLog.filter((c) => c.write).length,
    expireToken() {
      token = randomBytes(24).toString("hex");
    },
    setCdc(on) {
      cdcOn = on;
    },
    cdcEvents: () => [...events],
  };
}
