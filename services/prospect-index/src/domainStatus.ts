// Live status tables on the prospect index (pdl_companies.duckdb).
//
// The PDL `companies` table is rebuilt from source data; these tables are not.
// They accumulate what we learn about each domain over time, so the index is
// the live database of which companies exist and when we last checked:
//
//   domain_status  one row per domain: DNS result now, homepage fetch later
//   extra_domains  domains discovered outside PDL (enrichment, signups, signals)
//   all_domains    view: every domain we track (PDL + extra)
import type { DuckDBConnection } from "@duckdb/node-api";

export type DnsStatus =
  | "ok"          // resolves to at least one address
  | "no_address"  // domain exists but has no A/AAAA record
  | "nxdomain"    // domain does not exist
  | "servfail"    // authoritative servers failed (often a broken or expired setup)
  | "timeout"     // no answer from any resolver
  | "error";      // anything else

export async function ensureStatusSchema(c: DuckDBConnection) {
  await c.run(`
    CREATE TABLE IF NOT EXISTS domain_status (
      domain           VARCHAR PRIMARY KEY,
      dns_status       VARCHAR,
      dns_ips          INTEGER,
      dns_resolver     VARCHAR,
      dns_checked_at   TIMESTAMP,
      -- homepage fetch (filled by the fetch pass)
      http_status      INTEGER,
      http_final_url   VARCHAR,
      http_text_chars  INTEGER,
      http_method      VARCHAR,   -- 'direct' | 'scrapingbee'
      http_checked_at  TIMESTAMP
    )`);
  await c.run(`
    CREATE TABLE IF NOT EXISTS extra_domains (
      domain    VARCHAR PRIMARY KEY,
      name      VARCHAR,
      source    VARCHAR NOT NULL,   -- where we learned about it, e.g. 'pipe0', 'signup', 'theirstack'
      added_at  TIMESTAMP NOT NULL DEFAULT now()
    )`);
  await c.run(`
    CREATE OR REPLACE VIEW all_domains AS
      SELECT domain, 'pdl' AS source FROM companies
      UNION ALL
      SELECT e.domain, e.source FROM extra_domains e
      WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.domain = e.domain)`);
}

export type DnsResult = { domain: string; status: DnsStatus; ips: number; resolver: string; checkedAt: Date };

/** Upsert DNS results without touching the HTTP columns. */
export async function writeDnsResults(c: DuckDBConnection, rows: DnsResult[]) {
  if (!rows.length) return;
  await c.run(`CREATE TEMP TABLE IF NOT EXISTS dns_stage (domain VARCHAR, dns_status VARCHAR, dns_ips INTEGER, dns_resolver VARCHAR, dns_checked_at TIMESTAMP)`);
  await c.run(`DELETE FROM dns_stage`);
  const a = await c.createAppender("dns_stage");
  for (const r of rows) {
    a.appendVarchar(r.domain);
    a.appendVarchar(r.status);
    a.appendInteger(r.ips);
    a.appendVarchar(r.resolver);
    a.appendVarchar(r.checkedAt.toISOString().replace("T", " ").replace("Z", ""));
    a.endRow();
  }
  a.flushSync();
  a.closeSync();
  await c.run(`
    INSERT INTO domain_status (domain, dns_status, dns_ips, dns_resolver, dns_checked_at)
    SELECT domain, dns_status, dns_ips, dns_resolver, dns_checked_at FROM dns_stage
    ON CONFLICT (domain) DO UPDATE SET
      dns_status = excluded.dns_status, dns_ips = excluded.dns_ips,
      dns_resolver = excluded.dns_resolver, dns_checked_at = excluded.dns_checked_at`);
}

/** Add domains discovered outside PDL; existing rows keep their original source. */
export async function addExtraDomains(c: DuckDBConnection, rows: Array<{ domain: string; name?: string; source: string }>) {
  for (const r of rows) {
    await c.run(`INSERT INTO extra_domains (domain, name, source) VALUES ($d, $n, $s) ON CONFLICT (domain) DO NOTHING`,
      { d: r.domain.toLowerCase(), n: r.name ?? null, s: r.source });
  }
}
