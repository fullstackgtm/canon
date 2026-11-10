"use client";

import { useEffect, useRef, useState } from "react";
import { targetLine, type Grain, type Period, type TargetShape } from "../../../modules/kernel/pacing";
import { AXIS, GRID, SERIES } from "./report-chart";

/** The Ledger palette report-chart.tsx validated; a series keeps its colour whatever its rank. */
export { SERIES };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Cents as people read them: $1.24M, $412k, $950. */
export function money(cents: number): string {
  const n = cents / 100;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

export type ChartSeries = { id: string; label: string; color: string; period: Period; line: (number | null)[]; target: number | null; current: boolean };

function ticksFor(max: number): number[] {
  const rough = Math.max(max, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((n) => n >= rough) ?? rough;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/** Direct labels at each line's last point, nudged apart so none overlap. */
function labelsAt(series: ChartSeries[], x: (d: number) => number, y: (v: number) => number) {
  const out = series.flatMap((s) => {
    const last = s.line.findLastIndex((v) => v !== null);
    return last < 0 ? [] : [{ id: s.id, label: s.label, x: x(last), y: y(s.line[last]!) }];
  }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) {
    if (Math.abs(out[i].x - out[i - 1].x) < 80 && out[i].y - out[i - 1].y < 13) out[i].y = out[i - 1].y + 13;
  }
  return out;
}

/**
 * Running totals by day of the period, one line per series, each target dashed: the current period's in muted ink,
 * or one per series in its colour when `perSeries` (up to four; past that the breakdown below carries them).
 */
export function PacingChart({ series, shape, curve, perSeries, grain, today }: {
  series: ChartSeries[]; shape: TargetShape; curve: (f: number) => number; perSeries: boolean; grain: Grain; today: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const h = 320;
  const pad = { l: 56, r: series.length <= 4 && w > 520 ? 96 : 16, t: 12, b: 28 };
  const days = Math.max(1, ...series.map((s) => s.period.days));
  const crowded = perSeries && series.length > 4;
  const targets = series.map((s) => (s.target !== null && (perSeries ? !crowded : s.current) ? targetLine(s.target, s.period.days, shape, curve) : null));
  const top = Math.max(100, ...series.flatMap((s) => s.line.map((v) => v ?? 0)), ...targets.flatMap((t) => t ?? [])) * 1.06;
  const ticks = ticksFor(top);
  const yMax = ticks.at(-1)!;
  const x = (d: number) => pad.l + (d / Math.max(1, days - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (h - pad.t - pad.b);
  const path = (vals: readonly (number | null)[]) => vals.map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const xTicks = grain === "month" ? [0, 7, 14, 21, 28] : grain === "quarter" ? [0, 30, 61] : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const xLabel = (d: number, i: number) => (grain === "month" ? `Day ${d + 1}` : grain === "quarter" ? `Month ${i + 1}` : MONTHS[i]);
  const lone = series.length > 1 && !perSeries;

  return (
    <figure>
      <figcaption className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Running total by day of the {grain}</span>
        {series.map((s) => <span key={s.id} className="inline-flex items-center gap-1.5"><span className="w-4" style={{ background: s.color, height: s.current && lone ? 3 : 2 }} />{s.label}</span>)}
        {targets.some(Boolean) && <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed" style={{ borderColor: AXIS }} />{perSeries ? "Targets" : "Target"}</span>}
        {crowded && <span>Each target is in the table below.</span>}
      </figcaption>
      <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
        <svg width={w} height={h} role="img" aria-label={`Running total by day of the ${grain}`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const d = Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (days - 1));
            setHover(d >= 0 && d < days ? d : null);
          }}>
          {ticks.map((t) => <g key={t}><line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{money(t)}</text></g>)}
          {xTicks.filter((d) => d < days).map((d, i) => <text key={d} x={x(d)} y={h - 8} fontSize={11} fill={AXIS}>{xLabel(d, i)}</text>)}
          {today >= 0 && today < days - 1 && <g><line x1={x(today)} x2={x(today)} y1={pad.t} y2={h - pad.b} stroke={AXIS} strokeDasharray="2 3" /><text x={x(today) + 4} y={pad.t + 10} fontSize={11} fill={AXIS}>Today</text></g>}
          {targets.map((t, i) => t && <path key={`t${series[i].id}`} d={path(t)} fill="none" stroke={perSeries && series.length > 1 ? series[i].color : AXIS} strokeOpacity={perSeries && series.length > 1 ? 0.7 : 1} strokeWidth={1.5} strokeDasharray="5 4" />)}
          {[...series].reverse().map((s) => <path key={s.id} d={path(s.line)} fill="none" stroke={s.color} strokeWidth={s.current && lone ? 2.5 : 2} strokeOpacity={s.current || perSeries ? 1 : 0.75} strokeLinejoin="round" />)}
          {series.length <= 4 && w > 520 && labelsAt(series, x, y).map((l) => <text key={`l${l.id}`} x={l.x + 6} y={l.y + 4} fontSize={11} fill="currentColor" className="text-foreground">{l.label}</text>)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} stroke={AXIS} />}
          {hover !== null && series.map((s) => s.line[hover] != null && <circle key={`c${s.id}`} cx={x(hover)} cy={y(s.line[hover]!)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />)}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute top-2 z-10 min-w-52 border border-border bg-popover p-2 text-xs shadow-lg" style={{ left: Math.max(0, Math.min(x(hover) + 12, w - 240)) }}>
            <div className="mb-1 text-muted-foreground">Day {hover + 1} of the {grain}</div>
            {series.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 py-0.5">
                <span className="h-2 w-2 shrink-0" style={{ background: s.color }} />
                <span className="flex-1 truncate text-foreground">{s.label}</span>
                <span className="tabular-nums text-foreground">{s.line[hover] == null ? "-" : money(s.line[hover]!)}</span>
                {targets[i] && <span className="w-16 text-right tabular-nums text-muted-foreground">/ {money(targets[i]![Math.min(hover, targets[i]!.length - 1)])}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
