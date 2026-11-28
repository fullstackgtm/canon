"use client";
import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { resolveQuery, validateQueryFields, type DataComponent, type DataQuery } from "../../../recipes/data";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import type { ListResponse } from "../../../convex/lib/objects/listSpec";
import type { AggregateResponse } from "../../../convex/lib/objects/reportSpec";
import { formatMoney } from "../../../modules/kernel/text";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { RecordLink, RecordQuickView } from "./record-context";
import { ReportChart } from "../reports/report-chart";
import { present, type FieldInfo } from "../reports/present";
import type { PageSection } from "../../../recipes";

type Fields = readonly { apiName: string; fieldId: string; label?: string; hidden?: boolean; type?: string }[];
type Answer = { rows: ListResponse; fields: Fields } | { aggregate: AggregateResponse; fields: Fields };
export function DataSection({ section, record, fields }: { section: Extract<PageSection, { component: DataComponent }>; record: { id: string; values: Record<string, unknown> }; fields: Fields }) {
  const client = useConvex();
  const [state, setState] = useState<{ key: string; answer?: Answer; error?: string }>();
  const key = JSON.stringify([section.query, record, fields]);
  useEffect(() => {
    let live = true;
    async function load(): Promise<Answer> {
      const q = resolveQuery(section.query, record, fields);
      const desc = await client.query(api.objects.describe, { object: q.object });
      if (!desc?.readable) throw new Error("You cannot view this object");
      const def = indexObjectDef(desc as unknown as ObjectDef);
      validateQueryFields(q, def);
      const used = [...q.filter.map((f) => f.field), ...(q.sort ? [q.sort.field] : []), ...("columns" in q ? q.columns : []), ...("aggregate" in q && q.aggregate.fn !== "count" ? [q.aggregate.field] : []), ...("groupBy" in q ? [q.groupBy.field] : [])];
      if (used.some((name) => desc.fields.some((f) => (f.apiName === name || f.fieldId === name) && f.hidden))) throw new Error("You cannot view a field used by this query");
      if ("aggregate" in q) {
        const result = await client.action(api.reports.run, { spec: { object: q.object, filter: q.filter, groupBy: "groupBy" in q ? [q.groupBy] : [], measures: [q.aggregate], chart: "groupBy" in q ? "bar" : "number" } });
        return { aggregate: result, fields: desc.fields };
      }
      return { rows: await client.action(api.objects.list, { object: q.object, filter: q.filter, ...(q.sort ? { sort: q.sort } : {}), limit: q.limit }), fields: desc.fields };
    }
    void load().then((answer) => { if (live) setState({ key, answer }); }, (e: unknown) => { if (live) setState({ key, error: e instanceof Error ? e.message : "This query is unavailable" }); });
    return () => { live = false; };
    // The serialized inputs make a new record/query invalidate an outstanding read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  const current = state?.key === key ? state : undefined;
  return <section aria-label={section.title} className="min-w-0 overflow-hidden border border-border bg-card p-4">
    <h2 className="mb-3 text-sm font-medium">{section.title}</h2>
    {current?.error ? <p role="alert" className="text-sm text-muted-foreground">{current.error}</p> : current?.answer ? <DataResult kind={section.component} query={section.query} answer={current.answer} /> : <p role="status" className="text-sm text-muted-foreground">Loading records…</p>}
  </section>;
}
export function DataResult({ kind, query: q, answer }: { kind: DataComponent; query: DataQuery; answer: Answer }) {
  if ("aggregate" in answer && "aggregate" in q) {
    const fieldOf = (name: string): FieldInfo | undefined => { const f = answer.fields.find((f) => f.apiName === name); return f ? { label: f.label ?? name, type: f.type ?? "text" } : undefined; };
    const groupBy = "groupBy" in q ? [q.groupBy] : [];
    const p = present({ groupBy, measures: [q.aggregate] }, answer.aggregate, groupBy.map((g) => fieldOf(g.field)), [q.aggregate.fn === "count" ? undefined : fieldOf(q.aggregate.field)]);
    if (kind === "metric") return <p className="text-3xl font-semibold tabular-nums">{p.format(0, p.total[0])}</p>;
    if (!answer.aggregate.rows) return <p className="text-sm text-muted-foreground">No matching records.</p>;
    return <ReportChart p={{ ...p, groups: p.groups.slice(0, q.limit) }} kind="bar" />;
  }
  if (!("rows" in answer) || !("columns" in q)) return null;
  if (!answer.rows.rows.length) return <p className="text-sm text-muted-foreground">No matching records.</p>;
  const label = (name: string) => answer.fields.find((f) => f.apiName === name || f.fieldId === name)?.label ?? (name === "recordTitle" ? "Name" : name);
  const cell = (row: ListResponse["rows"][number], name: string) => {
    if (name === "recordTitle") return row.title;
    if (name === "id") return row.id;
    const f = answer.fields.find((f) => f.apiName === name || f.fieldId === name);
    const value = f ? row.values[f.fieldId] : name === "createdAt" ? row.createdAt : row.updatedAt;
    if (value == null) return "—";
    if (f?.type === "currency" && typeof value === "number") return formatMoney(value, typeof row.values.currency === "string" ? row.values.currency : "USD", 2);
    if (f?.type === "checkbox") return value ? "Yes" : "No";
    return Array.isArray(value) ? value.join(", ") : String(value);
  };
  const link = (row: ListResponse["rows"][number]) => <span className="inline-flex items-center gap-1"><RecordLink object={q.object} id={row.id} className="hover:underline">{row.title}</RecordLink><RecordQuickView object={q.object} id={row.id} label={row.title} /></span>;
  if (kind === "list") return <ul className="divide-y divide-border">{answer.rows.rows.map((row) => <li key={row.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm">{link(row)}<span className="break-words text-muted-foreground">{q.columns.filter((c) => c !== "recordTitle").map((c) => cell(row, c)).join(" · ")}</span></li>)}</ul>;
  return <div className="min-w-0 max-w-full overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Record</TableHead>{q.columns.filter((c) => c !== "recordTitle").map((c) => <TableHead key={c}>{label(c)}</TableHead>)}</TableRow></TableHeader><TableBody>{answer.rows.rows.map((row) => <TableRow key={row.id}><TableCell>{link(row)}</TableCell>{q.columns.filter((c) => c !== "recordTitle").map((c) => <TableCell key={c}>{cell(row, c)}</TableCell>)}</TableRow>)}</TableBody></Table></div>;
}
export function dataRenderers(record: { id: string; values: Record<string, unknown> }, fields: Fields) {
  const render = (section: Extract<PageSection, { component: DataComponent }>) => <DataSection section={section} record={record} fields={fields} />;
  return { table: render, list: render, metric: render, chart: render };
}
