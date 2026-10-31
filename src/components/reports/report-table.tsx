"use client";

import type { Presented, PresentedGroup } from "./present";
import { heat, ranges } from "@/lib/chart-style";

/** A table's sort: the column (keys first, then measures) and its direction. */
export type ReportSort = { col: number; dir: "asc" | "desc" };

/**
 * A report as a table: its groups, a subtotal after each first key when there are two keys, and the total. With
 * `onSort`, a header click sorts by its column (the caller orders `p`, as sortPresented does), then the other way.
 * `rowNumbers` numbers the rows; `heatmap` tints each metric cell by its place in its column (totals stay plain).
 */
export function ReportTable({ p, sort, onSort, rowNumbers, heatmap }: { p: Presented; sort?: ReportSort | null; onSort?: (col: number) => void; rowNumbers?: boolean; heatmap?: boolean }) {
  const two = p.keyLabels.length === 2;
  const span = heatmap ? ranges(p.groups.map((g) => g.values), p.measureLabels.length) : [];
  const cells = (g: Pick<PresentedGroup, "values">, tint = false) => g.values.map((v, i) => (
    <td key={i} className="px-3 py-1.5 text-right tabular-nums" style={tint && heatmap ? { background: `rgb(46 130 89 / ${heat(v, span[i].min, span[i].max)})` } : undefined}>{p.format(i, v)}</td>
  ));
  let n = 0;
  const num = () => (rowNumbers ? <td className="w-10 px-2 py-1.5 text-right text-xs text-muted-foreground tabular-nums">{++n}</td> : null);
  const blank = rowNumbers ? <td /> : null;
  const body: React.ReactNode[] = [];
  if (two) {
    for (const s of p.subtotals) {
      const k = JSON.stringify(s.keys[0]);
      const leaves = p.groups.filter((g) => JSON.stringify(g.keys[0]) === k);
      leaves.forEach((g, i) => body.push(
        <tr key={`${k}:${JSON.stringify(g.keys[1])}`} className="border-t border-border/60">
          {num()}
          <td className="px-3 py-1.5 text-foreground">{i === 0 ? g.labels[0] : ""}</td>
          <td className="px-3 py-1.5 text-muted-foreground">{g.labels[1]}</td>
          {cells(g, true)}
        </tr>,
      ));
      body.push(
        <tr key={`${k}:subtotal`} className="border-t border-border/60 bg-muted/30 font-medium">
          {blank}
          <td className="px-3 py-1.5 text-muted-foreground" colSpan={2}>{s.labels[0]} subtotal</td>
          {cells(s)}
        </tr>,
      );
    }
  } else {
    for (const g of p.groups) {
      body.push(
        <tr key={JSON.stringify(g.keys)} className="border-t border-border/60">
          {num()}
          {g.labels.map((l, i) => <td key={i} className="px-3 py-1.5 text-foreground">{l}</td>)}
          {cells(g, true)}
        </tr>,
      );
    }
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-muted-foreground">
            {rowNumbers && <th className="w-10 px-2 py-2 font-normal" aria-label="Row" />}
            {/* With no dimension, the total row's label still takes a column. */}
            {p.keyLabels.length === 0 && <th className="px-3 py-2 font-normal" aria-label="Row" />}
            {[...p.keyLabels, ...p.measureLabels].map((l, col) => {
              const end = col >= p.keyLabels.length;
              const on = sort?.col === col ? sort.dir : null;
              return (
                <th key={`${col}:${l}`} className={`px-3 py-2 font-normal${end ? " text-right" : ""}`} aria-sort={on === "asc" ? "ascending" : on === "desc" ? "descending" : onSort ? "none" : undefined}>
                  {onSort ? <button type="button" className="hover:text-foreground" onClick={() => onSort(col)}>{l}{on ? (on === "asc" ? " ↑" : " ↓") : ""}</button> : l}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {body}
          <tr className="border-t-2 border-border font-semibold">
            {blank}
            <td className="px-3 py-2" colSpan={Math.max(1, p.keyLabels.length)}>Total</td>
            {cells({ values: p.total })}
          </tr>
        </tbody>
      </table>
      {p.truncated && <p className="px-3 pt-2 text-xs text-muted-foreground">Showing the first 500 groups; the total counts every record.</p>}
    </div>
  );
}

/**
 * `p` in a column's order: a key's by its labels, a measure's by its values (none last). With two keys the first
 * key's subtotals take the order and the rows under each follow it.
 */
export function sortPresented(p: Presented, sort: ReportSort | null | undefined): Presented {
  if (!sort) return p;
  const keys = p.keyLabels.length;
  const sign = sort.dir === "asc" ? 1 : -1;
  const by = (g: PresentedGroup, col: number) => (col < keys ? g.labels[col] ?? "" : g.values[col - keys]);
  const cmp = (col: number) => (a: PresentedGroup, b: PresentedGroup) => {
    const x = by(a, col), y = by(b, col);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" })) * sign;
  };
  if (keys < 2) return { ...p, groups: [...p.groups].sort(cmp(sort.col)) };
  return sort.col === 1 ? { ...p, groups: [...p.groups].sort(cmp(1)) } : { ...p, subtotals: [...p.subtotals].sort(cmp(sort.col)), groups: [...p.groups].sort(cmp(sort.col)) };
}
