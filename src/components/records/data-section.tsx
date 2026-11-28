"use client";

import { cn } from "@/lib/utils";
import { companyDealsData } from "../../../recipes/relationData";
import type { PageKind } from "../../../recipes/blocks";
import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { resolveQuery, validateQueryFields, type DataComponent, type DataQuery } from "../../../recipes/data";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import type { ListResponse } from "../../../convex/lib/objects/listSpec";
import type { AggregateResponse } from "../../../convex/lib/objects/reportSpec";
import { formatMoney } from "../../../modules/kernel/text";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { RecordLink, RecordQuickView, useRecordsSaved } from "./record-context";
import { ReportChart } from "../reports/report-chart";
import { present, type FieldInfo } from "../reports/present";
import type { PageSection } from "../../../recipes";

import { projectedPast } from "../../../convex/lib/objects/views";
import type { BoardSaves } from "./board-view";
import { DataWriteResult } from "./data-write-section";
import type { ObjectDescription } from "./fields";
import type { Context } from "../../../recipes/conditions";

type DataRecord = { id: string; values: Record<string, unknown>; company?: { domain: string; stream?: string } };
type Fields = readonly { apiName: string; fieldId: string; label?: string; hidden?: boolean; type?: string; options?: readonly { value: string; label: string }[] }[];
type Answer = { desc: ObjectDescription; query: DataQuery; rows?: ListResponse; fields: Fields } | { rows: ListResponse; fields: Fields; unlinked?: string[] } | { aggregate: AggregateResponse; fields: Fields };
export function DataSection({ section, record, fields, pageObject = "deal", context = {} }: { pageObject?: PageKind; context?: Context; section: Extract<PageSection, { component: DataComponent }>; record: DataRecord; fields: Fields }) {
  const client = useConvex();
  const [state, setState] = useState<{ key: string; answer?: Answer; error?: string }>();
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState<BoardSaves>({ n: 0, saves: [] });
  useRecordsSaved((saves) => { setSaved((s) => ({ n: s.n + 1, saves })); setGeneration((g) => g + 1); });
  const key = JSON.stringify([section.query, record, fields, generation]);
  useEffect(() => {
    let live = true;
    async function load(): Promise<Answer> {
      let q = resolveQuery(section.query, record, fields);
      if ("record" in q && q.record) q = { ...q, filter: resolveQuery({ ...q, filter: [{ field: "id", op: "eq", value: { record: q.record } }] }, record, fields).filter };
      const desc = await client.query(api.objects.describe, { object: q.object });
      if (!desc?.readable) throw new Error("You cannot view this object");
      const def = indexObjectDef(desc as unknown as ObjectDef);
      validateQueryFields(q, def);
      const used = [...q.filter.map((f) => f.field), ...(q.sort ? [q.sort.field] : []), ...("columns" in q ? q.columns : []), ...("aggregate" in q && q.aggregate.fn !== "count" ? [q.aggregate.field] : []), ...("groupBy" in q ? [q.groupBy.field] : [])];
      if (used.some((name) => desc.fields.some((f) => (f.apiName === name || f.fieldId === name) && f.hidden))) throw new Error("You cannot view a field used by this query");
      if (q.from) {
        if (pageObject !== "account" || q.object !== "deal" || !record.company) throw new Error("This relation needs an account record");
        const deals = await client.query(api.deals.forCompany, { companyId: record.id, domain: record.company.domain, ...(record.company.stream ? { stream: record.company.stream } : {}) });
        return { ...companyDealsData(q, deals, def), fields: desc.fields };
      }
      if (section.component === "form" || section.component === "board" || section.component === "detail") {
        if ("defaults" in q) for (const [field, value] of Object.entries(q.defaults)) if (value && typeof value === "object") resolveQuery({ ...q, filter: [{ field, op: "eq", value }] }, record, fields);
        const usedFields = "fields" in q ? [...q.fields, ...Object.keys(q.defaults)] : "columns" in q ? q.columns : [];
        if (usedFields.some((name) => desc.fields.some((f) => (f.apiName === name || f.fieldId === name) && f.hidden))) throw new Error("You cannot view a field used by this block");
        const rows = section.component === "detail" ? await client.action(api.objects.list, { object: q.object, filter: q.filter, ...(q.sort ? { sort: q.sort } : {}), limit: 1 }) : undefined;
        return { desc, query: q, rows, fields: desc.fields };
      }
      if ("aggregate" in q) {
        const result = await client.action(api.reports.run, { spec: { object: q.object, filter: q.filter, groupBy: "groupBy" in q ? [q.groupBy] : [], measures: [q.aggregate], chart: "groupBy" in q ? "bar" : "number" } });
        return { aggregate: result, fields: desc.fields };
      }
      return { rows: await client.action(api.objects.list, { object: q.object, filter: q.filter, ...(q.sort ? { sort: q.sort } : {}), limit: q.limit }), fields: desc.fields };
    }
    async function caughtUp() {
      const started = Date.now();
      let answer = await load();
      const cursor = () => "aggregate" in answer ? answer.aggregate.projectedThrough : "rows" in answer ? answer.rows?.projectedThrough : undefined;
      while (live && cursor() && !projectedPast(cursor()!, saved.saves) && Date.now() - started < 4000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!live) return answer;
        answer = await load();
      }
      return answer;
    }
    void caughtUp().then((answer) => { if (live) setState({ key, answer }); }, (e: unknown) => { if (live) setState({ key, error: e instanceof Error ? e.message : "This query is unavailable" }); });
    return () => { live = false; };
    // The serialized inputs make a new record/query invalidate an outstanding read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  const current = state?.key === key ? state : undefined;
  return <section aria-label={section.title} className="record-panel record-panel-pad overflow-hidden">
    <h2 className="record-block-heading record-section-title mb-3">{section.title}</h2>
    {current?.error ? <p role="alert" className="record-value text-muted-foreground">{current.error}</p> : current?.answer ? "desc" in current.answer && (section.component === "form" || section.component === "board" || section.component === "detail") ? <DataWriteResult externalSaves={saved} section={section} query={current.answer.query} desc={current.answer.desc} rows={current.answer.rows} pageObject={pageObject} context={context} record={record} pageFields={fields} reload={() => setGeneration((g) => g + 1)} /> : <DataResult kind={section.component} query={section.query} answer={current.answer} /> : <p role="status" className="record-value text-muted-foreground">Loading records…</p>}
  </section>;
}
export function DataResult({ kind, query: q, answer, compact = false }: { kind: DataComponent; query: DataQuery; answer: Answer; compact?: boolean }) {
  if ("aggregate" in answer && "aggregate" in q) {
    const fieldOf = (name: string): FieldInfo | undefined => { const f = answer.fields.find((f) => f.apiName === name); return f ? { label: f.label ?? name, type: f.type ?? "text" } : undefined; };
    const groupBy = "groupBy" in q ? [q.groupBy] : [];
    const p = present({ groupBy, measures: [q.aggregate] }, answer.aggregate, groupBy.map((g) => fieldOf(g.field)), [q.aggregate.fn === "count" ? undefined : fieldOf(q.aggregate.field)]);
    if (kind === "metric") return <p className="record-metric tabular-nums">{p.format(0, p.total[0])}</p>;
    if (!answer.aggregate.rows) return <p className="record-value text-muted-foreground">No matching records.</p>;
    return <ReportChart p={{ ...p, groups: p.groups.slice(0, q.limit) }} kind="bar" />;
  }
  if (!("rows" in answer) || !answer.rows || !("columns" in q)) return null;
  if (!answer.rows.rows.length) return <p className="record-value text-muted-foreground">No matching records.</p>;
  const label = (name: string) => answer.fields.find((f) => f.apiName === name || f.fieldId === name)?.label ?? (name === "recordTitle" ? "Name" : name);
  const cell = (row: ListResponse["rows"][number], name: string) => {
    if (name === "recordTitle") return row.title;
    if (name === "id") return row.id;
    const f = answer.fields.find((f) => f.apiName === name || f.fieldId === name);
    const value = f ? row.values[f.fieldId] : name === "createdAt" ? row.createdAt : row.updatedAt;
    if (value == null) return "—";
    if (f?.type === "currency" && typeof value === "number") return formatMoney(value, typeof row.values.currency === "string" ? row.values.currency : "USD", 2);
    if (f?.type === "checkbox") return value ? "Yes" : "No";
    if (f?.type === "picklist") return f.options?.find((option) => option.value === value)?.label ?? String(value);
    return Array.isArray(value) ? value.join(", ") : String(value);
  };
  const link = (row: ListResponse["rows"][number]) => "unlinked" in answer && answer.unlinked?.includes(row.id) ? <span>{row.title}</span> : <span className="inline-flex items-center gap-1"><RecordLink object={q.object} id={row.id} className={compact ? "whitespace-normal [overflow-wrap:anywhere] hover:underline" : "hover:underline"}>{row.title}</RecordLink>{!compact && <RecordQuickView object={q.object} id={row.id} label={row.title} />}</span>;
  if (kind === "list") return <ul className="divide-y divide-border">{answer.rows.rows.map((row) => <li key={row.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 record-value">{link(row)}<span className="break-words text-muted-foreground">{q.columns.filter((c) => c !== "recordTitle").map((c) => cell(row, c)).join(" · ")}</span></li>)}</ul>;
  const columns = q.columns.filter((column) => column !== "recordTitle");
  const labelClass = cn("record-label", compact && "px-1.5");
  const valueClass = cn("record-value", compact && "px-1.5");
  return <div className="record-table min-w-0 max-w-full overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow><TableHead className={labelClass}>Record</TableHead>{columns.map((column) => <TableHead key={column} className={labelClass}>{label(column)}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {answer.rows.rows.map((row) => <TableRow key={row.id}>
          <TableCell className={valueClass}>{link(row)}</TableCell>
          {columns.map((column) => <TableCell key={column} className={valueClass}>{cell(row, column)}</TableCell>)}
        </TableRow>)}
      </TableBody>
    </Table>
  </div>;
}
export function dataRenderers(record: DataRecord, fields: Fields, pageObject: PageKind = "deal", context: Context = {}) {
  const render = (section: Extract<PageSection, { component: DataComponent }>) => <DataSection section={section} record={record} fields={fields} pageObject={pageObject} context={context} />;
  return { table: render, list: render, metric: render, chart: render, form: render, board: render, detail: render };
}
