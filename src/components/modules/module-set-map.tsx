"use client";

import { IcpViewer } from "@/components/icps/icp-viewer";
import { useMemo } from "react";
import type { Node } from "../../../modules/kernel/manifest";
import { focusQuery, focusedKey, layoutSetMap, setMapValue, setState, sharedCount, type SetMapRow } from "../../../modules/kernel/setMap";

type Props = {
  icp?: boolean;
  showQuery?: boolean;
  n: Extract<Node, { c: "setMap" }>;
  value: unknown;
  query: Readonly<Record<string, string>>;
  setQuery: (changes: Record<string, string | null>) => void;
  hovered: string | null;
  hover: (key: string | null) => void;
  text: (row: SetMapRow | null, text: string) => string;
};
const mix = (pct: number) => `color-mix(in oklab, var(--primary) ${pct}%, transparent)`;
const number = (n: number | null) => n === null ? "Unavailable" : n.toLocaleString();

/** A static map and a read-only inspector over caller-provided sets. Selection only changes their emphasis. */
export function ModuleSetMap({ icp = false, showQuery = false, n, value, query, setQuery, hovered, hover, text }: Props) {
  const map = useMemo(() => setMapValue(value, n.rows, n.overlaps), [value, n.rows, n.overlaps]);
  const { circles, frame } = useMemo(() => layoutSetMap(map.rows.map((r) => ({ id: r.key, parent: r.parent, count: r.count })), map.overlaps), [map]);
  const selected = focusedKey(map.rows.map((r) => r.key), n.selection, query);
  const row = map.rows.find((r) => r.key === selected);
  const select = (key: string) => setQuery(focusQuery(n.selection, key));
  const byKey = new Map(map.rows.map((r) => [r.key, r]));
  const siblings = row ? map.rows.filter((r) => r.key !== row.key && r.parent === row.parent) : [];
  const title = text(null, n.title ?? "Overlapping sets");
  if (!circles.length) return <p className="text-sm text-muted-foreground">{text(null, n.empty ?? "No sets yet.")}</p>;
  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="font-display font-semibold">{title}</h2>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="print:hidden">
          <svg viewBox={`${-frame - 6} ${-frame - 6} ${2 * (frame + 6)} ${2 * (frame + 6)}`} className="block w-full" role="group" aria-label={title}>
            <circle cx={0} cy={0} r={frame} fill="color-mix(in oklab, var(--foreground) 2%, transparent)" stroke="var(--border)" strokeDasharray="3 4" />
            {n.frameLabel && <text x={0} y={-frame + 12} textAnchor="middle" className="fill-muted-foreground text-[7.5px]">{text(null, n.frameLabel)}</text>}
            {circles.map((c) => {
              const r = byKey.get(c.id)!;
              const state = setState(map, c.id, selected), lit = hovered === c.id;
              return (
                <g key={c.id} role="button" tabIndex={0} aria-pressed={selected === c.id} aria-label={`${r.label}: ${number(r.count)}${r.active === false ? ", off" : ""}`}
                  onClick={() => select(c.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c.id); } }}
                  onMouseEnter={() => hover(c.id)} onMouseLeave={() => hover(null)} onFocus={() => hover(c.id)} onBlur={() => hover(null)}
                  className="cursor-pointer outline-none" opacity={state === "dim" && !lit ? 0.28 : 1}>
                  <title>{r.label}: {number(r.count)}</title>
                  <circle cx={c.x} cy={c.y} r={c.r}
                    fill={state === "focus" ? mix(75) : state === "inside" ? "color-mix(in oklab, var(--background) 40%, transparent)" : c.depth === 0 ? "color-mix(in oklab, var(--foreground) 5%, transparent)" : mix(c.depth === 1 ? 12 : 28)}
                    stroke={lit || state === "path" ? "var(--foreground)" : state === "focus" || state === "sibling" ? "var(--primary)" : c.depth === 0 ? "color-mix(in oklab, var(--foreground) 35%, transparent)" : mix(55)}
                    strokeWidth={lit ? 2 : state === "path" || state === "focus" ? 1.4 : 0.8}
                    strokeDasharray={state === "sibling" || r.active === false || r.count === null ? "3 2" : undefined} />
                </g>
              );
            })}
            {circles.filter((c) => c.depth === 0 || (c.id === selected && c.r > 9)).map((c) => {
              const r = byKey.get(c.id)!;
              const hasChildren = map.rows.some((child) => child.parent === r.key);
              return <text key={`label:${c.id}`} x={c.x} y={c.depth === 0 || hasChildren ? c.y - c.r + 11 : c.y + 3} textAnchor="middle"
                className={`pointer-events-none text-[7.5px] ${c.id === selected ? "fill-primary-foreground font-semibold" : c.depth === 0 ? "fill-foreground font-semibold" : "fill-muted-foreground"}`}
                opacity={setState(map, c.id, selected) === "dim" ? 0.4 : 1}>{r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}</text>;
            })}
          </svg>
          <p className="text-xs text-muted-foreground">Circles use compressed counts and a best-fit layout. Circle areas are approximate. Unavailable counts have a dashed outline.</p>
        </div>
        <div className="hidden space-y-2 print:block">
          {n.frameLabel && <p>{text(null, n.frameLabel)}</p>}
          <table><thead><tr><th>Set</th><th>Key</th><th>Parent key</th><th>Count</th><th>State</th></tr></thead><tbody>
            {map.rows.map((r) => <tr key={r.key}><td>{r.label}</td><td>{r.key}</td><td>{r.parent ?? "None"}</td><td>{number(r.count)}</td><td>{r.active === false ? "Off" : r.active === true ? "On" : ""}</td></tr>)}
          </tbody></table>
          <table><thead><tr><th>Set</th><th>Sibling</th><th>Shared count</th></tr></thead><tbody>
            {map.rows.flatMap((a, i) => map.rows.slice(i + 1).filter((b) => a.parent === b.parent).map((b) => <tr key={JSON.stringify([a.key, b.key])}><td>{a.label}</td><td>{b.label}</td><td>{number(sharedCount(map.overlaps, a.key, b.key))}</td></tr>))}
          </tbody></table>
        </div>
        {row && n.focus && <div aria-live="polite" className="space-y-3 border-t border-border pt-3">
          <h3 className="font-display font-semibold">{text(row, n.focus.title)}</h3>
          <dl className="space-y-2 text-sm">{n.focus.items.map((item, i) => {
            if (icp && item.value === "{$row.sentence}") return <div key={i}><dt className="mb-2 text-xs text-muted-foreground">Definition</dt><dd><IcpViewer query={String(row.query ?? "")} kind={row.kind === "Persona" ? "persona" : row.kind === "Segment" ? "segment" : "icp"} showQuery={showQuery} /></dd></div>;
            const content = text(row, item.value);
            return content ? <div key={i}><dt className="text-xs text-muted-foreground">{text(row, item.label)}</dt><dd className="whitespace-pre-wrap">{content}</dd></div> : null;
          })}</dl>
          {!!siblings.length && <div className="text-sm">
            <h4 className="text-xs text-muted-foreground">{text(null, n.focus.sharedLabel ?? "Shared with siblings")}</h4>
            <ul>{siblings.map((s) => <li key={s.key} className="flex items-baseline justify-between gap-3">
              <button type="button" onClick={() => select(s.key)} onMouseEnter={() => hover(s.key)} onMouseLeave={() => hover(null)} onFocus={() => hover(s.key)} onBlur={() => hover(null)} className="text-left underline underline-offset-2 print:hidden">{s.label}</button>
              <span className="hidden print:inline">{s.label}</span>
              <span className="tabular-nums">{number(sharedCount(map.overlaps, row.key, s.key))}</span>
            </li>)}</ul>
          </div>}
        </div>}
      </div>
    </section>
  );
}
