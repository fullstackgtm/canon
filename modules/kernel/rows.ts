/**
 * What a module table does with its rows (docs/modules.md, "Tables"): search, filters, sort, sections and totals,
 * over a binding the page read whole. Pure, so tests run it without React. A binding that didn't read every row its
 * view holds never comes here: the table says so instead of sorting or totalling part of it.
 */
import { formatValue, valueAt, type Doc, type Labels } from "./text.ts";

/** What a row value is, as the server describes a binding's fields. */
export type Kind = "choice" | "user" | "ref" | "bool" | "number" | "date" | "text" | "file";
export type TableSpec = {
  sort?: { by: string; dir?: "asc" | "desc" };
  filters?: ReadonlyArray<{ field: string; label: string }>;
  search?: readonly string[];
  group?: { by: string; collapsed?: boolean };
};
/** The person's choices: a sort, the values picked per filter (a date filter's as `from..to`), and the search text. */
export type TableState = { sort: { by: string; dir: "asc" | "desc" } | null; filters: Record<string, string[]>; q: string };
/** How values show: labels by field, member names, ref labels, and each field's kind. */
export type Shown = { labels?: Labels; members: ReadonlyMap<string, string>; refs?: Readonly<Record<string, string>>; currency: string; decimals?: number; kinds?: Record<string, Kind>; files?: Readonly<Record<string, { name: string }>> };

/** A filter's key for a value: its text, "" for none. */
export const filterKey = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A row value as it shows: its label, a member's name, a ref's label, a date, Yes/No or its text. */
export function shownValue(row: Doc, path: string, s: Shown): string {
  const v = valueAt(row, path);
  if (v === undefined || v === null || v === "") return "";
  const label = s.labels?.[path]?.[String(v)];
  if (label) return label;
  const kind = s.kinds?.[path];
  if (kind === "user") return formatValue(v, "user", s);
  if (kind === "ref") return formatValue(v, "ref", s) || String(v);
  if (kind === "date") return formatValue(v, "date", s);
  if (kind === "file") return formatValue(v, "file", s);
  return formatValue(v, undefined, s);
}

const compare = (a: unknown, b: unknown): number => {
  const none = (x: unknown) => x === undefined || x === null || x === "";
  if (none(a) || none(b)) return none(a) === none(b) ? 0 : none(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

/** Whether a row passes one filter: its value among those picked, or a date in the picked `from..to` range. */
function passes(row: Doc, field: string, picked: readonly string[], s: Shown): boolean {
  if (!picked.length) return true;
  const v = valueAt(row, field);
  if (s.kinds?.[field] === "date") {
    const [from, to] = (picked[0] ?? "").split("..");
    // A date field's text, or a time field's ms as its UTC day.
    const d = typeof v === "string" ? v.slice(0, 10) : typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString().slice(0, 10) : "";
    return Boolean(d) && (!from || d >= from) && (!to || d <= to);
  }
  const values = Array.isArray(v) ? v.map(filterKey) : [filterKey(v)];
  return values.some((x) => picked.includes(x));
}

export type Section = { key: string; label: string; rows: Doc[] };

/**
 * The rows a table shows, in order: searched (each searched value as it shows, or `also`: the row's cells' text, any
 * case), filtered, sorted (the person's sort, else the table's, else as read), then in sections by `group.by` in the
 * order their first row comes. Without a group, one section holds every row.
 */
export function arrange(rows: readonly Doc[], spec: TableSpec, state: TableState, s: Shown, also?: (row: Doc) => string): Section[] {
  const needle = state.q.trim().toLowerCase();
  let out = rows.filter((row) => {
    if (needle && !(spec.search ?? []).some((p) => shownValue(row, p, s).toLowerCase().includes(needle)) && !also?.(row).toLowerCase().includes(needle)) return false;
    return Object.entries(state.filters).every(([field, picked]) => passes(row, field, picked, s));
  });
  const sort = state.sort ?? (spec.sort ? { by: spec.sort.by, dir: spec.sort.dir ?? "asc" } : null);
  if (sort) {
    const sign = sort.dir === "desc" ? -1 : 1;
    // Labels sort as they show (a status by its label), the rest by value; empty values last either way.
    const key = (row: Doc) => (s.labels?.[sort.by] || s.kinds?.[sort.by] === "user" || s.kinds?.[sort.by] === "ref" ? shownValue(row, sort.by, s) || null : valueAt(row, sort.by));
    out = [...out].sort((a, b) => {
      const ka = key(a), kb = key(b);
      const empty = (x: unknown) => x === undefined || x === null || x === "";
      return empty(ka) || empty(kb) ? compare(ka, kb) : sign * compare(ka, kb);
    });
  }
  if (!spec.group) return [{ key: "", label: "", rows: out }];
  const sections = new Map<string, Section>();
  for (const row of out) {
    const k = filterKey(valueAt(row, spec.group.by));
    if (!sections.has(k)) sections.set(k, { key: k, label: shownValue(row, spec.group.by, s) || "None", rows: [] });
    sections.get(k)!.rows.push(row);
  }
  return [...sections.values()];
}

/** The sum of a row value over rows; values that aren't numbers count as 0. */
export const total = (rows: readonly Doc[], path: string): number =>
  rows.reduce((n, row) => { const v = valueAt(row, path); return n + (typeof v === "number" && Number.isFinite(v) ? v : 0); }, 0);

/** A column's total as it shows: the sum of `sum`, or with `over` that sum over the sum of `over` (a percent; none over 0). */
export function totalText(rows: readonly Doc[], t: { sum: string; over?: string; format?: string }, scope: Parameters<typeof formatValue>[2]): string {
  if (!t.over) return formatValue(total(rows, t.sum), t.format ?? "number", scope);
  const over = total(rows, t.over);
  return over ? formatValue(total(rows, t.sum) / over, t.format ?? "percent", scope) : "";
}

/** A filter's choices: each value the rows hold, as it shows, in order; "None" for rows without one. */
export function choicesOf(rows: readonly Doc[], field: string, s: Shown): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const v = valueAt(row, field);
    for (const x of Array.isArray(v) ? v : [v]) {
      const k = filterKey(x);
      if (!seen.has(k)) seen.set(k, k === "" ? "None" : shownValue({ ...row, data: { ...row.data, [field]: x } }, field, s) || k);
    }
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => (a.value === "" ? 1 : b.value === "" ? -1 : a.label.localeCompare(b.label)));
}

/** A table's state in the URL, under its id: `<id>.sort=by:dir`, `<id>.q=text`, `<id>.f.<field>=a,b`. */
export function stateFromQuery(id: string | undefined, query: Readonly<Record<string, string>>): TableState {
  const state: TableState = { sort: null, filters: {}, q: "" };
  if (!id) return state;
  const sort = query[`${id}.sort`];
  if (sort) { const [by, dir] = sort.split(":"); state.sort = { by, dir: dir === "desc" ? "desc" : "asc" }; }
  state.q = query[`${id}.q`] ?? "";
  for (const [k, v] of Object.entries(query)) if (k.startsWith(`${id}.f.`) && v) state.filters[k.slice(id.length + 3)] = v.split(",").map(decodeURIComponent);
  return state;
}

/** The URL parameters a table's state sets (null clears one). */
export function queryFromState(id: string, state: TableState, fields: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {
    [`${id}.sort`]: state.sort ? `${state.sort.by}:${state.sort.dir}` : null,
    [`${id}.q`]: state.q || null,
  };
  for (const f of fields) out[`${id}.f.${f}`] = state.filters[f]?.length ? state.filters[f].map(encodeURIComponent).join(",") : null;
  return out;
}
