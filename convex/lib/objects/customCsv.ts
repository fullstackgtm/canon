/**
 * CSV rows for a custom object (CP7d): header cells matched to fields by
 * label or apiName (any case), picklist cells by option label or value. The
 * registry's `coerce` then checks every value on save, so a CSV row follows
 * the same rules as a form save and an API call. Pure.
 */
import { parseCsv } from "./csvImport.ts";
import type { FieldDef } from "./registry.ts";

export type CustomCsvRow = { row: number; values: Record<string, string> };
export type CustomCsvPlan = { rows: CustomCsvRow[]; mapped: Array<{ header: string; apiName: string }>; ignored: string[] };

type Mappable = Pick<FieldDef, "apiName" | "label" | "type" | "system" | "archivedAt"> & { options?: readonly { value: string; label: string }[] };

export function planCustomCsv(fields: readonly Mappable[], text: string): CustomCsvPlan {
  const records = parseCsv(text);
  const writable = fields.filter((f) => !f.system && f.type !== "formula" && f.archivedAt === undefined);
  const byName = new Map<string, Mappable>();
  for (const f of writable) {
    byName.set(f.label.trim().toLowerCase(), f);
    byName.set(f.apiName.toLowerCase(), f);
  }
  const header = (records[0] ?? []).map((h) => h.trim());
  const columns = header.map((h) => byName.get(h.toLowerCase()) ?? null);
  const mapped = columns.flatMap((f, i) => (f ? [{ header: header[i], apiName: f.apiName }] : []));
  const ignored = header.filter((h, i) => h && !columns[i]);
  const rows: CustomCsvRow[] = [];
  records.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    const values: Record<string, string> = {};
    columns.forEach((f, j) => {
      const cell = (cells[j] ?? "").trim();
      if (!f || cell === "") return;
      // An option is written by its label in an export; the registry takes its value.
      const option = f.options?.find((o) => o.label.toLowerCase() === cell.toLowerCase() || o.value === cell);
      values[f.apiName] = f.type === "picklist" && option ? option.value : cell;
    });
    rows.push({ row: i + 2, values });
  });
  return { rows, mapped, ignored };
}
