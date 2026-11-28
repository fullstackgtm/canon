import type { Activity, ActivityComposerKind } from "../convex/lib/activities.ts";
import type { TimelineItem } from "../convex/lib/timeline.ts";
import { offered, type PageAction } from "./actions.ts";
import { activityComposerKinds, type PageKind, type RecordProps } from "./blocks.ts";
import type { Context } from "./conditions.ts";

export const ACTIVITY_LABELS: Record<ActivityComposerKind, string> = {
  note: "Note", task: "Task", call: "Call", meeting: "Meeting", email: "Email",
};

const defaultActions = [
  { id: "logActivity", runs: "kernel.logActivity", label: "<kind>" },
  { id: "draftEmail", runs: "kernel.saveGmailDraft", label: "Save draft" },
] satisfies PageAction[];

export function activityComposerOffers(object: PageKind, composer: RecordProps<"activity">["composer"], actions: readonly PageAction[] | undefined, context: Context) {
  const supported = activityComposerKinds(object);
  return [...new Set(composer ?? supported)].flatMap((kind) => {
    if (!supported.some((option) => option === kind)) return [];
    const runs = kind === "email" ? "kernel.saveGmailDraft" : "kernel.logActivity";
    const [offer] = offered(actions?.length ? actions : defaultActions, "activity", [runs], context, { kind: ACTIVITY_LABELS[kind] }, object);
    return offer ? [{ kind, ...offer }] : [];
  });
}

export type ActivityItem = Activity | Extract<TimelineItem, { kind: "email" }>;
type ActivityFilter = NonNullable<RecordProps<"activity">["filter"]>;
type Group = NonNullable<RecordProps<"activity">["group"]>;
type DatedItem = { item: ActivityItem; at: number; pending: boolean; date?: string };

export const activityKind = (item: ActivityItem) => item.kind === "module" ? item.activityKind : item.kind;
export const activityOwner = (item: ActivityItem) => item.kind === "email" ? item.event.userId : item.ownerId;

function timelineDate(item: ActivityItem, now: number): DatedItem {
  if (item.kind === "task" && item.status !== "completed") {
    const at = item.dueDate ? Date.parse(`${item.dueDate}T00:00:00`) : NaN;
    if (item.dueDate && Number.isFinite(at)) return { item, at, pending: true, date: item.dueDate };
    return { item, at: item.at, pending: true };
  }
  if (item.kind === "module" && item.date) {
    const at = Date.parse(`${item.date}T00:00:00`);
    const today = new Date(now).setHours(0, 0, 0, 0);
    if (Number.isFinite(at)) return { item, at, pending: at >= today, date: item.date };
  }
  return { item, at: item.at, pending: item.at > now };
}

export function activityTimeline(
  items: readonly ActivityItem[], filter: ActivityFilter, group: Group, now: number, viewerId?: string,
) {
  const rows = items.map((item) => timelineDate(item, now)).filter(({ item, pending }) =>
    (!filter.kinds || filter.kinds.includes(activityKind(item))) &&
    (!filter.mine || Boolean(viewerId && viewerId === activityOwner(item))) &&
    (filter.range === "upcoming" ? pending : filter.range === "past" ? !pending : true),
  );
  rows.sort((a, b) => b.at - a.at);
  if (group === "none") return [{ label: "", rows }];
  if (group === "upcomingOverdue") {
    const pending = rows.filter((row) => row.pending).sort((a, b) => {
      const orderAt = (row: DatedItem) => row.item.kind === "task" && !row.date ? Infinity : row.at;
      return orderAt(a) - orderAt(b);
    });
    return [
      { label: "Upcoming & Overdue", rows: pending },
      { label: "Past activity", rows: rows.filter((row) => !row.pending) },
    ].filter(({ rows }) => rows.length);
  }
  const days = new Map<string, DatedItem[]>();
  for (const row of rows) {
    const day = new Date(row.at).toLocaleDateString(undefined, { dateStyle: "long" });
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(row);
  }
  return [...days].map(([label, rows]) => ({ label, rows }));
}
