// Shared, read-only PDL company index: {DATA_DIR}/shared/pdl_companies.duckdb.
// Either built by services/prospect-index (table `companies`, fetched from R2 at
// startup by pdlFetch.ts) or by scripts/load-pdl.ts (table `pdl_companies`).
// Both are exposed to the queries below as the view `pdl_companies`.
// Data: People Data Labs Free Company Dataset, CC BY 4.0.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { AccountInput, IcpWeights, ProspectFacetsBody, ProspectFacetsResult, ProspectLookupBody, ProspectLookupResult, ProspectSearchBody, ProspectSearchResult, SharedCompanyDetail } from "./contract.ts";
import { NONE, REGION_OF_COUNTRY, SIZE_BANDS, regionOf } from "./dimensions.ts";
import { all, compact, lit, one, type Params } from "./db.ts";
import { HttpError } from "./errors.ts";
import { industryFilterKeys, industryKey, industrySourceNames } from "./industries.ts";

export const pdlPath = (dataDir: string) => join(dataDir, "shared", "pdl_companies.duckdb");

/**
 * Fit 0..100 for a PDL row, mirroring ops.ts FIT_FROM: base + industry weight
 * + country weight + the weights of every employee band the company's size
 * band overlaps (PDL sizes are bands, workspace rows store the band minimum).
 */
export function fitSql(w: IcpWeights): string {
  const cases = (col: string, m: Record<string, number> | undefined) =>
    m && Object.keys(m).length
      ? `CASE lower(${col}) ${Object.entries(m).map(([k, v]) => `WHEN ${lit(k.toLowerCase())} THEN ${Number(v)}`).join(" ")} ELSE 0 END`
      : "0";
  // Industry weights name canonical industries (1.17.0); the index holds PDL's spellings, so each weight covers every spelling of its key.
  const industries: Record<string, number> = {};
  for (const [k, v] of Object.entries(w.industries ?? {})) {
    for (const name of industrySourceNames(industryKey(k))) industries[name] = Math.max(industries[name] ?? -Infinity, v);
  }
  const bands = (w.employeeBands ?? []).length
    ? (w.employeeBands ?? []).map((b) => `CASE WHEN employeesMin BETWEEN ${Number(b.min)} AND ${Number(b.max)} THEN ${Number(b.weight)} ELSE 0 END`).join(" + ")
    : "0";
  return `LEAST(100, GREATEST(0, ${Number(w.base ?? 0)} + ${cases("industry", industries)} + ${cases("country", w.countries)} + ${bands}))`;
}

/** A PDL row's region, classified exactly as facets() groups it (dimensions.ts regionOf): "other" and "__none__" included. */
const REGION_OF_ROW = (() => {
  const byRegion = new Map<string, string[]>();
  for (const [country, region] of Object.entries(REGION_OF_COUNTRY)) byRegion.set(region, [...(byRegion.get(region) ?? []), country]);
  const cases = [...byRegion].map(([region, countries]) => `WHEN lower(trim(country)) IN (${countries.map(lit).join(",")}) THEN ${lit(region)}`).join(" ");
  return `CASE WHEN country IS NULL OR trim(country) = '' THEN '${NONE}' ${cases} ELSE 'other' END`;
})();

/** A PDL row's size band, by its band's lower bound (what workspace rows store as `employees`). */
const SIZE_BAND_OF_MIN = `CASE WHEN employeesMin IS NULL THEN '${NONE}' ${SIZE_BANDS.map((b) => `WHEN employeesMin <= ${Math.min(b.max, 2_147_483_647)} THEN '${b.key}'`).join(" ")} ELSE '${NONE}' END`;

export class PdlIndex {
  private conn: Promise<{ db: DuckDBInstance; c: DuckDBConnection }> | null = null;
  readonly dataDir: string;
  readonly memoryLimit: string;
  /** Set while the startup fetch from R2 is still downloading. */
  loading: string | null = null;
  /** Whether the loaded index carries company_tags (business types), known after open(). */
  hasTags = false;
  constructor(dataDir: string, memoryLimit = "512MB") {
    this.dataDir = dataDir;
    this.memoryLimit = memoryLimit;
  }

  private open() {
    const path = pdlPath(this.dataDir);
    if (!existsSync(path)) {
      throw new HttpError(503, this.loading ? `PDL company index loading: ${this.loading}` : "PDL company index not loaded (set BACKUP_S3_* so it is fetched from R2, or run scripts/load-pdl.ts)");
    }
    this.conn ??= (async () => {
      // In-memory database with the index attached read-only, so the view can
      // be created without writing to the file.
      const db = await DuckDBInstance.create(":memory:", { memory_limit: this.memoryLimit });
      const c = await db.connect();
      await c.run(`ATTACH ${lit(path)} AS pdl (READ_ONLY)`);
      const tables = (await all(c, `SELECT table_name FROM information_schema.tables WHERE table_catalog = 'pdl'`, {})).map((r) => r.table_name);
      await c.run(tables.includes("companies")
        ? `CREATE VIEW pdl_companies AS SELECT domain, name, industry, country, locality, region, linkedinUrl, founded, sizeBand,
             employeeMin AS employeesMin, employeeMax AS employeesMax, pdlId, domainConfidence FROM pdl.companies`
        : `CREATE VIEW pdl_companies AS SELECT *, 'high' AS domainConfidence FROM pdl.pdl_companies`);
      this.hasTags = tables.includes("company_tags");
      return { db, c };
    })();
    this.conn.catch(() => (this.conn = null));
    return this.conn;
  }

  /** The WHERE clause for a prospect filter (search and facets share it). */
  private whereFor(f: NonNullable<ProspectSearchBody["filter"]>): { where: string; params: Params } {
    const parts: string[] = [];
    const params: Params = {};
    if (f.q) (parts.push(`(contains(lower(name), $q) OR contains(domain, $q))`), (params.q = f.q.toLowerCase()));
    // Canonical industries (1.17.0) as the PDL spellings they cover, so the filter stays an index lookup.
    if (f.industry?.length) parts.push(`lower(industry) IN (${industryFilterKeys(f.industry).flatMap(industrySourceNames).map((x) => lit(x)).join(",")})`);
    if (f.country?.length) parts.push(`lower(country) IN (${f.country.map((x) => lit(x.toLowerCase())).join(",")})`);
    // 1.19.0: regions as their countries, size bands on the band's lower bound (how workspace rows store PDL sizes).
    if (f.region?.length) parts.push(`(${REGION_OF_ROW}) IN (${f.region.map(lit).join(",")})`);
    if (f.sizeBand?.length) parts.push(`(${SIZE_BAND_OF_MIN}) IN (${f.sizeBand.map(lit).join(",")})`);
    // Size is a band in PDL; a company matches when its band overlaps the requested range.
    if (f.employeeMin !== undefined) (parts.push(`coalesce(employeesMax, employeesMin) >= $emin`), (params.emin = f.employeeMin));
    if (f.employeeMax !== undefined) (parts.push(`employeesMin <= $emax`), (params.emax = f.employeeMax));
    if ("archetype" in f && f.archetype?.length) {
      // Refuse rather than ignore: without tags the count would be the whole index.
      if (!this.hasTags) throw new HttpError(422, "archetype filter needs a prospect index with company_tags; this one has none");
      parts.push(`domain IN (SELECT domain FROM pdl.company_tags WHERE archetype IN (${f.archetype.map(lit).join(",")}) AND p >= $minp)`);
      params.minp = f.minArchetypeP ?? 0.15;
    }
    return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }

  /**
   * The index grouped by one dimension (1.19.0): market sizes. SQL groups by the raw value; industries and
   * regions then fold into their keys here (a few hundred groups), so the scan stays one pass.
   */
  async facets(body: ProspectFacetsBody): Promise<ProspectFacetsResult> {
    const { c } = await this.open();
    const { where, params } = this.whereFor(body.filter ?? {});
    const expr = body.groupBy === "sizeBand" ? SIZE_BAND_OF_MIN : body.groupBy === "industry" ? "lower(industry)" : "lower(country)";
    const raw = await all(c, `SELECT ${expr} AS k, count(*) AS n FROM pdl_companies ${where} GROUP BY 1`, params);
    const groups = new Map<string, number>();
    for (const r of raw) {
      const v = r.k === null || r.k === undefined || String(r.k).trim() === "" ? null : String(r.k);
      const key = v === null ? NONE : body.groupBy === "industry" ? industryKey(v) : body.groupBy === "region" ? regionOf(v) : v;
      groups.set(key, (groups.get(key) ?? 0) + Number(r.n));
    }
    const sorted = [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const limit = body.limit ?? 200;
    return { groups: sorted.slice(0, limit), total: sorted.reduce((a, g) => a + g.count, 0), truncated: sorted.length > limit };
  }

  async search(body: ProspectSearchBody): Promise<ProspectSearchResult> {
    const { c } = await this.open();
    const { where, params } = this.whereFor(body.filter ?? {});
    const fit = body.rank ? fitSql(body.rank) : null;
    // Fit uses exactly the workspace /rescore model; confidence and LinkedIn only break ties.
    const rows = await all(c, `SELECT domain, name, industry, employeesMin AS employees, country, linkedinUrl${fit ? `, ${fit} AS fit` : ""}
      FROM pdl_companies ${where}
      ORDER BY ${fit ? "fit DESC, " : ""}(domainConfidence = 'high') DESC, (linkedinUrl IS NOT NULL) DESC, employeesMin DESC NULLS LAST,
        -- Final tie-break: a stable hash, not the domain itself. With the free
        -- dataset's coarse fields, hundreds of companies tie on everything
        -- above, and alphabetical order made every TAM start at "100ms".
        hash(domain), domain
      LIMIT ${body.limit ?? 50}`, params);
    const total = Number((await one(c, `SELECT count(*) AS n FROM pdl_companies ${where}`, params))!.n);
    return { rows: rows.map((r) => compact(r) as unknown as AccountInput), total };
  }

  /** 1.46.0: the index row for each domain that has one; domains are normalized the way the index stores them. */
  async lookup(body: ProspectLookupBody): Promise<ProspectLookupResult> {
    const { c } = await this.open();
    const domains = [...new Set(body.domains.map((d) => d.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/[/:?#].*$/, "")).filter(Boolean))];
    if (!domains.length) return { rows: [] };
    // A hash join against the wanted domains, scanning only the domain column: about 0.3 s per 1000 domains on the
    // 24M-row index. Both an IN list and per-domain index reads run out of the service's memory limit there (the
    // domain index alone is bigger than it).
    const rows = (await all(c, `SELECT p.domain, p.name, p.industry, p.country, p.region, p.locality, p.linkedinUrl, p.founded, p.sizeBand,
        p.employeesMin, p.employeesMax, p.domainConfidence
      FROM pdl_companies p JOIN (VALUES ${domains.map((d) => `(${lit(d)})`).join(",")}) w(d) ON p.domain = w.d`, {}))
      .map((r) => compact(r) as unknown as SharedCompanyDetail);
    return { rows };
  }

  /** Reopen after a new index version lands on disk. */
  reload() {
    this.close();
  }

  close() {
    void this.conn?.then(({ db, c }) => (c.closeSync(), db.closeSync())).catch(() => {});
    this.conn = null;
  }
}
