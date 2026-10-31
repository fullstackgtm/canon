"use client";

/**
 * Inside a cadence: its funnel (each stage opens the people in it), how fast
 * invites get accepted week by week, and when people accept.
 */
import { useState } from "react";
import { FUNNEL_STAGES, inStage, rate, type Funnel, type FunnelStage } from "../../../../convex/lib/linkedin/cadence";
import { ACCEPT_WITHIN_DAYS, cumulativeAcceptance, acceptanceCurve, acceptanceTimes, acceptedAtOf, inviteCohorts, type Timed } from "../../../../convex/lib/linkedin/acceptance";
import { cn } from "@/lib/utils";

export const pct = (n: number | null) => (n === null ? "–" : `${n}%`);
/** Replies out of everyone connected: someone can reply to the invite note before any message goes out. */
export const replyRate = (f: Funnel) => rate(f.replied, f.accepted + f.alreadyConnected);

const DAY_MS = 86_400_000;
const PEOPLE_PER_PAGE = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

export const STAGE_LABEL: Record<FunnelStage, string> = {
  enrolled: "Enrolled", invited: "Invited", pending: "Pending", accepted: "Accepted",
  alreadyConnected: "Already connected", messaged: "Messaged", replied: "Replied",
};

/** The funnel as buttons: pick a stage to list its people. */
export function FunnelStages({ funnel, truncated, stage, onStage }: { funnel: Funnel; truncated: boolean; stage: FunnelStage; onStage: (s: FunnelStage) => void }) {
  const note: Partial<Record<FunnelStage, string>> = {
    accepted: `${pct(rate(funnel.accepted, funnel.invited))} acceptance`,
    replied: `${pct(replyRate(funnel))} reply rate`,
  };
  return (
    <section aria-label="Funnel">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
        {FUNNEL_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={stage === s}
            onClick={() => onStage(s)}
            className={cn(
              "border border-border px-3 py-2 text-left hover:bg-muted/60",
              s === "accepted" && "border-foreground/40",
              stage === s && "bg-muted ring-1 ring-foreground/30",
            )}
          >
            <div className="text-xs text-muted-foreground">{STAGE_LABEL[s]}</div>
            <div className="text-lg tabular-nums">{funnel[s]}</div>
            {note[s] && <div className={cn("text-xs", s === "accepted" ? "font-semibold" : "text-muted-foreground")}>{note[s]}</div>}
          </button>
        ))}
      </div>
      {truncated && <p className="mt-1 text-xs text-muted-foreground">Counted over the newest 2,000 people.</p>}
    </section>
  );
}

/** Vertical bars for one series; each bar's tooltip carries its exact value. */
function Bars({ label, values, labels, format, valueLabel, height = 96 }: {
  label: string; values: (number | null)[]; labels: string[]; format: (v: number, i: number) => string;
  /** Direct labels on each bar, for short series. */
  valueLabel?: (v: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return (
    <figure aria-label={label}>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
      <div className="mt-2 flex items-end gap-[2px] border-b border-border" style={{ height }}>
        {values.map((v, i) => (
          <div key={i} className="group relative flex h-full flex-1 items-end" title={v === null ? `${labels[i]}: not enough time yet` : `${labels[i]}: ${format(v, i)}`}>
            <div
              className={cn("relative w-full rounded-t-[4px]", v === null ? "border border-dashed border-border" : "bg-foreground/70 group-hover:bg-foreground")}
              style={{ height: v === null ? 4 : `${Math.max(2, (v / max) * 85)}%` }}
            >
              {valueLabel && v !== null && <span className="absolute -top-4 left-0 right-0 text-center text-[10px] tabular-nums text-foreground">{valueLabel(v)}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-muted-foreground">
        {labels.map((l, i) => <span key={i} className="flex-1 whitespace-nowrap text-center">{l}</span>)}
      </div>
    </figure>
  );
}

const weekLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function CadenceActivity({ cadences }: { cadences: { acceptanceDays: ReturnType<typeof cumulativeAcceptance>; funnelTruncated: boolean }[] }) {
  const totals = new Map<number, { at: number; invited: number; accepted: number }>();
  for (const cadence of cadences) {
    for (const day of cadence.acceptanceDays) {
      const total = totals.get(day.at) ?? { at: day.at, invited: 0, accepted: 0 };
      total.invited += day.invited;
      total.accepted += day.accepted;
      totals.set(day.at, total);
    }
  }
  const days = [...totals.values()].sort((a, b) => a.at - b.at);
  return (
    <section aria-label="Activity across cadences" className="mt-6 space-y-2">
      <h2 className="text-sm font-semibold">Activity across cadences</h2>
      <p className="text-xs text-muted-foreground">All listed cadences, including paused cadences.</p>
      {cadences.some((c) => c.funnelTruncated) && <p className="text-sm text-amber-600 dark:text-amber-400">Partial totals. Some enrollments are outside the dashboard scan limits.</p>}
      {days.length ? <CumulativeAcceptanceChart days={days} /> : <p className="text-sm text-muted-foreground">No invites in the loaded enrollments.</p>}
    </section>
  );
}

function CumulativeAcceptanceChart({ days }: { days: ReturnType<typeof cumulativeAcceptance> }) {
  if (days.length === 0) return null;
  const last = days[days.length - 1];
  const top = Math.max(1, last.invited);
  const x = (i: number) => 48 + i / Math.max(1, days.length - 1) * 656;
  const y = (n: number) => 192 - n / top * 176;
  const labels = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const ticks = [...new Set([0, Math.ceil(top / 2), top])];
  const series = [
    { key: "invited", label: "Invites sent", color: "var(--primary)" },
    { key: "accepted", label: "Acceptances", color: "var(--muted-foreground)" },
  ] as const;
  return (
    <figure aria-label="Cumulative campaign performance" className="w-full max-w-[720px]">
      <figcaption className="text-sm font-semibold">Campaign performance</figcaption>
      <p className="text-xs text-muted-foreground">Cumulative totals by date (UTC). Older acceptances use the time our sync noticed them.</p>
      <svg viewBox="0 0 720 220" className="mt-2 w-full text-muted-foreground" role="img" aria-label={`${last.invited} invites sent and ${last.accepted} acceptances, ${weekLabel(days[0].at)} to ${weekLabel(last.at)}`}>
        {ticks.map((n) => <g key={n}>
          <line x1="48" x2="704" y1={y(n)} y2={y(n)} stroke="currentColor" opacity="0.15" />
          <text x="40" y={y(n) + 4} textAnchor="end" fontSize="11" fill="currentColor">{n}</text>
        </g>)}
        {labels.map((i) => <text key={i} x={x(i)} y="212" textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize="11" fill="currentColor">{weekLabel(days[i].at)}</text>)}
        {series.map((s) => <g key={s.key}>
          <polyline points={days.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")} fill="none" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.key === "accepted" ? "5 3" : undefined} />
          {days.map((d, i) => <circle key={d.at} cx={x(i)} cy={y(d[s.key])} r="3" fill={s.color}>
            <title>{`${weekLabel(d.at)}: ${d[s.key]} ${s.label.toLowerCase()}`}</title>
          </circle>)}
        </g>)}
      </svg>
      <div className="flex flex-wrap gap-5 text-xs text-muted-foreground">
        {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="w-4 border-t-2" style={{ borderColor: s.color, borderStyle: s.key === "accepted" ? "dashed" : "solid" }} />{s.label} · {last[s.key]}</span>)}
      </div>
    </figure>
  );
}

/** How quickly invites are accepted, fairly (an N-day rate only counts invites at least N days old), and when people accept. */
export function AcceptanceCharts({ rows, timezone, now }: { rows: Timed[]; timezone: string; now: number }) {
  const curve = acceptanceCurve(rows, now);
  const times = acceptanceTimes(rows, timezone);
  if (!rows.some((r) => r.invitedAt != null)) return <p className="text-sm text-muted-foreground">No invites sent yet.</p>;
  const hourLabels = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? String(h) : ""));
  return (
    <section aria-label="Acceptance timing" className="space-y-4">
      <CumulativeAcceptanceChart days={cumulativeAcceptance(rows, now)} />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Bars
          label="Accepted within"
          values={curve.map((w) => rate(w.accepted, w.eligible))}
          labels={curve.map((w) => `${w.days}d`)}
          format={(v, i) => `${v}% (${curve[i].accepted} of ${curve[i].eligible} invites at least ${curve[i].days} days old)`}
          valueLabel={(v) => `${v}%`}
        />
        <Bars
          label={`Acceptances by hour (${timezone})`}
          values={times.counted ? times.byHour : times.byHour.map(() => null)}
          labels={hourLabels}
          format={(v, i) => `${i}:00 · ${v} accepted`}
        />
        <Bars
          label="Acceptances by weekday"
          values={times.counted ? times.byWeekday : times.byWeekday.map(() => null)}
          labels={WEEKDAYS}
          format={(v, i) => `${WEEKDAYS[i]} · ${v} accepted`}
        />
      </div>
      {times.approximate > 0 && (
        <p className="text-xs text-muted-foreground">
          {times.approximate} earlier acceptance{times.approximate === 1 ? "" : "s"} only have the time our sync noticed them, so the hour and weekday charts leave them out.
        </p>
      )}
    </section>
  );
}

/** Invites by the week they went out, each week's acceptance within 1 to 21 days. "·" marks a window that hasn't passed yet. */
export function CohortTable({ rows, now }: { rows: Timed[]; now: number }) {
  const cohorts = inviteCohorts(rows, now).slice(0, 12);
  if (cohorts.length === 0) return null;
  return (
    <section aria-label="Weekly cohorts">
      <h3 className="text-sm font-semibold">Acceptance by invite week</h3>
      <div className="mt-2 overflow-x-auto border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Invites sent week of</th>
              <th className="px-2 py-1 text-right font-medium">Invited</th>
              {ACCEPT_WITHIN_DAYS.map((d) => <th key={d} className="px-2 py-1 text-right font-medium">≤ {d}d</th>)}
              <th className="px-2 py-1 text-right font-medium">Accepted so far</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.weekStart} className="border-t border-border/60">
                <td className="px-2 py-1.5">{weekLabel(c.weekStart)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.invited}</td>
                {c.windows.map((w) => (
                  <td key={w.days} className="px-2 py-1.5 text-right tabular-nums" title={w.eligible ? `${w.accepted} of ${w.eligible}` : "Too recent"}>
                    {w.eligible ? pct(rate(w.accepted, w.eligible)) : <span className="text-muted-foreground">·</span>}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right tabular-nums">{pct(rate(c.accepted, c.invited))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export type Person = Timed & {
  _id: string; contactName: string; linkedinUrl: string; lastSentAt: number | null; reason: string | null;
  stepIndex: number; nextAt: number; position: number | null; eta: number | null;
};

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–");
const daysBetween = (a: number, b: number) => {
  const d = (b - a) / DAY_MS;
  return d < 1 ? `${Math.max(1, Math.round(d * 24))}h` : `${d.toFixed(d < 10 ? 1 : 0)}d`;
};

/** The people in one funnel stage, with when they were invited, accepted and last messaged. */
export function StagePeople({ people, stage, stateLabel, next, actions }: {
  people: Person[];
  stage: FunnelStage;
  stateLabel: Record<string, string>;
  next: (p: Person) => string;
  actions?: (p: Person) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const rows = people.filter((p) => inStage(p, stage));
  const pages = Math.max(1, Math.ceil(rows.length / PEOPLE_PER_PAGE));
  const shown = Math.min(page, pages - 1);
  const pageRows = rows.slice(shown * PEOPLE_PER_PAGE, (shown + 1) * PEOPLE_PER_PAGE);
  return (
    <section aria-label="People">
      <h3 className="text-sm font-semibold">{STAGE_LABEL[stage]} <span className="font-normal text-muted-foreground">· {rows.length}</span></h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nobody here yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Contact</th><th className="font-medium">State</th><th className="font-medium">Invited</th>
                <th className="font-medium">Accepted</th><th className="font-medium">Last message</th><th className="font-medium">Next</th><th className="font-medium">Note</th><th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((p) => {
                const accepted = acceptedAtOf(p);
                return (
                  <tr key={p._id} className="border-t border-border/60">
                    <td className="py-1.5"><a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="hover:underline">{p.contactName}</a></td>
                    <td>{stateLabel[p.state] ?? p.state}</td>
                    <td className="text-xs tabular-nums">{when(p.invitedAt ?? null)}</td>
                    <td className="text-xs tabular-nums">
                      {accepted && p.invitedAt ? <>{when(accepted)} <span className="text-muted-foreground">({daysBetween(p.invitedAt, accepted)}{p.acceptedAt ? "" : ", approx."})</span></> : p.connectedAt ? "Already connected" : "–"}
                    </td>
                    <td className="text-xs tabular-nums">{when(p.lastSentAt)}</td>
                    <td className="text-xs text-muted-foreground">{next(p)}</td>
                    <td className="text-xs text-muted-foreground">{p.reason ?? ""}</td>
                    <td>{actions?.(p)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{shown * PEOPLE_PER_PAGE + 1}–{shown * PEOPLE_PER_PAGE + pageRows.length} of {rows.length}</span>
              <button type="button" className={btn} disabled={shown === 0} onClick={() => setPage(shown - 1)}>Previous</button>
              <button type="button" className={btn} disabled={shown >= pages - 1} onClick={() => setPage(shown + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
