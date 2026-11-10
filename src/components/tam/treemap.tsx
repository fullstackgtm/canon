"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { squarify, type Rect } from "@/lib/squarify";
import { METRIC_LABEL, type Metric } from "@/lib/tam-levels";
import { cn } from "@/lib/utils";

export type TreemapGroup = {
  key: string;
  label: string;
  /** Tile area: the first metric in Values. */
  value: number;
  count: number;
  revenue: number;
  opportunity: number;
  /** No positive identity (unknown, unsure, other): neutral hatched fill. */
  neutral?: boolean;
  /** Clicking does something other than zoom (e.g. expand "Other"). */
  hint?: string;
  /** With an ICP overlay: how many of this tile's accounts are in the ICP. */
  inIcp?: number;
  /** Companies that exist for this tile (the shared prospect index), when the view has a market. */
  market?: number;
  /** A pocket of the market with no accounts in the CRM: drawn as an outline; clicking offers to fill it. */
  ghost?: boolean;
  /** The groups past the named tiles, folded into one: laid out last (bottom-right) and drawn as the quietest tile. */
  rest?: boolean;
};

/** An ICP drawn over the treemap: a tile holding any of its accounts is outlined and counts them (docs/tam-and-icps.md). */
export type TreemapOverlay = { name: string };

const GAP = 2;
/** A tile with room for its name and "count · %"; a named tile any smaller folds into the rest (tam-explorer). */
const labelFits = (w: number, h: number) => w >= 76 && h >= 48;
/** The tiles' rects in a `size` box, the rest tile last. */
const layout = (groups: TreemapGroup[], size: { w: number; h: number }) =>
  squarify(groups, (g) => g.value, { x: 0, y: 0, w: size.w + GAP, h: size.h + GAP }, { last: (g) => Boolean(g.rest) });
/**
 * How many tiles in a `size` box (the rest tile too) would have no room for their label; with `icp` (the overlaid
 * ICP's name), a tile holding its accounts needs room for "<name>: <count>" too, on one line or wrapped to two.
 */
export const unlabeledTiles = (groups: TreemapGroup[], size: { w: number; h: number }, icp?: string) =>
  size.w > 0 ? layout(groups, size).filter((t) => {
    const marked = icp !== undefined && (t.item.inIcp ?? 0) > 0;
    const w = t.w - GAP, h = t.h - GAP;
    // The ICP line wraps to a second line where the tile is too narrow for it whole.
    const icpLines = !marked ? 0 : w >= `${icp}: ${(t.item.inIcp ?? 0).toLocaleString()}`.length * 6.4 + 12 ? 1 : 2;
    return !labelFits(w, h - icpLines * 16);
  }).length : 0;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const formatUsd = (n: number) => `$${compact.format(n)}`;
const metricOf = (g: TreemapGroup, m: Metric) => (m === "count" ? g.count : m === "revenue" ? g.revenue : m === "market" ? g.market ?? 0 : g.opportunity);
const formatMetric = (m: Metric, n: number) => (m === "count" ? n.toLocaleString() : m === "market" ? `~${compact.format(n)}` : n ? formatUsd(n) : "—");
/** A share as a percent: one decimal below 10%, "<0.1%" for a nonzero share too small to round to 0.1%. */
export const formatShare = (share: number) => (share > 0 && share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`);
/** Accounts held as a share of the market: "12%", "<1%". */
export const coverage = (count: number, market: number) => (market ? (count / market < 0.01 && count > 0 ? "<1%" : `${Math.round((count / market) * 100)}%`) : "");

/**
 * Single-hue sequential fill: size relative to the largest tile in view ->
 * the primary green mixed into the card surface (6%..26%, where ink text keeps
 * its contrast). Text stays in ink tokens, never the series color.
 */
function fillFor(relative: number) {
  const pct = Math.round(6 + Math.sqrt(Math.min(1, Math.max(0, relative))) * 20);
  return `color-mix(in oklab, var(--primary) ${pct}%, var(--card))`;
}

export function Treemap({
  groups,
  values,
  onSelect,
  enterFrom,
  overlay,
  total: shownTotal,
  className,
}: {
  groups: TreemapGroup[];
  /** What shares are of, when the tiles are only some of the groups (the rest summarised outside); else their sum. */
  total?: number;
  /** Metrics to show; the first sizes the tiles. */
  values: Metric[];
  onSelect: (group: TreemapGroup, rect: Rect) => void;
  /** Fractional rect (0..1) of the tile that was clicked, to zoom in from. */
  enterFrom?: Rect | null;
  overlay?: TreemapOverlay | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [entered, setEntered] = useState(!enterFrom);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (entered) return;
    // A timer, not rAF: rAF stalls in background tabs and would leave the map shrunk.
    const id = setTimeout(() => setEntered(true), 20);
    return () => clearTimeout(id);
  }, [entered]);

  const total = shownTotal ?? groups.reduce((a, g) => a + g.value, 0);
  const largest = Math.max(0, ...groups.filter((g) => !g.neutral).map((g) => g.value));
  const tiles = size.w > 0 ? layout(groups, size) : [];
  const hovered = tiles.find((t) => t.item.key === hover);

  const enterStyle =
    !entered && enterFrom
      ? {
          transform: `translate(${enterFrom.x * 100}%, ${enterFrom.y * 100}%) scale(${Math.max(enterFrom.w, 0.02)}, ${Math.max(enterFrom.h, 0.02)})`,
          opacity: 0.4,
        }
      : { transform: "none", opacity: 1 };

  return (
    <div ref={ref} className={cn("relative w-full overflow-hidden", className)} onMouseLeave={() => setHover(null)}>
      <div className="absolute inset-0 origin-top-left transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none" style={enterStyle}>
        {tiles.map((t) => {
          const g = t.item;
          const w = Math.max(0, t.w - GAP);
          const h = Math.max(0, t.h - GAP);
          const share = total ? t.value / total : 0;
          const roomy = labelFits(w, h);
          const roomier = roomy && h > 66;
          // A name runs to two lines where the tile has the height for it.
          const twoLines = h > 74;
          const tiny = w < 44 || h < 24;
          // A named tile holding any of the overlaid ICP's accounts carries one marker: an outline and its count line.
          // The rest tile only notes its matches in that line, so the outline always lands on a real group.
          const holdsIcp = Boolean(overlay) && (g.inIcp ?? 0) > 0;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => onSelect(g, { x: t.x / size.w, y: t.y / size.h, w: w / size.w, h: h / size.h })}
              onMouseEnter={() => setHover(g.key)}
              onFocus={() => setHover(g.key)}
              onBlur={() => setHover(null)}
              aria-label={`${g.label}: ${values.map((m) => `${formatMetric(m, metricOf(g, m))} ${METRIC_LABEL[m].toLowerCase()}`).join(", ")}, ${(share * 100).toFixed(1)}%${holdsIcp && overlay ? `, ${(g.inIcp ?? 0).toLocaleString()} in ${overlay.name}` : ""}. ${g.hint ?? "Zoom in"}`}
              className={cn(
                "absolute overflow-hidden rounded-[4px] p-1.5 text-left outline-none transition-[box-shadow,filter] duration-150",
                "focus-visible:ring-2 focus-visible:ring-primary hover:brightness-125",
                g.neutral && !g.ghost && "tam-hatch bg-muted",
                // A tile holding any of the overlaid ICP's accounts: a bottle-green inset outline, so the matches stand out.
                holdsIcp && !g.rest && "shadow-[inset_0_0_0_2px_var(--primary)]",
                hover === g.key && "ring-1 ring-primary/70",
                g.ghost && "border border-dashed border-primary/50",
              )}
              style={{
                left: t.x, top: t.y, width: w, height: h,
                background: g.ghost ? "transparent" : g.neutral ? undefined : overlay ? "var(--muted)" : fillFor(largest ? g.value / largest : 0),
                // The rest: a paler stone under the hatch than its neighbours, so it reads as the leftovers.
                ...(g.rest && !g.ghost ? { backgroundColor: "color-mix(in oklab, var(--muted) 50%, var(--card))" } : {}),
              }}
            >
              {/* Every tile reads the same: its name (two lines where there's height; shortened, never the numbers), then "count · %". */}
              {!tiny && (
                <span className={cn("relative block text-xs", twoLines ? "line-clamp-2" : "truncate", g.rest ? "font-normal text-muted-foreground" : "font-semibold text-foreground")}>{g.label}</span>
              )}
              {!tiny && (
                <span className={cn("relative mt-0.5 block whitespace-nowrap text-xs tabular-nums", g.rest ? "text-muted-foreground" : "text-foreground/75")}>
                  {formatMetric(values[0], g.value)} · {formatShare(share)}
                </span>
              )}
              {roomy && g.ghost && (
                <span className="relative mt-0.5 block truncate text-xs tabular-nums text-primary">none in CRM · fill this pocket</span>
              )}
              {roomy && !g.ghost && g.market !== undefined && values[0] !== "market" && (
                <span className="relative mt-0.5 block truncate text-xs tabular-nums text-foreground/75">of ~{compact.format(g.market)} market · {coverage(g.count, g.market)}</span>
              )}
              {roomy && !g.ghost && g.market !== undefined && values[0] === "market" && (
                <span className="relative mt-0.5 block truncate text-xs tabular-nums text-foreground/75">{g.count.toLocaleString()} in CRM · {coverage(g.count, g.market)}</span>
              )}
              {/* The count in the overlaid ICP, whole (it wraps rather than truncates); the share is in the tooltip. */}
              {!tiny && holdsIcp && !g.ghost && overlay && (
                <span className={cn("relative mt-0.5 block break-words text-xs tabular-nums", g.rest ? "text-muted-foreground" : "font-medium text-foreground")}>{overlay.name}: {(g.inIcp ?? 0).toLocaleString()}</span>
              )}
              {/* The market lines already give the account count; the other values still show. */}
              {roomier && values.length > 1 && !(g.market !== undefined && values.slice(1).every((m) => m === "count" || m === "market")) && (
                <span className="relative mt-0.5 block truncate text-xs tabular-nums text-foreground/75">
                  {values.slice(1).filter((m) => !(g.market !== undefined && (m === "count" || m === "market"))).map((m) => `${formatMetric(m, metricOf(g, m))} ${m === "count" ? "accts" : m === "revenue" ? "rev" : m === "market" ? "market" : "opp"}`).join(" · ")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {hovered && entered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-64 border border-border bg-popover px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(hovered.x + hovered.w / 2 - 128, 4), Math.max(size.w - 260, 4)),
            top: hovered.y + hovered.h / 2 > size.h / 2 ? Math.max(hovered.y - 76, 4) : Math.min(hovered.y + hovered.h + 4, size.h - 80),
          }}
        >
          <div className="mb-1 break-words font-medium text-foreground">{hovered.item.label}</div>
          {values.map((m) => (
            <div key={m} className="flex justify-between text-muted-foreground">
              <span>{m === "revenue" ? "Revenue (known)" : METRIC_LABEL[m]}</span>
              <span className="tabular-nums text-foreground">{formatMetric(m, metricOf(hovered.item, m))}</span>
            </div>
          ))}
          {overlay && (
            <div className="flex justify-between text-muted-foreground">
              <span className="truncate pr-2">In {overlay.name}</span>
              <span className="shrink-0 tabular-nums text-foreground">
                {(hovered.item.inIcp ?? 0).toLocaleString()}{hovered.item.count ? ` of ${hovered.item.count.toLocaleString()} · ${formatShare((hovered.item.inIcp ?? 0) / hovered.item.count)}` : ""}
              </span>
            </div>
          )}
          {hovered.item.market !== undefined && !values.includes("market") && (
            <div className="flex justify-between text-muted-foreground">
              <span>Market</span>
              <span className="tabular-nums text-foreground">~{compact.format(hovered.item.market)}</span>
            </div>
          )}
          {hovered.item.market !== undefined && (
            <div className="flex justify-between text-muted-foreground">
              <span>In CRM</span>
              <span className="tabular-nums text-foreground">{hovered.item.count.toLocaleString()} · {coverage(hovered.item.count, hovered.item.market)}</span>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>Share</span>
            <span className="tabular-nums text-foreground">{formatShare(total ? hovered.item.value / total : 0)}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{hovered.item.hint ?? "Click to zoom in"}</div>
        </div>
      )}
    </div>
  );
}
