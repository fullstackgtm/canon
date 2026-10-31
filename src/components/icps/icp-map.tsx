"use client";

import { useMemo } from "react";
import { layoutMap, ICP_MAP_FILL, type MapCounts, type MapNode } from "@/lib/icp-map";

type Props = {
  nodes: Array<MapNode & { name: string; on: boolean }>;
  counts: MapCounts;
  selected: string | null;
  hovered: string | null;
  onSelect: (id: string) => void;
};

const mix = (pct: number) => `color-mix(in oklab, var(--primary) ${pct}%, transparent)`;


/**
 * Every ICP, segment and persona as circles inside circles (lib/icp-map.ts), overlapping where siblings share
 * accounts. The selected row fills, the rows above it are outlined, siblings it overlaps are dashed, the rest fade.
 */
export function IcpMap({ nodes, counts, selected, hovered, onSelect }: Props) {
  const key = JSON.stringify([nodes.map((n) => [n.id, n.parent, n.kind]), counts]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { circles, frame } = useMemo(() => layoutMap(nodes, counts), [key]);
  if (!circles.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lineage = new Set<string>();
  for (let id = selected; id; id = byId.get(id)?.parent ?? null) lineage.add(id);
  const shared = (a: string, b: string) => counts.overlaps.some((o) => ((o.a === a && o.b === b) || (o.a === b && o.b === a)) && o.accounts > 0);
  const state = (id: string) => {
    if (!selected) return "";
    if (id === selected) return "focus";
    if (lineage.has(id)) return "path";
    for (let p = byId.get(id)?.parent ?? null; p; p = byId.get(p)?.parent ?? null) if (p === selected) return "inside";
    if (byId.get(id)?.parent === byId.get(selected)?.parent && shared(id, selected)) return "sibling";
    return "dim";
  };
  const pad = 6;
  return (
    <svg viewBox={`${-frame - pad} ${-frame - pad} ${2 * (frame + pad)} ${2 * (frame + pad)}`} className="block w-full" role="img" aria-label="Map of ICPs, segments and personas">
      <circle cx={0} cy={0} r={frame} fill="color-mix(in oklab, var(--foreground) 2%, transparent)" stroke="var(--border)" strokeDasharray="3 4" />
      <text x={0} y={-frame + 12} textAnchor="middle" className="fill-muted-foreground text-[7.5px]">Your CRM</text>
      {circles.map((c) => {
        const n = byId.get(c.id)!;
        const s = state(c.id);
        const lit = hovered === c.id;
        return (
          <g key={c.id} onClick={() => onSelect(c.id)} className="cursor-pointer" opacity={s === "dim" && !lit ? 0.28 : 1}>
            <title>{n.name}</title>
            <circle
              cx={c.x} cy={c.y} r={c.r}
              fill={s === "focus" ? mix(75) : s === "inside" ? "color-mix(in oklab, var(--background) 40%, transparent)" : ICP_MAP_FILL[c.kind]}
              stroke={lit || s === "path" ? "var(--foreground)" : s === "focus" || s === "sibling" ? "var(--primary)" : c.kind === "icp" ? "color-mix(in oklab, var(--foreground) 35%, transparent)" : mix(55)}
              strokeWidth={lit ? 2 : s === "path" || s === "focus" ? 1.4 : 0.8}
              strokeDasharray={s === "sibling" || !n.on ? "3 2" : undefined}
            />
          </g>
        );
      })}
      {circles.filter((c) => c.kind === "icp" || (c.id === selected && c.r > 9)).map((c) => {
        const n = byId.get(c.id)!;
        const parentOfOthers = circles.some((k) => byId.get(k.id)?.parent === c.id);
        return (
          <text
            key={`t${c.id}`} x={c.x} y={c.kind === "icp" || parentOfOthers ? c.y - c.r + 11 : c.y + 3} textAnchor="middle"
            className={`pointer-events-none text-[7.5px] ${c.id === selected ? "fill-primary-foreground font-semibold" : c.kind === "icp" ? "fill-foreground font-semibold" : "fill-muted-foreground"}`}
            opacity={state(c.id) === "dim" ? 0.4 : 1}
          >
            {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
          </text>
        );
      })}
    </svg>
  );
}
