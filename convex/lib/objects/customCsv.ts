/**
 * CSV rows for a custom object (CP7d): header cells matched to fields by label
 * or apiName (any case), each cell read by csvImport.ts `cleanCell`, the parser
 * every CSV import uses, so a file Canon exported reads back as the values it
 * held. A user cell names a member by email or exact name; a lookup cell names
 * its record by the export's `<Field> ID` column, else by exact title. The
 * registry's `coerce` then checks every value on save, so a CSV row follows the
 * same rules as a form save and an API call. Pure.
 */
import { cleanCell, memberNamed, parseCsv, type CsvMember } from "./csvImport.ts";
import type { FieldDef } from "./registry.ts";

/** A cell naming a member or a record, resolved against what the workspace holds (resolveCustomCsv). */
export type CustomCsvRef =
  | { apiName: string; label: string; kind: "user"; cell: string }
  | { apiName: string; label: string; kind: "lookup"; lookupTo: string; cell: string | null; id: string | null };
export type CustomCsvRow = { row: number; values: Record<string, string>; refs: CustomCsvRef[] };
export type CustomCsvPlan = { rows: CustomCsvRow[]; mapped: Array<{ header: string; apiName: string }>; ignored: string[] };

export type { CsvMember };
/** A lookup target's records that the file's cells name and the importer can see: ids, and ids by exact title. */
export type CsvTargets = { ids: ReadonlySet<string>; titles: ReadonlyMap<string, readonly string[]> };

/** The export's id column beside a lookup's title column (src/lib/list-csv.ts). */
const idHeader = (label: string) => `${label} id`.toLowerCase();

export function planCustomCsv(fields: readonly FieldDef[], text: string): CustomCsvPlan {
  const records = parseCsv(text);
  const writable = fields.filter((f) => !f.system && f.type !== "formula" && f.archivedAt === undefined);
  const byName = new Map<string, { field: FieldDef; idColumn: boolean }>();
  for (const f of writable) {
    byName.set(f.label.trim().toLowerCase(), { field: f, idColumn: false });
    byName.set(f.apiName.toLowerCase(), { field: f, idColumn: false });
    if (f.type === "lookup") byName.set(idHeader(f.label.trim()), { field: f, idColumn: true });
  }
  const header = (records[0] ?? []).map((h) => h.trim());
  const columns = header.map((h) => byName.get(h.toLowerCase()) ?? null);
  const mapped = columns.flatMap((c, i) => (c ? [{ header: header[i], apiName: c.field.apiName }] : []));
  const ignored = header.filter((h, i) => h && !columns[i]);
  const rows: CustomCsvRow[] = [];
  records.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    const values: Record<string, string> = {};
    const lookups = new Map<string, Extract<CustomCsvRef, { kind: "lookup" }>>();
    const refs: CustomCsvRef[] = [];
    columns.forEach((c, j) => {
      const cell = (cells[j] ?? "").trim();
      if (!c || cell === "") return;
      const f = c.field;
      if (f.type === "user") refs.push({ apiName: f.apiName, label: f.label, kind: "user", cell });
      else if (f.type === "lookup") {
        const ref = lookups.get(f.apiName) ?? { apiName: f.apiName, label: f.label, kind: "lookup", lookupTo: f.lookupTo, cell: null, id: null };
        lookups.set(f.apiName, c.idColumn ? { ...ref, id: cell } : { ...ref, cell });
      } else values[f.apiName] = cleanCell("custom", f, cell);
    });
    rows.push({ row: i + 2, values, refs: [...refs, ...lookups.values()] });
  });
  return { rows, mapped, ignored };
}

/** What a plan's lookup cells ask for, by target object: the ids and titles to look up. */
export function customCsvLookups(plan: CustomCsvPlan): Map<string, { ids: Set<string>; titles: Set<string> }> {
  const out = new Map<string, { ids: Set<string>; titles: Set<string> }>();
  for (const r of plan.rows) {
    for (const ref of r.refs) {
      if (ref.kind !== "lookup") continue;
      const want = out.get(ref.lookupTo) ?? { ids: new Set<string>(), titles: new Set<string>() };
      out.set(ref.lookupTo, want);
      if (ref.id) want.ids.add(ref.id);
      if (ref.cell) want.titles.add(ref.cell);
    }
  }
  return out;
}

export type ResolvedCustomCsv = { rows: Array<{ row: number; values: Record<string, string> }>; problems: Array<{ row: number; message: string }> };

/**
 * Each row's user and lookup cells as ids. A user cell is an active member's email or exact name. A lookup prefers
 * its id column when that id is a record the importer sees, else its title, which must name exactly one. A cell that
 * names nothing, or several, fails its row: it is reported, never stored as text.
 */
export function resolveCustomCsv(plan: CustomCsvPlan, members: readonly CsvMember[], targets: ReadonlyMap<string, CsvTargets>): ResolvedCustomCsv {
  const rows: ResolvedCustomCsv["rows"] = [];
  const problems: ResolvedCustomCsv["problems"] = [];
  for (const r of plan.rows) {
    const values = { ...r.values };
    const errors: string[] = [];
    for (const ref of r.refs) {
      if (ref.kind === "user") {
        const member = memberNamed(ref.cell, members);
        if (member.ok) values[ref.apiName] = member.id;
        else errors.push(`${ref.label}: ${member.message}`);
        continue;
      }
      const target = targets.get(ref.lookupTo);
      if (ref.id && target?.ids.has(ref.id)) {
        values[ref.apiName] = ref.id;
        continue;
      }
      const named = ref.cell ? target?.titles.get(ref.cell) ?? [] : [];
      if (named.length === 1) values[ref.apiName] = named[0];
      else if (named.length > 1) errors.push(`${ref.label}: ${named.length} records are named ${ref.cell}; add the ${ref.label} ID column`);
      else errors.push(`${ref.label}: no record ${ref.cell ? `is named ${ref.cell}` : `has the id ${ref.id}`}`);
    }
    if (errors.length) problems.push({ row: r.row, message: errors.join("; ") });
    else rows.push({ row: r.row, values });
  }
  return { rows, problems };
}
