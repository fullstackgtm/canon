const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as people read it: "Jul 1, 2026". */
export function dayText(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A range's ends as people read them: "Jul 1 – Sep 30, 2026", "From Jul 1, 2026", "Any date". */
export function rangeText(r: { from: string | null; to: string | null } | null): string {
  if (!r || (!r.from && !r.to)) return "Any date";
  if (r.from && r.to) {
    if (r.from === r.to) return dayText(r.from);
    const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
    return `${sameYear ? dayText(r.from).replace(/, \d{4}$/, "") : dayText(r.from)} – ${dayText(r.to)}`;
  }
  return r.from ? `From ${dayText(r.from)}` : `Through ${dayText(r.to!)}`;
}
