"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { ListRow } from "../../../convex/lib/objects/listSpec";
import type { ReportSpec } from "../../../modules/kernel/reportValidators";
import { LoadingRows } from "@/components/dashboard";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { recordHref } from "@/components/records/record-target";
import { getErrorMessage } from "@/lib/utils";
import type { FieldInfo, Presented } from "./present";
import { keyKindOf, pickFilters, type ListFilter } from "./pick-filter";
import type { ChartPick } from "./report-chart";

/** The records behind a clicked mark: a title naming the mark and the list request that finds them. */
export type RecordsPick = { title: string; filter: ListFilter[] };

/** At most this many records list in the panel; its count says how many match in all. */
const LIMIT = 50;

/**
 * A chart's click handler for a report, or undefined when its marks can't be listed (a key reads a related record).
 * The pick is titled from the presentation, so it reads as the chart does ("Stage: Proposal · Won").
 */
export function pickHandler(spec: ReportSpec, p: Presented, fieldOf: (name: string) => FieldInfo | undefined, open: (pick: RecordsPick) => void): ChartPick | undefined {
  if (spec.groupBy.some((g) => g.via)) return undefined;
  const kinds = spec.groupBy.map((g) => { const f = fieldOf(g.field); return keyKindOf(g.field, f?.type, f?.returns); });
  return ({ x, series, seriesKey }) => {
    const keys = seriesKey === undefined ? [x] : [x, seriesKey];
    const filter = pickFilters(spec, kinds, keys);
    if (!filter) return;
    const label = p.groups.find((g) => JSON.stringify(g.keys[0]) === JSON.stringify(x))?.labels[0] ?? String(x);
    open({ title: `${p.keyLabels[0]}: ${label}${seriesKey !== undefined && series ? ` · ${series}` : ""}`, filter });
  };
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

/**
 * The records a clicked mark stands for, in a side panel: each opens its record. Sorted by the report's measured field
 * (largest first) when it has one, so the records that make the number come first.
 */
export function ReportRecords({ spec, pick, fieldOf, onClose }: {
  spec: ReportSpec; pick: RecordsPick | null; fieldOf: (name: string) => FieldInfo | undefined; onClose: () => void;
}) {
  const list = useAction(api.objects.list);
  const measured = spec.measures.find((m) => m.fn !== "count" && m.field)?.field;
  const mf = measured ? fieldOf(measured) : undefined;
  const key = pick ? JSON.stringify([spec.object, pick.filter, measured]) : "";
  const [answer, setAnswer] = useState<{ key: string; rows?: ListRow[]; total?: number; error?: string }>({ key: "" });
  useEffect(() => {
    if (!pick) return;
    let live = true;
    list({ object: spec.object, filter: pick.filter, limit: LIMIT, ...(measured ? { sort: { field: measured, dir: "desc" as const } } : {}) })
      .then((r) => live && setAnswer({ key, rows: r.rows, total: r.total }))
      .catch((e) => live && setAnswer({ key, error: getErrorMessage(e) }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = answer.key === key ? answer : null;
  const show = (v: unknown) => (typeof v === "number" && (mf?.type === "currency" || mf?.returns === "currency") ? money(v) : v == null || v === "" ? "—" : String(v));
  return (
    <Sheet open={pick !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-base">{pick?.title}</SheetTitle>
          <SheetDescription className="text-xs">
            {ready?.total !== undefined ? `${ready.total.toLocaleString("en-US")} ${ready.total === 1 ? "record" : "records"}` : "Finding the records…"} behind this part of the report, with its filters.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {!ready ? <LoadingRows count={4} /> : ready.error ? <p className="text-sm text-destructive">{ready.error}</p> : !ready.rows?.length ? (
            <p className="text-sm text-muted-foreground">No records match. The report may have changed since it last ran.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border"><th className="py-2 font-medium">Name</th>{measured && <th className="py-2 text-right font-medium">{mf?.label ?? measured}</th>}</tr>
              </thead>
              <tbody>
                {ready.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="py-2 pr-3"><Link href={recordHref(spec.object, r.id)} className="underline-offset-2 hover:underline">{r.title || "Untitled"}</Link></td>
                    {measured && <td className="py-2 text-right tabular-nums">{show(r.values[measured])}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {ready?.total !== undefined && ready.total > (ready.rows?.length ?? 0) && (
            <p className="mt-3 text-xs text-muted-foreground">Showing the first {ready.rows?.length} of {ready.total.toLocaleString("en-US")}.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
