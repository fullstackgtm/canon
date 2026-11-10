"use client";

/**
 * A date range picked like Looker Studio's: a button showing the range, opening presets beside a two-month calendar and
 * a box that takes words ("last 2 quarters", "since March", "Q3 2026"), read by modules/kernel/dateRange.ts against
 * the workspace's fiscal year. Nothing applies until Apply. Used by a module page's `dateRange`, the report builder's
 * date filter and Opportunities' close date.
 */
import { useState } from "react";
import { format, parse } from "date-fns";
import { DayPicker, type DateRange as Picked } from "react-day-picker";
import { CalendarRange, ChevronDown, X } from "lucide-react";
import { DATE_PRESETS, parseDateRange, type DateRange } from "../../../modules/kernel/dateRange";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { rangeText } from "@/lib/date-range-text";
import { cn } from "@/lib/utils";

const today = () => format(new Date(), "yyyy-MM-dd");
const toDate = (day: string | null) => (day ? parse(day, "yyyy-MM-dd", new Date()) : undefined);
const toDay = (d: Date | undefined) => (d ? format(d, "yyyy-MM-dd") : null);
type Draft = { from: string | null; to: string | null; label?: string };

/** The range as it reads; `value` is the range applied, null for none. */
export function DateRangeInput({ label, value, fiscalYearStartMonth, onChange, className }: {
  label: string; value: { from: string | null; to: string | null; label?: string } | null; fiscalYearStartMonth?: number;
  onChange: (r: DateRange | null) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(value);
  const [text, setText] = useState("");
  // The calendar's first month: where the range starts, else last month (so this month shows second).
  const monthOf = (r: Draft | null) => toDate(r?.from ?? null) ?? toDate(r?.to ?? null) ?? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const [month, setMonth] = useState<Date>(() => monthOf(value));
  /** A range picked other than on the calendar (a preset, words): the calendar turns to it. */
  const pick = (r: Draft | null) => { setDraft(r); if (r) setMonth(monthOf(r)); };
  const parsed = text.trim() ? parseDateRange(text, today(), fiscalYearStartMonth) : null;
  const show = (o: boolean) => { setOpen(o); if (o) { setDraft(value); setMonth(monthOf(value)); setText(""); } };
  const apply = () => {
    onChange(draft && (draft.from || draft.to) ? { from: draft.from, to: draft.to, label: draft.label ?? rangeText(draft) } : null);
    setOpen(false);
  };
  const preset = (p: string) => { const r = parseDateRange(p, today(), fiscalYearStartMonth); if (r) pick(r.from || r.to ? r : null); setText(""); };
  const shown = value ? value.label ?? rangeText(value) : "Any date";
  return (
    <div className={cn("flex items-center gap-1 text-xs", className)} role="group" aria-label={label}>
      <Popover open={open} onOpenChange={show}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${label}: ${shown}`} className="flex h-8 min-w-0 flex-1 items-center gap-2 border border-border bg-background px-2.5 text-left text-xs hover:border-foreground/30 data-[state=open]:border-primary">
            <CalendarRange aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">{label}: </span>{shown}
              {value?.label && value.label !== rangeText(value) && (value.from || value.to) && <span className="text-muted-foreground"> · {rangeText(value)}</span>}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={12} className="w-auto max-w-[calc(100vw-2rem)] rounded-none p-0">
          <div className="flex flex-col sm:flex-row">
            <ul className="flex shrink-0 flex-row flex-wrap gap-1 border-b border-border p-2 sm:w-40 sm:flex-col sm:flex-nowrap sm:gap-0 sm:border-r sm:border-b-0" aria-label="Presets">
              {["Any date", ...DATE_PRESETS.filter((p) => p !== "All time")].map((p) => {
                const on = p === "Any date" ? !draft : draft?.label === p;
                return (
                  <li key={p}>
                    <button type="button" aria-pressed={on} onClick={() => (p === "Any date" ? (setDraft(null), setText("")) : preset(p))}
                      className={cn("w-full px-2.5 py-1.5 text-left text-sm", on ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{p}</button>
                  </li>
                );
              })}
            </ul>
            <div className="p-3">
              <DayPicker
                mode="range"
                numberOfMonths={2}
                selected={draft ? { from: toDate(draft.from), to: toDate(draft.to) } : undefined}
                onSelect={(r: Picked | undefined) => { setText(""); setDraft(r?.from || r?.to ? { from: toDay(r.from), to: toDay(r.to) } : null); }}
                month={month}
                onMonthChange={setMonth}
                classNames={{
                  months: "flex flex-col gap-6 sm:flex-row relative",
                  month: "flex flex-col gap-3",
                  month_caption: "flex h-7 items-center justify-center text-sm font-medium",
                  nav: "absolute inset-x-0 top-0 flex items-center justify-between",
                  button_previous: "size-7 inline-flex items-center justify-center text-muted-foreground hover:text-foreground",
                  button_next: "size-7 inline-flex items-center justify-center text-muted-foreground hover:text-foreground",
                  month_grid: "border-collapse",
                  weekdays: "flex",
                  weekday: "w-8 text-[11px] font-normal text-muted-foreground",
                  week: "mt-0.5 flex",
                  day: "size-8 p-0 text-center text-sm",
                  day_button: "size-8 inline-flex items-center justify-center hover:bg-muted",
                  range_middle: "bg-primary/10 [&>button]:hover:bg-primary/20",
                  range_start: "[&>button]:bg-primary [&>button]:text-primary-foreground",
                  range_end: "[&>button]:bg-primary [&>button]:text-primary-foreground",
                  selected: "font-medium",
                  today: "[&>button]:underline [&>button]:underline-offset-4",
                  outside: "text-muted-foreground opacity-40",
                }}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <input type="text" aria-label={`${label}: in words`} placeholder="or type: last 2 quarters" value={text}
                  className={cn("h-8 w-48 border bg-background px-2 text-sm", text.trim() && !parsed ? "border-destructive" : "border-border")}
                  onChange={(e) => { setText(e.target.value); const r = e.target.value.trim() ? parseDateRange(e.target.value, today(), fiscalYearStartMonth) : null; if (r) pick(r.from || r.to ? r : null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && parsed) { e.preventDefault(); apply(); } }} />
                <span className={cn("min-w-0 flex-1 truncate text-sm", text.trim() && !parsed ? "text-destructive" : "text-muted-foreground")} data-draft>
                  {text.trim() && !parsed ? "Not a date range" : rangeText(draft)}
                </span>
                <button type="button" className="px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={!!text.trim() && !parsed} onClick={apply}>Apply</button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {value && <button type="button" aria-label={`Clear ${label}`} className="p-1 text-muted-foreground hover:text-foreground" onClick={() => onChange(null)}><X className="size-3.5" /></button>}
    </div>
  );
}
