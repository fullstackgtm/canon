"use client";

import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useAction } from "convex/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { LIST_LIMIT_MAX, type ListRow, type ProjectedThrough, type Scalar } from "../../../convex/lib/objects/listSpec";
import { projectedPast } from "../../../convex/lib/objects/views";
import { addDays, addMonths, CALENDAR_MONTH_MAX, dayCell, daysFilter, monthBounds, monthWeeks, movedTo, placeByDay, type CalendarKind } from "../../../convex/lib/objects/calendar";
import { localTime } from "../../../convex/lib/timeZone";
import { LoadingRows, ReadFailure } from "@/components/dashboard";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, getErrorMessage } from "@/lib/utils";
import type { FieldDescription } from "./fields";
import { RecordLink } from "./record-context";
import { useObjectList, type ListedObject, type Save } from "./use-object-list";

const ROW_TYPE = "application/x-canon-row";
const CATCH_UP_MS = 4000;
const CATCH_UP_POLL_MS = 150;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type MonthQuery = { object: ListedObject; filter: ViewFilter[]; sort: { field: string; dir: "asc" } };

/** A month's records: the view's filters plus the month's range, read in pages of 200 up to CALENDAR_MONTH_MAX, again after each batch of saves. */
function useMonth(query: MonthQuery, saves: { n: number; saves: Save[] }) {
  const list = useAction(api.objects.list);
  const [state, setState] = useState<{ key: string; rows: ListRow[] | null; total: number; error: string }>({ key: "", rows: null, total: 0, error: "" });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query);
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    const q = JSON.parse(key) as MonthQuery;
    void (async () => {
      const started = Date.now();
      try {
        let first = await list({ ...q, limit: LIST_LIMIT_MAX });
        while (!projectedPast(first.projectedThrough as ProjectedThrough, saves.saves) && Date.now() - started < CATCH_UP_MS) {
          await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS));
          if (mine !== generation.current) return;
          first = await list({ ...q, limit: LIST_LIMIT_MAX });
        }
        const rows = [...first.rows];
        for (let cursor = first.nextCursor; cursor && rows.length < CALENDAR_MONTH_MAX; ) {
          const page = await list({ ...q, limit: LIST_LIMIT_MAX, cursor });
          if (mine !== generation.current) return;
          rows.push(...page.rows);
          cursor = page.nextCursor;
        }
        if (mine === generation.current) setState({ key, rows: rows.slice(0, CALENDAR_MONTH_MAX), total: first.total, error: "" });
      } catch (cause) {
        if (mine === generation.current) setState((cur) => ({ ...cur, key, error: getErrorMessage(cause) }));
      }
    })();
  }, [key, saves, tick, list]);
  const current = state.key === key;
  return { rows: current ? state.rows : null, total: current ? state.total : 0, error: current ? state.error : "", reload: () => setTick((n) => n + 1) };
}

/** One day's records in full, paged, for a day whose cell shows "N more". */
function DayList({ object, filter, field, kind, day, zone, onClose }: { object: ListedObject; filter: ViewFilter[]; field: string; kind: CalendarKind; day: string; zone: string; onClose: () => void }) {
  const { rows, total, hasMore, loadMore, loadingMore, error } = useObjectList({ object, filter: [...filter, ...daysFilter(field, kind, day, addDays(day, 1), zone)], sort: { field, dir: "asc" } });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dayLabel(day)}</DialogTitle>
          <DialogDescription>{rows === null ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "record" : "records"}`}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <ul className="flex flex-col divide-y divide-border border border-border">
          {rows?.map((row) => (
            <li key={row.id} className="px-3 py-2 text-sm"><RecordLink object={object} id={row.id} className="record-name hover:underline">{row.title || "Untitled"}</RecordLink></li>
          ))}
        </ul>
        {hasMore && <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="text-left text-xs text-primary hover:underline disabled:opacity-50">{loadingMore ? "Loading…" : `Show more (${rows?.length ?? 0} of ${total})`}</button>}
      </DialogContent>
    </Dialog>
  );
}

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * A month of records on a date or date-time field (lib/objects/calendar.ts): a grid of whole weeks, Monday first,
 * three records a day and "N more" for the rest, and an agenda of the month's days on a phone. The month's records
 * come from the list with the month's range added to the view's filters, through the caller's scoped client.
 * Dragging a record to another day sets the field through the record page's own edit.
 */
export function CalendarView({
  object, field, kind, filter, zone, month, onMonth, writable, onMove, saves,
}: {
  object: ListedObject;
  field: FieldDescription;
  kind: CalendarKind;
  filter: ViewFilter[];
  /** The workspace's time zone (calendar.ts calendarZone). */
  zone: string;
  /** `YYYY-MM`. */
  month: string;
  onMonth: (month: string) => void;
  writable: boolean;
  onMove: (row: ListRow, value: Scalar) => Promise<void>;
  saves: { n: number; saves: Save[] };
}) {
  const { from, to } = monthBounds(month);
  const { rows, total, error, reload } = useMonth({ object, filter: [...filter, ...daysFilter(field.apiName, kind, from, to, zone)], sort: { field: field.apiName, dir: "asc" } }, saves);
  const byDay = rows ? placeByDay(rows, field.fieldId, kind, zone) : new Map<string, ListRow[]>();
  const [open, setOpen] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Read once per mount: a render reads no clock.
  const [now] = useState(() => Date.now());
  const today = localTime(now, zone).date;
  const weeks = monthWeeks(month);

  const drop = (day: string, raw: string) => {
    const row = JSON.parse(raw) as ListRow;
    const value = row.values[field.fieldId];
    if (kind === "day" ? value === day : typeof value === "number" && localTime(value, zone).date === day) return;
    void onMove(row, movedTo(kind, value, day, zone));
  };
  const dayProps = (day: string) => writable ? {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(ROW_TYPE)) { e.preventDefault(); setOver(day); } },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(null); const raw = e.dataTransfer.getData(ROW_TYPE); if (raw) drop(day, raw); },
  } : {};
  const card = (row: ListRow) => (
    <RecordLink
      key={row.id}
      object={object}
      id={row.id}
      draggable={writable}
      onDragStart={(e) => { e.dataTransfer.setData(ROW_TYPE, JSON.stringify(row)); e.dataTransfer.effectAllowed = "move"; }}
      className="block truncate border border-border bg-card px-1.5 py-0.5 text-xs hover:border-primary/50 hover:underline"
    >
      {row.title || "Untitled"}
    </RecordLink>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))} className="inline-flex h-7 w-7 items-center justify-center border border-border hover:bg-muted"><ChevronLeft className="h-3.5 w-3.5" /></button>
        <h2 className="min-w-36 text-center text-sm font-medium">{monthLabel(month)}</h2>
        <button type="button" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))} className="inline-flex h-7 w-7 items-center justify-center border border-border hover:bg-muted"><ChevronRight className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => onMonth(today.slice(0, 7))} className="inline-flex h-7 items-center border border-border px-2 text-xs font-medium hover:bg-muted">Today</button>
        <span className="text-xs text-muted-foreground">
          {rows === null ? "" : `${total.toLocaleString()} by ${field.label.toLowerCase()}`}
          {kind === "instant" ? ` · times in ${zone.replace(/_/g, " ")}` : ""}
        </span>
      </div>
      {rows !== null && total > rows.length && (
        <p className="mb-2 text-xs text-muted-foreground">Showing the first {rows.length.toLocaleString()} of {total.toLocaleString()} this month; filter to see the rest.</p>
      )}
      {error ? <ReadFailure message={error} retry={reload} retained={false} /> : rows === null ? <LoadingRows /> : (
        <>
          <div className="hidden border-l border-t border-border sm:block">
            <div className="grid grid-cols-7 bg-muted/50 text-xs font-medium text-muted-foreground">
              {WEEKDAYS.map((d) => <div key={d} className="border-b border-r border-border px-2 py-1">{d}</div>)}
            </div>
            {weeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7">
                {week.map((day) => {
                  const { shown, more } = dayCell(byDay.get(day));
                  const inMonth = day >= from && day < to;
                  return (
                    <div
                      key={day}
                      aria-label={dayLabel(day)}
                      {...dayProps(day)}
                      className={cn("flex min-h-24 min-w-0 flex-col gap-1 border-b border-r border-border p-1", !inMonth && "bg-muted/30 text-muted-foreground", over === day && "bg-primary/5 outline outline-1 outline-primary")}
                    >
                      <span className={cn("self-start px-1 text-xs tabular-nums", day === today && "bg-primary font-medium text-primary-foreground")}>{Number(day.slice(8))}</span>
                      {shown.map(card)}
                      {more > 0 && <button type="button" onClick={() => setOpen(day)} className="self-start px-1 text-xs text-primary hover:underline">{more} more</button>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <ol className="flex flex-col gap-3 sm:hidden" aria-label="Agenda">
            {[...byDay.keys()].filter((d) => d >= from && d < to).sort().map((day) => (
              <li key={day}>
                <p className={cn("mb-1 text-xs font-medium text-muted-foreground", day === today && "text-primary")}>{dayLabel(day)}</p>
                <div className="flex flex-col gap-1">{byDay.get(day)!.map(card)}</div>
              </li>
            ))}
            {byDay.size === 0 && <li className="text-sm text-muted-foreground">Nothing this month.</li>}
          </ol>
        </>
      )}
      {open && <DayList object={object} filter={filter} field={field.apiName} kind={kind} day={open} zone={zone} onClose={() => setOpen(null)} />}
    </div>
  );
}
