import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as recordTarget from "../src/components/records/record-target.ts";
import * as views from "../convex/lib/objects/views.ts";

const require = createRequire(import.meta.url);
const noop = () => undefined;
type Props = Record<string, unknown>;
type Render = (props: Props) => React.ReactElement<Props> | null;

function load(file: string, stubs: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/components/records/${file}.tsx`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Record<string, unknown> = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.equal(id, "react/jsx-runtime");
    return require(id);
  } });
  return exports;
}

test("a record link navigates to the record's page, and only Quick view opens the inspection", () => {
  let inspection: { open: (target: recordTarget.RecordTarget) => void } | null = null;
  const Link = () => null;
  const { RecordLink, RecordQuickView } = load("record-context", {
    react: { ...React, useContext: () => inspection },
    "next/link": { default: Link },
    "lucide-react": { Eye: "svg" },
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" ") },
    "./record-target": recordTarget,
  }) as { RecordLink: Render; RecordQuickView: Render };
  const opened: recordTarget.RecordTarget[] = [];
  inspection = { open: (target) => { opened.push(target); } };

  const onClick = noop;
  const link = RecordLink({ object: "contact", id: "con 1", target: "_blank", className: "name", onClick, children: "Ada" })!;
  assert.equal(link.type, Link);
  assert.deepEqual({ ...link.props }, { target: "_blank", className: "name", onClick, children: "Ada", href: "/dashboard/records/contact/con%201" });
  assert.equal(RecordLink({ object: "deal", id: "d1", children: "Deal" })!.props.onClick, undefined);

  const button = RecordQuickView({ object: "contact", id: "con 1", label: "Ada" })!;
  assert.equal(button.type, "button");
  assert.equal(button.props["aria-haspopup"], "dialog");
  assert.match(String(button.props["aria-label"]), /Ada/);
  let stopped = 0;
  (button.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => { stopped++; } });
  assert.equal(stopped, 1);
  assert.deepEqual(opened.map((target) => ({ ...target })), [{ object: "contact", id: "con 1" }]);

  inspection = null;
  assert.equal(RecordQuickView({ object: "contact", id: "con 1", label: "Ada" }), null);
});

test("a full record page leads back to its object's own list", () => {
  assert.deepEqual(recordTarget.recordListOf("account", "Clients"), { href: "/dashboard/accounts", label: "Clients" });
  assert.deepEqual(recordTarget.recordListOf("contact", "People"), { href: "/dashboard/contacts", label: "People" });
  assert.deepEqual(recordTarget.recordListOf("deal", "Opportunities"), { href: "/dashboard/deals", label: "Opportunities" });
  assert.deepEqual(recordTarget.recordListOf("task", "Tasks"), { href: "/dashboard/tasks", label: "My work" });
  assert.deepEqual(recordTarget.recordListOf("invoice/x", "Invoices"), { href: "/dashboard/records/invoice%2Fx", label: "Invoices" });
  assert.deepEqual(recordTarget.recordListOf("constructor", "Builders"), { href: "/dashboard/records/constructor", label: "Builders" });
});

test("a board card's title navigates natively, beside a separate Quick view, and the card still drags", () => {
  const articles: Props[] = [];
  const links: Props[] = [];
  const runtime = require("react/jsx-runtime") as { jsx: (type: unknown, props: Props, key?: unknown) => unknown; jsxs: (type: unknown, props: Props, key?: unknown) => unknown };
  const record = (make: typeof runtime.jsx) => (type: unknown, props: Props, key?: unknown) => {
    if (type === "article") articles.push(props);
    return make(type, props, key);
  };
  const row = { id: "deal_1", version: 1, title: "Expansion", values: { f_account: "acc_1", f_stage: "open" } };
  const { BoardView } = load("board-view", {
    "react/jsx-runtime": { ...runtime, jsx: record(runtime.jsx), jsxs: record(runtime.jsxs) },
    react: React,
    "next/link": { default: ({ children, ...props }: Props & { children?: React.ReactNode }) => { links.push(props); return React.createElement("a", { href: props.href }, children); } },
    "./fields": { formatValue: () => "" },
    "./lookup-field": { useLookupTitles: () => ({}) },
    "./record-context": { RecordQuickView: ({ id }: { id: string }) => React.createElement("button", { "data-quick-view": id }) },
    "./record-target": recordTarget,
    "./use-object-list": { useObjectList: () => ({ rows: [row], total: 1, reload: noop, error: null }) },
    "./use-groups": { useGroups: () => ({ res: { groups: [{ key: "open", count: 1, sum: null }], rows: 1, sum: null, summed: null, truncated: false }, error: "", reload: noop }) },
    "../../../convex/lib/objects/views": views,
    "lucide-react": { ArrowRightLeft: "svg", Lock: "svg" },
    "@/components/dashboard": { ReadFailure: () => null },
    "@/components/ui/dropdown-menu": { DropdownMenu: "div", DropdownMenuTrigger: "button", DropdownMenuContent: "div", DropdownMenuItem: "div", DropdownMenuLabel: "div" },
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" "), formatCurrency: String },
  }) as { BoardView: React.ComponentType<Props> };
  const html = renderToStaticMarkup(React.createElement(BoardView, {
    object: "deal", filter: [], watch: [], onStale: noop, team: [], writable: true, onMove: noop, saves: { n: 0, saves: [] },
    groupBy: { apiName: "stage", fieldId: "f_stage", label: "Stage", options: [] },
    columns: [{ value: "open", label: "Open", accepts: true }],
    cardFields: [{ fieldId: "f_account", apiName: "account", label: "Company", type: "lookup", lookupTo: "account" }],
    hrefOf: (r: { id: string }) => recordTarget.recordHref("deal", r.id),
  }));

  assert.equal(articles.length, 1);
  assert.equal(articles[0].draggable, true);
  assert.equal(articles[0].onClick, undefined);
  const payloads = new Map<string, string>();
  const transfer = { setData: (kind: string, value: string) => payloads.set(kind, value), effectAllowed: "" };
  (articles[0].onDragStart as (event: { dataTransfer: typeof transfer }) => void)({ dataTransfer: transfer });
  assert.deepEqual(JSON.parse(payloads.get("application/x-canon-row")!), row);
  assert.equal(transfer.effectAllowed, "move");
  const [title, lookup] = links;
  assert.equal(title.href, "/dashboard/records/deal/deal_1");
  assert.equal(title.draggable, false);
  assert.equal(title.onClick, undefined);
  assert.equal(lookup.href, "/dashboard/accounts/acc_1");
  assert.equal(lookup.onClick, undefined);
  assert.match(html, /<a href="\/dashboard\/records\/deal\/deal_1">Expansion<\/a><button data-quick-view="deal_1">/);
});
