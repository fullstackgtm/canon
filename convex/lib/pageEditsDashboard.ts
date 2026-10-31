/**
 * The "edits" operator dashboard (docs/operator-tools.md): how customize-mode instructions on the deal page land,
 * across every workspace, from pageEditAttempts. Unlike the deploys dashboard, Convex computes it itself (a cron in
 * operatorDashboards.refreshEdits), so it shows the deployment it runs on: dev.canoncrm.com and local stacks.
 * Pure, so the figures are tested without a database (tests/pageEditsDashboard.test.ts).
 */

export type EditAttempt = {
  outcome: "changed" | "unchanged" | "refused" | "error";
  refusedBy?: string;
  by: string;
  request: string;
  pointed?: string;
  summary: string;
  ms: number;
  at: number;
};

const DAY = 86_400_000;
export const EDITS_WINDOW_DAYS = 7;

const share = (part: number, whole: number) => (whole ? part / whole : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const tally = (rows: EditAttempt[], key: (r: EditAttempt) => string) =>
  Object.entries(rows.reduce<Record<string, number>>((m, r) => { const k = key(r); m[k] = (m[k] ?? 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

/** The dashboard's display model for the attempts made in the last week before `now`. */
export function editsDashboard(rows: EditAttempt[], now: number) {
  const week = rows.filter((r) => r.at > now - EDITS_WINDOW_DAYS * DAY);
  const prior = rows.filter((r) => r.at <= now - EDITS_WINDOW_DAYS * DAY && r.at > now - 2 * EDITS_WINDOW_DAYS * DAY);
  const rate = (rs: EditAttempt[], o: EditAttempt["outcome"]) => share(rs.filter((r) => r.outcome === o).length, rs.length);
  const delta = (a: number | null, b: number | null, higherIsBetter: boolean) => (a !== null && b ? { ratio: (a - b) / b, higherIsBetter } : null);
  const failed = week.filter((r) => r.outcome === "refused" || r.outcome === "error" || r.outcome === "unchanged");
  // Seven rolling 24-hour buckets ending now, so every attempt the KPIs count is in exactly one; labelled by the day each ends.
  const perDay = (pick: (r: EditAttempt) => boolean) => Array.from({ length: EDITS_WINDOW_DAYS }, (_, i) => {
    const back = EDITS_WINDOW_DAYS - 1 - i;
    const on = week.filter((r) => Math.floor((now - r.at) / DAY) === back);
    return { label: new Date(now - back * DAY).toISOString().slice(5, 10), value: on.length ? on.filter(pick).length / on.length : null };
  });
  const alerts: string[] = [];
  const errorRate = rate(week, "error");
  if (week.length >= 10 && (errorRate ?? 0) > 0.05) alerts.push(`${Math.round(errorRate! * 100)}% of edits errored this week: read the recent failures below.`);
  const guard = week.filter((r) => r.refusedBy === "guard:drawnRename").length;
  if (guard >= 3) alerts.push(`${guard} renames were refused for pointing at a drawn control: check them for false refusals and add eval cases (scripts/page-customize-eval.mjs).`);

  return {
    title: "Deal page edits",
    description: "Customize-mode instructions on the deal page, every workspace on this deployment, last 7 days (pageEditAttempts).",
    sections: [
      {
        id: "outcomes",
        title: "Did the person get the change?",
        meta: `${week.length} attempts`,
        kpis: [
          { label: "Attempts", value: week.length, format: "count" as const, delta: delta(week.length, prior.length, true) },
          { label: "Changed", value: rate(week, "changed"), format: "percent" as const, delta: delta(rate(week, "changed"), rate(prior, "changed"), true) },
          { label: "Refused", value: rate(week, "refused"), format: "percent" as const, delta: delta(rate(week, "refused"), rate(prior, "refused"), false) },
          { label: "Errored", value: errorRate, format: "percent" as const, delta: delta(errorRate, rate(prior, "error"), false) },
          { label: "Median time", value: median(week.map((r) => r.ms / 1000)), format: "duration" as const },
        ],
        charts: [{ title: "Changed, by day", kind: "line" as const, format: "percent" as const, points: perDay((r) => r.outcome === "changed") }],
        bars: [
          { title: "Refused by", format: "count" as const, items: tally(week.filter((r) => r.outcome === "refused"), (r) => r.refusedBy ?? "unknown") },
          { title: "Handled by", format: "count" as const, items: tally(week, (r) => r.by || "none (failed before a model)") },
          { title: "Changed, by model", format: "percent" as const, items: tally(week, (r) => r.by || "none").map(({ label }) => ({ label, value: share(week.filter((r) => (r.by || "none") === label && r.outcome === "changed").length, week.filter((r) => (r.by || "none") === label).length) ?? 0 })) },
        ],
        alerts,
      },
      {
        id: "failures",
        title: "Recent refusals and errors",
        meta: "Newest first. Each is a candidate eval case if the person should have got the change.",
        tables: [{
          columns: [
            { key: "at", label: "When", format: "relative" as const },
            { key: "outcome", label: "Outcome", format: "status" as const },
            { key: "rule", label: "Refused by", format: "text" as const },
            { key: "request", label: "Asked", format: "text" as const },
            { key: "pointed", label: "Pointed at", format: "text" as const },
            { key: "by", label: "Model", format: "text" as const },
            { key: "summary", label: "Told them", format: "text" as const },
          ],
          rows: failed.sort((a, b) => b.at - a.at).slice(0, 40).map((r) => ({
            at: new Date(r.at).toISOString(), outcome: r.outcome, rule: r.refusedBy ?? null, request: clip(r.request, 120),
            pointed: clip(r.pointed, 100), by: r.by || null, summary: clip(r.summary, 160),
          })),
          ...(failed.length > 40 ? { note: `Showing 40 of ${failed.length}.` } : {}),
        }],
      },
    ],
  };
}
