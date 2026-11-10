/** Deterministic overlapping sets. Geometry is independent of labels, selection, hover and React. */
export type SetLayoutNode = { id: string; parent: string | null; count: number | null; head?: number };
export type SetOverlap = { a: string; b: string; count: number | null };
export type SetCircle = { id: string; x: number; y: number; r: number; depth: number };

export type RowFocus = { param: string; aliases?: readonly string[] };
export type SetMapRow = Record<string, unknown> & { key: string; parent: string | null; label: string; count: number | null; active?: boolean };
export type SetMapValue = { rows: SetMapRow[]; overlaps: SetOverlap[] };

/** A missing or stale URL key selects the first row, in the caller's order. */
export function focusedKey(keys: readonly string[], focus: RowFocus, query: Readonly<Record<string, string>>): string | null {
  const key = [focus.param, ...(focus.aliases ?? [])].map((p) => query[p]).find(Boolean);
  return key && keys.includes(key) ? key : keys[0] ?? null;
}

export function focusQuery(focus: RowFocus, key: string): Record<string, string | null> {
  return { ...Object.fromEntries((focus.aliases ?? []).map((p) => [p, null])), [focus.param]: key };
}

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const countValue = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);

/** Validate the entire caller-provided value once, before geometry or printing consumes it. */
export function setMapValue(value: unknown, rows: string, overlaps: string): SetMapValue {
  if (!record(value) || !Array.isArray(value[rows]) || !Array.isArray(value[overlaps])) throw new Error("A set map needs rows and pairwise shared counts");
  const inputRows = value[rows] as unknown[], inputOverlaps = value[overlaps] as unknown[];
  if (inputRows.length > 100 || inputOverlaps.length > 4950) throw new Error("A set map holds at most 100 rows and 4950 pairs");
  const parsed: SetMapRow[] = inputRows.map((r) => {
    if (!record(r) || typeof r.key !== "string" || !r.key || !(r.parent === null || typeof r.parent === "string") || typeof r.label !== "string" || !countValue(r.count) || (r.active !== undefined && typeof r.active !== "boolean")) throw new Error("A set row needs key, parent, label, count and an optional active flag");
    return r as SetMapRow;
  });
  const byKey = new Map(parsed.map((r) => [r.key, r]));
  if (byKey.size !== parsed.length) throw new Error("Set map keys must be unique");
  for (const row of parsed) {
    const path = new Set([row.key]);
    for (let parent = row.parent; parent !== null; parent = byKey.get(parent)!.parent) {
      if (!byKey.has(parent)) throw new Error("A set map parent is missing");
      if (path.has(parent)) throw new Error("Set map parents form a cycle");
      path.add(parent);
    }
  }
  const pairs = new Set<string>();
  const shared = inputOverlaps.map((o): SetOverlap => {
    if (!record(o) || typeof o.a !== "string" || typeof o.b !== "string" || !countValue(o.count)) throw new Error("A shared count needs a, b and count");
    const a = byKey.get(o.a), b = byKey.get(o.b), pair = JSON.stringify([o.a, o.b].sort());
    if (!a || !b || a === b || a.parent !== b.parent || pairs.has(pair)) throw new Error("Shared counts must name unique sibling pairs");
    pairs.add(pair);
    return { a: o.a, b: o.b, count: o.count };
  });
  return { rows: parsed, overlaps: shared };
}

/** Missing pairs remain unknown, rather than claiming the sets are disjoint. */
export function sharedCount(overlaps: readonly SetOverlap[], a: string, b: string): number | null {
  return overlaps.find((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a))?.count ?? null;
}

export function setState(map: SetMapValue, key: string, selected: string | null): "focus" | "path" | "inside" | "sibling" | "dim" | "" {
  if (!selected) return "";
  if (key === selected) return "focus";
  const byKey = new Map(map.rows.map((r) => [r.key, r]));
  for (let p = byKey.get(selected)?.parent; p; p = byKey.get(p)?.parent) if (p === key) return "path";
  for (let p = byKey.get(key)?.parent; p; p = byKey.get(p)?.parent) if (p === selected) return "inside";
  return byKey.get(key)?.parent === byKey.get(selected)?.parent && (sharedCount(map.overlaps, key, selected) ?? 0) > 0 ? "sibling" : "dim";
}

/** Compressed (count^0.4), so large sets don't hide smaller sets and their children. */
const radius = (count: number) => 4 + 2.2 * Math.pow(Math.max(count, 0), 0.4);

/** The area two circles share at centre distance d. */
export function lens(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  return r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) + r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
    - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
}

/** The centre distance at which two circles share `area`. */
function distFor(r1: number, r2: number, area: number): number {
  let lo = Math.abs(r1 - r2), hi = r1 + r2;
  if (area >= Math.PI * Math.min(r1, r2) ** 2) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lens(r1, r2, mid) > area) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

type Placed = { id: string; r: number; count: number; x: number; y: number; kids: Placed[] };

/**
 * Pairwise target distances fit the shared fraction of each smaller set. Fixed relaxation makes a deterministic
 * best fit when many pairs constrain each other; it cannot encode every inconsistent set of pair counts exactly.
 */
function arrange(items: Placed[], shared: (a: string, b: string) => number, pad: number): number {
  items.forEach((p, i) => {
    p.x = Math.cos(i * 2.4) * (p.r + 12) * 1.4;
    p.y = Math.sin(i * 2.4) * (p.r + 12) * 1.4;
  });
  const want = new Map<string, number | null>();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const [a, b] = [items[i], items[j]];
    const ov = shared(a.id, b.id), small = Math.min(a.count, b.count);
    want.set(`${i},${j}`, ov >= 1 && small > 0 ? distFor(a.r, b.r, Math.PI * Math.min(a.r, b.r) ** 2 * Math.min(1, ov / small)) : null);
  }
  for (let step = 0; step < 500; step++) {
    for (const p of items) {
      p.x *= 0.985;
      p.y *= 0.985;
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      let t = want.get(`${i},${j}`) ?? null;
      if (t === null) {
        if (d >= a.r + b.r + pad) continue;
        t = a.r + b.r + pad;
      }
      const m = (d - t) / 2 / d;
      a.x += dx * m; a.y += dy * m; b.x -= dx * m; b.y -= dy * m;
    }
  }
  const cx = (Math.min(...items.map((p) => p.x - p.r)) + Math.max(...items.map((p) => p.x + p.r))) / 2;
  const cy = (Math.min(...items.map((p) => p.y - p.r)) + Math.max(...items.map((p) => p.y + p.r))) / 2;
  for (const p of items) {
    p.x -= cx;
    p.y -= cy;
  }
  return Math.max(...items.map((p) => Math.hypot(p.x, p.y) + p.r));
}

/** The whole map: circles in absolute coordinates around (0, 0), and their enclosing frame. */
export function layoutSetMap(nodes: readonly SetLayoutNode[], overlaps: readonly SetOverlap[]): { circles: SetCircle[]; frame: number } {
  const count = new Map(nodes.map((n) => [n.id, n.count ?? 0]));
  const overlap = new Map(overlaps.map((o) => [JSON.stringify([o.a, o.b]), o.count ?? 0]));
  const shared = (a: string, b: string) => overlap.get(JSON.stringify([a, b])) ?? overlap.get(JSON.stringify([b, a])) ?? 0;
  const build = (n: SetLayoutNode): Placed => {
    const kids = nodes.filter((k) => k.parent === n.id).map(build);
    const own = radius(count.get(n.id) ?? 0);
    const placed: Placed = { id: n.id, r: own, count: count.get(n.id) ?? 0, x: 0, y: 0, kids };
    if (kids.length) {
      const head = n.head ?? (n.parent === null ? 16 : 6);
      const enclose = arrange(kids, shared, 3);
      for (const k of kids) k.y += head / 2;
      placed.r = Math.max(own, enclose + head);
    }
    return placed;
  };
  const roots = nodes.filter((n) => n.parent === null).map(build);
  if (!roots.length) return { circles: [], frame: 0 };
  const frame = arrange(roots, shared, 10) + 22;
  const circles: SetCircle[] = [];
  const flatten = (p: Placed, x: number, y: number, depth: number) => {
    circles.push({ id: p.id, x: x + p.x, y: y + p.y, r: p.r, depth });
    for (const k of p.kids) flatten(k, x + p.x, y + p.y, depth + 1);
  };
  for (const r of roots) flatten(r, 0, 0, 0);
  return { circles, frame };
}
