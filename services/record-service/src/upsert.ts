// Account and contact upserts with Salesforce identity (contract 1.2.0).
//
// Matching runs in JS inside the single writer: load every existing row the
// batch could match (by sfId, natural key and computed id), resolve each
// record to a target row or a rejection, diff field by field, then write the
// final rows, field history and outbox rows in a few set-based statements.
// Because the writer is single, sfId uniqueness per object holds without a
// unique index.
import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { MergeHints, UpsertAccountsBody, UpsertContactsBody, UpsertResult } from "./contract.ts";
import { all, lit } from "./db.ts";
import { domainMatchSql } from "./contactLinks.ts";
import { HttpError } from "./errors.ts";
import { industryKeySql } from "./industries.ts";
import { DEPARTMENT, SENIORITY, classifyTitleSql } from "./titles.ts";
import { LEDGER_OWNED } from "./register.ts";
import type { Workspace } from "./workspace.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);
export const normDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
export const accountIdFor = (domain: string) => `acc_${h(normDomain(domain))}`;
export const contactIdFor = (accountId: string, c: { email?: string; linkedinUrl?: string; fullName: string }) =>
  `con_${h(c.email ? `e:${c.email.toLowerCase()}` : c.linkedinUrl ? `l:${c.linkedinUrl.toLowerCase()}` : `n:${accountId}:${c.fullName.toLowerCase()}`)}`;

type Rejected = UpsertResult["rejected"][number];
type Row = Record<string, unknown> & { id: string; fieldUpdatedAt: Record<string, number>; version: number };
type HistoryRow = { object: string; id: string; field: string; oldValue: string | null; newValue: string | null };
type ChangeRow = { object: string; id: string; values: Record<string, unknown> };

/**
 * Link the unlinked contacts `scope` names (by contact id, or by the account domain they'd
 * take) to the account their email's domain names (contactLinks.ts). Each link gets a
 * history row and an outbox row from the "domain" source.
 */
export async function linkContactsByDomain(c: DuckDBConnection, now: number, scope: { contactIds?: readonly string[]; domains?: readonly string[] }) {
  const domains = new Set(scope.domains ?? []);
  if (scope.contactIds?.length) {
    const waiting = await all(c, `SELECT DISTINCT lower(split_part(email, '@', 2)) AS d FROM contacts
      WHERE id IN (${scope.contactIds.map(lit).join(", ")}) AND accountId = '' AND email LIKE '%@%'`);
    for (const r of waiting) domains.add(String(r.d));
  }
  if (!domains.size) return;
  const matches = domainMatchSql([...domains].map(lit).join(", "));
  const rows = await all(c, matches);
  if (!rows.length) return;
  await c.run(`UPDATE contacts SET accountId = m.accountId, updatedAt = $now, version = version + 1 FROM (${matches}) m WHERE contacts.id = m.contactId`, { now });
  await writeHistory(c, rows.map((r) => ({ object: "contact", id: String(r.contactId), field: "accountId", oldValue: "", newValue: String(r.accountId) })), "domain", "link:domain", now);
  await writeChanges(c, rows.map((r) => ({ object: "contact", id: String(r.contactId), values: { accountId: String(r.accountId) } })), "edit", "domain", now);
}

// ---------- idempotency ----------

/**
 * The stored answer for a key. With `request` (a hash of what the call
 * applies), a key stored for a different request is a 409; keys stored
 * before hashes were kept answer as before.
 */
export async function priorResult<T>(c: DuckDBConnection, key: string, request?: string): Promise<T | undefined> {
  const r = (await all(c, `SELECT result, request FROM idempotency WHERE key = $k LIMIT 1`, { k: key }))[0];
  if (!r) return undefined;
  if (request !== undefined && r.request != null && r.request !== request)
    throw new HttpError(409, `idempotency key ${key.slice(key.indexOf(":") + 1)} was already used for a different request`);
  return JSON.parse(String(r.result)) as T;
}
export async function saveResult(c: DuckDBConnection, key: string, result: unknown, opts: { request?: string; ts?: number } = {}) {
  await c.run(`INSERT INTO idempotency (key, result, ts, request) VALUES ($k, $r, $ts, $req)`,
    { k: key, r: JSON.stringify(result), ts: opts.ts ?? Date.now(), req: opts.request ?? null });
}

// ---------- shared writers ----------

const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
export const parseFua = (v: unknown): Record<string, number> => {
  if (!v) return {};
  try {
    return typeof v === "string" ? JSON.parse(v) : (v as Record<string, number>);
  } catch {
    return {};
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function writeHistory(c: DuckDBConnection, rows: HistoryRow[], actor: string, source: string, now: number) {
  if (!rows.length) return;
  const shape = JSON.stringify({ object: "VARCHAR", id: "VARCHAR", field: "VARCHAR", oldValue: "VARCHAR", newValue: "VARCHAR", ord: "BIGINT" });
  await c.run(`INSERT INTO field_history (seq, object, id, field, oldValue, newValue, actorId, ts, source)
    SELECT nextval('history_seq'), object, id, field, oldValue, newValue, $actor, $now, $src
    FROM (SELECT unnest(from_json($j, '[${shape}]'), recursive := true)) ORDER BY ord`,
  { j: JSON.stringify(rows.map((r, ord) => ({ ...r, ord }))), actor, now, src: source });
}

export async function writeChanges(c: DuckDBConnection, rows: ChangeRow[], op: string, origin: string, now: number) {
  if (!rows.length) return;
  // Assign seqs one statement per row block in a deterministic order.
  const shape = JSON.stringify({ object: "VARCHAR", id: "VARCHAR", fields: "VARCHAR", ord: "BIGINT" });
  await c.run(`INSERT INTO changes (seq, object, id, op, fields, ts, origin)
    SELECT nextval('change_seq'), object, id, $op, fields::JSON, $now, $origin
    FROM (SELECT unnest(from_json($j, '[${shape}]'), recursive := true)) ORDER BY ord`,
  { j: JSON.stringify(rows.map((r, ord) => ({ object: r.object, id: r.id, fields: JSON.stringify(r.values), ord }))), op, now, origin });
}

const inList = (xs: Iterable<string>) => {
  const arr = [...new Set(xs)];
  return arr.length ? arr.map(lit).join(",") : "NULL";
};

// ---------- accounts ----------

const ACCOUNT_FIELDS = ["name", "industry", "employees", "country", "linkedinUrl", "status", "ownerId", "segmentIds"] as const;
const ACCOUNT_ALL = `id, sfId, domain, name, industry, employees, country, linkedinUrl, status, ownerId, segmentIds, fieldUpdatedAt, version, stream`;
const ACCOUNT_SHAPE = JSON.stringify({
  id: "VARCHAR", sfId: "VARCHAR", domain: "VARCHAR", name: "VARCHAR", industry: "VARCHAR", employees: "INTEGER", country: "VARCHAR",
  linkedinUrl: "VARCHAR", status: "VARCHAR", ownerId: "VARCHAR", segmentIds: "VARCHAR[]", fieldUpdatedAt: "VARCHAR", version: "INTEGER",
});

/** Resolves records to target rows by matchBy keys, tracking pending rows so later records in a batch see earlier ones. */
class Index {
  rows = new Map<string, Row>();
  keys = new Map<string, Map<string, string>>(); // key name -> value -> id
  private keyNames: string[];
  constructor(keyNames: string[]) {
    this.keyNames = keyNames;
    for (const k of keyNames) this.keys.set(k, new Map());
  }
  add(r: Row) {
    this.rows.set(r.id, r);
    for (const k of this.keyNames) {
      const v = this.norm(k, r[k]);
      if (v) this.keys.get(k)!.set(v, r.id);
    }
  }
  /** Re-key a row after a key field changed. */
  rekey(r: Row, k: string, oldV: unknown) {
    const o = this.norm(k, oldV);
    if (o && this.keys.get(k)!.get(o) === r.id) this.keys.get(k)!.delete(o);
    const v = this.norm(k, r[k]);
    if (v) this.keys.get(k)!.set(v, r.id);
  }
  find(k: string, v: unknown): Row | undefined {
    const n = this.norm(k, v);
    const id = n ? this.keys.get(k)?.get(n) : undefined;
    return id ? this.rows.get(id) : undefined;
  }
  private norm(k: string, v: unknown) {
    if (v === null || v === undefined || v === "") return null;
    return k === "email" || k === "linkedinUrl" ? String(v).toLowerCase() : String(v);
  }
}

function toRow(r: Record<string, unknown>): Row {
  return { ...r, id: String(r.id), fieldUpdatedAt: parseFua(r.fieldUpdatedAt), version: Number(r.version) };
}

/** Fill-only upserts leave an existing row's non-empty values alone. */
function keep(fill: "all" | "missing" | undefined, existed: boolean, current: unknown): boolean {
  if (fill !== "missing" || !existed) return false;
  return !(current === undefined || current === null || current === "" || (Array.isArray(current) && !current.length));
}

function matchOrder(merge: MergeHints | undefined, natural: string[]): string[] {
  return merge?.matchBy ?? ["sfId", ...natural];
}

export async function upsertAccounts(ws: Workspace, body: UpsertAccountsBody): Promise<UpsertResult> {
  const key = `accounts.upsert:${body.idempotencyKey}`;
  const order = matchOrder(body.merge, ["domain"]);
  const recs = body.records.map((r) => ({ ...r, domain: normDomain(r.domain) }));
  return ws.write(async (c) => {
    const prior = await priorResult<UpsertResult>(c, key);
    if (prior) return prior;
    const now = Date.now();
    const sfIds = recs.map((r) => r.sfId).filter((x): x is string => !!x);
    const domains = recs.map((r) => r.domain).filter(Boolean);
    const existing = await all(c, `SELECT ${ACCOUNT_ALL} FROM accounts
      WHERE sfId IN (${inList(sfIds)}) OR domain IN (${inList(domains)}) OR id IN (${inList(domains.map(accountIdFor))})`);
    const idx = new Index(["sfId", "domain"]);
    for (const r of existing) idx.add(toRow(r));
    const preexisting = new Set(idx.rows.keys());
    const touched = new Map<string, Set<string>>(); // id -> changed fields
    const history: HistoryRow[] = [];
    const rejected: Rejected[] = [];
    const landed: string[] = [];
    let created = 0;
    let merged = 0;

    recs.forEach((rec, index) => {
      const reject = (reason: string) => rejected.push({ index, ...(rec.sfId ? { sfId: rec.sfId } : {}), reason });
      if (!rec.domain) return reject(`invalid domain: ${body.records[index].domain}`);
      let target: Row | undefined;
      for (const k of order) {
        if (k === "sfId" && rec.sfId) target = idx.find("sfId", rec.sfId);
        else if (k === "domain") target = idx.find("domain", rec.domain);
        if (target) break;
      }
      const changed = new Set<string>();
      const set = (row: Row, f: string, v: unknown) => {
        // A row on the ledger takes these fields only from the projector's write-back (register.ts).
        if (v === undefined || same(row[f], v) || (row.stream && LEDGER_OWNED.account.has(f))) return;
        if (preexisting.has(row.id)) history.push({ object: "account", id: row.id, field: f, oldValue: str(row[f]), newValue: str(v) });
        const old = row[f];
        row[f] = v;
        row.fieldUpdatedAt[f] = now;
        changed.add(f);
        if (f === "sfId" || f === "domain") idx.rekey(row, f, old);
      };
      if (target) {
        if (rec.sfId && target.sfId && target.sfId !== rec.sfId)
          return reject(`domain ${rec.domain} is already linked to Salesforce id ${target.sfId}`);
        if (rec.domain !== target.domain) {
          const holder = idx.find("domain", rec.domain);
          if (holder && holder.id !== target.id) return reject(`domain ${rec.domain} belongs to another account (${holder.id})`);
        }
        if (rec.sfId && !target.sfId) {
          const holder = idx.find("sfId", rec.sfId);
          if (holder && holder.id !== target.id) return reject(`Salesforce id ${rec.sfId} is already linked to ${holder.id}`);
          if (preexisting.has(target.id)) merged++;
        }
        set(target, "sfId", rec.sfId);
        set(target, "domain", rec.domain);
      } else {
        const byDomain = idx.find("domain", rec.domain);
        if (byDomain) return reject(`domain ${rec.domain} already exists (${byDomain.id}) and matchBy does not include domain`);
        const bySf = rec.sfId ? idx.find("sfId", rec.sfId) : undefined;
        if (bySf) return reject(`Salesforce id ${rec.sfId} already exists (${bySf.id}) and matchBy does not include sfId`);
        let id = accountIdFor(rec.domain);
        if (idx.rows.has(id)) id = `acc_${h(`sf:${rec.sfId ?? `${rec.domain}:${now}:${index}`}`)}`;
        target = { id, sfId: rec.sfId ?? null, domain: rec.domain, name: rec.name, status: "new", segmentIds: [], fieldUpdatedAt: {}, version: 0 };
        for (const f of ["sfId", "domain", "name"]) if (target[f]) target.fieldUpdatedAt[f] = now;
        idx.add(target);
        changed.add("domain").add("name");
        if (rec.sfId) changed.add("sfId");
        created++;
      }
      for (const f of ACCOUNT_FIELDS) {
        // A guarded name replaces only the placeholder it names, whatever the fill mode.
        if (f === "name" && rec.nameIfCurrently !== undefined && preexisting.has(target.id)) {
          if (target.name === rec.nameIfCurrently) set(target, f, rec.name);
          continue;
        }
        if (!keep(body.fill, preexisting.has(target.id), target[f])) set(target, f, rec[f]);
      }
      landed.push(target.id);
      if (changed.size) {
        const t = touched.get(target.id) ?? new Set<string>();
        for (const f of changed) t.add(f);
        touched.set(target.id, t);
      }
    });

    const newRows: Row[] = [];
    const updRows: Row[] = [];
    for (const id of touched.keys()) (preexisting.has(id) ? updRows : newRows).push(idx.rows.get(id)!);
    const stage = (rows: Row[]) => JSON.stringify(rows.map((r) => ({ ...r, fieldUpdatedAt: JSON.stringify(r.fieldUpdatedAt) })));
    if (updRows.length) {
      await c.run(`CREATE OR REPLACE TEMP TABLE stage_accounts AS SELECT * FROM (SELECT unnest(from_json($j, '[${ACCOUNT_SHAPE}]'), recursive := true))`, { j: stage(updRows) });
      await c.run(`UPDATE accounts SET sfId = s.sfId, domain = s.domain, name = s.name, industry = s.industry, employees = s.employees,
          country = s.country, linkedinUrl = s.linkedinUrl, status = s.status, ownerId = s.ownerId, segmentIds = coalesce(s.segmentIds, []::VARCHAR[]),
          fieldUpdatedAt = s.fieldUpdatedAt::JSON, source = $src, updatedAt = $now, version = accounts.version + 1
        FROM stage_accounts s WHERE accounts.id = s.id`, { src: body.source, now });
      await c.run(`DROP TABLE stage_accounts`);
    }
    if (newRows.length) {
      await c.run(`INSERT INTO accounts (id, sfId, domain, name, industry, employees, country, linkedinUrl, status, ownerId, segmentIds, source, updatedAt, version, fieldUpdatedAt)
        SELECT id, sfId, domain, name, industry, employees, country, linkedinUrl, coalesce(status, 'new'), ownerId, coalesce(segmentIds, []::VARCHAR[]),
          $src, $now, 1, fieldUpdatedAt::JSON
        FROM (SELECT unnest(from_json($j, '[${ACCOUNT_SHAPE}]'), recursive := true))`, { j: stage(newRows), src: body.source, now });
    }
    // A new company takes the contacts already waiting for its domain.
    await linkContactsByDomain(c, now, { domains: newRows.flatMap((r) => (r.domain ? [String(r.domain)] : [])) });
    const touchedIds = [...touched.keys()];
    if (touchedIds.length) {
      await c.run(refitSql(`WHERE a.id IN (${inList(touchedIds)})`));
    }
    await writeHistory(c, history, body.source, body.source, now);
    await writeChanges(c, touchedIds.sort().map((id) => {
      const r = idx.rows.get(id)!;
      return { object: "account", id, values: Object.fromEntries([...touched.get(id)!].map((f) => [f, r[f] ?? null])) };
    }), "upsert", body.source, now);
    const ids = [...new Set(landed)];
    const result: UpsertResult = { upserted: ids.length, ids, created, merged, rejected };
    await saveResult(c, key, result);
    return result;
  });
}

/** Legacy fit (one weight set, contract < 1.14.0) for accounts alias `a`, from the icp_* weight tables. */
const LEGACY_FIT = `LEAST(100, GREATEST(0,
      coalesce((SELECT max(base) FROM icp_meta), 0) + coalesce(i.w, 0) + coalesce(co.w, 0) + coalesce(e.w, 0)))`;

/** An accepted AI-field answer matches a custom criterion: one of its values, or a number in its range. NULL when unknown. */
const CUSTOM_MATCH = (a: string) => `CASE WHEN cu.vals IS NOT NULL
      THEN list_contains(cu.vals, lower(json_extract_string(${a}.custom, cu.path)))
      ELSE TRY_CAST(json_extract_string(${a}.custom, cu.path) AS DOUBLE) BETWEEN coalesce(cu.lo, -1e308) AND coalesce(cu.hi, 1e308) END`;

/** A gate's buyer rows of `kind` (db.ts icp_gate_buyer) hold a value matching `cond` on buyer alias `x`. */
const buyerHas = (icp: string, kinds: string, cond: string) => `EXISTS (SELECT 1 FROM icp_gate_buyer x WHERE x.icp = ${icp} AND x.kind IN (${kinds}) AND ${cond})`;

/**
 * (accountId, icp) for every gate with a buyer and every account with a live contact who is one (contract
 * 1.30.0): no exclude word in their title, and a title word, or a level of the gate's with its department or a
 * topic word when it names any. Over the accounts `where` selects (alias `a`), or all.
 */
const gateBuyers = (where: string) => `
  SELECT DISTINCT ct.accountId, b.icp FROM (
    SELECT accountId, lower(title) AS t, ${classifyTitleSql(SENIORITY, "lower(title)")} AS lvl, ${classifyTitleSql(DEPARTMENT, "lower(title)")} AS dept
    FROM contacts WHERE deletedAt IS NULL AND coalesce(accountId, '') <> '' AND coalesce(title, '') <> ''
      ${where ? `AND accountId IN (SELECT a.id FROM accounts a ${where})` : ""}
  ) ct CROSS JOIN (SELECT DISTINCT icp FROM icp_gate_buyer) b
  WHERE NOT ${buyerHas("b.icp", "'exclude'", "contains(ct.t, x.v)")}
    AND (${buyerHas("b.icp", "'title'", "contains(ct.t, x.v)")}
      OR (${buyerHas("b.icp", "'level'", "x.v = ct.lvl")}
        AND (NOT ${buyerHas("b.icp", "'department', 'topic'", "true")}
          OR ${buyerHas("b.icp", "'department', 'topic'", "((x.kind = 'department' AND x.v = ct.dept) OR (x.kind = 'topic' AND contains(ct.t, x.v)))")})))`;

/**
 * (account, icp, fit) for every ICP gate an account passes (contract 1.14.0): each
 * include set it names holds the account's value (unknown fails), no exclusion
 * matches, every custom criterion matches, and (1.30.0) when the gate names a
 * buyer, one of its contacts is one. Fit is its rank inside that gate.
 */
const gatePasses = (where: string, buyers: boolean) => `
  SELECT a3.id, g.icp, round(100 * (g.base + coalesce(gi.w, 0) + coalesce(gc.w, 0) + coalesce(ge.w, 0)) / g.max) AS fit
  FROM accounts a3 CROSS JOIN icp_gate g
  LEFT JOIN icp_gate_industry gi ON gi.icp = g.icp AND gi.k = ${industryKeySql("a3.industry")}
  LEFT JOIN icp_gate_country gc ON gc.icp = g.icp AND gc.k = lower(a3.country)
  LEFT JOIN (SELECT a4.id, b.icp, max(b.w) AS w FROM accounts a4 JOIN icp_gate_employees b ON a4.employees BETWEEN b.lo AND b.hi
    ${where.replaceAll("a.id", "a4.id")} GROUP BY a4.id, b.icp) ge ON ge.id = a3.id AND ge.icp = g.icp
  WHERE (NOT g.needIndustry OR gi.k IS NOT NULL)
    AND (NOT g.needCountry OR gc.k IS NOT NULL)
    AND (NOT g.needEmployees OR ge.id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM icp_gate_exclude x WHERE x.icp = g.icp
      AND x.k = CASE x.dim WHEN 'industry' THEN ${industryKeySql("a3.industry")} ELSE lower(a3.country) END)
    AND NOT EXISTS (SELECT 1 FROM icp_gate_custom cu WHERE cu.icp = g.icp AND NOT coalesce(${CUSTOM_MATCH("a3")}, false))
    ${buyers ? `AND (NOT EXISTS (SELECT 1 FROM icp_gate_buyer gb0 WHERE gb0.icp = g.icp)
      OR EXISTS (SELECT 1 FROM (${gateBuyers(where)}) gb WHERE gb.accountId = a3.id AND gb.icp = g.icp))` : ""}
    ${where ? `AND ${where.replace(/^WHERE /, "").replaceAll("a.id", "a3.id")}` : ""}`;

/**
 * The UPDATE that recomputes `fit` and `icpIds` for the accounts `where` selects
 * (a WHERE clause on alias `a`, or "" for all). With ICP gates stored, fit is the
 * best score among the gates an account passes, 0 outside them; without, the
 * legacy weights score it and icpIds is empty. `buyers: false` leaves out the buyer
 * check, for migrations that run before its table exists (db.ts 10).
 */
/**
 * Refit the accounts these contacts belong to, and `before`, the ones they belonged to before the write: a
 * contact's title or company decides whether its account has a buyer (1.30.0).
 */
export async function refitAccountsOfContacts(c: DuckDBConnection, contactIds: readonly string[], before: readonly string[] = []) {
  if (!contactIds.length && !before.length) return;
  const now = contactIds.length ? `SELECT accountId FROM contacts WHERE id IN (${contactIds.map(lit).join(", ")})` : "";
  const was = before.filter(Boolean).map(lit).join(", ");
  await c.run(refitSql(`WHERE a.id IN (${[now, was ? `SELECT unnest([${was}])` : ""].filter(Boolean).join(" UNION ")})`));
}

export function refitSql(where = "", opts: { buyers?: boolean } = {}): string {
  return `UPDATE accounts SET fit = f.fit, icpIds = f.icpIds FROM (
    SELECT a.id,
      CASE WHEN EXISTS (SELECT 1 FROM icp_gate) THEN coalesce(p.fit, 0) ELSE ${LEGACY_FIT} END AS fit,
      coalesce(p.icpIds, []::VARCHAR[]) AS icpIds
    FROM accounts a
    LEFT JOIN icp_industry i ON i.k = ${industryKeySql("a.industry")}
    LEFT JOIN icp_country co ON co.k = lower(a.country)
    LEFT JOIN (SELECT a2.id, sum(b.w) AS w FROM accounts a2 JOIN icp_employees b ON a2.employees BETWEEN b.lo AND b.hi
      ${where.replaceAll("a.id", "a2.id")} GROUP BY a2.id) e ON e.id = a.id
    LEFT JOIN (SELECT id, max(fit) AS fit, list(icp ORDER BY icp) AS icpIds FROM (${gatePasses(where, opts.buyers ?? true)}) GROUP BY id) p ON p.id = a.id
    ${where}
  ) f WHERE accounts.id = f.id AND (accounts.fit IS DISTINCT FROM f.fit OR coalesce(accounts.icpIds, []::VARCHAR[]) IS DISTINCT FROM f.icpIds)`;
}

/**
 * Per gate, its members and the accounts it can't decide: none of its criteria
 * fails on a known value, but at least one is unknown (an empty field, an
 * unanswered AI field) or, with a buyer (1.30.0), no contact there is one yet.
 * Those join the gate once the value is filled or a buyer is added.
 */
export const ICP_STATS_SQL = `
  SELECT g.icp AS id,
    (SELECT count(*) FROM accounts a WHERE a.deletedAt IS NULL AND list_contains(coalesce(a.icpIds, []::VARCHAR[]), g.icp)) AS members,
    (SELECT count(*) FROM accounts a WHERE a.deletedAt IS NULL AND NOT list_contains(coalesce(a.icpIds, []::VARCHAR[]), g.icp)
      AND (NOT g.needIndustry OR a.industry IS NULL OR EXISTS (SELECT 1 FROM icp_gate_industry gi WHERE gi.icp = g.icp AND gi.k = ${industryKeySql("a.industry")}))
      AND (NOT g.needCountry OR a.country IS NULL OR EXISTS (SELECT 1 FROM icp_gate_country gc WHERE gc.icp = g.icp AND gc.k = lower(a.country)))
      AND (NOT g.needEmployees OR a.employees IS NULL OR EXISTS (SELECT 1 FROM icp_gate_employees b WHERE b.icp = g.icp AND a.employees BETWEEN b.lo AND b.hi))
      AND NOT EXISTS (SELECT 1 FROM icp_gate_exclude x WHERE x.icp = g.icp
        AND x.k = CASE x.dim WHEN 'industry' THEN ${industryKeySql("a.industry")} ELSE lower(a.country) END)
      AND NOT EXISTS (SELECT 1 FROM icp_gate_custom cu WHERE cu.icp = g.icp AND NOT coalesce(${CUSTOM_MATCH("a")}, true))
      AND ((g.needIndustry AND a.industry IS NULL) OR (g.needCountry AND a.country IS NULL) OR (g.needEmployees AND a.employees IS NULL)
        OR EXISTS (SELECT 1 FROM icp_gate_custom cu WHERE cu.icp = g.icp AND json_extract_string(a.custom, cu.path) IS NULL)
        OR EXISTS (SELECT 1 FROM icp_gate_buyer b WHERE b.icp = g.icp))) AS unverified
  FROM icp_gate g ORDER BY g.icp`;

// ---------- contacts ----------

const CONTACT_FIELDS = ["fullName", "title", "email", "emailStatus", "linkedinUrl", "status"] as const;
const CONTACT_ALL = `id, sfId, accountId, fullName, title, email, emailStatus, linkedinUrl, status, fieldUpdatedAt, version, stream, accountLedger`;
const CONTACT_SHAPE = JSON.stringify({
  id: "VARCHAR", sfId: "VARCHAR", accountId: "VARCHAR", fullName: "VARCHAR", title: "VARCHAR", email: "VARCHAR", emailStatus: "VARCHAR",
  linkedinUrl: "VARCHAR", status: "VARCHAR", fieldUpdatedAt: "VARCHAR", version: "INTEGER",
});

export async function upsertContacts(ws: Workspace, body: UpsertContactsBody): Promise<UpsertResult> {
  const key = `contacts.upsert:${body.idempotencyKey}`;
  const order = matchOrder(body.merge, ["email", "linkedinUrl"]);
  // Legacy callers (no sfIds, no merge hints) keep the 1.1.0 behaviour: an unknown account fails the batch with 400.
  const legacy = !body.merge && body.records.every((r) => !r.sfId && !r.accountSfId);
  const recs = body.records.map((r) => ({ ...r, email: r.email?.toLowerCase(), accountDomain: r.accountDomain ? normDomain(r.accountDomain) : undefined }));
  return ws.write(async (c) => {
    const prior = await priorResult<UpsertResult>(c, key);
    if (prior) return prior;
    const now = Date.now();
    // Resolve accounts.
    const accRows = await all(c, `SELECT id, sfId, domain FROM accounts WHERE id IN (${inList(recs.flatMap((r) => (r.accountId ? [r.accountId] : [])))})
      OR domain IN (${inList(recs.flatMap((r) => (r.accountDomain ? [r.accountDomain] : [])))})
      OR sfId IN (${inList(recs.flatMap((r) => (r.accountSfId ? [r.accountSfId] : [])))})`);
    const accById = new Set(accRows.map((a) => String(a.id)));
    const accByDomain = new Map(accRows.map((a) => [String(a.domain), String(a.id)]));
    const accBySf = new Map(accRows.filter((a) => a.sfId).map((a) => [String(a.sfId), String(a.id)]));
    const resolveAccount = (r: (typeof recs)[number]) =>
      r.accountId ? (accById.has(r.accountId) ? r.accountId : undefined)
        : r.accountSfId ? accBySf.get(r.accountSfId)
        : accByDomain.get(r.accountDomain!);
    if (legacy) {
      const missing = recs.filter((r) => !resolveAccount(r)).map((r) => r.accountId ?? r.accountDomain);
      if (missing.length) throw new HttpError(400, `unknown account(s): ${[...new Set(missing)].slice(0, 10).join(", ")}`);
    }
    const accIdsFor = recs.map(resolveAccount);
    const candIds = recs.flatMap((r, i) => (accIdsFor[i] ? [contactIdFor(accIdsFor[i]!, r), contactIdFor(accIdsFor[i]!, { fullName: r.fullName })] : []));
    // Name-only records (no sfId, email or LinkedIn) can be the same person another
    // source stored with a LinkedIn URL: load same-name contacts in their accounts.
    const nameOnly = (r: (typeof recs)[number]) => !r.sfId && !r.email && !r.linkedinUrl;
    // Records that can match by account + name: name-only ones, and LinkedIn-only ones
    // (a person another source stored by name, maybe since given an email by a rep).
    const loose = (r: (typeof recs)[number]) => !r.sfId && !r.email;
    const byNameAccounts = recs.flatMap((r, i) => (loose(r) && accIdsFor[i] ? [accIdsFor[i]!] : []));
    const byNameNames = recs.flatMap((r, i) => (loose(r) && accIdsFor[i] ? [r.fullName.toLowerCase()] : []));
    const existing = await all(c, `SELECT ${CONTACT_ALL} FROM contacts
      WHERE sfId IN (${inList(recs.flatMap((r) => (r.sfId ? [r.sfId] : [])))})
        OR email IN (${inList(recs.flatMap((r) => (r.email ? [r.email] : [])))})
        OR list_has_any(coalesce(additionalEmails, []::VARCHAR[]), [${inList(recs.flatMap((r) => (r.email ? [r.email] : [])))}]::VARCHAR[])
        OR lower(linkedinUrl) IN (${inList(recs.flatMap((r) => (r.linkedinUrl ? [r.linkedinUrl.toLowerCase()] : [])))})
        OR id IN (${inList(candIds)})
        OR (accountId IN (${inList(byNameAccounts)}) AND lower(fullName) IN (${inList(byNameNames)}))`);
    // account + lower(name) -> the contacts with that name there; a match needs exactly one.
    const sameName = new Map<string, Set<string>>();
    const nameKeyOf = new Map<string, string>(); // contact id -> its key in sameName
    const indexName = (id: string, accountId: unknown, fullName: unknown) => {
      const old = nameKeyOf.get(id);
      if (old) sameName.get(old)?.delete(id);
      const k = `${accountId}\u0000${String(fullName).toLowerCase()}`;
      sameName.set(k, (sameName.get(k) ?? new Set()).add(id));
      nameKeyOf.set(id, k);
    };
    for (const r of existing) indexName(String(r.id), r.accountId, r.fullName);
    /** Among same-name contacts in an account, the one with no identity (no CRM id, email or LinkedIn), lowest id first. */
    const unidentified = (accountId: string, fullName: string): Row | undefined =>
      [...(sameName.get(`${accountId}\u0000${fullName.toLowerCase()}`) ?? [])]
        .sort()
        .map((id) => idx.rows.get(id))
        .find((r) => r && !r.sfId && !r.email && !r.linkedinUrl);
    const idx = new Index(["sfId", "email", "linkedinUrl"]);
    for (const r of existing) idx.add(toRow(r));
    // A person found by one of their other emails (1.28.0) is that person; a primary still wins its own key.
    if (existing.length) {
      const others = await all(c, `SELECT id, additionalEmails FROM contacts WHERE id IN (${inList(existing.map((r) => String(r.id)))}) AND len(additionalEmails) > 0`);
      for (const o of others) for (const e of (o.additionalEmails as string[] | null) ?? []) if (!idx.find("email", e)) idx.keys.get("email")!.set(e.toLowerCase(), String(o.id));
    }
    const preexisting = new Set(idx.rows.keys());
    const touched = new Map<string, Set<string>>();
    const history: HistoryRow[] = [];
    const rejected: Rejected[] = [];
    const landed: string[] = [];
    let created = 0;
    let merged = 0;

    recs.forEach((rec, index) => {
      const reject = (reason: string) => rejected.push({ index, ...(rec.sfId ? { sfId: rec.sfId } : {}), reason });
      const accountId = accIdsFor[index];
      if (!accountId) return reject(`unknown account: ${rec.accountId ?? rec.accountSfId ?? rec.accountDomain}`);
      let target: Row | undefined;
      for (const k of order) {
        if (k === "sfId" && rec.sfId) target = idx.find("sfId", rec.sfId);
        else if (k === "email" && rec.email) target = idx.find("email", rec.email);
        else if (k === "linkedinUrl" && rec.linkedinUrl) target = idx.find("linkedinUrl", rec.linkedinUrl);
        if (target) break;
      }
      // Legacy identity: the computed id (email / linkedin / account+name hash).
      const computedId = contactIdFor(accountId, rec);
      if (!target && !rec.sfId) target = idx.rows.get(computedId);
      // A name-only record's computed id is just account + name: when several people
      // there share the name, it identifies none of them (whichever kept the id), so it
      // goes to the unidentified same-name contact instead (created once, then reused).
      if (target && target.id === computedId && nameOnly(rec) && (sameName.get(`${accountId}\u0000${rec.fullName.toLowerCase()}`)?.size ?? 0) > 1) {
        target = unidentified(accountId, rec.fullName);
      }
      if (!target && rec.sfId && !rec.email && !rec.linkedinUrl) {
        const byName = idx.rows.get(computedId);
        if (byName && !byName.sfId) target = byName;
      }
      // The reverse order: a name-only record for a person another source already
      // stored with a LinkedIn URL (or under another id). Only an unambiguous match.
      if (!target && nameOnly(rec)) {
        const ids = sameName.get(`${accountId}\u0000${rec.fullName.toLowerCase()}`);
        if (ids?.size === 1) target = idx.rows.get([...ids][0]);
        else if (ids && ids.size > 1) target = unidentified(accountId, rec.fullName);
      }
      // A LinkedIn-identified person already stored by name only (from a source
      // with no profile URL) is the same contact: attach to it, don't fork.
      if (!target && !rec.sfId && !rec.email && rec.linkedinUrl) {
        const ids = sameName.get(`${accountId}\u0000${rec.fullName.toLowerCase()}`);
        const byName = ids?.size === 1 ? idx.rows.get([...ids][0]) : undefined;
        // An email a rep found doesn't make it another person; only a different LinkedIn identity does.
        if (byName && !byName.sfId && !byName.linkedinUrl) target = byName;
      }
      const changed = new Set<string>();
      const set = (row: Row, f: string, v: unknown) => {
        // A contact whose companies are on the ledger takes its account from its primary edge (associations.ts).
        if (v === undefined || same(row[f], v) || (row.stream && LEDGER_OWNED.contact.has(f)) || (f === "accountId" && row.accountLedger === true)) return;
        if (preexisting.has(row.id)) history.push({ object: "contact", id: row.id, field: f, oldValue: str(row[f]), newValue: str(v) });
        const old = row[f];
        row[f] = v;
        row.fieldUpdatedAt[f] = now;
        changed.add(f);
        if (f === "sfId" || f === "email" || f === "linkedinUrl") idx.rekey(row, f, old);
      };
      if (target) {
        if (rec.sfId && target.sfId && target.sfId !== rec.sfId)
          return reject(`contact ${target.id} is already linked to Salesforce id ${target.sfId}`);
        if (rec.sfId && !target.sfId) {
          const holder = idx.find("sfId", rec.sfId);
          if (holder && holder.id !== target.id) return reject(`Salesforce id ${rec.sfId} is already linked to ${holder.id}`);
          if (preexisting.has(target.id)) merged++;
        }
        if (rec.email && rec.email !== target.email) {
          const holder = idx.find("email", rec.email);
          if (holder && holder.id !== target.id) return reject(`email ${rec.email} belongs to another contact (${holder.id})`);
        }
        set(target, "sfId", rec.sfId);
        // Fill-only never moves an existing contact to another account.
        if (!keep(body.fill, preexisting.has(target.id), target.accountId)) set(target, "accountId", accountId);
      } else {
        for (const [k, v] of [["sfId", rec.sfId], ["email", rec.email], ["linkedinUrl", rec.linkedinUrl]] as const) {
          const holder = v ? idx.find(k, v) : undefined;
          if (holder) return reject(`${k} ${v} already exists (${holder.id}) and matchBy does not allow matching it`);
        }
        let id = computedId;
        if (idx.rows.has(id)) id = `con_${h(`sf:${rec.sfId ?? `${accountId}:${now}:${index}`}`)}`;
        target = { id, sfId: rec.sfId ?? null, accountId, fullName: rec.fullName, status: "new", fieldUpdatedAt: {}, version: 0 };
        for (const f of ["sfId", "accountId", "fullName"]) if (target[f]) target.fieldUpdatedAt[f] = now;
        idx.add(target);
        changed.add("accountId").add("fullName");
        if (rec.sfId) changed.add("sfId");
        created++;
      }
      for (const f of CONTACT_FIELDS) if (!keep(body.fill, preexisting.has(target.id), target[f])) set(target, f, rec[f]);
      // Keep the same-name index current within the batch (a renamed or moved row
      // leaves its old key), so matching never depends on record order.
      indexName(target.id, target.accountId, target.fullName);
      landed.push(target.id);
      if (changed.size) {
        const t = touched.get(target.id) ?? new Set<string>();
        for (const f of changed) t.add(f);
        touched.set(target.id, t);
      }
    });

    const newRows: Row[] = [];
    const updRows: Row[] = [];
    for (const id of touched.keys()) (preexisting.has(id) ? updRows : newRows).push(idx.rows.get(id)!);
    const stage = (rows: Row[]) => JSON.stringify(rows.map((r) => ({ ...r, fieldUpdatedAt: JSON.stringify(r.fieldUpdatedAt) })));
    if (updRows.length) {
      await c.run(`CREATE OR REPLACE TEMP TABLE stage_contacts AS SELECT * FROM (SELECT unnest(from_json($j, '[${CONTACT_SHAPE}]'), recursive := true))`, { j: stage(updRows) });
      await c.run(`UPDATE contacts SET sfId = s.sfId, accountId = s.accountId, fullName = s.fullName, title = s.title, email = s.email,
          emailStatus = s.emailStatus, linkedinUrl = s.linkedinUrl, status = s.status, fieldUpdatedAt = s.fieldUpdatedAt::JSON,
          source = $src, updatedAt = $now, version = contacts.version + 1
        FROM stage_contacts s WHERE contacts.id = s.id`, { src: body.source, now });
      await c.run(`DROP TABLE stage_contacts`);
    }
    if (newRows.length) {
      await c.run(`INSERT INTO contacts (id, sfId, accountId, fullName, title, email, emailStatus, linkedinUrl, status, source, updatedAt, version, fieldUpdatedAt)
        SELECT id, sfId, accountId, fullName, title, email, emailStatus, linkedinUrl, coalesce(status, 'new'), $src, $now, 1, fieldUpdatedAt::JSON
        FROM (SELECT unnest(from_json($j, '[${CONTACT_SHAPE}]'), recursive := true))`, { j: stage(newRows), src: body.source, now });
    }
    await writeHistory(c, history, body.source, body.source, now);
    const touchedIds = [...touched.keys()].sort();
    await writeChanges(c, touchedIds.map((id) => {
      const r = idx.rows.get(id)!;
      return { object: "contact", id, values: Object.fromEntries([...touched.get(id)!].map((f) => [f, r[f] ?? null])) };
    }), "upsert", body.source, now);
    const ids = [...new Set(landed)];
    // The companies the matched people were at before this write, too: a person who moved may take its only buyer.
    await refitAccountsOfContacts(c, ids, existing.map((r) => String(r.accountId ?? "")));
    const result: UpsertResult = { upserted: ids.length, ids, created, merged, rejected };
    await saveResult(c, key, result);
    return result;
  });
}
