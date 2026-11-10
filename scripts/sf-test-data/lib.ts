/**
 * Shared helpers for the Salesforce test-data scripts.
 *
 * The test org is shared with QuotaQueue: these scripts only ever touch
 * records carrying BOTH tags below, and never print the access token.
 */
import { execFileSync } from "node:child_process";
import type { SfConn } from "../../engine/src/sync/salesforceImport/contracts.ts";
import { soql, toCsv, csvToObjects } from "../../engine/src/sync/salesforceImport/sfClient.ts";

export const ORG_USER = process.env.SF_TEST_ORG ?? "ryan.184a62440546@agentforce.com";
/** Name / LastName prefix. "B" scopes to workstream B so other workstreams' FSGTMSYNC records are never touched. */
export const NAME_PREFIX = "FSGTMSYNC B ";
export const DESCRIPTION_TAG = "fsgtm-sync-test b-import";
export const API_VERSION = "60.0";
export const MAX_RECORDS = 1800;

export function connFromSfCli(): SfConn {
  const out = execFileSync("sf", ["org", "display", "-o", ORG_USER, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const r = JSON.parse(out).result as { accessToken: string; instanceUrl: string };
  if (!r?.accessToken || !r.instanceUrl) throw new Error("sf org display returned no session");
  const token = r.accessToken;
  return { instanceUrl: r.instanceUrl, apiVersion: API_VERSION, getToken: async () => token };
}

async function call(c: SfConn, method: string, path: string, body?: string, contentType = "application/json"): Promise<Response> {
  const res = await fetch(`${c.instanceUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await c.getToken()}`, ...(body !== undefined ? { "Content-Type": contentType } : {}), Accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

/** Bulk API 2.0 ingest insert; returns created ids in input order (or throws listing failures). */
export async function bulkInsert(c: SfConn, object: string, header: string[], rows: Array<Record<string, unknown>>): Promise<string[]> {
  const base = `/services/data/v${c.apiVersion}/jobs/ingest`;
  const job = (await (await call(c, "POST", base, JSON.stringify({ object, operation: "insert", contentType: "CSV", lineEnding: "LF" }))).json()) as { id: string };
  await call(c, "PUT", `${base}/${job.id}/batches`, toCsv(header, rows), "text/csv");
  await call(c, "PATCH", `${base}/${job.id}`, JSON.stringify({ state: "UploadComplete" }));
  for (let delay = 1000; ; delay = Math.min(delay * 1.5, 5000)) {
    const s = (await (await call(c, "GET", `${base}/${job.id}`)).json()) as { state: string; numberRecordsFailed: number; errorMessage?: string };
    if (s.state === "JobComplete") break;
    if (s.state === "Failed" || s.state === "Aborted") throw new Error(`ingest ${object} ${s.state}: ${s.errorMessage ?? ""}`);
    await new Promise((r) => setTimeout(r, delay));
  }
  const ok = csvToObjects(await (await call(c, "GET", `${base}/${job.id}/successfulResults`)).text());
  const failed = csvToObjects(await (await call(c, "GET", `${base}/${job.id}/failedResults`)).text());
  if (failed.length) throw new Error(`${failed.length} ${object} rows failed: ${failed.slice(0, 3).map((f) => f.sf__Error).join(" | ")}`);
  if (ok.length !== rows.length) throw new Error(`${object}: expected ${rows.length} created, got ${ok.length}`);
  // successfulResults echoes input columns; match on a unique column.
  const uniq = header.includes("Name") ? "Name" : "LastName";
  const byKey = new Map(ok.map((r) => [r[uniq], r.sf__Id]));
  return rows.map((r) => byKey.get(String(r[uniq]))!);
}

/** Ids of records carrying both tags. */
export async function taggedIds(c: SfConn, object: "Account" | "Contact" | "Lead"): Promise<string[]> {
  const nameField = object === "Account" ? "Name" : "LastName";
  const res = await soql<{ Id: string; Description: string | null }>(
    c,
    `SELECT Id, Description FROM ${object} WHERE ${nameField} LIKE '${NAME_PREFIX}%'`,
  );
  // Description (long text) cannot be filtered in SOQL WHERE: check it here.
  return res.records.filter((r) => (r.Description ?? "").includes(DESCRIPTION_TAG)).map((r) => r.Id);
}

export async function taggedCounts(c: SfConn) {
  return {
    Account: (await taggedIds(c, "Account")).length,
    Contact: (await taggedIds(c, "Contact")).length,
    Lead: (await taggedIds(c, "Lead")).length,
  };
}

/** Delete by id via composite sobjects (200 per call). Only ids from taggedIds are ever passed. */
export async function deleteIds(c: SfConn, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const res = (await (await call(c, "DELETE", `/services/data/v${c.apiVersion}/composite/sobjects?allOrNone=false&ids=${batch.join(",")}`)).json()) as Array<{ success: boolean; errors: Array<{ message: string }> }>;
    for (const r of res) if (r.success) deleted++; else if (!/ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY/.test(JSON.stringify(r.errors))) console.error("delete failed:", r.errors.map((e) => e.message).join("; "));
  }
  return deleted;
}
