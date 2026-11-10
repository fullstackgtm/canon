// ICP trees (contract 1.31.0, docs/icp-tree.md): counts for ICPs, the segments that narrow them and the personas
// inside, compiled to one read query per request. Nothing is stored: a tree is counted as the caller sends it.
// Company criteria read as gates do (upsert.ts gatePasses): canonical industries, lowercase countries, employee
// ranges, exclusions, and AI-field answers in `custom`; person criteria read contacts' titles through titles.ts.
import type { IcpTreeCountsBody, IcpTreeCountsResult, IcpTreeNode, TerritoryTreeBody } from "./contract.ts";
import { HttpError } from "./errors.ts";
import { countTerritoryTree, territoryTreeProblem, type TerritoryAccountRow, type TerritoryTreeResult } from "./territoryTree.ts";
import { all, lit, type Params } from "./db.ts";
import { industryFilterKeys, industryKeySql } from "./core/kernel/industries.ts";
import { DEPARTMENT, SENIORITY, classifyTitleSql } from "./core/kernel/titles.ts";
import type { Workspace } from "./workspace.ts";

type Account = NonNullable<IcpTreeNode["account"]>;
type Person = NonNullable<IcpTreeNode["person"]>;
type Scope = NonNullable<IcpTreeCountsBody["accountScope"]>;


const list = (xs: readonly string[]) => xs.map(lit).join(", ");

/** A visibility scope over `col`, as ops.ts legacyScopeSql reads it, with its own parameter names. */
function scopeSql(scope: Scope, params: Params, col: string, prefix: string): string {
  const owner = `nullif(${col}, '')`;
  const names = scope.owners.map((o, i) => ((params[`${prefix}${i}`] = o), `$${prefix}${i}`));
  const owned = names.length ? `${owner} IN (${names.join(", ")})` : "FALSE";
  return scope.unowned ? `(${owned} OR ${owner} IS NULL)` : `coalesce(${owned}, FALSE)`;
}

/**
 * Company criteria on accounts alias `a` (or unaliased columns, `a` = ""): each non-empty include set must hold the
 * value (unknown fails), no exclusion may. The account list's `criteria` (ops.ts whereFor) compiles here too.
 */
export function accountSql(x: Account, a = "a."): string[] {
  const parts: string[] = [];
  const IND = industryKeySql(`${a}industry`);
  const owner = `coalesce(nullif(${a}ownerId, ''), '__none__')`;
  const industries = industryFilterKeys(x.industries ?? []);
  if (industries.length) parts.push(`${IND} IN (${list(industries)})`);
  if (x.countries?.length) parts.push(`lower(${a}country) IN (${list(x.countries.map((c) => c.toLowerCase()))})`);
  if (x.employees?.length) parts.push(`(${x.employees.map((e) => `${a}employees BETWEEN ${Number(e.min)} AND ${Number(e.max)}`).join(" OR ")})`);
  const excluded = industryFilterKeys(x.excludeIndustries ?? []);
  if (excluded.length) parts.push(`coalesce(${IND} NOT IN (${list(excluded)}), TRUE)`);
  if (x.excludeCountries?.length) parts.push(`coalesce(lower(${a}country) NOT IN (${list(x.excludeCountries.map((c) => c.toLowerCase()))}), TRUE)`);
  if (x.cities?.length) parts.push(`lower(trim(${a}city)) IN (${list(x.cities.map((c) => c.toLowerCase()))})`);
  if (x.owners?.length) parts.push(`${owner} IN (${list(x.owners)})`);
  if (x.excludeOwners?.length) parts.push(`${owner} NOT IN (${list(x.excludeOwners)})`);
  if (x.revenue?.length) parts.push(`(${x.revenue.map((r) => `${a}annualRevenue BETWEEN ${Number(r.min)} AND ${Number(r.max)}`).join(" OR ")})`);
  for (const cu of "custom" in x ? x.custom ?? [] : []) {
    // The key matches ^custom\.[A-Za-z0-9_-]+$ (contract.ts IcpCustomCriterion), so the quoted path needs no escaping.
    const answer = `json_extract_string(${a}custom, '$."${cu.key}"')`;
    parts.push(cu.values
      ? `coalesce(list_contains([${list(cu.values.map((v) => v.toLowerCase()))}], lower(${answer})), FALSE)`
      : `coalesce(TRY_CAST(${answer} AS DOUBLE) BETWEEN ${cu.min ?? -1e308} AND ${cu.max ?? 1e308}, FALSE)`);
  }
  return parts;
}

/** A person criterion on classified contacts alias `ct` (t: lowercased title, lvl, dept). */
function personSql(p: Person): string {
  const any = (xs: readonly string[]) => xs.map((x) => `contains(ct.t, ${lit(x.toLowerCase())})`).join(" OR ");
  const topics = p.topics ?? [];
  const excluded = p.exclude.length ? `NOT (${any(p.exclude)})` : "TRUE";
  const titled = p.titles.length ? `(${any(p.titles)})` : "FALSE";
  const level = p.levels.length ? `ct.lvl IN (${list(p.levels.map((l) => l.toLowerCase()))})` : "TRUE";
  const where = [p.departments.length ? `ct.dept IN (${list(p.departments.map((d) => d.toLowerCase()))})` : "", topics.length ? any(topics) : ""].filter(Boolean);
  const department = where.length ? `(${where.join(" OR ")})` : "TRUE";
  // With only titles named, only titles match; with nothing named, everyone does.
  const ranked = p.levels.length || where.length ? `(${level} AND ${department})` : p.titles.length ? "FALSE" : "TRUE";
  return `(${excluded} AND (${titled} OR ${ranked}))`;
}

/** One snapshot of node counts and sibling overlaps, returned as tagged rows. */
export function icpTreeSql(body: IcpTreeCountsBody): { sql: string; params: Params } {
  const params: Params = {};
  const index = new Map(body.nodes.map((n, i) => [n.id, i]));
  const ctes = [
    `acc AS MATERIALIZED (SELECT a.id, a.industry, a.country, a.employees, a.custom, a.city, a.ownerId, a.annualRevenue FROM accounts a WHERE a.deletedAt IS NULL${body.accountScope ? ` AND ${scopeSql(body.accountScope, params, "a.ownerId", "as")}` : ""})`,
  ];
  if (body.nodes.some((n) => n.person || n.has?.length)) {
    ctes.push(`ct AS MATERIALIZED (SELECT c.accountId, lower(c.title) AS t, ${classifyTitleSql(SENIORITY, "lower(c.title)")} AS lvl, ${classifyTitleSql(DEPARTMENT, "lower(c.title)")} AS dept
      FROM contacts c WHERE c.deletedAt IS NULL AND coalesce(c.accountId, '') <> '' AND coalesce(c.title, '') <> ''
        AND c.accountId IN (SELECT id FROM acc)${body.contactScope ? ` AND ${scopeSql(body.contactScope, params, "c.ownerId", "cs")}` : ""})`);
  }
  body.nodes.forEach((n, i) => {
    const parent = n.parent !== undefined ? `(SELECT id FROM n${index.get(n.parent)})` : "";
    if (n.person) {
      ctes.push(`p${i} AS MATERIALIZED (SELECT ct.accountId AS id, count(*) AS people FROM ct WHERE ${personSql(n.person)}${parent ? ` AND ct.accountId IN ${parent}` : ""} GROUP BY ct.accountId)`);
      ctes.push(`n${i} AS (SELECT id FROM p${i})`);
      return;
    }
    const where = [
      ...(parent ? [`a.id IN ${parent}`] : []),
      ...accountSql(n.account ?? {}),
      ...(n.has ?? []).map((h) => `a.id ${h.neg ? "NOT IN" : "IN"} (SELECT ct.accountId FROM ct WHERE ${personSql(h.person)})`),
    ];
    ctes.push(`n${i} AS MATERIALIZED (SELECT a.id FROM acc a${where.length ? ` WHERE ${where.join(" AND ")}` : ""})`);
  });
  // A scalar subquery per sibling pair can exceed DuckDB's default expression depth.
  ctes.push(`membership AS MATERIALIZED (${body.nodes.map((n, i) =>
    `SELECT ${i} AS node_index, ${n.parent === undefined ? -1 : index.get(n.parent)} AS parent_index, id, ${n.person ? "people" : "0 AS people"} FROM ${n.person ? `p${i}` : `n${i}`}`
  ).join("\nUNION ALL\n")})`);
  return { sql: `WITH ${ctes.join(",\n")}
    SELECT 'node' AS kind, node_index AS i, -1 AS j, count(*) AS accounts, sum(people) AS people
    FROM membership GROUP BY node_index
    UNION ALL
    SELECT 'overlap' AS kind, l.node_index AS i, r.node_index AS j, count(DISTINCT l.id) AS accounts, 0 AS people
    FROM membership l JOIN membership r
      ON l.id = r.id AND l.node_index < r.node_index AND l.parent_index = r.parent_index
    GROUP BY l.node_index, r.node_index`, params };
}

export async function icpTreeCounts(ws: Workspace, body: IcpTreeCountsBody): Promise<IcpTreeCountsResult> {
  const { sql, params } = icpTreeSql(body);
  const rows = await ws.read((c) => all(c, sql, params));
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "node") {
      counts.set(`a${row.i}`, Number(row.accounts));
      counts.set(`q${row.i}`, Number(row.people));
    } else {
      counts.set(`o${row.i}_${row.j}`, Number(row.accounts));
    }
  }
  const n = (k: string) => counts.get(k) ?? 0;
  const overlaps: IcpTreeCountsResult["overlaps"] = [];
  body.nodes.forEach((a, i) => body.nodes.forEach((b, j) => {
    if (j > i && a.parent === b.parent) overlaps.push({ a: a.id, b: b.id, accounts: n(`o${i}_${j}`) });
  }));
  return { nodes: body.nodes.map((node, i) => ({ id: node.id, accounts: n(`a${i}`), people: node.person ? n(`q${i}`) : 0 })), overlaps };
}

/**
 * A territory tree's counts (contract 1.37.0, territoryTree.ts): the live accounts in scope read once, then counted in
 * memory, where precedence and named accounts are a walk rather than a query per node.
 */
export async function territoryTreeCounts(ws: Workspace, body: TerritoryTreeBody): Promise<TerritoryTreeResult> {
  const problem = territoryTreeProblem(body);
  if (problem) throw new HttpError(400, problem);
  const params: Params = {};
  const sql = `SELECT a.id, a.name, a.updatedAt, a.domain, a.industry, a.country, a.employees, nullif(a.ownerId, '') AS ownerId, a.icpIds, a.city, a.annualRevenue FROM accounts a WHERE a.deletedAt IS NULL${body.accountScope ? ` AND ${scopeSql(body.accountScope, params, "a.ownerId", "as")}` : ""}`;
  const rows = await ws.read(async (c) => (await all(c, sql, params)) as unknown as TerritoryAccountRow[]);
  return countTerritoryTree(rows.map((r) => ({ ...r, updatedAt: r.updatedAt == null ? null : Number(r.updatedAt), employees: r.employees == null ? null : Number(r.employees), annualRevenue: r.annualRevenue == null ? null : Number(r.annualRevenue), icpIds: Array.isArray(r.icpIds) ? r.icpIds : [] })), body);
}
