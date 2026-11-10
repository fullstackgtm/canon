// Small helpers over @duckdb/node-api plus the per-workspace schema migrations.
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { domainMatchSql } from "./contactLinks.ts";
import { industryKeySql } from "./core/kernel/industries.ts";
import { refitSql } from "./upsert.ts";

export type Params = Record<string, DuckDBValue>;
export type Row = Record<string, unknown>;

/** Convert DuckDB JS values to plain JSON-friendly values (bigint -> number). */
function plainValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(plainValue);
  return v;
}

export async function all(c: DuckDBConnection, sql: string, params: Params = {}): Promise<Row[]> {
  const reader = await c.runAndReadAll(sql, params);
  return (reader.getRowObjectsJS() as Row[]).map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[k] = plainValue(v);
    return out;
  });
}

export async function one(c: DuckDBConnection, sql: string, params: Params = {}): Promise<Row | undefined> {
  return (await all(c, sql, params))[0];
}

/** Escape a string as a SQL literal. Used only where binding a parameter is impractical (IN lists). */
export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Drop null/undefined fields so optional contract fields are omitted rather than null. */
export function compact<T extends Row>(r: T): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

// ---------- migrations ----------
// Each workspace file carries its own schema_version. Migrations run in order
// inside one transaction when a workspace is opened.

/** A step is SQL, or a function returning SQL when SQL from a module that imports this one is needed (evaluated as it runs). */
export const MIGRATIONS: Array<Array<string | (() => string)>> = [
  // 1: initial schema
  [
    `CREATE TABLE accounts (
      id VARCHAR NOT NULL, domain VARCHAR NOT NULL, name VARCHAR NOT NULL, industry VARCHAR, employees INTEGER,
      country VARCHAR, linkedinUrl VARCHAR, fit DOUBLE NOT NULL DEFAULT 0, status VARCHAR NOT NULL DEFAULT 'new',
      ownerId VARCHAR, segmentIds VARCHAR[] NOT NULL DEFAULT [], source VARCHAR NOT NULL,
      updatedAt BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`,
    `CREATE INDEX accounts_id ON accounts(id)`,
    `CREATE INDEX accounts_domain ON accounts(domain)`,
    `CREATE TABLE contacts (
      id VARCHAR NOT NULL, accountId VARCHAR NOT NULL, fullName VARCHAR NOT NULL, title VARCHAR, email VARCHAR,
      emailStatus VARCHAR, linkedinUrl VARCHAR, status VARCHAR NOT NULL DEFAULT 'new', source VARCHAR NOT NULL,
      updatedAt BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`,
    `CREATE INDEX contacts_id ON contacts(id)`,
    `CREATE INDEX contacts_accountId ON contacts(accountId)`,
    `CREATE SEQUENCE history_seq START 1`,
    `CREATE TABLE field_history (
      seq BIGINT NOT NULL, object VARCHAR NOT NULL, id VARCHAR NOT NULL, field VARCHAR NOT NULL,
      oldValue VARCHAR, newValue VARCHAR, actorId VARCHAR NOT NULL, ts BIGINT NOT NULL)`,
    `CREATE INDEX field_history_id ON field_history(id)`,
    // Outbox. seq comes from a sequence and every write goes through one writer,
    // so seq order is commit order and a consumer polling after=N never misses a row.
    `CREATE SEQUENCE change_seq START 1`,
    `CREATE TABLE changes (seq BIGINT NOT NULL, object VARCHAR NOT NULL, id VARCHAR NOT NULL, op VARCHAR NOT NULL,
      fields JSON, ts BIGINT NOT NULL)`,
    `CREATE TABLE idempotency (key VARCHAR NOT NULL, result JSON NOT NULL, ts BIGINT NOT NULL)`,
    `CREATE INDEX idempotency_key ON idempotency(key)`,
    `CREATE TABLE icp_meta (base DOUBLE NOT NULL)`,
    `CREATE TABLE icp_industry (k VARCHAR NOT NULL, w DOUBLE NOT NULL)`,
    `CREATE TABLE icp_country (k VARCHAR NOT NULL, w DOUBLE NOT NULL)`,
    `CREATE TABLE icp_employees (lo INTEGER NOT NULL, hi INTEGER NOT NULL, w DOUBLE NOT NULL)`,
  ],
  // 2: Salesforce sync (contract 1.2.0). sfId uniqueness per object is enforced
  // by the single writer in ops.ts (DuckDB unique indexes reject some valid
  // in-transaction updates), so these indexes are plain.
  [
    `ALTER TABLE accounts ADD COLUMN sfId VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN fieldUpdatedAt VARCHAR`,
    `CREATE INDEX accounts_sfId ON accounts(sfId)`,
    `ALTER TABLE contacts ADD COLUMN sfId VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN fieldUpdatedAt VARCHAR`,
    `CREATE INDEX contacts_sfId ON contacts(sfId)`,
    `CREATE INDEX contacts_email ON contacts(email)`,
    `ALTER TABLE changes ADD COLUMN origin VARCHAR`,
    `ALTER TABLE field_history ADD COLUMN source VARCHAR`,
    `CREATE TABLE object_definitions (name VARCHAR NOT NULL, label VARCHAR NOT NULL, fields JSON NOT NULL, updatedAt BIGINT NOT NULL)`,
    `CREATE TABLE custom_records (
      id VARCHAR NOT NULL, object VARCHAR NOT NULL, sfId VARCHAR, externalKey VARCHAR, fields JSON NOT NULL,
      fieldUpdatedAt JSON NOT NULL, source VARCHAR NOT NULL, updatedAt BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`,
    `CREATE INDEX custom_records_id ON custom_records(id)`,
    `CREATE INDEX custom_records_object_sfId ON custom_records(object, sfId)`,
    `CREATE INDEX custom_records_object_key ON custom_records(object, externalKey)`,
  ],
  // 3: TAM explorer (contract 1.4.0): derived revenue and traits (JSON object text).
  [
    `ALTER TABLE accounts ADD COLUMN revenue DOUBLE`,
    `ALTER TABLE accounts ADD COLUMN revenueSource VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN revenueConfidence DOUBLE`,
    `ALTER TABLE accounts ADD COLUMN traits VARCHAR`,
  ],
  // 4: object-layer projector (docs/cp0-object-layer.md, CP1f). The mirror is
  // the ledger entries the projector has applied; the cursor is the last seq
  // applied per shard. p_<object> tables are created per build (projector.ts).
  [
    `CREATE TABLE ledger_mirror (stream VARCHAR NOT NULL, version INTEGER NOT NULL, object VARCHAR NOT NULL, shard INTEGER NOT NULL, seq BIGINT NOT NULL, entry VARCHAR NOT NULL)`,
    `CREATE INDEX ledger_mirror_stream ON ledger_mirror(stream)`,
    `CREATE TABLE projector_cursor (shard INTEGER NOT NULL, seq BIGINT NOT NULL)`,
    `CREATE TABLE projection_builds (build_id INTEGER NOT NULL, object VARCHAR NOT NULL, signature VARCHAR NOT NULL, def VARCHAR NOT NULL,
      cursor VARCHAR NOT NULL, status VARCHAR NOT NULL, started_at BIGINT NOT NULL, finished_at BIGINT)`,
  ],
  // 5: records/edit (contract 1.6.0) keeps a hash of what each key applied, so
  // reusing a key for a different edit is refused instead of answered from cache.
  [`ALTER TABLE idempotency ADD COLUMN request VARCHAR`],
  // 6: one register of accounts and contacts (contract 1.8.0, docs/cp0-object-layer.md
  // "One register"). A row linked to a ledger stream takes its registry fields from
  // the projector's write-back; `ledgerVersion` is the stream version written back.
  // The new columns hold the registry fields the tables lacked. Marking the current
  // account and contact builds stale makes the projector rebuild them once, which
  // links and writes back every stream that already exists.
  [
    `ALTER TABLE accounts ADD COLUMN stream VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN ledgerVersion INTEGER`,
    `ALTER TABLE accounts ADD COLUMN deletedAt BIGINT`,
    `ALTER TABLE accounts ADD COLUMN phone VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN city VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN description VARCHAR`,
    `ALTER TABLE accounts ADD COLUMN annualRevenue DOUBLE`,
    `ALTER TABLE accounts ADD COLUMN custom JSON`,
    `CREATE INDEX accounts_stream ON accounts(stream)`,
    `ALTER TABLE contacts ADD COLUMN stream VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN ledgerVersion INTEGER`,
    `ALTER TABLE contacts ADD COLUMN deletedAt BIGINT`,
    `ALTER TABLE contacts ADD COLUMN phone VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN ownerId VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN lifecycleStage VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN custom JSON`,
    `CREATE INDEX contacts_stream ON contacts(stream)`,
    // A domain a linked account waits for while another linked account still holds it (register.ts retryPendingDomains).
    `CREATE TABLE register_pending (stream VARCHAR NOT NULL, domain VARCHAR NOT NULL, since BIGINT NOT NULL, kind VARCHAR NOT NULL, actor VARCHAR NOT NULL)`,
    `UPDATE projection_builds SET signature = 'relink-register' WHERE object IN ('account', 'contact') AND status = 'done'`,
  ],
  // 7: the Convex ICP version the stored weights are (contract 1.10.0).
  [`ALTER TABLE icp_meta ADD COLUMN version INTEGER`],
  // 8: saved ICPs as gates (contract 1.14.0, upsert.ts refitSql). With any icp_gate row, fit and icpIds come from the gates.
  [
    `CREATE TABLE icp_gate (icp VARCHAR NOT NULL, base DOUBLE NOT NULL, max DOUBLE NOT NULL,
      needIndustry BOOLEAN NOT NULL, needCountry BOOLEAN NOT NULL, needEmployees BOOLEAN NOT NULL)`,
    `CREATE TABLE icp_gate_industry (icp VARCHAR NOT NULL, k VARCHAR NOT NULL, w DOUBLE NOT NULL)`,
    `CREATE TABLE icp_gate_country (icp VARCHAR NOT NULL, k VARCHAR NOT NULL, w DOUBLE NOT NULL)`,
    `CREATE TABLE icp_gate_employees (icp VARCHAR NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, w DOUBLE NOT NULL)`,
    `CREATE TABLE icp_gate_exclude (icp VARCHAR NOT NULL, dim VARCHAR NOT NULL, k VARCHAR NOT NULL)`,
    `CREATE TABLE icp_gate_custom (icp VARCHAR NOT NULL, path VARCHAR NOT NULL, vals VARCHAR[], lo DOUBLE, hi DOUBLE)`,
    `ALTER TABLE accounts ADD COLUMN icpIds VARCHAR[]`,
  ],
  // 9: link the contacts waiting for an account to the one their email's domain names (contract 1.16.0, contactLinks.ts).
  [`UPDATE contacts SET accountId = m.accountId FROM (${domainMatchSql(undefined, { beforeLedgerLinks: true })}) m WHERE contacts.id = m.contactId`],
  // 10: canonical industries (contract 1.17.0, industries.ts): stored ICP weights and gates are re-keyed from
  // source spellings to canonical keys (spellings that share one keep the larger weight), then every account's
  // fit and ICP membership is recomputed under them.
  [
    `CREATE TABLE icp_industry_c AS SELECT ${industryKeySql("k")} AS k, max(w) AS w FROM icp_industry GROUP BY 1`,
    `DELETE FROM icp_industry`,
    `INSERT INTO icp_industry SELECT k, w FROM icp_industry_c WHERE k IS NOT NULL`,
    `DROP TABLE icp_industry_c`,
    `CREATE TABLE icp_gate_industry_c AS SELECT icp, ${industryKeySql("k")} AS k, max(w) AS w FROM icp_gate_industry GROUP BY 1, 2`,
    `DELETE FROM icp_gate_industry`,
    `INSERT INTO icp_gate_industry SELECT icp, k, w FROM icp_gate_industry_c WHERE k IS NOT NULL`,
    `DROP TABLE icp_gate_industry_c`,
    `UPDATE icp_gate_exclude SET k = ${industryKeySql("k")} WHERE dim = 'industry'`,
    () => refitSql("", { buyers: false }),
  ],
  // 11: associations (contract 1.20.0, associations.ts). `accountLedger` marks a contact whose companies are on the
  // ledger: its accountId is its primary edge's, written by the projector, and upserts and domain linking leave it
  // alone. Marking the association build stale makes the projector rebuild it once, which writes back every edge
  // a service before 1.20.0 already projected.
  [
    `ALTER TABLE contacts ADD COLUMN accountLedger BOOLEAN`,
    `UPDATE projection_builds SET signature = 'write-back-associations' WHERE object = 'association' AND status = 'done'`,
  ],
  // 12: merges (contract 1.23.0, register.ts). A row merged into another on the ledger names its survivor's
  // stream; it is deleted for lists and search, and the recycle bin leaves it out (undo is on the survivor).
  [
    `ALTER TABLE accounts ADD COLUMN mergedInto VARCHAR`,
    `ALTER TABLE contacts ADD COLUMN mergedInto VARCHAR`,
  ],
  // 13: a contact's lead status (contract 1.25.0), a registry field the ledger writes back like `lifecycleStage`.
  [`ALTER TABLE contacts ADD COLUMN leadStatus VARCHAR`],
  // 14: a person's other emails and phones (contract 1.28.0, #299), registry lists the ledger writes back. A row
  // from before has none: its email and phone read as one-item lists, so nothing is backfilled.
  [
    `ALTER TABLE contacts ADD COLUMN additionalEmails VARCHAR[]`,
    `ALTER TABLE contacts ADD COLUMN additionalPhones VARCHAR[]`,
  ],
  // 15: who must work at an account in an ICP (contract 1.30.0, upsert.ts gate buyers): one row per gate value,
  // kind level, department, topic, title or exclude. A gate with none is decided by the company alone.
  [`CREATE TABLE icp_gate_buyer (icp VARCHAR NOT NULL, kind VARCHAR NOT NULL, v VARCHAR NOT NULL)`],
  // 16: module docs (contract 1.33.0, moduleDocs.ts): each projected doc of a Canon module as Canon wrote it, keyed by
  // module, collection and key. `synced_at` is this service's clock when the row was last written: a rebuild's last page
  // deletes the rows it didn't rewrite.
  [
    `CREATE TABLE module_docs (module VARCHAR NOT NULL, collection VARCHAR NOT NULL, key VARCHAR NOT NULL, parent_key VARCHAR, gen INTEGER,
      gens JSON, owner VARCHAR, data JSON NOT NULL, version INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, synced_at BIGINT NOT NULL)`,
    `CREATE INDEX module_docs_key ON module_docs(module, collection, key)`,
  ],
  [
    `CREATE TABLE module_projection (module VARCHAR PRIMARY KEY, package_id VARCHAR NOT NULL, epoch BIGINT NOT NULL, generation BIGINT NOT NULL, collections VARCHAR NOT NULL)`,
    `CREATE TABLE module_doc_receipts (module VARCHAR NOT NULL, collection VARCHAR NOT NULL, key VARCHAR NOT NULL, seq BIGINT NOT NULL, job VARCHAR NOT NULL, seen VARCHAR, PRIMARY KEY(module, collection, key))`,
    `CREATE TABLE module_collection_receipts (module VARCHAR NOT NULL, collection VARCHAR NOT NULL, seq BIGINT NOT NULL, job VARCHAR NOT NULL, complete BOOLEAN NOT NULL, PRIMARY KEY(module, collection))`,
  ],
];

/**
 * Outbox and history seqs must never be reused, even after a crash. A DuckDB
 * sequence's position is persisted with checkpoints, so after a SIGKILL its
 * replayed position can trail rows that were committed through the WAL. On
 * every open, move each sequence past the highest committed value.
 */
export async function reseatSequences(c: DuckDBConnection) {
  let reseated = false;
  for (const [seq, table] of [["change_seq", "changes"], ["history_seq", "field_history"]] as const) {
    const max = Number((await one(c, `SELECT coalesce(max(seq), 0) AS m FROM ${table}`))!.m);
    const cur = await one(c, `SELECT last_value AS v FROM duckdb_sequences() WHERE sequence_name = '${seq}'`).catch(() => undefined);
    const last = cur?.v == null ? 0 : Number(cur.v);
    if (last < max) {
      // nextval() once past max: a fresh sequence starting at max+1.
      await c.run(`CREATE OR REPLACE SEQUENCE ${seq} START ${max + 1}`);
      reseated = true;
    }
  }
  if (reseated) await c.run("CHECKPOINT");
  return reseated;
}

export async function migrate(c: DuckDBConnection): Promise<number> {
  await c.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, appliedAt BIGINT NOT NULL)`);
  const cur = Number((await one(c, `SELECT coalesce(max(version), 0) AS v FROM schema_version`))!.v);
  for (let v = cur; v < MIGRATIONS.length; v++) {
    await c.run("BEGIN TRANSACTION");
    try {
      for (const stmt of MIGRATIONS[v]) await c.run(typeof stmt === "function" ? stmt() : stmt);
      await c.run(`INSERT INTO schema_version VALUES (${v + 1}, ${Date.now()})`);
      await c.run("COMMIT");
    } catch (e) {
      await c.run("ROLLBACK").catch(() => {});
      throw e;
    }
  }
  // Keep DDL out of the WAL: DuckDB 1.5 fails to replay some ALTER TABLE
  // statements after a crash ("GetDefaultDatabase with no default database").
  if (cur < MIGRATIONS.length) await c.run("CHECKPOINT");
  return MIGRATIONS.length;
}
