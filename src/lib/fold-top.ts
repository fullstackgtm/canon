type Group = { keys: readonly unknown[]; labels: readonly string[]; values: readonly (number | null)[] };

/**
 * A chart of many groups (17,000 accounts by name) as its `max` largest by the first value, and the rest as one
 * "Other" that adds them up where a value adds up (a count or a total), so the chart's total stays true. Only a chart
 * folds: the table lists every group. Dates and two-key charts are left as they are; their order is the point.
 */
export function foldTop<P extends { keyLabels: readonly string[]; groups: readonly Group[] }>(p: P, fns: readonly string[], max = 10, dated = false): P {
  if (p.keyLabels.length !== 1 || dated || p.groups.length <= max + 1) return p;
  const ranked = [...p.groups].sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity));
  const rest = ranked.slice(max);
  const other: Group = {
    keys: [{ other: rest.length }],
    labels: [`Other (${rest.length})`],
    values: fns.map((fn, i) => (fn === "count" || fn === "sum" ? rest.reduce((s, g) => s + (g.values[i] ?? 0), 0) : null)),
  };
  return { ...p, groups: [...ranked.slice(0, max), other] };
}
