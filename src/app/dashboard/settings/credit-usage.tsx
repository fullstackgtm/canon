"use client";

import { Fragment, useState } from "react";
import { useQuery } from "convex/react";
import { ChevronRight } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";

/** The report chart's first series green for spend, its axis ink for the ceiling (components/reports/report-chart.tsx). */
const USED = "#2e8259";
const AVAILABLE = "#6c6b6a";
const GRID = "#e3e3e0";

const DAY = 86_400_000;
const W = 720;
const H = 220;
const PAD = { left: 52, right: 12, top: 12, bottom: 28 };

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 10 ? 2 : 0 });
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** About four round steps from 0 past `max`. */
function ticks(max: number): number[] {
  const rough = Math.max(max, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/** This month's credits under the billing actions: available vs spent by day, then each day's line items. */
export function CreditUsage() {
  const usage = useQuery(api.credits.usage);
  const [open, setOpen] = useState<number | null>(null);
  const toggle = (at: number) => setOpen((o) => (o === at ? null : at));
  if (usage === undefined) return <LoadingRows count={1} height="h-48" />;
  if (usage === null) return null;
  if (!usage.complete) {
    return <p className="text-sm text-muted-foreground">This month has too much credit activity to chart here. Your balance above is current.</p>;
  }

  const days = usage.days;
  const last = days[days.length - 1];
  const left = last.available - last.cumulative;
  // Today's pace carried to month end: what the rest of the month likely costs.
  const projected = (last.cumulative / days.length) * usage.monthDays;
  const short = projected - last.available;
  // The day the pace crosses what's available, inside the month whenever there's a shortfall.
  const runOut = days[0].at + Math.min(usage.monthDays - 1, Math.floor(last.available / (last.cumulative / days.length || 1))) * DAY;

  const max = Math.max(...days.map((d) => d.available), projected, 1);
  const yTicks = ticks(max);
  const top = yTicks[yTicks.length - 1];
  const x = (i: number) => PAD.left + (i / Math.max(1, usage.monthDays - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const line = (vals: number[]) => vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  // Credits arrive at once, so the ceiling steps up on the day they land.
  const steps = (vals: number[]) => vals.map((v, i) => `${x(i)},${y(vals[Math.max(0, i - 1)])} ${x(i)},${y(v)}`).join(" ");
  const end = usage.monthDays - 1;
  const xLabels = [0, 7, 14, 21, end].filter((i, k, a) => i <= end && a.indexOf(i) === k);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Usage this month</h3>
        <p className="text-sm text-muted-foreground">
          {num(last.cumulative)} used of {num(last.available)} · {num(left)} left
        </p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {last.cumulative === 0
          ? "No credits spent yet this month."
          : short > 0
            ? `At this pace you run out around ${day(runOut)} and need about ${num(Math.ceil(short))} more credits by month end.`
            : `At this pace you use about ${num(Math.round(projected))} credits this month, within what you have.`}
      </p>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" role="img" aria-label={`Credits available and cumulative credits used, ${day(days[0].at)} to today. Daily values are in the table below.`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={AVAILABLE}>{num(t)}</text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === end ? "end" : "middle"} fontSize="11" fill={AVAILABLE}>{day(days[0].at + i * DAY)}</text>
        ))}
        <polyline points={steps(days.map((d) => d.available))} fill="none" stroke={AVAILABLE} strokeWidth="2" />
        <line x1={x(days.length - 1)} y1={y(last.available)} x2={x(end)} y2={y(last.available)} stroke={AVAILABLE} strokeWidth="2" strokeDasharray="2 4" />
        <polyline points={line(days.map((d) => d.cumulative))} fill="none" stroke={USED} strokeWidth="2.5" />
        {last.cumulative > 0 && days.length < usage.monthDays && (
          <line x1={x(days.length - 1)} y1={y(last.cumulative)} x2={x(end)} y2={y(projected)} stroke={USED} strokeWidth="2" strokeDasharray="4 4" opacity="0.6" />
        )}
        {days.map((d, i) => (
          <circle key={d.at} cx={x(i)} cy={y(d.cumulative)} r="6" fill="transparent">
            <title>{`${day(d.at)}: ${num(d.cumulative)} used of ${num(d.available)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: AVAILABLE }} />Available (free allowance + bought)</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: USED }} />Used so far</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 border-t-2 border-dashed" style={{ borderColor: USED }} />At this pace</span>
      </div>

      <table className="mt-5 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 font-medium">Day</th>
            <th className="py-2 text-right font-medium">Used</th>
            <th className="py-2 text-right font-medium">Added</th>
            <th className="py-2 text-right font-medium">Used to date</th>
            <th className="py-2 text-right font-medium">Available</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <Fragment key={d.at}>
              <tr
                className={`border-b border-border ${d.entries ? "cursor-pointer hover:bg-muted/50" : "text-muted-foreground"}`}
                onClick={d.entries ? () => toggle(d.at) : undefined}
                onKeyDown={d.entries ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(d.at); } } : undefined}
                tabIndex={d.entries ? 0 : undefined}
                aria-expanded={d.entries ? open === d.at : undefined}
              >
                <td className="py-2">
                  <span className="flex items-center gap-1">
                    <ChevronRight className={`size-3.5 transition-transform ${d.entries ? "" : "invisible"} ${open === d.at ? "rotate-90" : ""}`} />
                    {day(d.at)}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{d.used ? num(d.used) : "–"}</td>
                <td className="py-2 text-right tabular-nums">{d.added ? `+${num(d.added)}` : "–"}</td>
                <td className="py-2 text-right tabular-nums">{num(d.cumulative)}</td>
                <td className="py-2 text-right tabular-nums">{num(d.available)}</td>
              </tr>
              {open === d.at && (
                <tr className="border-b border-border bg-muted/30">
                  <td colSpan={5} className="px-6 py-2"><DayEntries day={d.at} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One day's ledger rows: what each credit went to. */
function DayEntries({ day: at }: { day: number }) {
  const activity = useQuery(api.credits.dayActivity, { day: at });
  if (activity === undefined) return <LoadingRows count={2} height="h-5" />;
  if (!activity) return null;
  return (
    <ul className="divide-y divide-border/60 text-xs">
      {activity.entries.map((e) => (
        <li key={e.id} className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="min-w-0 truncate">
            <span className="mr-2 tabular-nums text-muted-foreground">{time(e.at)}</span>
            {e.note ?? e.kind}
            {e.pending && <span className="ml-2 text-muted-foreground">(held, may settle for less)</span>}
          </span>
          <span className="shrink-0 tabular-nums">{e.amount > 0 ? "+" : ""}{num(e.amount)}</span>
        </li>
      ))}
      {activity.more && <li className="py-1.5 text-muted-foreground">Showing the latest {activity.entries.length}.</li>}
    </ul>
  );
}
