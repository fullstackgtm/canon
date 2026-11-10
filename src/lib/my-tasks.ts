/**
 * The My tasks list's shape. A task's `dueDate` is a plain calendar day
 * (YYYY-MM-DD, no time zone), so "today" is the viewer's local calendar day:
 * the browser computes it and passes it in. Pure, so the grouping is testable.
 */
export type TaskRow = { id: string; subject: string; dueDate: string | null; status: string | null };

export type TaskGroupKey = "overdue" | "today" | "upcoming" | "none";
export type TaskGroups = Record<TaskGroupKey, TaskRow[]>;

export const GROUP_LABELS: Record<TaskGroupKey, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", none: "No due date" };
export const GROUP_ORDER: readonly TaskGroupKey[] = ["overdue", "today", "upcoming", "none"];

/** A task is done when its status is completed; every other status (including none) is open. */
export const isDone = (status: string | null) => status === "completed";

/** The viewer's local calendar day as YYYY-MM-DD. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Open tasks split into Overdue, Today, Upcoming and No due date; each group by due date, then subject. */
export function groupTasks(tasks: readonly TaskRow[], today: string): TaskGroups {
  const groups: TaskGroups = { overdue: [], today: [], upcoming: [], none: [] };
  for (const t of tasks) {
    if (isDone(t.status)) continue;
    const key: TaskGroupKey = !t.dueDate ? "none" : t.dueDate < today ? "overdue" : t.dueDate === today ? "today" : "upcoming";
    groups[key].push(t);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.subject.localeCompare(b.subject));
  }
  return groups;
}

/** The nav badge: open tasks that are overdue or due today. */
export const dueCount = (groups: TaskGroups) => groups.overdue.length + groups.today.length;
