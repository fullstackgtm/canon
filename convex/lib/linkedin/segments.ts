/**
 * A cadence's results split by a trait of the people in it (docs/linkedin-cadences.md,
 * "Segments"): title, company, seniority, time in role, or recent LinkedIn activity.
 * Each segment counts the people and the cadence's funnel, so acceptance and response
 * rates compare across segments.
 *
 * Pure: no database access, no Node-only imports.
 */
import { NONE } from "../../../services/record-service/src/dimensions.ts";
import { seniorityOf } from "../staging.ts";
import { funnelOf, rate, type EnrollmentState } from "./cadence.ts";

export const SEGMENT_DIMENSIONS = ["title", "company", "seniority", "tenure", "activity"] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];
export const SEGMENT_LABEL: Record<SegmentDimension, string> = {
  title: "Title",
  company: "Company",
  seniority: "Seniority",
  tenure: "Time in current role",
  activity: "Recent LinkedIn activity",
};

/** Title and company keep their largest segments; the rest are one "Other" row. */
export const SEGMENTS_MAX = 12;
export const UNKNOWN = "Unknown";
export const OTHER = "Other";

const DAY = 86_400_000;
const YEAR = 365 * DAY;

/** What is known about one person in the cadence, from their contact record and the sender's activity check. */
export type SegmentPerson = {
  state: EnrollmentState;
  invitedAt?: number | null;
  connectedAt?: number | null;
  lastSentAt?: number | null;
  title: string | null;
  company: string | null;
  /** The profile's own seniority (enrichment), when there is one; otherwise it is read from the title. */
  seniority: string | null;
  /** When they started their current role: "2024-05-01", or anything Date.parse reads. */
  roleStart: string | null;
  /** The sender's last activity check: null when never checked; lastActiveAt null when nothing was found. */
  activity: { lastActiveAt: number | null; checkedAt: number } | null;
};

export type SegmentRow = {
  segment: string;
  people: number;
  invited: number;
  accepted: number;
  /** Accepted plus already connected: everyone a message could reach. */
  connected: number;
  replied: number;
  acceptRate: number | null;
  responseRate: number | null;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SENIORITY_LABEL: Record<string, string> = { cxo: "C-level", c_suite: "C-level", vp: "VP" };
const seniorityLabel = (s: string) => SENIORITY_LABEL[s.toLowerCase()] ?? cap(s.replace(/_/g, " "));

/** One title for many spellings: "VP, Sales " and "vp sales" are the same segment. */
export function titleKey(title: string | null): string {
  const t = (title ?? "").toLowerCase().replace(/[^a-z0-9&+/ ]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? cap(t) : UNKNOWN;
}

export function tenureBand(roleStart: string | null, now: number): string {
  const start = roleStart ? Date.parse(roleStart) : NaN;
  if (!Number.isFinite(start) || start > now) return UNKNOWN;
  const years = (now - start) / YEAR;
  return years < 1 ? "Under 1 year" : years < 3 ? "1–3 years" : years < 5 ? "3–5 years" : "5+ years";
}

export function activityBand(activity: SegmentPerson["activity"], now: number): string {
  if (!activity) return "Not checked";
  if (activity.lastActiveAt === null) return "No posts or comments found";
  const days = (now - activity.lastActiveAt) / DAY;
  return days <= 30 ? "Active in last 30 days" : days <= 90 ? "Active 31–90 days ago" : "Quiet over 90 days";
}

const ORDER: Partial<Record<SegmentDimension, string[]>> = {
  tenure: ["Under 1 year", "1–3 years", "3–5 years", "5+ years", UNKNOWN],
  activity: ["Active in last 30 days", "Active 31–90 days ago", "Quiet over 90 days", "No posts or comments found", "Not checked"],
};

export function segmentOf(p: SegmentPerson, by: SegmentDimension, now: number): string {
  switch (by) {
    case "title": return titleKey(p.title);
    case "company": return p.company?.trim() || UNKNOWN;
    case "seniority": {
      const own = p.seniority?.trim();
      if (own) return seniorityLabel(own);
      const fromTitle = seniorityOf(p.title ?? undefined);
      return fromTitle === NONE ? UNKNOWN : seniorityLabel(fromTitle);
    }
    case "tenure": return tenureBand(p.roleStart, now);
    case "activity": return activityBand(p.activity, now);
  }
}

function rowFor(segment: string, people: SegmentPerson[]): SegmentRow {
  const f = funnelOf(people);
  const connected = f.accepted + f.alreadyConnected;
  return {
    segment, people: f.enrolled, invited: f.invited, accepted: f.accepted, connected, replied: f.replied,
    acceptRate: rate(f.accepted, f.invited), responseRate: rate(f.replied, connected),
  };
}

/** The cadence's people grouped by one trait, largest first (fixed order for bands); small title and company groups fold into "Other". */
export function segmentBreakdown(people: readonly SegmentPerson[], by: SegmentDimension, now: number): SegmentRow[] {
  const groups = new Map<string, SegmentPerson[]>();
  // A title group shows the first spelling seen ("VP, Sales"), not its key.
  const shown = new Map<string, string>();
  for (const p of people) {
    const key = segmentOf(p, by, now);
    groups.set(key, [...(groups.get(key) ?? []), p]);
    if (by === "title" && key !== UNKNOWN && !shown.has(key)) shown.set(key, p.title!.trim().replace(/\s+/g, " "));
  }
  const rowOf = (key: string, ps: SegmentPerson[]) => rowFor(shown.get(key) ?? key, ps);
  const order = ORDER[by];
  if (order) return order.filter((k) => groups.has(k)).map((k) => rowOf(k, groups.get(k)!));
  const sorted = [...groups].sort((a, b) => (a[0] === UNKNOWN ? 1 : b[0] === UNKNOWN ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])));
  const known = sorted.filter(([k]) => k !== UNKNOWN);
  const unknown = sorted.find(([k]) => k === UNKNOWN);
  const kept = known.slice(0, SEGMENTS_MAX);
  const rest = known.slice(SEGMENTS_MAX).flatMap(([, ps]) => ps);
  return [
    ...kept.map(([k, ps]) => rowOf(k, ps)),
    ...(rest.length ? [rowFor(OTHER, rest)] : []),
    ...(unknown ? [rowOf(UNKNOWN, unknown[1])] : []),
  ];
}
