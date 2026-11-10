/**
 * An account's or contact's tasks, notes, calls and meetings: the records whose
 * `accountId` or `contactId` lookup names it, read from each object's projection
 * with one bounded list.
 * Pure: the caller passes the record client.
 */
import type { ListResponse, ListRow, ProjectedThrough } from "./objects/listSpec";
import type { FieldValue } from "./objects/registry";
import type { RecordClient } from "./recordClient";
import type { ModuleActivity as DeclaredModuleActivity } from "../../modules/kernel/activities.ts";

export const ACTIVITY_OBJECTS = ["note", "task", "call", "meeting"] as const;
export type ActivityObject = (typeof ACTIVITY_OBJECTS)[number];

/** Activities read per object. */
export const ACTIVITIES_PER_OBJECT = 50;

/** A record an activity is about. `name` is its title as the register lists it. */
export type TargetObject = "account" | "contact" | "deal" | "lead";
export type ActivityTarget = { object: TargetObject; id: string; name: string };

/** `targets` is set when a timeline names the records an activity is about (convex/activityTargets.ts). */
type Common = { id: string; at: number; ownerId: string | null; targets?: ActivityTarget[] };

export type ModuleActivity = Common & DeclaredModuleActivity;
export type ModuleActivityRef = { object: "account" | "contact"; id: string } | { object: "deal"; id: string; dealId: string };
export type ModuleActivityRow = { activity: ModuleActivity; createdAt: number; refs: ModuleActivityRef[] };

/** What an id names: the register's ids carry a prefix; a deal's or a lead's is its stream id, so an unprefixed id is read as a deal (targetNames tells the two apart). */
export const targetObjectOf = (id: string): "account" | "contact" | "deal" => (id.startsWith("acc_") ? "account" : id.startsWith("con_") ? "contact" : "deal");

/** One activity on a timeline. `at` places it: a call's time, a meeting's start, else when it was logged. */
export type Activity =
  | ModuleActivity
  | (Common & { kind: "note"; body: string })
  | (Common & { kind: "task"; subject: string; dueDate: string | null; status: string | null })
  | (Common & { kind: "call"; subject: string | null; outcome: string | null })
  | (Common & { kind: "meeting"; title: string; startAt: number });
export type LedgerActivity = Exclude<Activity, ModuleActivity>;

const text = (v: FieldValue | undefined) => (typeof v === "string" && v !== "" ? v : null);
const time = (v: FieldValue | undefined) => (typeof v === "number" ? v : null);

export function activityOf(object: ActivityObject, row: ListRow): LedgerActivity {
  const v = row.values;
  const common = { id: row.id, ownerId: text(v.ownerId) };
  switch (object) {
    case "note":
      return { ...common, kind: "note", at: row.createdAt, body: text(v.body) ?? row.title };
    case "task":
      return { ...common, kind: "task", at: row.createdAt, subject: text(v.subject) ?? row.title, dueDate: text(v.dueDate), status: text(v.status) };
    case "call":
      return { ...common, kind: "call", at: time(v.callAt) ?? row.createdAt, subject: text(v.subject), outcome: text(v.outcome) };
    case "meeting": {
      const startAt = time(v.startAt) ?? row.createdAt;
      return { ...common, kind: "meeting", at: startAt, title: text(v.title) ?? row.title, startAt };
    }
  }
}

/** Per shard, the lowest cursor of the lists: the activities reflect every save at or below it. */
function lowestThrough(pages: readonly ListResponse[]): ProjectedThrough {
  const shards = new Set(pages.flatMap((p) => Object.keys(p.projectedThrough)));
  return Object.fromEntries([...shards].map((s) => [s, Math.min(...pages.map((p) => p.projectedThrough[s] ?? 0))]));
}

/** How to find activities: by a lookup naming a record, or by their own ids. `id` is a register id, a deal's stream id, or a list of them. */
export type ActivityLink = { field: "accountId" | "contactId" | "dealId" | "id"; id: string | readonly string[] };

/** The records each activity names in its lookups, by activity id. */
export type LookupTargets = Record<string, string[]>;

/** The activities a link finds, newest logged first per object, and the records each names in its lookups. */
export async function linkedActivities(
  client: Pick<RecordClient, "listObjects">, ws: string, link: ActivityLink,
): Promise<{ activities: LedgerActivity[]; projectedThrough: ProjectedThrough; lookups: LookupTargets }> {
  const ids = typeof link.id === "string" ? [link.id] : link.id;
  if (!ids.length) return { activities: [], projectedThrough: {}, lookups: {} };
  const filter = typeof link.id === "string" ? { field: link.field, op: "eq" as const, value: link.id } : { field: link.field, op: "in" as const, value: [...ids] };
  const pages = await Promise.all(ACTIVITY_OBJECTS.map((object) => client.listObjects(ws, object, {
    filter: [filter], sort: { field: "createdAt", dir: "desc" }, limit: ACTIVITIES_PER_OBJECT,
  })));
  const rows = ACTIVITY_OBJECTS.flatMap((object, i) => pages[i]?.rows.map((row) => ({ object, row })) ?? []);
  const lookups = Object.fromEntries(rows.map(({ row }) => [row.id, (["accountId", "contactId", "dealId"] as const).flatMap((f) => text(row.values[f]) ?? [])]));
  return { activities: rows.map(({ object, row }) => activityOf(object, row)), projectedThrough: lowestThrough(pages), lookups };
}

/** Titles of records by id, from the register (companies, people), the deals list and the leads list. A deleted or unknown id is left out. */
export async function targetNames(client: Pick<RecordClient, "listRegister" | "listObjects">, ws: string, ids: readonly string[]): Promise<Map<string, ActivityTarget>> {
  const by: Record<"account" | "contact" | "deal", string[]> = { account: [], contact: [], deal: [] };
  for (const id of new Set(ids)) by[targetObjectOf(id)].push(id);
  const read = async (object: TargetObject, wanted: readonly string[]): Promise<ActivityTarget[]> => {
    if (!wanted.length) return [];
    const req = { filter: [{ field: "id", op: "in" as const, value: [...wanted] }], limit: wanted.length };
    const page = object === "deal" || object === "lead" ? await client.listObjects(ws, object, req) : await client.listRegister(ws, object, req);
    return page.rows.map((r) => ({ object, id: r.id, name: r.title || r.id }));
  };
  const [accounts, contacts, deals] = await Promise.all([read("account", by.account), read("contact", by.contact), read("deal", by.deal)]);
  // A lead's id is a stream id, as a deal's is: the ones no deal claims are asked of the leads.
  const claimed = new Set(deals.map((d) => d.id));
  const leads = await read("lead", by.deal.filter((id) => !claimed.has(id)));
  return new Map([...accounts, ...contacts, ...deals, ...leads].map((t) => [t.id, t]));
}
