/**
 * A module page as a document (docs/modules.md, "Records, exports and print"): what its print stylesheet prints,
 * as blocks a PDF lays out. The page as the caller reads it (`api.modules.page`): its header, banners, details,
 * figures, tables (sorted, filtered and grouped as the URL has them, with totals), status, loaded call values,
 * messages, approval steps and a set map's count/overlap fallback, in the open tab. Forms, buttons, charts, reports,
 * trees and history aren't drawn.
 * Pure: the PDF action and tests use it.
 */
import type { CallResult, Column, Node, TimelineHide } from "./manifest.ts";
import type { PdfBlock, PdfDoc } from "./pdf.ts";
import { arrange, stateFromQuery, total, totalText, type Kind, type Shown } from "./rows.ts";
import { columnText, fiscalMonths, fiscalYearOf, formatValue, renderText, rowWhenHolds, valueAt, type Doc, type TextScope } from "./text.ts";
import { focusedKey, setMapValue, sharedCount } from "./setMap.ts";

/** Literal null is an argument; a computed null means its binding supplied no value. */
export function formArguments<T>(expressions: Record<string, T>, resolve: (expression: T) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(expressions).flatMap(([key, expression]) => {
    const value = resolve(expression);
    return value === undefined || (value === null && expression !== null) ? [] : [[key, value]];
  }));
}

/** What a page read, as `api.modules.page` returns it, plus the values of the calls it loads. */
export type PrintView = {
  module: { title: string };
  userId?: string | null;
  page: { title: string; body: readonly Node[]; document?: { heading?: string; wordmark?: string; footer?: string } | null };
  data: Record<string, unknown>;
  lists: Record<string, { complete: boolean }>;
  labels: Record<string, Record<string, Record<string, string>>>;
  formats: Record<string, Record<string, string>>;
  kinds: Record<string, Record<string, string>>;
  refLabels: Record<string, string>;
  files: Record<string, { name: string }>;
  members: ReadonlyArray<{ id: string; name: string }>;
  currency: string;
  decimals?: number;
  query: Record<string, string>;
  machines: Record<string, { field: string; stateLabels: Record<string, string> | null }>;
  calls: Record<string, { label: string; result: CallResult | null }>;
  loads: Record<string, { call: string }>;
  integrity?: Record<string, { state: string } | null>;
  /** The loaded calls' values, by binding. */
  loaded: Record<string, unknown>;
  /** The reader's time zone, for times. */
  timeZone?: string;
  /** The month the workspace's fiscal year starts in: fiscal month columns and FY names. */
  fiscalYearStartMonth?: number;
};

/** Whether a component's `when` holds on the page's docs: a field's value, whether it is set, or a list being empty. */
export function nodeShows(when: Node["when"], data: Record<string, unknown>): boolean {
  if (!when) return true;
  const bound = data[when.bind];
  // A list binding read short isn't empty: it holds more than it read.
  // A one-doc binding is empty when there is no doc.
  if ("empty" in when) return Array.isArray(bound) ? (bound.length === 0) === when.empty : bound !== undefined && (bound === null) === when.empty;
  const doc = bound as Doc | null | undefined;
  if (!doc || typeof doc !== "object" || !("data" in doc)) return false;
  const v = doc.data[when.field];
  if ("set" in when) return (v !== undefined && v !== null && v !== "") === when.set;
  return when.in.includes((v ?? null) as never);
}

/**
 * Whether a timeline's `hide` (docs/modules.md, "Components") leaves an event out: its actor among `actors` and its kind
 * or verb among `events` (each any when left out), unless `keep` names its verb or kind.
 */
export function timelineHides(hide: TimelineHide, e: { actor: { kind: string }; kind: string; verb: string }): boolean {
  const actor = e.actor.kind === "user" ? "person" : e.actor.kind;
  if (hide.keep?.includes(e.verb) || hide.keep?.includes(e.kind)) return false;
  return (!hide.actors || (hide.actors as readonly string[]).includes(actor)) && (!hide.events || hide.events.includes(e.verb) || hide.events.includes(e.kind));
}

const asDoc = (row: unknown, i: number): Doc => {
  const data = (typeof row === "object" && row !== null ? row : { value: row }) as Record<string, unknown>;
  return { key: String(data.key ?? data.id ?? i), version: 0, owner: null, data };
};

/** The rows a table or a chart reads: a list binding's docs, or the list in a loaded call's value (`rows`, a field of it). */
export function rowsOfValue(value: unknown, field?: string): Doc[] {
  const list = field && typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : value;
  return (Array.isArray(list) ? list : []).map(asDoc);
}

/** An `each` column's item: its key (`{col}`) and the fields `{$col.<field>}` reads. */
export type EachItem = { key: string; data: Record<string, unknown> };

/**
 * The items an `each` column repeats over (docs/modules.md, "Tables"): a fiscal year's twelve months in fiscal order
 * (`year`, the page value it names: this fiscal year when it isn't one), or a binding's rows (`rows`, a list's docs or
 * a call's value or its field).
 */
export function eachItems(each: NonNullable<Column["each"]>, rowsOf: (from: string, field?: string) => Doc[], year: unknown, fyStart = 1): EachItem[] {
  if ("fiscalMonths" in each) {
    const y = Number(year);
    return fiscalMonths(year !== null && year !== undefined && year !== "" && Number.isInteger(y) ? y : fiscalYearOf(new Date(), fyStart), fyStart).map(({ key, ...data }) => ({ key, data: { key, ...data } }));
  }
  return rowsOf(each.from, each.rows).slice(0, 60).map((d) => ({ key: String(d.data.key ?? d.key), data: { ...d.data, key: d.data.key ?? d.key } }));
}

/**
 * The columns a table shows: each `each` column once per item, its texts and row paths with `{col}` as the item's key
 * and `{$col.<field>}` filled from the item (formats too: `{$col.start|date}`). Other columns as they are.
 */
export function expandColumns(columns: readonly Column[], itemsOf: (each: NonNullable<Column["each"]>) => EachItem[], scope: TextScope): Column[] {
  return columns.flatMap((c): Column[] => {
    if (!c.each) return [c];
    const { each: _each, ...base } = c;
    return itemsOf(c.each).map((item) => {
      const itemScope: TextScope = { ...scope, binds: { ...scope.binds, col: { key: item.key, version: 0, owner: null, data: item.data } } };
      const out = JSON.parse(JSON.stringify(base), (_k, v) => (typeof v === "string" ? fillCol(v, item.key, itemScope) : v)) as Column;
      // A header link one of whose item values is empty (a month with no period) isn't a link: its label stays.
      const empty = (base.headerLink?.match(/\{\$col\.[a-zA-Z][a-zA-Z0-9_]*(?:\|[a-zA-Z]+)?\}/g) ?? []).some((m) => renderText(m, itemScope) === "");
      if (empty) delete out.headerLink;
      return out;
    });
  });
}
/** A text of an `each` column for one item: `{col}` its key, `{$col...}` its fields; every other placeholder kept. */
function fillCol(t: string, key: string, scope: TextScope): string {
  return t.replace(/\{col\}/g, key).replace(/\{\$col\.[a-zA-Z][a-zA-Z0-9_]*(?:\|[a-zA-Z]+)?\}/g, (m) => renderText(m, scope));
}

/** The page as a document: its title, the line under it, and its blocks. `footer` is the line on every page. */
export function printDoc(v: PrintView, footer: string): PdfDoc {
  const members = new Map(v.members.map((m) => [m.id, m.name]));
  const loadedDocs = Object.fromEntries(Object.entries(v.loaded).map(([b, value]) => [b, asDoc(value, 0)]));
  const text: TextScope = { binds: { ...v.data, ...loadedDocs }, members, currency: v.currency, decimals: v.decimals, labels: v.labels, refs: v.refLabels, formats: v.formats, files: v.files, ...(v.timeZone ? { timeZone: v.timeZone } : {}), ...(v.fiscalYearStartMonth ? { fiscalYearStartMonth: v.fiscalYearStartMonth } : {}) };
  /** A page value an `each` column's fiscal year names: a URL parameter (or its default), a bound doc's field, a constant. */
  const pageValue = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    const o = x as { query?: string; default?: unknown; bind?: string; field?: string };
    if (o.query !== undefined) return v.query[o.query] || o.default;
    if (o.bind !== undefined) return valueAt(v.data[o.bind], o.field ?? "key");
    return undefined;
  };
  const columnsOf = (columns: readonly Column[]) => expandColumns(columns, (each) => eachItems(each, (from, field) => (v.loads[from] ? rowsOfValue(v.loaded[from], field) : ((v.data[from] as Doc[] | undefined) ?? [])), "fiscalMonths" in each ? pageValue(each.fiscalMonths) : null, v.fiscalYearStartMonth), text);
  const rowScope = (bind: string, row: Doc): TextScope => ({ ...text, row, rowLabels: v.labels[bind], rowFormats: v.formats[bind] });
  const blocks: PdfBlock[] = [];
  let title = v.page.title ? renderText(v.page.title, text) : v.module.title;
  let subtitle: string | undefined;

  /** A table's rows as the page shows them: searched, filtered, sorted and grouped by its state in the URL. */
  const table = (declared: readonly Column[], rows: Doc[], bind: string | null, spec: Extract<Node, { c: "table" }> | Extract<CallResult, { kind: "table" }>, complete: boolean) => {
    const columns = columnsOf(declared);
    const shown: Shown = { labels: bind ? v.labels[bind] : undefined, members, refs: v.refLabels, currency: v.currency, decimals: v.decimals, kinds: (bind ? v.kinds[bind] : undefined) as Record<string, Kind> | undefined, files: v.files };
    const state = stateFromQuery("id" in spec ? spec.id : undefined, v.query);
    const sections = complete ? arrange(rows, spec, state, shown) : [{ key: "", label: "", rows }];
    const cell = (row: Doc) => columns.map((c) => {
      if (c.when && !rowWhenHolds(c.when, row, v.userId)) return "";
      const scope = bind ? rowScope(bind, row) : { ...text, row };
      return renderText(columnText(c, row, v.userId), scope) || (c.empty ? renderText(c.empty, scope) : "");
    });
    const out: Array<{ cells: string[]; group?: boolean }> = [];
    for (const sec of sections) {
      if (spec.group) out.push({ group: true, cells: columns.map((c, i) => (i === 0 ? `${sec.label} · ${sec.rows.length}` : c.group !== undefined ? (sec.rows[0] ? renderText(c.group, bind ? rowScope(bind, sec.rows[0]) : { ...text, row: sec.rows[0] }) : "") : c.total ? totalText(sec.rows, c.total, text) : "")) });
      for (const row of sec.rows) out.push({ cells: cell(row) });
    }
    const all = sections.flatMap((s) => s.rows);
    const totals = complete && columns.some((c) => c.total) ? columns.map((c, i) => (i === 0 ? "Total" : c.total ? totalText(all, c.total, text) : "")) : undefined;
    if (!complete) blocks.push({ kind: "text", tone: "muted", text: "This list has more rows than the page read; it shows the first ones." });
    blocks.push({ kind: "table", columns: columns.map((c) => ({ label: renderText(c.label, text), ...(c.align ? { align: c.align } : {}) })), rows: out, ...(totals ? { total: totals } : {}) });
  };
  const callValue = (bind: string, result: CallResult, label: string) => {
    const value = v.loaded[bind];
    if (value === undefined) return;
    blocks.push({ kind: "heading", text: label });
    if (result.kind === "message") blocks.push({ kind: "text", text: typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value) });
    else if (result.kind === "kpis") blocks.push({ kind: "figures", items: result.items.map((x) => ({ label: x.label, value: renderText(x.value, { ...text, binds: { ...text.binds, result: asDoc(value, 0) } }) })) });
    else table(result.columns, rowsOfValue(value, result.rows), null, result, true);
  };

  // The page's leading headers are one header's variants: the first that shows titles the document, as on the page.
  let titled = false;
  const walk = (nodes: readonly Node[], first: boolean) => nodes.forEach((n, i) => {
    if (!nodeShows(n.when, text.binds)) return;
    switch (n.c) {
      case "header":
        if (first && nodes.slice(0, i).every((x) => x.c === "header")) {
          if (!titled) { title = renderText(n.title, text) || title; subtitle = n.subtitle ? renderText(n.subtitle, text) : undefined; titled = true; }
        } else blocks.push({ kind: "heading", text: renderText(n.title, text) });
        return;
      case "banner": blocks.push({ kind: "text", tone: "strong", text: renderText(n.text, text) }); return;
      case "prose": blocks.push({ kind: "prose", text: renderText(n.text, text) }); return;
      case "detail": blocks.push({ kind: "fields", columns: n.columns ?? 3, items: n.items.map((x) => ({ label: x.label, value: renderText(x.value, text) || "None" })) }); return;
      case "kpis": {
        const complete = (b: string) => v.lists[b]?.complete !== false;
        const rowsOf = (b: string) => (v.data[b] as Doc[] | undefined) ?? [];
        blocks.push({ kind: "figures", items: n.items.map((x) => ({
          label: x.label,
          value: "value" in x ? renderText(x.value, text) : "count" in x ? (complete(x.count) ? rowsOf(x.count).length.toLocaleString() : "") : complete(x.total.from) ? formatValue(total(rowsOf(x.total.from), x.total.sum), x.total.format ?? "number", text) : "",
        })) });
        return;
      }
      case "table": {
        const call = v.loads[n.from];
        if (call) { if (v.loaded[n.from] !== undefined) table(n.columns, rowsOfValue(v.loaded[n.from], n.rows), null, n, true); return; }
        table(n.columns, (v.data[n.from] as Doc[] | undefined) ?? [], n.from, n, v.lists[n.from]?.complete !== false);
        return;
      }
      case "setMap": {
        blocks.push({ kind: "heading", text: renderText(n.title ?? "Overlapping sets", text) });
        if (n.frameLabel) blocks.push({ kind: "text", tone: "muted", text: renderText(n.frameLabel, text) });
        const value = v.loaded[n.from];
        if (value === undefined) { blocks.push({ kind: "text", text: "Set map unavailable: its data has not loaded." }); return; }
        const map = setMapValue(value, n.rows, n.overlaps);
        if (!map.rows.length) { blocks.push({ kind: "text", text: renderText(n.empty ?? "No sets yet.", text) }); return; }
        const count = (x: number | null) => x === null ? "Unavailable" : x.toLocaleString();
        blocks.push({ kind: "text", tone: "muted", text: "Counts and pairwise overlaps from the map. Circle sizes are compressed and overlap geometry is approximate." });
        blocks.push({ kind: "table", columns: ["Set", "Key", "Parent key", "Count", "State"].map((label) => ({ label })),
          rows: map.rows.map((r) => ({ cells: [r.label, r.key, r.parent ?? "None", count(r.count), r.active === false ? "Off" : r.active === true ? "On" : ""] })) });
        const pairs = map.rows.flatMap((a, i) => map.rows.slice(i + 1).filter((b) => a.parent === b.parent).map((b) => ({ cells: [a.label, b.label, count(sharedCount(map.overlaps, a.key, b.key))] })));
        if (pairs.length) blocks.push({ kind: "table", columns: ["Set", "Sibling", "Shared count"].map((label) => ({ label })), rows: pairs });
        const key = focusedKey(map.rows.map((r) => r.key), n.selection, v.query);
        const selected = map.rows.find((r) => r.key === key);
        if (selected && n.focus) {
          const scope = { ...text, row: asDoc(selected, 0) };
          blocks.push({ kind: "heading", text: renderText(n.focus.title, scope) });
          blocks.push({ kind: "fields", columns: 2, items: n.focus.items.map((item) => ({ label: renderText(item.label, scope), value: renderText(item.value, scope) })).filter((item) => item.value !== "") });
        }
        return;
      }
      case "callResult": {
        const call = v.loads[n.from];
        const info = call ? v.calls[call.call] : undefined;
        if (info?.result) callValue(n.from, info.result, n.label ?? info.label);
        return;
      }
      case "statusSteps": {
        const doc = v.data[n.from] as Doc | null | undefined;
        const mc = v.machines[n.machine];
        if (doc && mc) { const s = String(doc.data[mc.field] ?? ""); blocks.push({ kind: "text", text: `Status: ${mc.stateLabels?.[s] ?? s}` }); }
        return;
      }
      case "integrity": {
        const st = v.integrity?.[n.from]?.state;
        if (st) blocks.push({ kind: "text", tone: "muted", text: st === "intact" ? "Sealed. It matches what was sealed." : st === "changed" ? "Changed since it was sealed." : "Not sealed." });
        return;
      }
      case "thread": {
        const rows = [...((v.data[n.from] as Doc[] | undefined) ?? [])].sort((a, b) => Number(valueAt(a, n.at ?? "createdAt") ?? 0) - Number(valueAt(b, n.at ?? "createdAt") ?? 0));
        if (!rows.length) return;
        blocks.push({ kind: "heading", text: "Messages" });
        for (const row of rows) {
          const author = n.author ? formatValue(valueAt(row, n.author), "user", text) : "";
          blocks.push({ kind: "text", tone: "muted", text: [author, formatValue(valueAt(row, n.at ?? "createdAt"), "time", text)].filter(Boolean).join(" · ") });
          blocks.push({ kind: "text", text: String(valueAt(row, n.body) ?? "") });
        }
        return;
      }
      case "approvalChain": {
        const rows = (v.data[n.from] as Doc[] | undefined) ?? [];
        if (!rows.length || !n.state) return;
        blocks.push({ kind: "table", columns: [{ label: "Step" }, { label: "Approver" }, { label: "State" }, { label: "When" }], rows: rows.map((row) => ({ cells: [
          renderText(n.title, rowScope(n.from, row)), n.approver ? formatValue(valueAt(row, n.approver), "user", text) : "", renderText(`{$row.${n.state}}`, rowScope(n.from, row)), n.at ? formatValue(valueAt(row, n.at), "time", text) : "",
        ] })) });
        return;
      }
      case "tabs": {
        const id = (t: { id?: string }, k: number) => t.id ?? String(k);
        const named = n.param ? v.query[n.param] : undefined;
        const open = n.tabs.find((t, k) => id(t, k) === named) ?? n.tabs[0];
        if (open) walk(open.body, false);
        return;
      }
      default: return;
    }
  });
  walk(v.page.body, true);
  // The page's own words for its document: a line over the title, a wordmark on every page, its footer.
  const words = v.page.document ?? {};
  const said = (t: string | undefined) => (t ? renderText(t, text) : "");
  const heading = said(words.heading), wordmark = said(words.wordmark), own = said(words.footer);
  return { title, ...(subtitle ? { subtitle } : {}), ...(heading ? { heading } : {}), ...(wordmark ? { wordmark } : {}), footer: own ? `${own} · ${footer}` : footer, blocks };
}

/** A value's JSON with every object's keys sorted, so two declarations that say the same thing read the same. */
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v) ?? "null");
/**
 * The id a page's judgement of an action goes by (`blocked[docKey][id]`): `t:<machine>.<transition>` or `op:<name>`, and
 * the action's `fixed` as declared when it has one. Two buttons for one transition that fix other arguments ("Approve"
 * with `force: false`, "Approve anyway" with `force: true`) are judged apart. The server and the page compute it alike.
 */
export function blockedId(kind: "t" | "op", name: string, fixed?: Record<string, unknown> | null): string {
  return fixed && Object.keys(fixed).length ? `${kind}:${name}|${canonical(fixed)}` : `${kind}:${name}`;
}
