/** `xs` with the item at `from` moved to index `to` (in the list without it). */
export function moveAt<T>(xs: readonly T[], from: number, to: number): T[] {
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x);
  return out;
}

export type KeyList = "group" | "split";
export const GROUP_MAX = 2;

/**
 * A report's dimensions after a drag: Group by (the rows, the chart's axis) holds two at most, Split by (the columns,
 * the chart's colors) one. A field dropped on a Split by that holds one swaps with it: the one there takes its place in
 * Group by. A move that would overfill Group by is refused with the reason.
 */
export function moveKey<T>(group: readonly T[], split: readonly T[], from: { list: KeyList; i: number }, to: { list: KeyList; i: number }): { group: T[]; split: T[] } | string {
  if (from.list === to.list) {
    return from.list === "group" ? { group: moveAt(group, from.i, to.i), split: [...split] } : { group: [...group], split: [...split] };
  }
  if (from.list === "split") {
    if (group.length >= GROUP_MAX) return `Group by holds ${GROUP_MAX} fields at most.`;
    const g = [...group];
    g.splice(Math.max(0, Math.min(to.i, g.length)), 0, split[from.i]);
    return { group: g, split: [] };
  }
  const moved = group[from.i];
  const g = [...group];
  g.splice(from.i, 1, ...split);
  return { group: g, split: [moved] };
}
