/**
 * A module's CSV imports (docs/modules.md, "CSV imports"): Canon's Upload → Match columns → Review → Import, the
 * matched rows given to a call of the module as its `rows` argument, `batch` rows a call. Each column is a field of
 * a row; a row field the call requires is a column the file must match.
 *
 * Pure: the manifest's checks, the shape a page reads, and a file's rows as the call's values.
 */
import { coreOf, humanName, type FieldSpec, type ValidatorJSON } from "./schema.ts";

export type CsvImportColumn = { field: string; label?: string; synonyms?: readonly string[] };
export type CsvImportDecl = { label: string; call: string; columns: readonly CsvImportColumn[]; batch?: number };

/** What a cell reads as: text, a number, money in cents, a YYYY-MM-DD day, yes or no, or one of a field's values. */
export type CsvCell =
  | { kind: "text" | "number" | "money" | "date" | "bool" }
  | { kind: "choice"; options: readonly { value: string | number | boolean; label: string }[] };
export type CsvImportShape = {
  label: string; call: string; batch: number;
  columns: readonly { field: string; label: string; required: boolean; synonyms: readonly string[]; cell: CsvCell }[];
};

export const CSV_IMPORT_BATCH = 100;
export const CSV_IMPORT_BATCH_MAX = 500;
/** The most rows one import reads: past it the file is refused, not cut short. */
export const CSV_IMPORT_ROWS_MAX = 5000;

/** The fields of one row of the call's `rows` argument, or why the call can't take an import. */
export function csvRowFields(args: { value: Record<string, FieldSpec> } | undefined): Record<string, FieldSpec> | string {
  const rows = args?.value.rows;
  if (!rows) return "must take rows, a list of objects";
  const list = coreOf(rows.fieldType);
  const row = list.type === "array" ? coreOf(list.value) : null;
  if (!row || row.type !== "object") return "must take rows, a list of objects";
  const others = Object.entries(args!.value).filter(([k, s]) => k !== "rows" && !s.optional).map(([k]) => k);
  if (others.length) return `takes ${others.join(", ")} besides rows, which an import can't give`;
  return row.value;
}

/** How a row field's cells read, or null when no cell can give it (a ref, a list, an object, a file). */
export function csvCellOf(spec: FieldSpec): CsvCell | null {
  const v = coreOf(spec.fieldType);
  if (v.type === "string") return { kind: spec.widget === "date" ? "date" : "text" };
  if (v.type === "number") return { kind: spec.widget === "money" ? "money" : "number" };
  if (v.type === "boolean") return { kind: "bool" };
  const literals = (u: ValidatorJSON): u is Extract<ValidatorJSON, { type: "union" }> => u.type === "union" && u.value.every((x) => x.type === "literal" || x.type === "null");
  if (v.type === "literal" || literals(v)) {
    const values = v.type === "literal" ? [v.value] : v.value.flatMap((x) => (x.type === "literal" ? [x.value] : []));
    const labels = v.type === "union" ? v.labels ?? {} : {};
    return { kind: "choice", options: values.map((value) => ({ value, label: labels[String(value)] ?? String(value) })) };
  }
  return null;
}

/** What is wrong with one declared import, given the call it names (absent when it names none). */
export function csvImportProblems(x: CsvImportDecl, call: { args?: { value: Record<string, FieldSpec> }; system?: true; canon?: unknown } | undefined): string[] {
  if (!call) return [`call names ${x.call}, which is not a call`];
  if (call.system || call.canon) return [`call names ${x.call}, which must be a person's call`];
  const fields = csvRowFields(call.args);
  if (typeof fields === "string") return [`call ${x.call} ${fields}`];
  const e: string[] = [];
  const seen = new Set<string>();
  x.columns.forEach((c, i) => {
    if (seen.has(c.field)) e.push(`columns[${i}] names ${c.field} again`);
    seen.add(c.field);
    const spec = fields[c.field];
    if (!spec) e.push(`columns[${i}] names ${c.field}, which is not a field of ${x.call}'s rows`);
    else if (!csvCellOf(spec)) e.push(`columns[${i}] names ${c.field}, which no cell can give (text, a number, money, a date, yes or no, or a choice)`);
  });
  for (const [f, spec] of Object.entries(fields)) if (!spec.optional && !seen.has(f)) e.push(`${x.call}'s rows require ${f}, which no column gives`);
  if (x.batch !== undefined && !(Number.isInteger(x.batch) && x.batch >= 1 && x.batch <= CSV_IMPORT_BATCH_MAX)) e.push(`batch is a whole number from 1 to ${CSV_IMPORT_BATCH_MAX}`);
  return e;
}

/** The import as a page reads it: each column's label, whether the file must give it, and how its cells read. */
export function csvImportShape(x: CsvImportDecl, call: { args?: { value: Record<string, FieldSpec> } }): CsvImportShape {
  const fields = csvRowFields(call.args) as Record<string, FieldSpec>;
  return {
    label: x.label, call: x.call, batch: x.batch ?? CSV_IMPORT_BATCH,
    columns: x.columns.map((c) => ({
      field: c.field, label: c.label ?? fields[c.field]?.label ?? humanName(c.field), required: !fields[c.field]?.optional,
      synonyms: c.synonyms ?? [], cell: csvCellOf(fields[c.field]!)!,
    })),
  };
}
