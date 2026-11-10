/**
 * Minimal Salesforce REST + Bulk API 2.0 query client: B's local stand-in for
 * A's connectors/salesforce/ modules (same SfConn shape). Swap for A's
 * `bulkQuery` / `describeGlobal` / `describeSObject` / `soql` when merged.
 *
 * Never logs or embeds tokens in errors.
 */
import type { SfConn } from "./contracts.ts";

async function sfFetch(c: SfConn, path: string, init: RequestInit = {}): Promise<Response> {
  const f = c.fetchImpl ?? fetch;
  const url = path.startsWith("http") ? path : `${c.instanceUrl.replace(/\/$/, "")}${path}`;
  const go = async (token: string) =>
    f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
  let res = await go(await c.getToken());
  if (res.status === 401 && c.refreshToken) res = await go(await c.refreshToken());
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Salesforce ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${body}`);
  }
  return res;
}

const base = (c: SfConn) => `/services/data/v${c.apiVersion}`;

export type DescribeGlobalSObject = { name: string; label: string; custom: boolean; queryable: boolean; createable?: boolean; deprecatedAndHidden?: boolean };
export type DescribeField = {
  name: string; label: string; type: string; referenceTo?: string[]; updateable?: boolean; custom?: boolean; calculated?: boolean; picklistValues?: Array<{ value: string; active?: boolean }>;
};

export async function describeGlobal(c: SfConn): Promise<DescribeGlobalSObject[]> {
  const res = await sfFetch(c, `${base(c)}/sobjects`);
  return ((await res.json()) as { sobjects: DescribeGlobalSObject[] }).sobjects;
}

export async function describeSObject(c: SfConn, name: string): Promise<{ name: string; label: string; custom: boolean; fields: DescribeField[] }> {
  const res = await sfFetch(c, `${base(c)}/sobjects/${encodeURIComponent(name)}/describe`);
  return (await res.json()) as { name: string; label: string; custom: boolean; fields: DescribeField[] };
}

/** REST SOQL query, following nextRecordsUrl. */
export async function soql<T = Record<string, unknown>>(c: SfConn, q: string): Promise<{ totalSize: number; records: T[] }> {
  let res = await sfFetch(c, `${base(c)}/query?q=${encodeURIComponent(q)}`);
  let page = (await res.json()) as { totalSize: number; records: T[]; nextRecordsUrl?: string; done: boolean };
  const records = [...page.records];
  while (!page.done && page.nextRecordsUrl) {
    res = await sfFetch(c, page.nextRecordsUrl);
    page = (await res.json()) as typeof page;
    records.push(...page.records);
  }
  return { totalSize: page.totalSize, records };
}

/** GET a path under the org's versioned REST base, such as `/ui-api/...`. */
export async function restGet<T>(c: SfConn, path: string): Promise<T> {
  return (await (await sfFetch(c, `${base(c)}${path}`)).json()) as T;
}

/** GET a sub-resource as text (a blob field's content). */
export async function restGetText(c: SfConn, path: string): Promise<string> {
  return (await sfFetch(c, `${base(c)}${path}`)).text();
}

export async function countRecords(c: SfConn, object: string): Promise<number> {
  return (await soql(c, `SELECT COUNT() FROM ${object}`)).totalSize;
}

// ---------- Bulk API 2.0 query ----------

export async function createBulkQueryJob(c: SfConn, q: string): Promise<string> {
  const res = await sfFetch(c, `${base(c)}/jobs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "query", query: q, contentType: "CSV", columnDelimiter: "COMMA", lineEnding: "LF" }),
  });
  return ((await res.json()) as { id: string }).id;
}

export async function waitBulkQueryJob(c: SfConn, jobId: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let delay = opts.pollMs ?? 500;
  for (;;) {
    const res = await sfFetch(c, `${base(c)}/jobs/query/${jobId}`);
    const job = (await res.json()) as { state: string; numberRecordsProcessed?: number; errorMessage?: string };
    if (job.state === "JobComplete") return job.numberRecordsProcessed ?? 0;
    if (job.state === "Failed" || job.state === "Aborted") throw new Error(`Bulk query job ${jobId} ${job.state}: ${job.errorMessage ?? ""}`);
    if (Date.now() > deadline) throw new Error(`Bulk query job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
}

/** One results page. `nextLocator` is undefined at the end. */
export async function bulkQueryPage(
  c: SfConn,
  jobId: string,
  locator: string | undefined,
  maxRecords: number,
): Promise<{ rows: Record<string, string>[]; nextLocator?: string }> {
  const qs = new URLSearchParams({ maxRecords: String(maxRecords) });
  if (locator) qs.set("locator", locator);
  const res = await sfFetch(c, `${base(c)}/jobs/query/${jobId}/results?${qs}`, { headers: { Accept: "text/csv" } });
  const next = res.headers.get("Sforce-Locator");
  const rows = csvToObjects(await res.text());
  return { rows, nextLocator: next && next !== "null" ? next : undefined };
}

/** Plan-contract shaped helper: every page of a fresh bulk query. */
export async function* bulkQuery(c: SfConn, q: string, maxRecords = 5000): AsyncIterable<Record<string, string>[]> {
  const jobId = await createBulkQueryJob(c, q);
  await waitBulkQueryJob(c, jobId);
  let locator: string | undefined;
  do {
    const page = await bulkQueryPage(c, jobId, locator, maxRecords);
    yield page.rows;
    locator = page.nextLocator;
  } while (locator);
}

// ---------- CSV (RFC 4180) ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

export function toCsv(header: string[], rows: Array<Record<string, unknown>>): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))].join("\n") + "\n";
}
