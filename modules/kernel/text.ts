/**
 * A module page's text (docs/modules.md, "Text"): `{$bind.field}` and `{$row.field}` placeholders, each with an
 * optional format. Money is stored in minor units (cents), as everywhere in Canon. Pure: the browser draws pages
 * with it, and Convex writes notifications and CSV exports with it.
 */
export type Doc = {
  key: string; version: number; data: Record<string, unknown>; owner: string | null;
  parentKey?: string | null; createdAt?: number; updatedAt?: number;
  /** A binding's joined refs (null: the reader can't see it) and counts (docs/modules.md, "Pages"). */
  joined?: Record<string, Record<string, unknown> | null>; counts?: Record<string, number | Array<string | number | boolean>>;
};
/** Value labels by field (a schema union's `labels`): what a value shows as when no format is given. */
export type Labels = Record<string, Record<string, string>>;
/** The format a field takes when text gives none, by field: a number with a `time` hint shows as a date and time. */
export type Formats = Record<string, string>;
/**
 * `refs`: what a deal, team or module doc ref shows as, by its id. `formats`: each binding's fields' own formats.
 * `plain`: values as a CSV holds them (money as 1234.50, dates as YYYY-MM-DD, times as ISO), not as a page shows them.
 */
export type TextScope = {
  binds: Record<string, unknown>; row?: Doc; members: ReadonlyMap<string, string>; currency: string;
  /** The places money shows with (the workspace's currency decimal places, 0 to 4); the currency's own when absent. */
  decimals?: number;
  labels?: Record<string, Labels>; rowLabels?: Labels; refs?: Readonly<Record<string, string>>;
  formats?: Record<string, Formats>; rowFormats?: Formats; plain?: boolean;
  /** What the files the page's docs hold are, by id: a file field shows its file's name. */
  files?: Readonly<Record<string, { name: string }>>;
  /** The time zone a time in ms shows in (the reader's, when a server renders it); the runtime's otherwise. */
  timeZone?: string;
  /** List bindings read short of their rows: their `{$<bind>.count}` shows as "50+". */
  short?: ReadonlySet<string>;
  /** The month (1 to 12) the workspace's fiscal year starts in: a `fy` format names a fiscal year by it. */
  fiscalYearStartMonth?: number;
  /** What the workspace calls each deal stage and deal type (`|stage`, `|dealType`), by value. */
  dealLabels?: Readonly<Record<"stage" | "dealType", Readonly<Record<string, string>>>>;
};

/**
 * A fiscal year as it reads: the calendar year when the fiscal year starts in January, else "FY" and the year it ends
 * in (a July start: July 2026 to June 2027 is FY2027).
 */
export const fiscalYearLabel = (year: number, startMonth = 1): string => (startMonth > 1 && startMonth <= 12 ? `FY${year}` : String(year));

/** The fiscal year (named by the year it ends in) a date falls in, for a year that starts in `startMonth`. */
export function fiscalYearOf(date: Date, startMonth = 1): number {
  const month = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const y = date.getFullYear();
  return month === 1 ? y : date.getMonth() + 1 >= month ? y + 1 : y;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * The twelve months of fiscal year `year` (named by the year it ends in), in fiscal order: each `key` (`m<calendar
 * month>`: m7 is July), its `label` ("Jul"), its `month` (YYYY-MM), first and last day, and place (`index`, from 0).
 */
export function fiscalMonths(year: number, startMonth = 1): Array<{ key: string; label: string; month: string; start: string; end: string; index: number }> {
  const first = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const startYear = first === 1 ? year : year - 1;
  return Array.from({ length: 12 }, (_, index) => {
    const abs = first - 1 + index;
    const y = startYear + Math.floor(abs / 12), m = (abs % 12) + 1;
    const mm = String(m).padStart(2, "0");
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { key: `m${m}`, label: MONTHS[m - 1], month: `${y}-${mm}`, start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}`, index };
  });
}

const PLACEHOLDER = /\{\$([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)?)(?:\|([a-zA-Z]+))?\}/g;

const isDoc = (x: unknown): x is Doc => typeof x === "object" && x !== null && "data" in x && "key" in x;
const META = new Set(["key", "version", "owner", "parentKey", "createdAt", "updatedAt"]);

/**
 * One value of a bound doc or the row: a field, Canon's metadata (`key`, `version`, `owner`, `parentKey`,
 * `createdAt`, `updatedAt`) when the doc has no field of that name, a count, a joined doc's field (`deal.amount`) or
 * a nested object's (`followUp.due`).
 */
export function valueAt(doc: unknown, path: string): unknown {
  if (!isDoc(doc)) return undefined;
  const [first, second] = path.split(".");
  if (second !== undefined) {
    if (doc.joined && Object.hasOwn(doc.joined, first)) return doc.joined[first]?.[second];
    const nested = doc.data[first];
    return typeof nested === "object" && nested !== null && !Array.isArray(nested) ? (nested as Record<string, unknown>)[second] : undefined;
  }
  if (first === "key" || first === "version") return doc[first];
  if (Object.hasOwn(doc.data, first)) return doc.data[first];
  if (META.has(first)) return doc[first as keyof Doc];
  return doc.counts?.[first];
}

/**
 * A text rendered as `renderText` does, or "" when it holds placeholders and every one of them is empty: a field's help
 * "Deal: {$row.dealId.companyName}" for a deal with no company says nothing rather than a bare "Deal:".
 */
export function renderFilled(text: string, scope: TextScope): string {
  const marks = text.match(PLACEHOLDER) ?? [];
  if (marks.length && marks.every((m) => renderText(m, scope) === "")) return "";
  return renderText(text, scope);
}

/**
 * Whether a row condition (RowWhen: a column's, a chip's, a source's, a contributed badge's or Team column's `when`)
 * holds on a row: its field, a count its binding gives each row (`{ "field": "held", "in": [1] }`) or a joined doc's
 * field, read like a cell's text reads them. `me` is the member who reads the row: `{ "field": "assignee", "me": false }`
 * holds while someone else (or no one) holds it; with no reader known, `me: true` never holds.
 */
export function rowWhenHolds(
  w: { field: string; in: readonly unknown[] } | { field: string; set: boolean } | { field: string; me: boolean } | { field: string; gte: number },
  row: Doc,
  me?: string | null,
): boolean {
  const v = valueAt(row, w.field);
  if ("me" in w) return (!!me && (Array.isArray(v) ? v : [v]).includes(me)) === w.me;
  if ("gte" in w) return typeof v === "number" ? v >= w.gte : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= w.gte;
  // A count of none, or an empty list, isn't set: `{ "field": "tasks", "set": true }` shows on rows with a task.
  const counted = !w.field.includes(".") && !Object.hasOwn(row.data, w.field) && row.counts !== undefined && Object.hasOwn(row.counts, w.field);
  const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (counted && v === 0);
  if ("set" in w) return !empty === w.set;
  return Array.isArray(v) ? v.some((x) => w.in.includes(x)) : w.in.includes(v ?? null);
}

export function columnText(c: { value: string; cases?: ReadonlyArray<{ when: Parameters<typeof rowWhenHolds>[0]; value: string }> }, row: Doc, me?: string | null): string {
  return c.cases?.find((x) => rowWhenHolds(x.when, row, me))?.value ?? c.value;
}

/**
 * A contributed deals badge's labels per deal (docs/modules.md, "On Canon's pages"): one per doc whose `deal` field
 * names the deal and on which `when` holds (the reader as `me`), each label once; with `count`, one per deal, over its
 * first doc, with the deal's docs as `{$docs.count}` ("+2 credited").
 */
export function dealBadges(
  b: { deal: string; label: string; when?: Parameters<typeof rowWhenHolds>[0]; count?: true },
  docs: readonly Doc[],
  scope: TextScope,
  me?: string | null,
): Map<string, string[]> {
  const byDeal = new Map<string, Doc[]>();
  for (const d of docs) {
    const deal = d.data[b.deal];
    if (typeof deal !== "string" || (b.when && !rowWhenHolds(b.when, d, me))) continue;
    const list = byDeal.get(deal);
    if (list) list.push(d); else byDeal.set(deal, [d]);
  }
  const out = new Map<string, string[]>();
  for (const [deal, own] of byDeal) {
    const labels = (b.count ? own.slice(0, 1) : own).map((d) => renderText(b.label, { ...scope, row: d, binds: b.count ? { ...scope.binds, docs: own } : scope.binds }).trim());
    const kept = [...new Set(labels.filter(Boolean))];
    if (kept.length) out.set(deal, kept);
  }
  return out;
}

/** A date (`YYYY-MM-DD`) or a time in ms as a Date, or null. A date reads as the local day it names. */
function dateOf(value: unknown): { at: Date; day: boolean } | null {
  if (typeof value === "number" && Number.isFinite(value)) return { at: new Date(value), day: false };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) { const at = new Date(`${value}T00:00:00`); return Number.isNaN(at.getTime()) ? null : { at, day: true }; }
  return null;
}
const isoDay = (d: { at: Date; day: boolean }) => (d.day ? `${d.at.getFullYear()}-${String(d.at.getMonth() + 1).padStart(2, "0")}-${String(d.at.getDate()).padStart(2, "0")}` : d.at.toISOString().slice(0, 10));

/** A time in ms shown in the reader's zone when the scope names one; a date is a day wherever it is read. */
const zone = (d: { day: boolean }, scope: Pick<TextScope, "timeZone">) => (!d.day && scope.timeZone ? { timeZone: scope.timeZone } : {});

/** A workspace's currency decimal places as money shows with them: 0 to 4, else 2. */
export const moneyDecimals = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4 ? n : 2);

/** Minor units (cents) as money in `currency`, with `decimals` places when given. */
export function formatMoney(cents: number, currency: string, decimals?: number): string {
  const places = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, ...places }).format(cents / 100); } catch { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", ...places }).format(cents / 100); }
}

const CRM_NAMES: Readonly<Record<string, string>> = { salesforce: "Salesforce", hubspot: "HubSpot" };

/** A deal's `source` as a line: "Manually created", "Imported from CSV", or "Synced from <CRM>". */
export function dealSourceText(source: string): string {
  if (source === "manual") return "Manually created";
  if (source === "csv") return "Imported from CSV";
  return `Synced from ${CRM_NAMES[source] ?? source.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

export function formatValue(value: unknown, format: string | undefined, scope: Pick<TextScope, "members" | "currency" | "decimals" | "refs" | "plain" | "files" | "timeZone" | "fiscalYearStartMonth" | "dealLabels">): string {
  if (format === "json") return value === undefined ? "" : JSON.stringify(value);
  if (value === undefined || value === null || value === "") return "";
  const plain = scope.plain === true;
  switch (format) {
    // A deal's stage or type as the workspace names it ("Closed won"), else its value in words.
    case "stage": case "dealType":
      return scope.dealLabels?.[format]?.[String(value)] ?? String(value).replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    case "dealSource":
      return dealSourceText(String(value));
    case "money":
      if (typeof value !== "number") return String(value);
      return plain ? (value / 100).toFixed(2) : formatMoney(value, scope.currency, scope.decimals);
    case "number":
      // A list as a number is how many it holds ("3 going").
      if (Array.isArray(value)) return plain ? String(value.length) : value.length.toLocaleString();
      return typeof value === "number" ? (plain ? String(value) : value.toLocaleString()) : String(value);
    case "date": {
      const d = dateOf(value);
      if (!d) return String(value);
      return plain ? isoDay(d) : d.at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", ...zone(d, scope) });
    }
    case "time": {
      const d = dateOf(value);
      if (!d) return String(value);
      if (plain) return d.day ? isoDay(d) : d.at.toISOString();
      return d.day ? d.at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : d.at.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...zone(d, scope) });
    }
    case "percent":
      if (typeof value !== "number") return String(value);
      return plain ? String(value) : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(value);
    case "fy": {
      const year = Number(value);
      return Number.isInteger(year) ? fiscalYearLabel(year, scope.fiscalYearStartMonth) : String(value);
    }
    case "user":
      return scope.members.get(String(value)) ?? "A former member";
    case "file":
      return scope.files?.[String(value)]?.name ?? "A file";
    case "ref": {
      // A deal, team, company, person or doc the reader can't see shows as nothing rather than its id; a list, as the names it can.
      const one = (x: unknown) => scope.refs?.[String(x)] ?? scope.members.get(String(x)) ?? "";
      return Array.isArray(value) ? value.map(one).filter(Boolean).join(", ") : one(value);
    }
    default:
      if (Array.isArray(value)) return plain ? value.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join("; ") : `${value.length} ${value.length === 1 ? "item" : "items"}`;
      if (typeof value === "boolean") return value ? "Yes" : "No";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** `text` with each placeholder filled from the page's bindings or the row. */
export function renderText(text: string, scope: TextScope): string {
  return text.replace(PLACEHOLDER, (_m, bind: string, field: string, format: string | undefined) => {
    // A list binding's `count`: how many rows it read ("50+" when it read short of them): a tab's "Needs action (3)".
    const bound = bind === "row" ? undefined : scope.binds[bind];
    if (Array.isArray(bound) && field === "count") return `${bound.length.toLocaleString()}${scope.short?.has(bind) ? "+" : ""}`;
    const value = valueAt(bind === "row" ? scope.row : scope.binds[bind], field);
    const label = format ? undefined : (bind === "row" ? scope.rowLabels : scope.labels?.[bind])?.[field]?.[String(value)];
    // A field's own format (a time) when the text gives none; `createdAt` and `updatedAt` are times.
    const own = format ?? (bind === "row" ? scope.rowFormats : scope.formats?.[bind])?.[field] ?? (field === "createdAt" || field === "updatedAt" ? "time" : undefined);
    return label ?? formatValue(value, own, scope);
  });
}

/**
 * A page path with its `:params` filled, in its path and its query (`tallies?month=:key`): `:key` from the row or the
 * doc an op returned, the rest from the row's fields or the route.
 */
export function fillPath(path: string, values: Record<string, string>): string {
  return path.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_m, name: string) => encodeURIComponent(values[name] ?? ""));
}

/**
 * Rows as CSV (RFC 4180): fields with a comma, a quote or a line break quoted, quotes doubled. A cell a spreadsheet
 * would run as a formula (it starts with =, +, -, @, a tab or a carriage return) is prefixed with ', unless it is a
 * plain number.
 */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
