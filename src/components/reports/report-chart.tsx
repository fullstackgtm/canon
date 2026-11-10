"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReportChart as ChartKind } from "../../../modules/kernel/reportLanguage";
import type { Presented } from "./present";
import { PALETTES, type PaletteName } from "@/lib/chart-style";
import type { Waterfall, WaterfallBar } from "@/lib/waterfall";

/**
 * The Ledger categorical palette, in its validated order (dataviz skill
 * validator, light mode against the card surface #fafaf8: every slot inside the
 * lightness band and chroma floor, every adjacent pair clears CVD dE 9.0 and
 * normal-vision dE 15.4, all >= 3:1). Slot 1 is the brand's bottle green,
 * lifted to chart lightness. "Other" takes the muted ink, never a ninth hue.
 */
export const SERIES = ["#2e8259", "#3d6fa8", "#c25a2a", "#1d9b9b", "#b08300", "#6a58d8", "#b8506a", "#7f8b1f"];
const OTHER = "#8a8886";
const SURFACE = "#fafaf8";
export const GRID = "#e3e3e0";
export const AXIS = "#6c6b6a";
/** Ink for values read off the chart (a bar's total), stronger than the axis. */
const INK = "#1c1a1a";
/** Series a stacked bar, line or pie shows before folding the rest into Other. */
const SERIES_MAX = 6;

/** `key`: the second key's value a split series stands for (absent for a single series and for Other). */
/** `tints`: a color per value overriding `color` (a won stage green, a lost one gray; see `tone`). */
type Series = { label: string; color: string; values: (number | null)[]; key?: unknown; measure?: number; axis?: "left" | "right"; type?: "bar" | "line" | "area"; tints?: (string | undefined)[] };
/** How a column, line or area chart draws its values (a report spec's `display`). */
export type ChartDisplay = {
  stacked?: boolean; axes?: readonly ("left" | "right")[]; types?: readonly ("bar" | "line")[];
  palette?: PaletteName; labels?: boolean; legend?: "top" | "bottom" | "none"; grid?: boolean;
};
/** How a chart looks (its display's style): its hues, data labels, the legend's place and gridlines. */
/** `height`: a column, line or area chart's plot height in px (260 by default). */
/**
 * `maxBar`: the widest a column draws, in px, so a few months' bars read as data, not blocks. `tight`: the value axis
 * ends at the first nice tick above the data (see `tightTicks`).
 */
type Look = { colors: readonly string[]; labels?: boolean; legend: "top" | "bottom" | "none"; grid: boolean; tone?: Tone; height?: number; maxBar?: number; tight?: boolean };
const LookCtx = createContext<Look>({ colors: SERIES, legend: "top", grid: true });
/**
 * What a category stands for, when it is good or bad news: a won stage, a lost one. A chart of one series colors a
 * won category the brand green, a lost one the muted gray and an open one blue, whatever the palette, as Won beside
 * Lost always reads; a category with no known outcome keeps its color.
 */
export type Tone = (key: unknown) => "won" | "lost" | "open" | undefined;
const WON = "#2e8259";
/** Still open: the Ledger's blue, so green only ever means won. */
const OPEN = "#3d6fa8";
const toned = (shape: Shape, tone: Tone | undefined): Shape =>
  !tone || shape.series.length !== 1 ? shape : { ...shape, series: [{ ...shape.series[0], tints: shape.keys.map((k) => { const t = tone(k); return t === "won" ? WON : t === "lost" ? OTHER : t === "open" ? OPEN : undefined; }) }] };
/**
 * A split's own colors and order, when its values have a meaning the palette's by-size order would lose (a deal's
 * stages in pipeline order). A series it returns nothing for keeps its color and sits after the styled ones.
 */
export type SeriesStyle = (key: unknown) => { color: string; order: number } | undefined;
const styled = (shape: Shape, style: SeriesStyle | undefined): Shape => {
  if (!style) return shape;
  const at = (x: Series) => (x.key === undefined ? undefined : style(x.key));
  const series = shape.series.map((x) => ({ ...x, color: at(x)?.color ?? x.color }));
  const order = (x: Series) => at(x)?.order ?? Number.MAX_SAFE_INTEGER;
  return { ...shape, series: series.sort((a, b) => order(a) - order(b)) };
};
/** `keys`: each category's first key as the report holds it, for a click that opens what a bar stands for. */
type Shape = { categories: string[]; keys: unknown[]; series: Series[] };
/**
 * A click on a mark: the first key of its category and the series it is part of. `seriesKey` is the second key's value
 * when the mark is one series of a split, so a click can stand for both keys.
 */
export type ChartPick = (at: { x: unknown; series: string; seriesKey?: unknown }) => void;

/**
 * The chart's data: the first measure per first key, split by the second key's largest values when there is one.
 * An average, min or max does not add up, so a stacked bar draws the service's per-first-key value instead, and
 * nothing folds into Other.
 */
function shapeOf(p: Presented, fold: number, stacked: boolean, colors: readonly string[] = SERIES): Shape {
  if (p.keyLabels.length < 2) {
    return { categories: p.groups.map((g) => g.labels[0]), keys: p.groups.map((g) => g.keys[0]), series: [{ label: p.measureLabels[0], color: colors[0], values: p.groups.map((g) => g.values[0]) }] };
  }
  if (stacked && !p.additive) {
    return { categories: p.subtotals.map((s) => s.labels[0]), keys: p.subtotals.map((s) => s.keys[0]), series: [{ label: p.measureLabels[0], color: colors[0], values: p.subtotals.map((s) => s.values[0]) }] };
  }
  const firsts = p.subtotals.map((s) => JSON.stringify(s.keys[0]));
  const totals = new Map<string, { label: string; sum: number }>();
  for (const g of p.groups) {
    const k = JSON.stringify(g.keys[1]);
    const t = totals.get(k) ?? { label: g.labels[1], sum: 0 };
    totals.set(k, { label: t.label, sum: t.sum + Math.abs(g.values[0] ?? 0) });
  }
  // A yes/no split keeps its colors whatever the sizes: yes takes the first hue, no the muted ink (Won beside Lost).
  // Any other split is colored by size, so its largest values take the first hues.
  const yesNo = [...totals.keys()].every((k) => k === "true" || k === "false");
  const ranked = yesNo ? [...totals.entries()].sort((a, b) => (a[0] === "true" ? 0 : 1) - (b[0] === "true" ? 0 : 1)) : [...totals.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const kept = ranked.slice(0, ranked.length > fold ? fold - 1 : fold);
  const keptKeys = new Set(kept.map(([k]) => k));
  const colorOf = (k: string, i: number) => (yesNo ? (k === "true" ? colors[0] : OTHER) : colors[i]);
  const series: Series[] = kept.map(([k, t], i) => ({ label: t.label, color: colorOf(k, i), key: JSON.parse(k) as unknown, values: firsts.map((f) => p.groups.find((g) => JSON.stringify(g.keys[0]) === f && JSON.stringify(g.keys[1]) === k)?.values[0] ?? null) }));
  if (ranked.length > kept.length && p.additive) {
    series.push({
      label: "Other", color: OTHER,
      values: firsts.map((f) => p.groups.filter((g) => JSON.stringify(g.keys[0]) === f && !keptKeys.has(JSON.stringify(g.keys[1]))).reduce((s, g) => s + (g.values[0] ?? 0), 0)),
    });
  }
  return { categories: p.subtotals.map((s) => s.labels[0]), keys: p.subtotals.map((s) => s.keys[0]), series };
}

/** The series a stacked bar chart of `p` draws, after folding the smallest into Other, for a legend drawn outside it. */
export function stackedSeries(p: Presented): { label: string; other: boolean; color: string }[] {
  return shapeOf(p, SERIES_MAX, true).series.map((s) => ({ label: s.label, other: s.key === undefined && s.label === "Other", color: s.color }));
}

/** Axis ticks from 0 past `max`, about four steps of 1, 2 or 5 times a power of ten; whole steps for whole-number data. */
function ticksFor(max: number, whole: boolean): number[] {
  const rough = Math.max(max, whole ? 1 : Number.MIN_VALUE) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 5, 10].map((m) => m * pow).find((n) => n >= rough) ?? rough;
  if (whole) step = Math.max(1, Math.round(step));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}
const niceMax = (v: number) => ticksFor(v, false).at(-1)!;
/**
 * Ticks that end at the first nice value above `max` (a $422K top reads to $500K, not $600K): steps of 1, 2, 2.5 or 5
 * times a power of ten, three to six of them, keeping a little headroom so a value label above the tallest bar stays
 * clear of the top edge.
 */
function tightTicks(max: number, whole: boolean): number[] {
  if (max <= 0) return ticksFor(max, whole);
  const pow = 10 ** Math.floor(Math.log10(max));
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5].map((m) => m * pow).filter((s) => !whole || Number.isInteger(s));
  const fit = steps.map((step) => ({ step, n: Math.ceil((max * 1.08) / step) })).filter((c) => c.n >= 3 && c.n <= 6);
  if (!fit.length) return ticksFor(max, whole);
  const { step, n } = fit.reduce((a, b) => (b.step * b.n < a.step * a.n ? b : a));
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}

/** The rendered width of a chart's box, so an SVG draws in real pixels and its text stays 11px in a narrow tile. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

type Tip = { x: number; y: number; title: string; rows: { color: string; label: string; value: string }[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div role="status" className="pointer-events-none absolute z-10 min-w-36 border border-border bg-popover px-2.5 py-2 text-xs shadow-lg" style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }}>
      <div className="mb-1 text-muted-foreground">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3" style={{ background: r.color }} />
          <span className="font-semibold text-foreground">{r.value}</span>
          <span className="text-muted-foreground">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A legend for two or more series, or for any split by a second key (one series still names which value it is). */
function Legend({ series, shape, split }: { series: Series[]; shape: "rect" | "line"; split: boolean }) {
  const { legend } = useContext(LookCtx);
  if ((series.length < 2 && !split) || legend === "none") return null;
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground ${legend === "bottom" ? "order-last mt-3" : "mb-3"}`} data-legend={legend}>
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          <span className={shape === "rect" ? "inline-block h-2.5 w-2.5 rounded-[2px]" : "inline-block h-0.5 w-3"} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const at = (e: { clientX: number; clientY: number }, t: NonNullable<Tip>["rows"], title: string) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, title, rows: t });
  };
  return { box, tip, at, clear: () => setTip(null) };
}

/** Horizontal bars: one row per first key, stacked by the second; long labels stay readable on a phone. */
function Bars({ p, shape, onPick }: { p: Presented; shape: Shape; onPick?: ChartPick }) {
  const { box, tip, at, clear } = useTip();
  const totals = shape.categories.map((_, i) => shape.series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const { labels } = useContext(LookCtx);
  return (
    <div ref={box} className="relative flex flex-col" onPointerLeave={clear}>
      <Legend series={shape.series} shape="rect" split={p.keyLabels.length > 1 && p.additive} />
      <div className="space-y-1.5">
        {shape.categories.map((c, i) => {
          let offset = 0;
          return (
            <div key={`${c}-${i}`} className="grid grid-cols-[minmax(5rem,35%)_1fr] items-center gap-3 text-xs">
              <div className="truncate text-right text-muted-foreground" title={c}>{c}</div>
              <div className="flex items-center gap-2">
                <div className="relative flex h-5 min-w-0 flex-1 items-center">
                  {shape.series.map((s, j) => {
                    const v = Math.max(0, s.values[i] ?? 0);
                    const w = (v / max) * 100;
                    const left = offset;
                    offset += w;
                    if (v === 0) return null;
                    const last = shape.series.slice(j + 1).every((x) => !(x.values[i] ?? 0));
                    return (
                      <button
                        key={s.label}
                        type="button"
                        aria-label={`${c}, ${s.label}: ${p.format(0, s.values[i])}`}
                        className={`absolute h-full outline-none hover:brightness-125 focus-visible:brightness-125${onPick && pickable(s) ? " cursor-pointer" : ""}`}
                        onClick={onPick && pickable(s) ? () => onPick({ x: shape.keys[i], series: s.label, seriesKey: s.key }) : undefined}
                        style={{ left: `${left}%`, width: `calc(${w}% - ${last ? 0 : 2}px)`, background: s.tints?.[i] ?? s.color, borderRadius: last ? "0 4px 4px 0" : 0 }}
                        onPointerMove={(e) => at(e, shape.series.filter((x) => x.values[i] !== null).map((x) => ({ color: x.color, label: x.label, value: p.format(0, x.values[i]) })), c)}
                        onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); at({ clientX: r.left + r.width / 2, clientY: r.top }, [{ color: s.color, label: s.label, value: p.format(0, s.values[i]) }], c); }}
                        onBlur={clear}
                      />
                    );
                  })}
                </div>
                {labels !== false && <span className="w-16 shrink-0 text-foreground">{p.formatCompact(0, totals[i])}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

const H = 240;
const PAD = { l: 52, r: 16, t: 12, b: 28 };

/** One line per series over the first key's buckets, with a crosshair that snaps to the nearest one. */
function Lines({ p, shape, onPick }: { p: Presented; shape: Shape; onPick?: ChartPick }) {
  const { box, tip, at, clear } = useTip();
  const { ref, width: W } = useWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const { labels, grid } = useContext(LookCtx);
  const n = shape.categories.length;
  const ticks = ticksFor(Math.max(0, ...shape.series.flatMap((s) => s.values.map((v) => v ?? 0))), p.whole);
  const max = ticks.at(-1)!;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
  // The bucket under the pointer, read from the event itself, so a tap with no hover first still lands on one.
  const indexAt = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : ((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1))));
  };
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const i = indexAt(e);
    setHover(i);
    at(e, shape.series.map((s) => ({ color: s.color, label: s.label, value: p.format(0, s.values[i]) })), shape.categories[i]);
  };
  return (
    <div ref={box} className="relative flex flex-col">
      <Legend series={shape.series} shape="line" split={p.keyLabels.length > 1} />
      <div ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={`${p.measureLabels[0]} by ${p.keyLabels[0]}`}>
        {ticks.map((t) => (
          <g key={t}>
            {(grid || t === 0) && <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />}
            <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS}>{p.formatCompact(0, t)}</text>
          </g>
        ))}
        {shape.categories.map((c, i) => (i % every === 0 || i === n - 1 ? <text key={i} x={x(i)} y={H - 8} textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"} fontSize={11} fill={AXIS}>{c.replace(/^Week of /, "")}</text> : null))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke={AXIS} strokeWidth={1} />}
        {shape.series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
          return (
            <g key={s.label}>
              <polyline points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => (v === null || (hover !== i && i !== n - 1) ? null : <circle key={i} cx={x(i)} cy={y(v)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />))}
              {labels && s.values.map((v, i) => (v === null || (i % every !== 0 && i !== n - 1) ? null : <text key={`l${i}`} x={x(i)} y={y(v) - 8} textAnchor="middle" fontSize={10} fill={AXIS} data-label>{p.formatCompact(0, v)}</text>))}
            </g>
          );
        })}
        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" className={onPick ? "cursor-pointer" : undefined} onPointerMove={move} onPointerLeave={() => { setHover(null); clear(); }}
          onClick={onPick ? (e) => onPick({ x: shape.keys[indexAt(e)], series: "" }) : undefined} />
      </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** A donut of the first key's share, folded to SERIES_MAX slices; values and shares sit in the legend. */
function Pie({ p, onPick }: { p: Presented; onPick?: ChartPick }) {
  const { box, tip, at, clear } = useTip();
  const { colors, tone } = useContext(LookCtx);
  const rows = p.keyLabels.length > 1 ? p.subtotals : p.groups;
  const positive = rows.map((g) => ({ label: g.labels[0], key: g.keys[0] as unknown, v: Math.max(0, g.values[0] ?? 0) })).filter((r) => r.v > 0);
  const sorted = [...positive].sort((a, b) => b.v - a.v);
  const kept = sorted.slice(0, sorted.length > SERIES_MAX ? SERIES_MAX - 1 : SERIES_MAX).map((r, i) => ({ ...r, color: tone?.(r.key) === "won" ? WON : tone?.(r.key) === "lost" ? OTHER : tone?.(r.key) === "open" ? colors[(i % (colors.length - 1)) + 1] : colors[i] }));
  const rest = sorted.slice(kept.length).reduce((s, r) => s + r.v, 0);
  const slices: { label: string; key?: unknown; v: number; color: string }[] = rest > 0 ? [...kept, { label: "Other", v: rest, color: OTHER }] : kept;
  const sum = slices.reduce((s, r) => s + r.v, 0);
  if (!sum) return <p className="text-sm text-muted-foreground">Nothing to chart: every group is zero or empty.</p>;
  const starts = slices.reduce<number[]>((acc, s) => [...acc, acc[acc.length - 1] + (s.v / sum) * Math.PI * 2], [-Math.PI / 2]);
  const R = 80;
  const r0 = 50;
  const arc = (a0: number, a1: number) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (r: number, a: number) => `${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)}`;
    return `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
  };
  return (
    <div ref={box} className="relative flex flex-wrap items-start gap-4">
      <svg viewBox="0 0 200 200" className="h-40 w-40 shrink-0" role="img" aria-label={`${p.measureLabels[0]} by ${p.keyLabels[0]}`} onPointerLeave={clear}>
        {slices.map((s, i) => {
          const a0 = starts[i];
          const a1 = starts[i + 1];
          const d = slices.length === 1 ? `M 100 ${100 - R} A ${R} ${R} 0 1 1 99.99 ${100 - R} L 99.99 ${100 - r0} A ${r0} ${r0} 0 1 0 100 ${100 - r0} Z` : arc(a0, a1);
          const pick = onPick && "key" in s ? () => onPick({ x: s.key, series: s.label }) : undefined;
          return <path key={s.label} d={d} fill={s.color} stroke={SURFACE} strokeWidth={2} className={pick ? "cursor-pointer hover:brightness-125" : "hover:brightness-125"} onClick={pick} onPointerMove={(e) => at(e, [{ color: s.color, label: `${Math.round((s.v / sum) * 100)}%`, value: p.format(0, s.v) }], s.label)} />;
        })}
      </svg>
      <ul className="min-w-40 flex-1 space-y-1 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="text-foreground">{p.format(0, s.v)}</span>
            <span className="w-10 text-right text-muted-foreground">{Math.round((s.v / sum) * 100)}%</span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}

/**
 * The series a column, line or area chart draws: with one key and several values, one series per value (each on its
 * axis, a column chart's value as bars or a line); else the first value split by the second key, as `shapeOf`.
 */
function cartesianShape(p: Presented, kind: "column" | "line" | "area", display: ChartDisplay | undefined, colors: readonly string[] = SERIES): Shape {
  const own = kind === "area" ? "area" : kind === "line" ? "line" : "bar";
  if (p.keyLabels.length < 2 && p.measureLabels.length > 1) {
    return {
      categories: p.groups.map((g) => g.labels[0]), keys: p.groups.map((g) => g.keys[0]),
      series: p.measureLabels.map((label, i) => ({
        label, color: colors[i % colors.length], values: p.groups.map((g) => g.values[i]), measure: i, axis: display?.axes?.[i] ?? "left",
        type: kind === "column" ? (display?.types?.[i] === "line" ? "line" : "bar") : own,
      })),
    };
  }
  const base = shapeOf(p, SERIES_MAX, display?.stacked === true, colors);
  return { ...base, series: base.series.map((x) => ({ ...x, measure: 0, axis: "left" as const, type: own })) };
}

const CHART_H = 260;
const CPAD = { l: 56, r: 16, t: 12, b: 32 };
/**
 * Vertical columns (side by side, or stacked), lines and areas over the first key, on a left axis and, for values put
 * there, a second axis on the right: money beside a percent, a count beside a sum.
 */
function Cartesian({ p, shape, stacked, onPick }: { p: Presented; shape: Shape; stacked: boolean; onPick?: ChartPick }) {
  const { box, tip, at, clear } = useTip();
  const { labels, grid, height, maxBar, tight } = useContext(LookCtx);
  const CH = height ?? CHART_H;
  const { ref, width: W0 } = useWidth(640);
  const right = shape.series.some((x) => x.axis === "right");
  const W = W0, PADR = right ? 56 : CPAD.r;
  const n = shape.categories.length;
  const band = (W - CPAD.l - PADR) / Math.max(1, n);
  const cx = (i: number) => CPAD.l + band * (i + 0.5);
  const side = (axis: "left" | "right") => shape.series.filter((x) => (x.axis ?? "left") === axis);
  // An axis's top: the tallest column stack (or column), line or area stack on it.
  const topOf = (axis: "left" | "right") => {
    const on = side(axis);
    const stackable = on.filter((x) => (x.type === "bar" || x.type === "area") && stacked);
    const stacks = shape.categories.map((_, i) => stackable.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
    return Math.max(0, ...stacks, ...on.flatMap((x) => x.values.map((v) => v ?? 0)));
  };
  const axisTicks = tight ? tightTicks : ticksFor;
  const leftTicks = axisTicks(topOf("left"), p.whole), rightTicks = right ? axisTicks(topOf("right"), false) : [];
  const yOf = (axis: "left" | "right") => { const max = (axis === "left" ? leftTicks : rightTicks).at(-1) || 1; return (v: number) => CPAD.t + (1 - v / max) * (CH - CPAD.t - CPAD.b); };
  const fmtAxis = (axis: "left" | "right", v: number) => { const s0 = side(axis)[0]; return p.formatCompact(s0?.measure ?? 0, v); };
  const bars = shape.series.filter((x) => x.type === "bar");
  const barW = Math.min(maxBar ?? Infinity, stacked || bars.length < 2 ? band * 0.6 : (band * 0.8) / bars.length);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 80))));
  const rowsAt = (i: number) => shape.series.filter((x) => x.values[i] !== null).map((x) => ({ color: x.color, label: x.label, value: p.format(x.measure ?? 0, x.values[i]) }));
  // Stacked areas and columns: each series sits on the ones before it, per axis.
  const base = new Map<string, number[]>();
  const offsetOf = (x: Series, i: number) => {
    if (!stacked || x.type === "line") return 0;
    const k = `${x.axis}:${x.type}`;
    const acc = base.get(k) ?? shape.categories.map(() => 0);
    const at0 = acc[i];
    return at0;
  };
  const push = (x: Series) => {
    if (!stacked || x.type === "line") return;
    const k = `${x.axis}:${x.type}`;
    const acc = base.get(k) ?? shape.categories.map(() => 0);
    base.set(k, acc.map((a, i) => a + Math.max(0, x.values[i] ?? 0)));
  };
  let barIndex = 0;
  return (
    <div ref={box} className="relative flex flex-col">
      <Legend series={shape.series} shape="rect" split={p.keyLabels.length > 1 || shape.series.length > 1} />
      <div ref={ref}>
        <svg viewBox={`0 0 ${W} ${CH}`} width={W} height={CH} className="block max-w-full" role="img" aria-label={`${shape.series.map((x) => x.label).join(", ")} by ${p.keyLabels[0]}`} onPointerLeave={clear}>
          {leftTicks.map((t) => (
            <g key={`l${t}`}>
              {(grid || t === 0) && <line x1={CPAD.l} x2={W - PADR} y1={yOf("left")(t)} y2={yOf("left")(t)} stroke={GRID} strokeWidth={1} />}
              <text x={CPAD.l - 8} y={yOf("left")(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS}>{fmtAxis("left", t)}</text>
            </g>
          ))}
          {rightTicks.map((t) => <text key={`r${t}`} x={W - PADR + 8} y={yOf("right")(t)} dy="0.32em" textAnchor="start" fontSize={11} fill={AXIS} data-axis="right">{fmtAxis("right", t)}</text>)}
          {shape.categories.map((c, i) => (i % every === 0 ? <text key={i} x={cx(i)} y={CH - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{c.replace(/^Week of /, "")}</text> : null))}
          {shape.series.map((x) => {
            const y = yOf(x.axis ?? "left");
            if (x.type === "bar") {
              const j = barIndex++;
              const out = x.values.map((v, i) => {
                if (v === null || v <= 0) return null;
                const off = offsetOf(x, i);
                const left = stacked || bars.length < 2 ? cx(i) - barW / 2 : cx(i) - (barW * bars.length) / 2 + j * barW;
                const top = y(off + v), h = y(off) - top;
                const label = labels && !stacked && i % every === 0 ? <text x={left + barW / 2} y={top - 4} textAnchor="middle" fontSize={11} fontWeight={500} fill={INK} data-label>{p.formatCompact(x.measure ?? 0, v)}</text> : null;
                return <g key={i}>{label}<rect x={left} y={top} width={Math.max(1, barW - (stacked ? 0 : 2))} height={Math.max(0, h)} style={{ fill: x.tints?.[i] ?? x.color }} className={onPick && pickable(x) ? "cursor-pointer hover:brightness-125" : "hover:brightness-125"} onClick={onPick && pickable(x) ? () => onPick({ x: shape.keys[i], series: x.label, seriesKey: x.key }) : undefined} onPointerMove={(e) => at(e, rowsAt(i), c0(shape, i))} /></g>;
              });
              push(x);
              return <g key={x.label} data-series={x.label}>{out}</g>;
            }
            const pts = x.values.map((v, i) => (v === null ? null : { x: cx(i), y: y(offsetOf(x, i) + v), y0: y(offsetOf(x, i)) }));
            const line = pts.flatMap((q) => (q ? [`${q.x},${q.y}`] : [])).join(" ");
            const fill = x.type === "area" ? [...pts.flatMap((q) => (q ? [`${q.x},${q.y}`] : [])), ...[...pts].reverse().flatMap((q) => (q ? [`${q.x},${q.y0}`] : []))].join(" ") : "";
            push(x);
            return (
              <g key={x.label} data-series={x.label} data-axis={x.axis}>
                {fill && <polygon points={fill} fill={x.color} fillOpacity={0.22} />}
                <polyline points={line} fill="none" stroke={x.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={x.axis === "right" ? "5 3" : undefined} />
                {pts.map((q, i) => (q ? <circle key={i} cx={q.x} cy={q.y} r={3} fill={x.color} stroke={SURFACE} strokeWidth={1.5} /> : null))}
                {labels && pts.map((q, i) => (q && i % every === 0 ? <text key={`l${i}`} x={q.x} y={q.y - 7} textAnchor="middle" fontSize={10} fill={AXIS} data-label>{p.formatCompact(x.measure ?? 0, (x.values[i] ?? 0))}</text> : null))}
              </g>
            );
          })}
          {labels && stacked && bars.length > 0 && shape.categories.map((_, i) => {
            const onLeft = bars.filter((x) => (x.axis ?? "left") === "left");
            const total = onLeft.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0);
            return total > 0 && i % every === 0 ? <text key={`t${i}`} x={cx(i)} y={yOf("left")(total) - 4} textAnchor="middle" fontSize={11} fontWeight={500} fill={INK} data-label>{p.formatCompact(onLeft[0]?.measure ?? 0, total)}</text> : null;
          })}
          {/* Each category is a tab stop that shows its tooltip (every series' value), so the breakdown is keyboard-reachable too. */}
          {shape.categories.map((c, i) => <rect key={`hit${i}`} x={cx(i) - band / 2} y={CPAD.t} width={band} height={CH - CPAD.t - CPAD.b} fill="transparent" pointerEvents={bars.length ? "none" : "all"}
            tabIndex={0} role="img" aria-label={`${c}: ${rowsAt(i).map((r) => `${r.label} ${r.value}`).join(", ")}`} className="outline-none focus-visible:stroke-primary focus-visible:[stroke-width:2]"
            onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); at({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 3 }, rowsAt(i), c); }} onBlur={clear}
            onPointerMove={(e) => at(e, rowsAt(i), c)} onClick={onPick ? () => onPick({ x: shape.keys[i], series: shape.series[0]?.label ?? "" }) : undefined} />)}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}
const c0 = (shape: Shape, i: number) => shape.categories[i];

/** A waterfall's hues: increases the brand green, decreases the Ledger orange, totals the axis ink. */
const WF = { up: SERIES[0], down: SERIES[2], total: AXIS } as const;
const WPAD = { l: 56, r: 16, t: 18, b: 40 };
/** A label in at most two lines of about `chars` characters, the last cut short with an ellipsis. */
function wrap(label: string, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/)) {
    if (line && (line + " " + word).length > chars) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines;
  const second = lines.slice(1).join(" ");
  return [lines[0], second.length > chars ? `${second.slice(0, Math.max(1, chars - 1))}…` : second];
}

/**
 * A waterfall (bridge): the start total, each step floating from the running total before it, and the end total,
 * joined by dashed connectors. Signed labels sit on the steps; `onPick` gets a clicked step's row index.
 */
export function WaterfallChart({ w, format, compact, onPick, label }: {
  w: Waterfall; format: (v: number) => string; compact: (v: number) => string; onPick?: (row: number) => void; label: string;
}) {
  const { box, tip, at, clear } = useTip();
  const CH = CHART_H;
  const { ref, width: W } = useWidth(640);
  const top = ticksFor(Math.max(0, w.max), false);
  const step = top.length > 1 ? top[1] - top[0] : top[0] || 1;
  const below: number[] = [];
  for (let v = -step; v > w.min - step; v -= step) below.unshift(v);
  const ticks = [...below, ...top];
  const lo = ticks[0], hi = ticks.at(-1)!;
  const y = (v: number) => WPAD.t + (1 - (v - lo) / (hi - lo || 1)) * (CH - WPAD.t - WPAD.b);
  const n = w.bars.length;
  const band = (W - WPAD.l - WPAD.r) / Math.max(1, n);
  const barW = Math.min(64, band * 0.62);
  const cx = (i: number) => WPAD.l + band * (i + 0.5);
  const chars = Math.max(4, Math.floor(band / 6.2));
  const signed = (b: WaterfallBar) => (b.kind === "total" ? compact(b.value) : `${b.value > 0 ? "+" : "−"}${compact(Math.abs(b.value))}`);
  const color = (b: WaterfallBar) => WF[b.kind];
  return (
    <div ref={box} className="relative flex flex-col" onPointerLeave={clear}>
      <div ref={ref}>
        <svg viewBox={`0 0 ${W} ${CH}`} width={W} height={CH} className="block max-w-full" role="img" aria-label={label} data-chart="waterfall">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={WPAD.l} x2={W - WPAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={WPAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS}>{compact(t)}</text>
            </g>
          ))}
          {w.bars.slice(0, -1).map((b, i) => (
            <line key={`c${i}`} x1={cx(i) + barW / 2} x2={cx(i + 1) - barW / 2} y1={y(b.to)} y2={y(b.to)} stroke={AXIS} strokeWidth={1} strokeDasharray="3 2" data-connector />
          ))}
          {w.bars.map((b, i) => {
            const y0 = y(Math.max(b.from, b.to)), y1 = y(Math.min(b.from, b.to));
            const pick = onPick && b.row !== undefined ? () => onPick(b.row!) : undefined;
            const lines = wrap(b.label, chars);
            const name = `${b.label}: ${b.kind === "total" ? format(b.value) : `${b.value > 0 ? "+" : "−"}${format(Math.abs(b.value))}`}`;
            return (
              <g key={`${b.label}-${i}`} data-bar={b.kind}>
                <rect x={cx(i) - barW / 2} y={y0} width={barW} height={Math.max(1, y1 - y0)} fill={color(b)} rx={2} aria-label={name}
                  className={pick ? "cursor-pointer hover:brightness-110" : "hover:brightness-110"} onClick={pick}
                  onPointerMove={(e) => at(e, [{ color: color(b), label: b.kind === "total" ? "Total" : b.kind === "up" ? "Increase" : "Decrease", value: b.kind === "total" ? format(b.value) : `${b.value > 0 ? "+" : "−"}${format(Math.abs(b.value))}` }], b.label)} />
                <text x={cx(i)} y={b.kind === "down" ? y1 + 12 : y0 - 5} textAnchor="middle" fontSize={10} fontWeight={b.kind === "total" ? 600 : 400} fill={b.kind === "total" ? "currentColor" : color(b)} data-label>{signed(b)}</text>
                <text x={cx(i)} y={CH - WPAD.b + 14} textAnchor="middle" fontSize={11} fill={AXIS}>
                  {lines.map((l, k) => <tspan key={k} x={cx(i)} dy={k === 0 ? 0 : 13}>{l}</tspan>)}
                  <title>{b.label}</title>
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}
/** Other folds many values into one mark, so no single filter stands for it. */
const pickable = (s: Series) => s.label !== "Other" || s.key !== undefined;

/**
 * The report drawn as `kind`. A table report draws nothing here: the table below is the report. `height` sets a column,
 * line or area chart's plot height; `caption: false` drops the "measure by key" line for a host that titles the chart
 * itself; `seriesStyle` colors and orders a split's series; `maxBarWidth` caps a column's width; `tightAxis` ends the
 * value axis at the first nice tick above the data.
 */
export function ReportChart({ p, kind, onPick, display, tone, height, caption = true, seriesStyle, maxBarWidth, tightAxis }: {
  p: Presented; kind: ChartKind; onPick?: ChartPick; display?: ChartDisplay; tone?: Tone; height?: number; caption?: boolean; seriesStyle?: SeriesStyle; maxBarWidth?: number; tightAxis?: boolean;
}) {
  const colors = PALETTES[display?.palette ?? "canon"];
  const look: Look = { colors, labels: display?.labels, legend: display?.legend ?? "top", grid: display?.grid !== false, tone, height, maxBar: maxBarWidth, tight: tightAxis };
  const shape = useMemo(() => styled(toned(shapeOf(p, SERIES_MAX, kind === "bar", colors), tone), seriesStyle), [p, kind, colors, tone, seriesStyle]);
  const cartesian = useMemo(() => (kind === "column" || kind === "area" || (kind === "line" && (p.measureLabels.length > 1 || display?.axes?.includes("right"))) ? styled(toned(cartesianShape(p, kind, display, colors), kind === "column" ? tone : undefined), seriesStyle) : null), [p, kind, display, colors, tone, seriesStyle]);
  let body: ReactNode = null;
  if (p.rows === 0 && kind !== "number") {
    body = <p className="text-sm text-muted-foreground">No records match this report yet.</p>;
  } else if (kind === "number") {
    body = (
      <div>
        <div className="text-xs text-muted-foreground">{p.measureLabels[0]}</div>
        <div className="mt-1 text-5xl font-semibold text-foreground" style={{ fontVariantNumeric: "proportional-nums" }}>{p.format(0, p.total[0])}</div>
        <div className="mt-1 text-xs text-muted-foreground">{p.rows.toLocaleString("en-US")} records</div>
      </div>
    );
  } else if (kind !== "table" && !p.keyLabels.length) {
    body = <p className="text-sm text-muted-foreground">Group by a field to draw a chart.</p>;
  } else if (cartesian) body = <Cartesian p={p} shape={cartesian} stacked={display?.stacked === true && kind !== "line"} onPick={onPick} />;
  else if (kind === "bar") body = <Bars p={p} shape={shape} onPick={onPick} />;
  else if (kind === "line") body = <Lines p={p} shape={shape} onPick={onPick} />;
  else if (kind === "pie") body = p.additive ? <Pie p={p} onPick={onPick} /> : <p className="text-sm text-muted-foreground">A pie shows parts of a whole: measure a count or a sum to draw one.</p>;
  if (kind === "number" || kind === "table" || !p.keyLabels.length) return body;
  return (
    <LookCtx.Provider value={look}>
      <figure>
        {caption && <figcaption className="mb-3 text-xs text-muted-foreground">{cartesian && cartesian.series.length > 1 && p.keyLabels.length < 2 ? p.measureLabels.join(", ") : p.measureLabels[0]} by {p.keyLabels.join(" and ")}</figcaption>}
        {body}
      </figure>
    </LookCtx.Provider>
  );
}
