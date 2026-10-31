"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MEASURED_AS, measureWord, metricName, type MetricFn } from "@/lib/metric-names";
import { cn } from "@/lib/utils";

const seg = (on: boolean) => cn("flex-1 px-2 py-1 text-xs", on ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground");

/**
 * A metric as a chip: a type mark, its plain name ("Total amount") and the line that defines it ("TOTAL of Amount"),
 * opening one popover that changes how it is measured and shown. A count has nothing to measure, only to show.
 */
export function MetricChip({ fn, label, where, fieldLabel, fieldType, records, share, compare, canCompare, grip, className, dragProps, onFn, onShow, onRemove }: {
  fn: MetricFn; label?: string; where?: string; fieldLabel: string; fieldType?: string; records: string; share: boolean; compare: boolean; canCompare: boolean;
  grip?: ReactNode; className?: string; dragProps?: Record<string, unknown>; onFn: (fn: MetricFn) => void; onShow: (as: "value" | "share" | "prev") => void; onRemove?: () => void;
}) {
  const name = metricName({ fn, label }, fieldLabel, records);
  const word = measureWord(fn);
  const mark = share || fn === "pctTrue" ? "%" : fn === "count" ? "#" : fieldType === "currency" ? "$" : "#";
  const measured = fn !== "count" && fn !== "pctTrue";
  return (
    <li className={cn("group flex items-center gap-1.5 border border-primary/25 bg-primary/5 px-2 py-1.5", className)} {...dragProps}>
      {grip}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${share ? "% of " : ""}${name}: change how it is measured`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span aria-hidden className="grid size-6 shrink-0 place-items-center bg-primary/15 text-xs font-semibold text-primary">{mark}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground">{share ? `% of ${name.charAt(0).toLowerCase()}${name.slice(1)}` : name}</span>
              <span className="block truncate text-[11px] text-muted-foreground"><span className="font-semibold tracking-wide underline decoration-dotted underline-offset-2">{word}</span>{fn === "count" ? ` of ${records.toLowerCase()}` : ` of ${fieldLabel}`}{where ? ` · ${where}` : ""}{share ? " · as % of total" : ""}{compare ? " · vs previous period" : ""}</span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 rounded-none p-3">
          <div className="font-display text-base font-semibold">{name}</div>
          {where && <p className="mt-1 text-xs text-muted-foreground">Counts only {records.toLowerCase()} where {where}.</p>}
          {fn === "pctTrue" && <p className="mt-1 text-xs text-muted-foreground">The share of {records.toLowerCase()}{where ? ` where ${where}` : ""} whose {fieldLabel} is yes.</p>}
          {measured && (
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Measured as</div>
              <div className="mt-1 flex overflow-hidden border border-border" role="group" aria-label="Measured as">
                {(Object.keys(MEASURED_AS) as Array<keyof typeof MEASURED_AS>).map((f) => (
                  <button key={f} type="button" aria-pressed={fn === f} className={seg(fn === f)} onClick={() => onFn(f)}>{MEASURED_AS[f]}</button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{metricName({ fn }, fieldLabel, records)} across the records in each group.{label ? ` Changing it renames ${label}.` : ""}</p>
            </div>
          )}
          <div className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Show as</div>
            <div className="mt-1 flex overflow-hidden border border-border" role="group" aria-label="Show as">
              <button type="button" aria-pressed={!share && !compare} className={seg(!share && !compare)} onClick={() => onShow("value")}>Value</button>
              <button type="button" aria-pressed={share} className={seg(share)} onClick={() => onShow("share")}>% of total</button>
              <button type="button" aria-pressed={compare} disabled={!canCompare && !compare} title={canCompare ? undefined : "Set a date range to compare with the period before it"} className={cn(seg(compare), "disabled:opacity-40")} onClick={() => onShow("prev")}>vs previous</button>
            </div>
            {!canCompare && <p className="mt-1 text-[11px] text-muted-foreground">Set a date range to compare with the period before it.</p>}
          </div>
          {onRemove && <button type="button" className="mt-3 text-xs text-muted-foreground underline hover:text-foreground" onClick={onRemove}>Remove metric</button>}
        </PopoverContent>
      </Popover>
      {onRemove && <button type="button" aria-label={`Remove ${name}`} className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" onClick={onRemove}><X className="size-3.5" /></button>}
    </li>
  );
}
