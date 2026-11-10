/** The core ICP map's existing contract, backed by the general overlapping-set geometry. */
import { layoutSetMap } from "../../modules/kernel/setMap.ts";
export { lens } from "../../modules/kernel/setMap.ts";

export type MapNode = { id: string; parent: string | null; kind: "icp" | "segment" | "persona" };
export type MapCounts = { nodes: Array<{ id: string; accounts: number }>; overlaps: Array<{ a: string; b: string; accounts: number }> };
export type Circle = { id: string; kind: MapNode["kind"]; x: number; y: number; r: number; depth: number };

export function layoutMap(nodes: readonly MapNode[], counts: MapCounts): { circles: Circle[]; frame: number } {
  const accounts = new Map(counts.nodes.map((n) => [n.id, n.accounts]));
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]));
  const layout = layoutSetMap(nodes.map((n) => ({ id: n.id, parent: n.parent, count: accounts.get(n.id) ?? 0, head: n.kind === "icp" ? 16 : 6 })),
    counts.overlaps.map((o) => ({ a: o.a, b: o.b, count: o.accounts })));
  return { ...layout, circles: layout.circles.map((c) => ({ ...c, kind: kinds.get(c.id)! })) };
}

export const ICP_MAP_FILL = {
  icp: "color-mix(in oklab, var(--foreground) 5%, transparent)",
  segment: "color-mix(in oklab, var(--primary) 12%, transparent)",
  persona: "color-mix(in oklab, var(--primary) 28%, transparent)",
};
