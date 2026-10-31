// Duplicate candidates over the register (contract 1.24.0, CP15b). The matching is the pure
// core/objects/duplicates.ts, shared with the Convex fake; this reads the live rows it runs over.
// A row merged into another, or deleted, has `deletedAt` set and is not a candidate.
import { findDuplicates, type DuplicateGroup, type DuplicateObject, type DuplicateRow } from "./core/objects/duplicates.ts";
import { all } from "./db.ts";
import { legacyScopeSql } from "./ops.ts";
import type { Workspace } from "./workspace.ts";

export type DuplicatesResponse = { groups: DuplicateGroup[]; total: number };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function registerDuplicates(w: Workspace, object: DuplicateObject, limit: number, scope?: { owners: readonly string[]; unowned: boolean }): Promise<DuplicatesResponse> {
  // A scope (CP14, 1.29.0): candidates among the records the caller sees, so a group never names a hidden one.
  const params: Record<string, string> = {};
  const visible = scope ? ` AND ${legacyScopeSql(scope, params)}` : "";
  const rows = await w.read(async (c) => object === "account"
    ? all(c, `SELECT id, name, domain, linkedinUrl, industry AS detail FROM accounts WHERE deletedAt IS NULL${visible}`, params)
    : all(c, `SELECT id, fullName AS name, email, additionalEmails, linkedinUrl, accountId, title AS detail FROM contacts WHERE deletedAt IS NULL${visible}`, params));
  const groups = findDuplicates(object, rows.map((r): DuplicateRow => ({
    id: String(r.id), name: String(r.name ?? ""), domain: str(r.domain), email: str(r.email),
    ...(Array.isArray(r.additionalEmails) && r.additionalEmails.length ? { otherEmails: r.additionalEmails.map(String) } : {}), linkedinUrl: str(r.linkedinUrl), accountId: str(r.accountId), detail: str(r.detail),
  })));
  return { groups: groups.slice(0, limit), total: groups.length };
}
