// Read-only export of one workspace's register (contract 1.48.0): every row of accounts, contacts and field_history,
// all columns as stored, a page at a time in a stable order. Convex assembles a workspace archive from these pages
// (convex/workspaceTransfer.ts). The shared prospect index is not a workspace's and has no export.
import { all, one, type Params } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { Workspace } from "./workspace.ts";

export const EXPORT_TABLES = { accounts: "id", contacts: "id", field_history: "seq" } as const;
export type ExportTable = keyof typeof EXPORT_TABLES;

/** Rows after `after` (the last page's final key), keyed by `id` or, for field_history, `seq`. `next` is null on the last page. */
export async function exportRows(ws: Workspace, table: ExportTable, after: string | undefined, limit: number) {
  const key = EXPORT_TABLES[table];
  if (key === "seq" && after !== undefined && !/^\d{1,19}$/.test(after)) throw new HttpError(400, "after must be a field_history seq");
  return ws.read(async (c) => {
    const where = after === undefined ? "" : key === "seq" ? `WHERE seq > $after` : `WHERE id > $after`;
    const params: Params = after === undefined ? {} : { after: key === "seq" ? BigInt(after) : after };
    const rows = await all(c, `SELECT * FROM ${table} ${where} ORDER BY ${key} LIMIT ${limit + 1}`, params);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? String(page[page.length - 1][key]) : null };
  });
}

export async function exportCounts(ws: Workspace) {
  return ws.read(async (c) => {
    const counts: Record<ExportTable, number> = { accounts: 0, contacts: 0, field_history: 0 };
    for (const table of Object.keys(EXPORT_TABLES) as ExportTable[]) counts[table] = Number((await one(c, `SELECT count(*) AS n FROM ${table}`))?.n ?? 0);
    return counts;
  });
}

/**
 * Write a page of an archive's register rows into a workspace being imported (contract 1.49.0): each row replaces
 * the row with its key, column for column, and a column the table lacks refuses the page. Convex remaps every id in
 * the rows before sending them and calls this only for a workspace it checked was empty.
 */
export async function importRows(ws: Workspace, table: ExportTable, rows: readonly Record<string, unknown>[]) {
  const key = EXPORT_TABLES[table];
  return ws.write(async (c) => {
    const types = new Map((await all(c, `SELECT column_name AS n, data_type AS t FROM information_schema.columns WHERE table_name = $t`, { t: table })).map((r) => [String(r.n), String(r.t)]));
    for (const row of rows) {
      const cols = Object.keys(row);
      const unknown = cols.filter((col) => !types.has(col));
      if (unknown.length) throw new HttpError(400, `${table} has no column ${unknown.join(", ")}`);
      if (row[key] === undefined || row[key] === null) throw new HttpError(400, `a ${table} row needs ${key}`);
      const params: Params = {};
      const values = cols.map((col, i) => {
        const type = types.get(col)!;
        const v = row[col];
        if (v === null || v === undefined) return "NULL";
        if (type.endsWith("[]")) { params[`p${i}`] = JSON.stringify(v); return `from_json($p${i}, '${JSON.stringify([type.slice(0, -2)])}')`; }
        params[`p${i}`] = type === "JSON" ? (typeof v === "string" ? v : JSON.stringify(v)) : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean);
        return `CAST($p${i} AS ${type})`;
      });
      await c.run(`DELETE FROM ${table} WHERE ${key} = CAST($k AS ${types.get(key)})`, { k: row[key] as string | number });
      await c.run(`INSERT INTO ${table} (${cols.map((col) => `"${col}"`).join(", ")}) VALUES (${values.join(", ")})`, params);
    }
    // History written after the import continues past the archive's seqs.
    if (table === "field_history") {
      const top = Number((await one(c, `SELECT coalesce(max(seq), 0) AS m FROM field_history`))!.m);
      const cur = await one(c, `SELECT last_value AS v FROM duckdb_sequences() WHERE sequence_name = 'history_seq'`);
      if (cur?.v == null || Number(cur.v) < top) await c.run(`CREATE OR REPLACE SEQUENCE history_seq START ${top + 1}`);
    }
    return { written: rows.length };
  });
}
