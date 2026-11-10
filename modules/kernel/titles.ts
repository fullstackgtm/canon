/**
 * A person's level and department from their job title. The record service matches
 * contacts against an ICP's buyer with these in SQL (services/record-service/src/upsert.ts
 * gate buyers, through the copy scripts/sync-object-core.ts writes), and Convex uses the
 * same tables for staging dimensions (convex/lib/staging.ts). Dependency-free.
 * The patterns are RE2-compatible, so DuckDB runs them as written.
 */

/** Ordered: the first pattern a lowercased title matches names its level. */
export const SENIORITY: ReadonlyArray<readonly [string, RegExp]> = [
  ["founder", /\bfounder\b|\bco-?founder\b/],
  ["owner", /\bowner\b/],
  ["vp", /\bvp\b|\bvice[- ]president\b|\bsvp\b|\bevp\b/],
  ["cxo", /\bchief\b|\bc[a-z]o\b|\b(ciso|chro|cdao|caio)\b|\bpresident\b|\bgeneral counsel\b/],
  ["head", /\bhead\b/],
  ["director", /\bdirector\b/],
  ["partner", /\bpartner\b/],
  ["manager", /\bmanager\b|\blead\b/],
];

/** Ordered: revenue operations before sales and operations; business development before sales. */
export const DEPARTMENT: ReadonlyArray<readonly [string, RegExp]> = [
  ["Revenue operations", /\brev(enue)?\s*ops\b|\brevenue operations\b|\bsales operations\b|\bsales ops\b|\bgtm operations\b/],
  ["Customer success", /\bcustomer success\b|\bcustomer experience\b|\bclient success\b/],
  ["Business development", /\bbusiness development\b|\bbdr\b|\bpartnerships?\b|\balliances\b/],
  ["Sales", /\bsales\b|\baccount executive\b|\bsdr\b|\bcro\b|\bchief revenue\b|\brevenue\b|\bcommercial\b/],
  ["Marketing", /\bmarketing\b|\bcmo\b|\bgrowth\b|\bdemand gen|\bbrand\b|\bcontent\b/],
  ["Finance", /\bfinance\b|\bfinancial\b|\bcfo\b|\baccounting\b|\bcontroller\b|\btreasur/],
  ["Engineering", /\bengineer|\bcto\b|\bdeveloper\b|\bsoftware\b|\bdevops\b|\btechnology\b/],
  ["Product", /\bproduct\b|\bcpo\b/],
  ["IT", /\bit\b|\binformation technology\b|\bcio\b|\binformation security\b|\bciso\b|\bsystems\b/],
  ["HR", /\bhr\b|\bhuman resources\b|\bpeople\b|\btalent\b|\brecruit|\bchro\b/],
  ["Legal", /\blegal\b|\bcounsel\b|\bcompliance\b|\bclo\b/],
  ["Operations", /\boperations\b|\bcoo\b|\bops\b/],
];

/** The first key whose pattern matches `title`, or null. */
export function classifyTitle(table: ReadonlyArray<readonly [string, RegExp]>, title: string | null | undefined): string | null {
  const t = (title ?? "").toLowerCase();
  return (t && table.find(([, re]) => re.test(t))?.[0]) || null;
}

/** The same classification in SQL over a lowercased title expression; department keys come back lowercased. */
export function classifyTitleSql(table: ReadonlyArray<readonly [string, RegExp]>, lowered: string): string {
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return `CASE ${table.map(([k, re]) => `WHEN regexp_matches(${lowered}, ${quote(re.source)}) THEN ${quote(k.toLowerCase())}`).join(" ")} END`;
}
