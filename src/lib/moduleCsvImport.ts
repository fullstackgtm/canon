/**
 * A module's CSV import in the browser (modules/kernel/csvImport.ts): match the file's columns to the import's, then
 * read each row as the call's values, with the rows it can't read and why. Nothing is written here: the page sends
 * the rows to the import's call, a batch at a time, and the call's own checks and writes decide.
 */
import { dayFirstColumn, norm, normalizeDay, parseCsv } from "../../convex/lib/objects/csvImport.ts";
import { CSV_IMPORT_ROWS_MAX, type CsvCell, type CsvImportShape } from "../../modules/kernel/csvImport.ts";

export type CsvFile = { header: string[]; rows: string[][] };
/** Per import column, the file's column it reads (its index), or null for none. */
export type CsvMapping = Record<string, number | null>;
export type CsvRead = { rows: Record<string, unknown>[]; lines: number[]; problems: { line: number; message: string }[] };

/** The file's header and rows, blank lines left out; refused past CSV_IMPORT_ROWS_MAX rows. */
export function readCsvFile(text: string): CsvFile {
  const [header = [], ...rest] = parseCsv(text);
  const rows = rest.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header.some((h) => h.trim() !== "")) throw new Error("The file has no header row.");
  if (rows.length > CSV_IMPORT_ROWS_MAX) throw new Error(`The file has ${rows.length.toLocaleString("en-US")} rows; an import takes at most ${CSV_IMPORT_ROWS_MAX.toLocaleString("en-US")}. Split it and import each part.`);
  return { header: header.map((h) => h.trim()), rows };
}

/** Each import column matched to the file's column named as its field, its label or one of its synonyms. */
export function matchCsvColumns(shape: CsvImportShape, header: readonly string[]): CsvMapping {
  const taken = new Set<number>();
  return Object.fromEntries(shape.columns.map((c) => {
    const names = new Set([c.field, c.label, ...c.synonyms].map(norm));
    const at = header.findIndex((h, i) => !taken.has(i) && names.has(norm(h)));
    if (at >= 0) taken.add(at);
    return [c.field, at >= 0 ? at : null];
  }));
}

/** A number as a CSV writes it: $1,234.50, 7.5k, (200) for a negative. Null when it isn't one. */
function numberOf(cell: string): number | null {
  const s = cell.replace(/[$€£,\s]/g, "");
  const negative = /^\(.*\)$/.test(s);
  const m = /^(-?\d*\.?\d+)([kmb])?$/i.exec(negative ? s.slice(1, -1) : s);
  if (!m) return null;
  const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

const YES = new Set(["yes", "y", "true", "t", "1", "x"]);
const NO = new Set(["no", "n", "false", "f", "0"]);

/** One cell as the column's value, or what's wrong with it. */
function valueOf(cell: CsvCell, text: string, dayFirst: boolean): { value: unknown } | { problem: string } {
  if (cell.kind === "text") return { value: text };
  if (cell.kind === "number" || cell.kind === "money") {
    const n = numberOf(text);
    if (n === null) return { problem: `"${text}" isn't a number` };
    return { value: cell.kind === "money" ? Math.round(n * 100) : n };
  }
  if (cell.kind === "date") {
    const day = normalizeDay(text, dayFirst);
    return day ? { value: day } : { problem: `"${text}" isn't a date` };
  }
  if (cell.kind === "bool") {
    const t = text.toLowerCase();
    return YES.has(t) ? { value: true } : NO.has(t) ? { value: false } : { problem: `"${text}" isn't yes or no` };
  }
  if (cell.kind !== "choice") return { value: text };
  const option = cell.options.find((o) => String(o.value).toLowerCase() === text.toLowerCase() || o.label.toLowerCase() === text.toLowerCase());
  return option ? { value: option.value } : { problem: `"${text}" isn't one of ${cell.options.map((o) => o.label).join(", ")}` };
}

/**
 * The file's rows as the call's rows: a blank cell leaves its field out, a required column's blank cell or a cell
 * that doesn't read skips the row with a problem. `lines` are the kept rows' line numbers in the file (the header is 1).
 */
export function readCsvRows(shape: CsvImportShape, file: CsvFile, mapping: CsvMapping): CsvRead {
  const out: CsvRead = { rows: [], lines: [], problems: [] };
  const dayFirst = Object.fromEntries(shape.columns.map((c) => {
    const at = mapping[c.field];
    return [c.field, c.cell.kind === "date" && at !== null && at !== undefined ? dayFirstColumn(file.rows.map((r) => r[at] ?? "")) : false];
  }));
  file.rows.forEach((r, i) => {
    const line = i + 2;
    const row: Record<string, unknown> = {};
    const wrong: string[] = [];
    for (const c of shape.columns) {
      const at = mapping[c.field];
      const text = at === null || at === undefined ? "" : (r[at] ?? "").trim();
      if (text === "") { if (c.required) wrong.push(`${c.label} is blank`); continue; }
      const got = valueOf(c.cell, text, dayFirst[c.field]!);
      if ("problem" in got) wrong.push(`${c.label}: ${got.problem}`);
      else row[c.field] = got.value;
    }
    if (wrong.length) out.problems.push({ line, message: wrong.join("; ") });
    else { out.rows.push(row); out.lines.push(line); }
  });
  return out;
}

/** The import columns the file must match and doesn't. */
export const unmatchedRequired = (shape: CsvImportShape, mapping: CsvMapping) =>
  shape.columns.filter((c) => c.required && (mapping[c.field] === null || mapping[c.field] === undefined));
