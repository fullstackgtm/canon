// Typed operations on one workspace file.
import { createHash } from "node:crypto";
import type {
  AccountFilter, AccountRow, AccountSort, AnnotateAccountsBody, AnnotateResult, Change, FacetDimension, FacetsBody, FacetsResult, ChangesResult, ContactRow, EditBody, EditResult, FieldHistoryRow,
  GetAccountResult, GetContactResult, IcpGate, IcpStatsResult, IcpWeights, ListAccountsBody, ListAccountsResult, ListContactsBody, ListContactsResult, RescoreResult,
} from "./contract.ts";
import { all, compact, lit, one, type Params } from "./db.ts";
import { NONE, REGION_OF_COUNTRY, SIZE_BANDS } from "./core/kernel/dimensions.ts";
import { industryFilterKeys, industryKey, industryKeySql } from "./core/kernel/industries.ts";
import { HttpError } from "./errors.ts";
import { accountSql } from "./icpTree.ts";
import { LEDGER_OWNED } from "./register.ts";
import { ICP_STATS_SQL, normDomain, refitSql, parseFua, priorResult, saveResult, writeChanges, writeHistory } from "./upsert.ts";
import type { Workspace } from "./workspace.ts";
import type { DuckDBConnection } from "@duckdb/node-api";

export { accountIdFor, normDomain, upsertAccounts, upsertContacts } from "./upsert.ts";

// ---------- reads ----------

const ACCOUNT_COLS = `id, sfId, domain, name, industry, employees, country, linkedinUrl, fit, status, ownerId, segmentIds, source, updatedAt, version, fieldUpdatedAt,
  revenue, revenueSource, revenueConfidence, traits, stream, ledgerVersion, phone, city, description, annualRevenue, icpIds`;
const CONTACT_COLS = `id, sfId, accountId, fullName, title, email, emailStatus, linkedinUrl, status, source, updatedAt, version, fieldUpdatedAt,
  stream, ledgerVersion, phone, ownerId, lifecycleStage, leadStatus`;

function toAccount(r: Record<string, unknown>): AccountRow {
  const a = compact(r) as unknown as AccountRow;
  a.segmentIds = (r.segmentIds as string[] | null) ?? [];
  a.fieldUpdatedAt = parseFua(r.fieldUpdatedAt);
  a.traits = r.traits ? (JSON.parse(String(r.traits)) as Record<string, string>) : {};
  a.icpIds = (r.icpIds as string[] | null) ?? [];
  return a;
}
function toContact(r: Record<string, unknown>): ContactRow {
  const c = compact(r) as unknown as ContactRow;
  c.fieldUpdatedAt = parseFua(r.fieldUpdatedAt);
  return c;
}
const HISTORY_COLS = `seq, object, id, field, oldValue, newValue, actorId, source, ts AS "at"`;

// ---------- TAM dimensions (1.4.0) ----------

const SIZE_BAND_SQL = `CASE WHEN employees IS NULL THEN '${NONE}' ${SIZE_BANDS.map((b) => `WHEN employees <= ${Math.min(b.max, 2_147_483_647)} THEN '${b.key}'`).join(" ")} ELSE '${NONE}' END`;
const COUNTRIES_BY_REGION = Object.entries(REGION_OF_COUNTRY).reduce<Record<string, string[]>>((acc, [c, r]) => ((acc[r] ??= []).push(c), acc), {});
const REGION_SQL = `CASE WHEN country IS NULL OR trim(country) = '' THEN '${NONE}' ${Object.entries(COUNTRIES_BY_REGION)
  .map(([r, cs]) => `WHEN lower(trim(country)) IN (${cs.map(lit).join(",")}) THEN '${r}'`).join(" ")} ELSE 'other' END`;
const INDUSTRY_KEY = industryKeySql("industry");
/** An AI field's accepted answer, lowercased, "__none__" when not answered; the slug matches FIELD_SLUG_RE, so the path needs no escaping. */
const fieldSql = (slug: string) => `coalesce(lower(json_extract_string(custom, '$."custom.${slug}"')), '${NONE}')`;
/** traits is a JSON object text column; keys match TRAIT_KEY_RE, so the path needs no escaping. */
const traitSql = (key: string) => `coalesce(json_extract_string(traits, '$."${key}"'), '${NONE}')`;

/** Case-insensitive `IN`, where "__none__" also matches NULL. */
function inWithNone(col: string, values: string[]): string {
  const rest = values.filter((v) => v !== NONE);
  const parts = rest.length ? [`lower(${col}) IN (${rest.map((x) => lit(x.toLowerCase())).join(",")})`] : [];
  if (values.includes(NONE)) parts.push(`${col} IS NULL`);
  return `(${parts.join(" OR ")})`;
}

/** A visibility scope (CP14, 1.29.0) over `ownerId`, empty read as no owner, as projectionQuery.ts scopeSql reads it. */
export function legacyScopeSql(scope: { owners: readonly string[]; unowned: boolean }, params: Params, col = "ownerId"): string {
  const owner = `nullif(${col}, '')`;
  const names = scope.owners.map((o, i) => ((params[`scope${i}`] = o), `$scope${i}`));
  const owned = names.length ? `${owner} IN (${names.join(", ")})` : "FALSE";
  return scope.unowned ? `(${owned} OR ${owner} IS NULL)` : `coalesce(${owned}, FALSE)`;
}

export function whereFor(f: AccountFilter = {}): { sql: string; params: Params } {
  // A record deleted on the ledger leaves the register's lists, counts and facets (the recycle bin is the ledger's).
  const parts: string[] = [`deletedAt IS NULL`];
  const params: Params = {};
  if (f.segmentId === NONE) parts.push(`len(segmentIds) = 0`);
  else if (f.segmentId) (parts.push(`list_contains(segmentIds, $seg)`), (params.seg = f.segmentId));
  if (f.status) (parts.push(`status = $status`), (params.status = f.status));
  if (f.ownerId) (parts.push(`ownerId = $owner`), (params.owner = f.ownerId));
  if (f.scope) parts.push(legacyScopeSql(f.scope, params));
  if (f.minFit !== undefined) (parts.push(`fit >= $minFit`), (params.minFit = f.minFit));
  if (f.q) (parts.push(`(contains(lower(name), $q) OR contains(domain, $q))`), (params.q = f.q.toLowerCase()));
  if (f.sfId) (parts.push(`sfId = $sfId`), (params.sfId = f.sfId));
  if (f.industry?.length) {
    // Canonical industries (1.17.0): any source's spelling of a value matches the same accounts.
    const keys = industryFilterKeys(f.industry);
    const named = keys.filter((k) => k !== NONE);
    const ors = named.length ? [`${INDUSTRY_KEY} IN (${named.map(lit).join(",")})`] : [];
    if (keys.includes(NONE)) ors.push(`industry IS NULL OR trim(industry) = ''`);
    parts.push(`(${ors.join(" OR ")})`);
  }
  if (f.country?.length) parts.push(inWithNone("country", f.country));
  if (f.sizeBand?.length) parts.push(`(${SIZE_BAND_SQL}) IN (${f.sizeBand.map(lit).join(",")})`);
  if (f.region?.length) parts.push(`(${REGION_SQL}) IN (${f.region.map(lit).join(",")})`);
  for (const [key, values] of Object.entries(f.traits ?? {})) parts.push(`${traitSql(key)} IN (${values.map(lit).join(",")})`);
  if (f.employeeMin !== undefined) (parts.push(`employees >= $emin`), (params.emin = f.employeeMin));
  if (f.employeeMax !== undefined) (parts.push(`employees <= $emax`), (params.emax = f.employeeMax));
  if (f.icpId) (parts.push(`list_contains(coalesce(icpIds, []::VARCHAR[]), $icp)`), (params.icp = f.icpId));
  for (const [slug, values] of Object.entries(f.custom ?? {})) parts.push(`${fieldSql(slug)} IN (${values.map((v) => lit(v === NONE ? v : v.toLowerCase())).join(",")})`);
  for (const c of f.criteria ?? []) parts.push(...accountSql(c, ""));
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString()).o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {}
  throw new HttpError(400, "invalid cursor");
}

export async function listAccounts(ws: Workspace, body: ListAccountsBody): Promise<ListAccountsResult> {
  const sort: AccountSort = body.sort ?? { field: "fit", dir: "desc" };
  const limit = body.limit ?? 50;
  const offset = decodeCursor(body.cursor);
  const { sql, params } = whereFor(body.filter);
  return ws.read(async (c) => {
    const rows = await all(c, `SELECT ${ACCOUNT_COLS} FROM accounts ${sql}
      ORDER BY ${sort.field} ${sort.dir.toUpperCase()} NULLS LAST, id ASC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = Number((await one(c, `SELECT count(*) AS n FROM accounts ${sql}`, params))!.n);
    const next = offset + rows.length;
    return { rows: rows.map(toAccount), nextCursor: rows.length === limit && next < total ? encodeCursor(next) : null, total };
  });
}

export async function listContacts(ws: Workspace, body: ListContactsBody): Promise<ListContactsResult> {
  const limit = body.limit ?? 50;
  const offset = decodeCursor(body.cursor);
  const parts: string[] = [`deletedAt IS NULL`];
  const params: Params = {};
  if (body.filter?.accountId) (parts.push(`accountId = $accountId`), (params.accountId = body.filter.accountId));
  if (body.filter?.sfId) (parts.push(`sfId = $sfId`), (params.sfId = body.filter.sfId));
  if (body.filter?.scope) parts.push(legacyScopeSql(body.filter.scope, params));
  if (body.filter?.q) {
    parts.push(`(contains(lower(fullName), $q) OR contains(lower(coalesce(title, '')), $q) OR contains(lower(coalesce(email, '')), $q))`);
    params.q = body.filter.q.toLowerCase();
  }
  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return ws.read(async (c) => {
    const rows = await all(c, `SELECT ${CONTACT_COLS} FROM contacts ${where} ORDER BY updatedAt DESC, id ASC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = Number((await one(c, `SELECT count(*) AS n FROM contacts ${where}`, params))!.n);
    const next = offset + rows.length;
    return {
      rows: rows.map(toContact),
      nextCursor: rows.length === limit && next < total ? encodeCursor(next) : null,
      total,
    };
  });
}

export async function countSegment(ws: Workspace, filter: AccountFilter): Promise<{ total: number }> {
  const { sql, params } = whereFor(filter);
  return ws.read(async (c) => ({ total: Number((await one(c, `SELECT count(*) AS n FROM accounts ${sql}`, params))!.n) }));
}

function groupExpr(dim: FacetDimension): string {
  switch (dim) {
    case "industry": return `coalesce(${INDUSTRY_KEY}, '${NONE}')`;
    case "country": return `coalesce(lower(country), '${NONE}')`;
    case "sizeBand": return SIZE_BAND_SQL;
    case "region": return REGION_SQL;
    case "segment": return `unnest(CASE WHEN len(segmentIds) = 0 THEN ['${NONE}'] ELSE segmentIds END)`;
    default: return dim.startsWith("field:") ? fieldSql(dim.slice("field:".length)) : traitSql(dim.slice("trait:".length));
  }
}

/** Counts and known revenue per group, largest groups first. */
export async function facets(ws: Workspace, body: FacetsBody): Promise<FacetsResult> {
  const { sql, params } = whereFor(body.filter);
  const limit = body.limit ?? 200;
  return ws.read(async (c) => {
    const rows = await all(c, `SELECT k AS "key", count(*) AS n, coalesce(sum(revenue), 0) AS rev, count(revenue) AS known, coalesce(sum(employees), 0) AS emp
      FROM (SELECT ${groupExpr(body.groupBy)} AS k, revenue, employees FROM accounts ${sql}) GROUP BY k ORDER BY n DESC, k ASC`, params);
    const tot = (await one(c, `SELECT count(*) AS n, coalesce(sum(revenue), 0) AS rev, count(revenue) AS known, coalesce(sum(employees), 0) AS emp FROM accounts ${sql}`, params))!;
    return {
      groups: rows.slice(0, limit).map((r) => ({ key: String(r.key), count: Number(r.n), revenue: Number(r.rev), revenueKnown: Number(r.known), employees: Number(r.emp) })),
      total: Number(tot.n),
      revenue: Number(tot.rev),
      revenueKnown: Number(tot.known),
      employees: Number(tot.emp),
      truncated: rows.length > limit,
    };
  });
}

export async function getAccount(ws: Workspace, id: string): Promise<GetAccountResult> {
  return ws.read(async (c) => {
    const acc = await one(c, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $id LIMIT 1`, { id });
    if (!acc) throw new HttpError(404, "account not found");
    const contacts = await all(c, `SELECT ${CONTACT_COLS} FROM contacts WHERE accountId = $id AND deletedAt IS NULL ORDER BY fullName, id LIMIT 500`, { id });
    const history = await all(c, `SELECT ${HISTORY_COLS} FROM field_history
      WHERE id = $id ORDER BY seq DESC LIMIT 200`, { id });
    return {
      account: toAccount(acc),
      contacts: contacts.map(toContact),
      history: history.map((h) => compact(h)) as unknown as FieldHistoryRow[],
    };
  });
}

export async function getContact(ws: Workspace, id: string): Promise<GetContactResult> {
  return ws.read(async (c) => {
    const row = await one(c, `SELECT ${CONTACT_COLS} FROM contacts WHERE id = $id LIMIT 1`, { id });
    if (!row) throw new HttpError(404, "contact not found");
    return { contact: toContact(row) };
  });
}

export async function getChanges(ws: Workspace, after: number, limit: number): Promise<ChangesResult> {
  return ws.read(async (c) => {
    const rows = await all(c, `SELECT seq, object, id, op, fields, origin, ts AS "at" FROM changes WHERE seq > $after ORDER BY seq LIMIT ${limit}`, { after });
    const changes = rows.map((r): Change => {
      const values = (r.fields ? JSON.parse(String(r.fields)) : {}) as Record<string, unknown>;
      // Rows written before 1.2.0 carried actorId/version inside the payload.
      const fields = r.op === "rescore" ? [] : Object.keys(values).filter((k) => k !== "actorId" && k !== "version");
      return {
        seq: Number(r.seq), object: String(r.object), id: String(r.id), op: r.op as Change["op"], fields, values,
        origin: r.origin == null ? "fsgtm" : String(r.origin), at: Number(r.at),
      };
    });
    return { changes, lastSeq: changes.length ? changes[changes.length - 1].seq : after };
  });
}

// ---------- writes ----------

/**
 * What an edit applies: the record and its patch. Caller metadata (actor,
 * source, sourceTimestamp, expectedVersion) stays out, so a retry that
 * re-stamps its time is still a replay.
 */
const editHash = (b: EditBody) =>
  createHash("sha256").update(JSON.stringify([b.object, b.id, Object.entries(b.patch).sort(([x], [y]) => (x < y ? -1 : 1)), ...(b.payload ? [b.payload] : [])])).digest("hex");

export async function edit(ws: Workspace, body: EditBody): Promise<EditResult> {
  const key = `edit:${body.idempotencyKey}`;
  const table = body.object === "account" ? "accounts" : "contacts";
  const fields = Object.keys(body.patch); // validated against EDITABLE_FIELDS by the contract
  const source = body.source ?? "fsgtm";
  const request = editHash(body);
  return ws.write(async (c) => {
    const prior = await priorResult<EditResult>(c, key, request);
    if (prior) return prior;
    const cur = await one(c, `SELECT * FROM ${table} WHERE id = $id LIMIT 1`, { id: body.id });
    if (!cur) throw new HttpError(404, `${body.object} not found`);
    // A record on the ledger takes these fields only from the projector's write-back (register.ts): Convex writes them to the ledger.
    const owned = cur.stream ? fields.filter((f) => LEDGER_OWNED[body.object].has(f)) : [];
    if (owned.length) throw new HttpError(409, `${owned.join(", ")} of ${body.object} ${body.id} belong to its ledger record; edit them through Canon`);
    if (body.expectedVersion !== undefined && Number(cur.version) !== body.expectedVersion)
      throw new HttpError(409, `version mismatch: expected ${body.expectedVersion}, found ${cur.version}`);
    const now = ws.nextAt();
    const stamp = body.sourceTimestamp ?? now;
    const changed = fields.filter((f) => (cur[f] ?? null) !== body.patch[f]);
    let version = Number(cur.version);
    if (changed.length) {
      const fua = parseFua(cur.fieldUpdatedAt);
      for (const f of changed) fua[f] = stamp;
      const params: Params = { id: body.id, now, src: source, fua: JSON.stringify(fua) };
      changed.forEach((f, i) => (params[`v${i}`] = body.patch[f]));
      const set = changed.map((f, i) => `${f} = $v${i}`).join(", ");
      const row = await one(c, `UPDATE ${table} SET ${set}, source = $src, updatedAt = $now, version = version + 1, fieldUpdatedAt = $fua::JSON
        WHERE id = $id RETURNING version`, params);
      version = Number(row!.version);
      await writeHistory(c, changed.map((f) => ({
        object: body.object, id: body.id, field: f, oldValue: cur[f] == null ? null : String(cur[f]), newValue: body.patch[f] == null ? null : String(body.patch[f]),
      })), body.actorId, source, now);
      await writeChanges(c, [{ object: body.object, id: body.id, values: Object.fromEntries(changed.map((f) => [f, body.patch[f]])) }], "edit", source, now);
      if (table === "accounts" && changed.some((f) => ["industry", "country", "employees"].includes(f))) {
        await c.run(refitSql(`WHERE a.id = $id`), { id: body.id });
      }
      // A contact's title or company decides whether its account (and the one it left) has a buyer (1.30.0).
      if (table === "contacts" && changed.some((f) => f === "title" || f === "accountId")) {
        const accounts = [...new Set([cur.accountId, body.patch.accountId ?? cur.accountId].filter((x): x is string => typeof x === "string" && x !== ""))];
        if (accounts.length) await c.run(refitSql(`WHERE a.id IN (${accounts.map(lit).join(", ")})`));
      }
    }
    const result = { version, at: now };
    await saveResult(c, key, result, { request, ts: now });
    return result;
  });
}

/** Derived revenue and traits; see AnnotateAccountsBody. */
export async function annotate(ws: Workspace, body: AnnotateAccountsBody): Promise<AnnotateResult> {
  return ws.write(async (c) => {
    const missing: string[] = [];
    let updated = 0;
    for (const rec of body.records) {
      const cur = rec.id
        ? await one(c, `SELECT id, revenueSource, traits FROM accounts WHERE id = $id LIMIT 1`, { id: rec.id })
        : await one(c, `SELECT id, revenueSource, traits FROM accounts WHERE domain = $d LIMIT 1`, { d: normDomain(rec.domain!) });
      if (!cur) {
        missing.push((rec.id ?? rec.domain)!);
        continue;
      }
      const sets: string[] = [];
      const params: Params = { id: String(cur.id) };
      const keepCrm = rec.revenueSource === "estimate" && cur.revenueSource === "crm";
      if (rec.revenue !== undefined && !keepCrm) {
        sets.push(`revenue = $rev`, `revenueSource = $rs`, `revenueConfidence = $rc`);
        params.rev = rec.revenue;
        params.rs = rec.revenue === null ? null : (rec.revenueSource ?? "crm");
        params.rc = rec.revenue === null ? null : (rec.revenueConfidence ?? null);
      }
      if (rec.traits) {
        const traits = cur.traits ? (JSON.parse(String(cur.traits)) as Record<string, string>) : {};
        for (const [k, v] of Object.entries(rec.traits)) {
          if (v === null) delete traits[k];
          else traits[k] = v;
        }
        sets.push(`traits = $traits`);
        params.traits = JSON.stringify(traits);
      }
      if (!sets.length) continue;
      await c.run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = $id`, params);
      updated++;
    }
    return { updated, missing };
  });
}

/** Field history for any object, newest first (up to 500 rows). */
export async function history(ws: Workspace, object: string, id: string): Promise<{ rows: FieldHistoryRow[] }> {
  return ws.read(async (c) => {
    const rows = await all(c, `SELECT ${HISTORY_COLS} FROM field_history WHERE id = $id AND object = $o ORDER BY seq DESC LIMIT 500`, { id, o: object });
    return { rows: rows.map((h) => compact(h)) as unknown as FieldHistoryRow[] };
  });
}

/**
 * Score every account with `icp`, which replaces the stored weights; Convex keeps every version (icpVersions).
 * With `gates` (1.14.0), they replace the stored gates and set fit and icpIds; without, the gates are cleared.
 * The version check and every scoring write share the exclusive transaction (1.41.0).
 */
export async function rescore(ws: Workspace, icp: IcpWeights, version?: number, gates: IcpGate[] = []): Promise<RescoreResult> {
  return ws.write(async (c) => {
    const t0 = performance.now();
    const current = await one(c, `SELECT version FROM icp_meta LIMIT 1`);
    if (current?.version != null) {
      const accepted = Number(current.version);
      if (version === undefined || version < accepted) throw new HttpError(409, "stale ICP version");
      if (version === accepted) return { rescored: 0, ms: Math.round(performance.now() - t0) };
    }
    await c.run(`DELETE FROM icp_meta; DELETE FROM icp_industry; DELETE FROM icp_country; DELETE FROM icp_employees;`);
    await c.run(`INSERT INTO icp_meta (base, version) VALUES ($b, $v)`, { b: icp.base ?? 0, v: version ?? null });
    for (const [k, w] of canonicalWeights(icp.industries)) await c.run(`INSERT INTO icp_industry VALUES ($k, $w)`, { k, w });
    for (const [k, w] of Object.entries(icp.countries ?? {})) await c.run(`INSERT INTO icp_country VALUES ($k, $w)`, { k: k.toLowerCase(), w });
    for (const b of icp.employeeBands ?? []) await c.run(`INSERT INTO icp_employees VALUES ($lo, $hi, $w)`, { lo: b.min, hi: b.max, w: b.weight });
    await storeGates(c, gates);
    const n = Number((await one(c, `SELECT count(*) AS n FROM accounts`))!.n);
    await c.run(refitSql());
    await writeChanges(c, [{ object: "workspace", id: ws.id, values: { icp, version: version ?? null, gates: gates.map((g) => g.id), rescored: n } }], "rescore", "fsgtm", Date.now());
    return { rescored: n, ms: Math.round(performance.now() - t0) };
  }, "exclusive");
}

/** Industry weights keyed by canonical industry (1.17.0); spellings that share a key keep the larger weight. */
function canonicalWeights(m: Record<string, number> | undefined): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const [k, w] of Object.entries(m ?? {})) {
    const key = industryKey(k);
    out.set(key, Math.max(out.get(key) ?? -Infinity, w));
  }
  return [...out];
}

async function storeGates(c: DuckDBConnection, gates: IcpGate[]) {
  await c.run(`DELETE FROM icp_gate; DELETE FROM icp_gate_industry; DELETE FROM icp_gate_country; DELETE FROM icp_gate_employees;
    DELETE FROM icp_gate_exclude; DELETE FROM icp_gate_custom; DELETE FROM icp_gate_buyer;`);
  for (const g of gates) {
    const industries = canonicalWeights(g.industries);
    const countries = Object.entries(g.countries);
    await c.run(`INSERT INTO icp_gate VALUES ($icp, $base, $max, $ni, $nc, $ne)`, {
      icp: g.id, base: g.base, max: g.max, ni: industries.length > 0, nc: countries.length > 0, ne: g.employees.length > 0,
    });
    for (const [k, w] of industries) await c.run(`INSERT INTO icp_gate_industry VALUES ($icp, $k, $w)`, { icp: g.id, k, w });
    for (const [k, w] of countries) await c.run(`INSERT INTO icp_gate_country VALUES ($icp, $k, $w)`, { icp: g.id, k: k.toLowerCase(), w });
    for (const b of g.employees) await c.run(`INSERT INTO icp_gate_employees VALUES ($icp, $lo, $hi, $w)`, { icp: g.id, lo: b.min, hi: b.max, w: b.weight });
    for (const k of industryFilterKeys(g.excludeIndustries)) await c.run(`INSERT INTO icp_gate_exclude VALUES ($icp, 'industry', $k)`, { icp: g.id, k });
    for (const k of g.excludeCountries) await c.run(`INSERT INTO icp_gate_exclude VALUES ($icp, 'country', $k)`, { icp: g.id, k: k.toLowerCase() });
    const buyer = g.buyer ? ([["level", g.buyer.levels], ["department", g.buyer.departments], ["topic", g.buyer.topics], ["title", g.buyer.titles], ["exclude", g.buyer.exclude]] as const) : [];
    for (const [kind, values] of buyer) {
      for (const v of new Set(values.map((x) => x.trim().toLowerCase()).filter(Boolean))) await c.run(`INSERT INTO icp_gate_buyer VALUES ($icp, $kind, $v)`, { icp: g.id, kind, v });
    }
    for (const cu of g.custom) {
      await c.run(`INSERT INTO icp_gate_custom VALUES ($icp, $path, ${cu.values ? `[${cu.values.map((v) => lit(v.toLowerCase())).join(", ")}]` : "NULL"}, $lo, $hi)`, {
        // The key matches ^custom\.[A-Za-z0-9_-]+$ (contract.ts IcpCustomCriterion), so the quoted path needs no escaping.
        icp: g.id, path: `$."${cu.key}"`, lo: cu.min ?? null, hi: cu.max ?? null,
      });
    }
  }
}

/** Members and unverified accounts per stored ICP gate (1.14.0). */
export async function icpStats(ws: Workspace): Promise<IcpStatsResult> {
  return ws.read(async (c) => ({
    gates: (await all(c, ICP_STATS_SQL)).map((r) => ({ id: String(r.id), members: Number(r.members), unverified: Number(r.unverified) })),
  }));
}
