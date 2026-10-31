/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000): tiles whose
 * areas are proportional to their values, laid out in rows that keep each
 * tile's aspect ratio as close to 1 as possible. Pure; values <= 0 are dropped.
 */
export type Rect = { x: number; y: number; w: number; h: number };
export type Tile<T> = Rect & { item: T; value: number };

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

export function squarify<T>(items: T[], valueOf: (item: T) => number, box: Rect): Tile<T>[] {
  const entries = items
    .map((item) => ({ item, value: valueOf(item) }))
    .filter((e) => e.value > 0 && Number.isFinite(e.value))
    .sort((a, b) => b.value - a.value);
  const total = entries.reduce((a, e) => a + e.value, 0);
  if (!entries.length || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = entries.map((e) => e.value * scale);

  const out: Tile<T>[] = [];
  let free: Rect = { ...box };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(free.w, free.h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const rowArea = row.reduce((a, b) => a + b, 0);
    const horizontal = free.w >= free.h; // lay the row along the short side
    const thickness = rowArea / side;
    let offset = 0;
    row.forEach((area, k) => {
      const length = area / thickness;
      const e = entries[i + k];
      out.push(
        horizontal
          ? { x: free.x, y: free.y + offset, w: thickness, h: length, item: e.item, value: e.value }
          : { x: free.x + offset, y: free.y, w: length, h: thickness, item: e.item, value: e.value },
      );
      offset += length;
    });
    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    i = j;
  }
  return out;
}
