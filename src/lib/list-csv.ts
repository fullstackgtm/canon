import { serializeCsvRows } from "./csv-export.ts";

/** Rows one export reads: the projection pages through at most this many. */
export const EXPORT_ROWS_MAX = 10_000;

type Option = { value: string; label: string };
export type ExportField = { fieldId: string; apiName: string; label: string; type: string; options?: readonly Option[]; lookupTo?: string };
export type ExportRow = { id: string; title: string; createdAt: number; updatedAt: number; values: Record<string, unknown> };
type Cell = string | number | null;
type Column = { header: string; read: (row: ExportRow) => Cell };

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : typeof ms === "string" ? ms : null);
const labelOf = (f: ExportField, v: unknown) => f.options?.find((o) => o.value === v)?.label ?? String(v);

/**
 * The columns a list view exports: the id, the title, then each shown column as
 * the list reads it. A lookup adds its target's id, money is in whole units,
 * and money carries its currency code: the record's own currency field's when
 * the object has one (a deal's), else the workspace's.
 */
function columnsOf(fields: readonly ExportField[], titleLabel: string, shown: readonly string[], users: ReadonlyMap<string, string>, titles: Readonly<Record<string, string>>, workspaceCurrency?: string): Column[] {
  const byName = new Map(fields.map((f) => [f.apiName, f]));
  const own = byName.get("currency");
  const currency = shown.includes("currency") ? undefined : own;
  const out: Column[] = [{ header: "ID", read: (r) => r.id }, { header: titleLabel, read: (r) => r.title }];
  for (const name of shown) {
    if (name === "createdAt" || name === "updatedAt") {
      out.push({ header: name === "createdAt" ? "Created" : "Last modified", read: (r) => iso(r[name]) });
      continue;
    }
    const f = byName.get(name);
    if (!f) continue;
    const raw = (r: ExportRow) => {
      const v = r.values[f.fieldId];
      return v === undefined || v === "" ? null : v;
    };
    const read = (r: ExportRow): Cell => {
      const v = raw(r);
      if (v === null) return null;
      switch (f.type) {
        case "currency": return typeof v === "number" ? (v / 100).toFixed(2) : String(v);
        case "date":
        case "datetime": return f.type === "date" && typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : iso(v);
        case "checkbox": return v === true ? "Yes" : v === false ? "No" : String(v);
        case "picklist": return labelOf(f, v);
        case "multipicklist": return (Array.isArray(v) ? v : [v]).map((x) => labelOf(f, x)).join("; ");
        case "user": return users.get(String(v)) ?? String(v);
        case "lookup": return titles[String(v)] ?? String(v);
        case "splits": return JSON.stringify(v);
        default: return typeof v === "number" ? v : Array.isArray(v) ? v.join("; ") : String(v);
      }
    };
    out.push({ header: f.label, read });
    if (f.type === "lookup") out.push({ header: `${f.label} ID`, read: (r) => (raw(r) === null ? null : String(raw(r))) });
    // An object with its own currency field (a deal) never takes the workspace's: its Currency column, or this one, says it.
    if (f.type === "currency" && (currency || (!own && workspaceCurrency))) {
      out.push({ header: `${f.label} currency`, read: (r) => (raw(r) === null ? null : currency ? (r.values[currency.fieldId] as string | undefined) ?? null : workspaceCurrency ?? null) });
    }
  }
  return out;
}

/** A list view as CSV: values as the list shows them, dates as ISO, owners by name and lookups by title. */
export function listCsv(input: {
  fields: readonly ExportField[];
  titleLabel: string;
  columns: readonly string[];
  rows: readonly ExportRow[];
  users: ReadonlyMap<string, string>;
  titles: Readonly<Record<string, string>>;
  /** The workspace's currency code, for money on an object with no currency field of its own. */
  currency?: string;
}): string {
  const cols = columnsOf(input.fields, input.titleLabel, input.columns, input.users, input.titles, input.currency);
  return serializeCsvRows([cols.map((c) => c.header), ...input.rows.map((r) => cols.map((c) => c.read(r)))]) + "\n";
}

/** `deals-2026-10-09.csv` */
export const exportFileName = (pluralLabel: string, now: Date) => `${pluralLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${now.toISOString().slice(0, 10)}.csv`;
