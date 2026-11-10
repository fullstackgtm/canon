"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CHART_VARIANTS, type ChartVariant } from "@/lib/chart-variants";
import { cn } from "@/lib/utils";

const A = "fill-primary", B = "fill-primary/35", L = "stroke-primary", M = "fill-muted-foreground/25";

/** A small picture of each chart, drawn in Canon's greens. */
const THUMB: Record<string, ReactNode> = {
  table: <>{[6, 14, 22, 30].map((y, i) => <rect key={y} x="6" y={y} width="52" height="5" className={i ? M : A} />)}</>,
  number: <><rect x="8" y="9" width="22" height="4" className={M} /><rect x="8" y="17" width="34" height="14" className={A} /></>,
  column: <>{[[8, 18], [20, 10], [32, 22], [44, 14]].map(([x, y]) => <rect key={x} x={x} y={y} width="8" height={34 - y} className={A} />)}</>,
  "column-stacked": <>{[[8, 18, 26], [20, 10, 22], [32, 22, 28], [44, 14, 24]].map(([x, y, s]) => <g key={x}><rect x={x} y={y} width="8" height={s - y} className={B} /><rect x={x} y={s} width="8" height={34 - s} className={A} /></g>)}</>,
  bar: <>{[[8, 40], [16, 28], [24, 46], [32, 20]].map(([y, w]) => <rect key={y} x="8" y={y - 2} width={w} height="5" className={A} />)}</>,
  line: <polyline points="6,28 18,20 30,24 42,10 58,14" fill="none" strokeWidth="2.5" className={L} />,
  combo: <>{[[8, 18], [20, 12], [32, 22], [44, 16]].map(([x, y]) => <rect key={x} x={x} y={y} width="8" height={34 - y} className={B} />)}<polyline points="12,14 24,8 36,16 48,6" fill="none" strokeWidth="2.5" className={L} /></>,
  area: <path d="M6 34 L6 26 L18 18 L30 22 L42 10 L58 14 L58 34 Z" className={B} />,
  "area-stacked": <><path d="M6 34 L6 22 L18 14 L30 18 L42 8 L58 12 L58 34 Z" className={B} /><path d="M6 34 L6 28 L18 24 L30 27 L42 20 L58 23 L58 34 Z" className={A} /></>,
  pie: <><circle cx="32" cy="20" r="14" className={B} /><path d="M32 20 L32 6 A14 14 0 0 1 45 25 Z" className={A} /></>,
};

const Thumb = ({ id, className }: { id: string; className?: string }) => (
  <svg viewBox="0 0 64 40" aria-hidden className={cn("h-10 w-16", className)}>{THUMB[id]}</svg>
);

/**
 * The chart picker, as Looker Studio's: the chart drawn now as a button, opening every chart as a picture in its
 * section. One that can't draw the report is dimmed with the reason; the one that reads it best is marked.
 */
export function ChartPicker({ current, suggested, why, onPick }: {
  current: ChartVariant; suggested: string; why: (v: ChartVariant) => string | undefined; onPick: (v: ChartVariant) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = [...new Set(CHART_VARIANTS.map((v) => v.group))];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Chart: ${current.label}`} className="flex w-full items-center gap-3 border border-border bg-background px-2 py-1.5 text-left text-sm hover:border-foreground/30 data-[state=open]:border-primary">
          <Thumb id={current.id} className="h-8 w-12 shrink-0 border border-border bg-card" />
          <span className="flex-1">{current.label}</span>
          <ChevronDown className="size-4 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="max-h-[70vh] w-80 overflow-y-auto rounded-none p-3">
        {groups.map((g) => (
          <div key={g} className="mb-3 last:mb-0">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{g}</div>
            <div className="flex flex-wrap gap-2">
              {CHART_VARIANTS.filter((v) => v.group === g).map((v) => {
                const reason = why(v);
                const on = v.id === current.id;
                return (
                  <button key={v.id} type="button" aria-pressed={on} aria-label={v.label} disabled={!!reason && !on}
                    title={reason ? `${v.label}: ${reason}` : v.label}
                    onClick={() => { onPick(v); setOpen(false); }}
                    className={cn("relative border bg-card p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                      on ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40")}>
                    {v.id === suggested && <span className="absolute -top-2 left-1 bg-primary px-1 text-[9px] font-medium leading-4 text-primary-foreground">Suggested</span>}
                    <Thumb id={v.id} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
