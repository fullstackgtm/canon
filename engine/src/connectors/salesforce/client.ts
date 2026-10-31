/**
 * Salesforce REST + Bulk API 2.0 client for import and sync.
 *
 * Runtime-agnostic: only `fetch`, no Node built-ins, so it runs in Convex's
 * default runtime, in Node and against the sf-sim simulator.
 *
 * Auth: `getToken()` returns the current access token. On a 401 the client
 * calls `refreshToken()` (when given) once and retries. Tokens are never
 * logged or put in error messages.
 */

export type SfConn = {
  instanceUrl: string;
  getToken(): Promise<string>;
  /** Called once on a 401; returns a fresh token. Defaults to getToken(). */
  refreshToken?(): Promise<string>;
  /** e.g. "v62.0" */
  apiVersion: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  /** Retries for 503 / 429 / network errors (default 4). */
  maxRetries?: number;
};

export class SalesforceApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(`Salesforce ${status} ${errorCode}: ${message}`);
    this.status = status;
    this.errorCode = errorCode;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Low-level request with refresh-on-401 and retry on 503/429. Returns the raw Response (ok). */
export async function sfRequest(c: SfConn, path: string, init: RequestInit = {}): Promise<Response> {
  const f = c.fetch ?? fetch;
  const url = path.startsWith("http") ? path : `${c.instanceUrl.replace(/\/$/, "")}${path.startsWith("/services/") ? "" : `/services/data/${c.apiVersion}`}${path}`;
  let token = await c.getToken();
  let refreshed = false;
  const max = c.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt >= max) throw e;
      await sleep(Math.min(200 * 2 ** attempt, 5000));
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await (c.refreshToken ?? c.getToken)();
      continue;
    }
    if ((res.status === 503 || res.status === 429 || res.status === 502) && attempt < max) {
      await res.text().catch(() => "");
      await sleep(Math.min(200 * 2 ** attempt, 5000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code = "UNKNOWN";
      let msg = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        const e = Array.isArray(j) ? j[0] : j;
        code = e?.errorCode ?? e?.error ?? code;
        msg = e?.message ?? e?.error_description ?? msg;
      } catch {
        // not JSON
      }
      throw new SalesforceApiError(res.status, code, msg);
    }
    return res;
  }
}

export async function sfJson<T>(c: SfConn, path: string, init: RequestInit = {}): Promise<T> {
  const res = await sfRequest(c, path, {
    ...init,
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- describe ----------

export type SObjectSummary = {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  keyPrefix: string | null;
  deprecatedAndHidden?: boolean;
  customSetting?: boolean;
};

export type SFieldDescribe = {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  createable: boolean;
  nillable: boolean;
  custom: boolean;
  calculated: boolean;
  externalId?: boolean;
  referenceTo: string[];
  picklistValues?: Array<{ value: string; label: string | null; active: boolean }>;
};

export type SObjectDescribe = SObjectSummary & { fields: SFieldDescribe[] };

export async function describeGlobal(c: SfConn): Promise<SObjectSummary[]> {
  const r = await sfJson<{ sobjects: SObjectSummary[] }>(c, "/sobjects");
  return r.sobjects;
}

export async function describeSObject(c: SfConn, name: string): Promise<SObjectDescribe> {
  return sfJson<SObjectDescribe>(c, `/sobjects/${encodeURIComponent(name)}/describe`);
}

// ---------- REST query ----------

export type QueryResult<T> = { totalSize: number; done: boolean; nextRecordsUrl?: string; records: T[] };

/** Yields each page of a REST SOQL query, following nextRecordsUrl. */
export async function* soqlPages<T = Record<string, unknown>>(c: SfConn, query: string): AsyncGenerator<QueryResult<T>> {
  let r = await sfJson<QueryResult<T>>(c, `/query?q=${encodeURIComponent(query)}`);
  yield r;
  while (!r.done && r.nextRecordsUrl) {
    r = await sfJson<QueryResult<T>>(c, r.nextRecordsUrl);
    yield r;
  }
}

/** Runs a SOQL query and returns every record (all pages). For COUNT() queries, read totalSize. */
export async function soql<T = Record<string, unknown>>(c: SfConn, query: string): Promise<{ totalSize: number; records: T[] }> {
  const records: T[] = [];
  let totalSize = 0;
  for await (const p of soqlPages<T>(c, query)) {
    totalSize = p.totalSize;
    records.push(...p.records);
  }
  return { totalSize, records };
}

// ---------- REST writes ----------

export async function patchRecord(c: SfConn, object: string, id: string, fields: Record<string, unknown>): Promise<void> {
  await sfJson<void>(c, `/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(fields) });
}

export type CompositeResult = { id: string | null; success: boolean; errors: Array<{ statusCode: string; message: string; fields?: string[] }> };

/** Update up to 200 records in one call (allOrNone=false). */
export async function patchRecords(c: SfConn, object: string, records: Array<{ id: string; fields: Record<string, unknown> }>): Promise<CompositeResult[]> {
  if (records.length > 200) throw new Error("patchRecords takes at most 200 records");
  return sfJson<CompositeResult[]>(c, "/composite/sobjects", {
    method: "PATCH",
    body: JSON.stringify({ allOrNone: false, records: records.map((r) => ({ attributes: { type: object }, id: r.id, ...r.fields })) }),
  });
}

// ---------- CSV ----------

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') (field += '"'), (i += 2);
        else (quoted = false), i++;
      } else (field += ch), i++;
      continue;
    }
    if (ch === '"') (quoted = true), (any = true), i++;
    else if (ch === ",") row.push(field), (field = ""), (any = true), i++;
    else if (ch === "\r" || ch === "\n") {
      if (any || field || row.length) row.push(field), rows.push(row);
      row = [];
      field = "";
      any = false;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else (field += ch), (any = true), i++;
  }
  if (any || field || row.length) row.push(field), rows.push(row);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

const csvCell = (v: unknown) => (v === null || v === undefined ? "#N/A" : `"${String(v).replaceAll('"', '""')}"`);
export function toCsv(header: string[], rows: Array<Record<string, unknown>>): string {
  return [header.map((h) => `"${h}"`).join(","), ...rows.map((r) => header.map((h) => (h in r ? csvCell(r[h]) : "")).join(","))].join("\n") + "\n";
}

// ---------- Bulk API 2.0 ----------

export type BulkQueryOptions = { pollIntervalMs?: number; timeoutMs?: number; maxRecords?: number; onJob?: (jobId: string) => void };

/**
 * Runs a Bulk API 2.0 query job and yields result pages (arrays of rows keyed
 * by field name, values as strings; empty string = null). Resumable callers
 * can record the job id via `onJob`.
 */
export async function* bulkQuery(c: SfConn, query: string, o: BulkQueryOptions = {}): AsyncGenerator<Record<string, string>[]> {
  const job = await sfJson<{ id: string; state: string }>(c, "/jobs/query", {
    method: "POST",
    body: JSON.stringify({ operation: "query", query, contentType: "CSV", columnDelimiter: "COMMA", lineEnding: "LF" }),
  });
  o.onJob?.(job.id);
  yield* bulkQueryResults(c, job.id, o);
}

/** Polls a Bulk query job until complete, then yields its result pages. */
export async function* bulkQueryResults(c: SfConn, jobId: string, o: BulkQueryOptions = {}): AsyncGenerator<Record<string, string>[]> {
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const s = await sfJson<{ state: string; errorMessage?: string }>(c, `/jobs/query/${jobId}`);
    if (s.state === "JobComplete") break;
    if (s.state === "Failed" || s.state === "Aborted") throw new SalesforceApiError(400, s.state.toUpperCase(), s.errorMessage ?? `bulk query job ${s.state}`);
    if (Date.now() > deadline) throw new Error(`bulk query job ${jobId} timed out`);
    await sleep(o.pollIntervalMs ?? 1000);
  }
  let locator: string | null = null;
  for (;;) {
    const qs = new URLSearchParams();
    if (locator) qs.set("locator", locator);
    if (o.maxRecords) qs.set("maxRecords", String(o.maxRecords));
    const res = await sfRequest(c, `/jobs/query/${jobId}/results${qs.toString() ? `?${qs}` : ""}`, { headers: { Accept: "text/csv" } });
    const rows = parseCsv(await res.text());
    if (rows.length) yield rows;
    const next = res.headers.get("sforce-locator");
    if (!next || next === "null") return;
    locator = next;
  }
}

export type BulkIngestResult = {
  jobId: string;
  state: string;
  processed: number;
  failed: number;
  successes: Array<{ id: string; created: boolean; row: Record<string, string> }>;
  failures: Array<{ id: string; error: string; row: Record<string, string> }>;
};

/** Runs a Bulk API 2.0 ingest job (insert / update / upsert / delete) and waits for its results. */
export async function bulkIngest(
  c: SfConn,
  input: { object: string; operation: "insert" | "update" | "upsert" | "delete"; records: Array<Record<string, unknown>>; externalIdFieldName?: string; pollIntervalMs?: number; timeoutMs?: number },
): Promise<BulkIngestResult> {
  const job = await sfJson<{ id: string }>(c, "/jobs/ingest", {
    method: "POST",
    body: JSON.stringify({ object: input.object, operation: input.operation, contentType: "CSV", lineEnding: "LF", ...(input.externalIdFieldName ? { externalIdFieldName: input.externalIdFieldName } : {}) }),
  });
  const header = [...new Set(input.records.flatMap((r) => Object.keys(r)))];
  await sfRequest(c, `/jobs/ingest/${job.id}/batches`, { method: "PUT", headers: { "Content-Type": "text/csv" }, body: toCsv(header, input.records) });
  await sfJson(c, `/jobs/ingest/${job.id}`, { method: "PATCH", body: JSON.stringify({ state: "UploadComplete" }) });
  const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
  let info: { state: string; numberRecordsProcessed: number; numberRecordsFailed: number };
  for (;;) {
    info = await sfJson(c, `/jobs/ingest/${job.id}`);
    if (info.state === "JobComplete" || info.state === "Failed" || info.state === "Aborted") break;
    if (Date.now() > deadline) throw new Error(`bulk ingest job ${job.id} timed out`);
    await sleep(input.pollIntervalMs ?? 1000);
  }
  const ok = parseCsv(await (await sfRequest(c, `/jobs/ingest/${job.id}/successfulResults`, { headers: { Accept: "text/csv" } })).text());
  const bad = parseCsv(await (await sfRequest(c, `/jobs/ingest/${job.id}/failedResults`, { headers: { Accept: "text/csv" } })).text());
  const strip = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("sf__")));
  return {
    jobId: job.id, state: info.state, processed: info.numberRecordsProcessed, failed: info.numberRecordsFailed,
    successes: ok.map((r) => ({ id: r.sf__Id, created: r.sf__Created === "true", row: strip(r) })),
    failures: bad.map((r) => ({ id: r.sf__Id, error: r.sf__Error, row: strip(r) })),
  };
}
