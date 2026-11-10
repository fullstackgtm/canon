/**
 * A report's look, as Looker Studio's Style tab sets it, kept in Canon's theme: a palette of the Ledger's hues, data
 * labels, the legend's place, gridlines, and for a table row numbers and a heatmap.
 */
export const PALETTES = {
  /** The Ledger categorical palette, validated (see SERIES in report-chart). */
  canon: ["#2e8259", "#3d6fa8", "#c25a2a", "#1d9b9b", "#b08300", "#6a58d8", "#b8506a", "#7f8b1f"],
  greens: ["#1f5c40", "#2e8259", "#4f9a72", "#76b291", "#9ccab0", "#7f8b1f", "#5b6b2a", "#b3c98a"],
  cool: ["#3d6fa8", "#1d9b9b", "#2e8259", "#6a58d8", "#5b8fd1", "#2b5c8a", "#4fa3a3", "#8a7fd6"],
  warm: ["#c25a2a", "#b08300", "#b8506a", "#d9822b", "#8f5b2e", "#7f8b1f", "#a8453f", "#c99a3a"],
} as const;
export type PaletteName = keyof typeof PALETTES;
export const PALETTE_LABEL: Record<PaletteName, string> = { canon: "Canon", greens: "Greens", cool: "Cool", warm: "Warm" };

/** A metric cell's heatmap tint: its place between the column's lowest and highest, as an opacity of the brand green. */
export function heat(v: number | null, min: number, max: number): number {
  if (v === null || !Number.isFinite(v) || max <= min) return 0;
  return Math.round((0.06 + ((v - min) / (max - min)) * 0.4) * 100) / 100;
}

/** Each column's lowest and highest value, for its heatmap. */
export function ranges(rows: readonly (readonly (number | null)[])[], columns: number): Array<{ min: number; max: number }> {
  return Array.from({ length: columns }, (_, i) => {
    const vs = rows.map((r) => r[i]).filter((v): v is number => v !== null && Number.isFinite(v));
    return vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : { min: 0, max: 0 };
  });
}
