/**
 * The record service's register export (service 1.48.0), for workspace archives only. It reads every row whatever a
 * caller may see, so it stays off RecordClient, whose scoped wrappers pass every method through.
 *
 * Pure: no Convex or Node imports.
 */
import type { RegisterSection } from "./tables.ts";

export const REGISTER_EXPORT_VERSION = "1.48.0";
/** The record service contract that takes an archive's register rows back (import/{table}). */
export const REGISTER_IMPORT_VERSION = "1.49.0";
const TABLE_OF: Record<RegisterSection, "accounts" | "contacts" | "field_history"> = {
  "register.accounts": "accounts", "register.contacts": "contacts", "register.field_history": "field_history",
};

type Env = Record<string, string | undefined>;

/** The service's base URL and token, or null when this deployment keeps its register in Convex (fakeRecord* tables). */
export function registerService(env: Env): { url: string; token: string } | null {
  const url = env.RECORD_SERVICE_URL;
  if (!url) return null;
  if (!env.RECORD_SERVICE_TOKEN) throw new Error("RECORD_SERVICE_URL is set but RECORD_SERVICE_TOKEN is missing.");
  return { url: url.replace(/\/$/, ""), token: env.RECORD_SERVICE_TOKEN };
}

async function post<T>(service: { url: string; token: string }, ws: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${service.url}/v1/workspaces/${encodeURIComponent(ws)}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", "X-Workspace-Id": ws },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`record service ${path} failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
  return (await response.json()) as T;
}

export function registerPage(service: { url: string; token: string }, ws: string, section: RegisterSection, after: string | undefined, limit: number, fetchImpl: typeof fetch = fetch) {
  return post<{ rows: Record<string, unknown>[]; next: string | null }>(service, ws, `export/${TABLE_OF[section]}`, { ...(after !== undefined ? { after } : {}), limit }, fetchImpl);
}

export async function registerCounts(service: { url: string; token: string }, ws: string, fetchImpl: typeof fetch = fetch): Promise<Record<RegisterSection, number>> {
  const counts = await post<Record<"accounts" | "contacts" | "field_history", number>>(service, ws, "export/counts", {}, fetchImpl);
  return { "register.accounts": counts.accounts, "register.contacts": counts.contacts, "register.field_history": counts.field_history };
}

/** Write a page of an archive's register rows, ids already remapped, into the workspace being imported. */
export function registerImport(service: { url: string; token: string }, ws: string, section: RegisterSection, rows: readonly Record<string, unknown>[], fetchImpl: typeof fetch = fetch) {
  return post<{ written: number }>(service, ws, `import/${TABLE_OF[section]}`, { rows }, fetchImpl);
}

/** Whether contract `have` is at least `need` (both `major.minor.patch`, any build suffix ignored). */
export function contractAtLeast(have: string | null, need: string) {
  if (!have) return false;
  const a = have.split(/[+-]/)[0].split(".").map(Number), b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
