/**
 * Automation rules (CP17): the pure parts of running one. What a rule is (its
 * document and its sentence) is the kernel's, modules/kernel/automation.ts.
 * Here: which ledger entries may start it, whether an entry is the change its trigger names,
 * whether the record passes its conditions, and who round robin picks next.
 * convex/automations.ts drives it from the ledger.
 *
 * A rule acts on changes made in Canon now: by people, the API, MCP and
 * agents. It never acts on what integrations bring in (a CRM sync, a CSV or
 * CRM import, and every dated history point they carry: isHistoricalSource),
 * nor on a change its own action made. Each automated write is its own
 * source record, `automation:<ruleId>:<depth>:…`, so a rule recognizes its
 * writes and skips them, and a chain of rules stops at MAX_DEPTH.
 *
 * Free of database and Node-only imports.
 */
import { sameValue } from "./canon/policy.ts";
import type { EntryBody, EntrySource, EntryActor, FoldState } from "./objects/fold.ts";
import { compileListRequest, listRowOf, matchesFilter, type ListFilter, type ListRow } from "./objects/listSpec.ts";
import { FILTER_OPS } from "../../modules/kernel/reportLanguage.ts";
import type { FieldValue, ResolvedObjectDef } from "./objects/registry.ts";
import { localTime } from "./linkedin/limits.ts";

import {
  ACTIONS_MAX, CONDITIONS_MAX, MAX_DEPTH, TODAY,
  type AutomationAction, type Condition, type ScheduleTrigger, type Step, type Trigger,
} from "../../modules/kernel/automation.ts";

// ───────────────────────────── Origins ─────────────────────────────

export type AutomationMark = { ruleId: string; depth: number };

/** The prefix an automated write's source ref starts with: the rule and how deep in a chain of rules it is. */
export const automationRefPrefix = (m: AutomationMark) => `automation:${m.ruleId}:${m.depth}:`;

/** The rule that wrote an entry, from its source ref, or null for any other writer. */
export function automationMarkOf(ref: string): AutomationMark | null {
  const m = /^automation:([^:]+):(\d+):/.exec(ref);
  return m ? { ruleId: m[1], depth: Number(m[2]) } : null;
}

/** A dated past value an import carries (a CRM's history point, `…:history:…` or `hubspot-history:…`). */
const isHistoryRef = (ref: string) => /(^|:)history:|^hubspot-history:/.test(ref);
const INTEGRATION_SOURCES: ReadonlySet<string> = new Set(["salesforce", "hubspot", "import"]);

/**
 * Whether an entry may start a rule, and at what depth. Integrations and
 * imports never do (their history least of all); an automated write does at
 * its rule's depth, never at MAX_DEPTH or beyond.
 */
export function entryOrigin(source: EntrySource, actor: EntryActor): { ok: true; mark: AutomationMark | null; depth: number } | { ok: false; reason: string } {
  if (INTEGRATION_SOURCES.has(source.kind) || actor.kind === "integration") return { ok: false, reason: "integration" };
  if (isHistoryRef(source.ref)) return { ok: false, reason: "history" };
  const mark = automationMarkOf(source.ref);
  if (mark && mark.depth >= MAX_DEPTH) return { ok: false, reason: "depth" };
  return { ok: true, mark, depth: mark ? mark.depth : 0 };
}

// ───────────────────────────── Triggers ─────────────────────────────

/** The fields an entry changed (accepted asserts and decisions), by fieldId. A proposal changes nothing yet. */
export function changedFieldIds(body: EntryBody): string[] {
  if (body.kind === "assert") return body.status === "accepted" ? body.assertions.map((a) => a.fieldId) : [];
  if (body.kind === "decide") return body.decisions.filter((d) => d.status === "accepted").map((d) => d.fact.fieldId);
  return [];
}

/** The event an entry is for a rule's trigger, before values are compared: a cheap test that decides whether to fold. */
export function eventKind(version: number, body: EntryBody): "created" | "updated" | "deleted" | null {
  if (body.kind === "lifecycle") return body.op === "create" ? "created" : body.op === "delete" ? "deleted" : null;
  if (!changedFieldIds(body).length) return null;
  return version === 1 ? "created" : "updated";
}

const fieldIdOf = (def: ResolvedObjectDef, apiName: string) => def.byApiName.get(apiName)?.fieldId ?? null;

/** Whether an entry might be the trigger's change, from the entry alone. */
export function mayTrigger(trigger: Trigger, def: ResolvedObjectDef, version: number, body: EntryBody): boolean {
  const kind = eventKind(version, body);
  if (kind !== trigger.kind) return false;
  if (trigger.kind !== "updated" || !trigger.field) return true;
  const fieldId = fieldIdOf(def, trigger.field);
  return fieldId !== null && changedFieldIds(body).includes(fieldId);
}

const inList = (list: readonly (string | number | boolean)[] | undefined, value: FieldValue | undefined) =>
  !list?.length || (value !== null && value !== undefined && !Array.isArray(value) && list.some((x) => sameValue(x, value as string | number | boolean)));

/**
 * Whether the record's values before and after the entry are the trigger's
 * change. An update fires only when the field's value moved (a value said
 * again is no change), from one of `from` and to one of `to` when set.
 */
export function triggerFires(trigger: Trigger, def: ResolvedObjectDef, before: Record<string, FieldValue> | null, after: Record<string, FieldValue>): { fires: boolean; from?: FieldValue; to?: FieldValue } {
  if (trigger.kind !== "updated") return { fires: true };
  const fields = trigger.field ? [trigger.field] : def.fields.filter((f) => !f.system).map((f) => f.apiName);
  for (const apiName of fields) {
    const fieldId = fieldIdOf(def, apiName);
    if (!fieldId) continue;
    const from = before?.[fieldId] ?? null;
    const to = after[fieldId] ?? null;
    if (sameValue(from as never, to as never)) continue;
    if (inList(trigger.from, from) && inList(trigger.to, to)) return { fires: true, from, to };
  }
  return { fires: false };
}

// ───────────────────────────── Conditions ─────────────────────────────

/** The conditions as list filters, `{today}` read in `tz` at `now`. */
export function resolveConditions(def: ResolvedObjectDef, conditions: readonly Condition[], now: number, tz: string): ListFilter[] {
  return conditions.map((c) => {
    if (c.value !== TODAY) return c as ListFilter;
    const type = def.byApiName.get(c.field)?.type;
    return { ...c, value: type === "datetime" ? now : localTime(now, tz).date } as ListFilter;
  });
}

/** Why a rule's conditions cannot be checked on this object, or null: the list views' filter grammar, checked the same way. */
export function conditionsProblem(def: ResolvedObjectDef, conditions: readonly Condition[]): string | null {
  if (conditions.length > CONDITIONS_MAX) return `At most ${CONDITIONS_MAX} conditions`;
  const bad = conditions.find((c) => !(FILTER_OPS as readonly string[]).includes(c.op));
  if (bad) return `Unknown condition ${bad.op}`;
  try {
    compileListRequest(def, { filter: resolveConditions(def, conditions, 0, "UTC"), limit: 1 });
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Invalid condition";
  }
}

/** The record as the list views see it, so a condition means what the same filter means on a list. */
export const rowOf = (def: ResolvedObjectDef, state: FoldState, extra: Record<string, FieldValue> = {}): ListRow => {
  const row = listRowOf(def, state);
  return { ...row, values: { ...row.values, ...extra } };
};

/** Whether a record passes every condition (`{today}` in `tz`). */
export function conditionsMet(def: ResolvedObjectDef, row: ListRow, conditions: readonly Condition[], now = Date.now(), tz = "UTC"): boolean {
  if (!conditions.length) return true;
  const compiled = compileListRequest(def, { filter: resolveConditions(def, conditions, now, tz), limit: 1 });
  return compiled.filters.every((f) => matchesFilter(row, f));
}

// ───────────────────────────── Actions ─────────────────────────────

/** Why an action cannot run on this object, or null. */
export function actionProblem(def: ResolvedObjectDef, a: AutomationAction): string | null {
  if (a.kind === "set_field") {
    const f = def.byApiName.get(a.field);
    if (!f || f.system || f.archivedAt !== undefined) return `${def.label} has no field ${a.field}`;
    if (f.apiName === "ownerId") return "Use Assign owner to set the owner";
    return null;
  }
  if (a.kind === "assign_owner") {
    if (!def.byApiName.has("ownerId")) return `${def.pluralLabel} have no owner`;
    return a.owner.kind === "record_owner" ? "Pick who becomes the owner" : null;
  }
  if (!a.subject.trim()) return "A task needs a subject";
  if (!Number.isInteger(a.dueInDays) || a.dueInDays < 0 || a.dueInDays > 365) return "Due in 0 to 365 days";
  return null;
}

/**
 * The next member in turn: the pool from `index`, skipping members who are
 * no longer active. Returns who, and the index the rotation moves to.
 */
export function nextInTurn<T extends string>(pool: readonly T[], index: number, active: (id: T) => boolean): { userId: T; next: number } | null {
  for (let i = 0; i < pool.length; i++) {
    const at = (index + i) % pool.length;
    if (active(pool[at])) return { userId: pool[at], next: (at + 1) % pool.length };
  }
  return null;
}

/**
 * Round robin by weight (a `weighted` routing rule): one turn of the rotation,
 * where each member comes up `weight` times (a whole number, 1 to 100),
 * spread out (smooth weighted round robin), so weights 2 and 1 give A, B, A.
 */
export const WEIGHT_MAX = 100;
export function weightedCycle<T extends string>(assignees: ReadonlyArray<{ userId: T; weight?: number }>): T[] {
  const w = assignees.map((a) => Math.min(WEIGHT_MAX, Math.max(1, Math.round(a.weight ?? 1))));
  const total = w.reduce((x, y) => x + y, 0);
  const current = w.map(() => 0);
  const out: T[] = [];
  for (let n = 0; n < total; n++) {
    let best = 0;
    for (let i = 0; i < w.length; i++) {
      current[i] += w[i];
      if (current[i] > current[best]) best = i;
    }
    current[best] -= total;
    out.push(assignees[best].userId);
  }
  return out;
}

// ───────────────────────────── Schedules ─────────────────────────────

/** Records one slot of a scheduled rule acts on; past it the rest wait for the next slot. */
export const SLOT_CAP = 500;

/** Why a schedule cannot run, or null. */
export function scheduleProblem(t: ScheduleTrigger): string | null {
  if (!Number.isInteger(t.minute) || t.minute < 0 || t.minute >= 1440) return "Pick a time of day";
  if (t.cadence === "weekly" && (t.weekday === undefined || !Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6)) return "Pick a day of the week";
  return null;
}

const MINUTE = 60_000;
/** A local date and minute read as if UTC: the wall clock, comparable across instants. */
const wallAt = (at: number, tz: string) => {
  const t = localTime(at, tz);
  return Date.parse(`${t.date}T00:00:00Z`) + t.minute * MINUTE;
};

/**
 * The first slot after `after`: the next instant whose wall clock in `tz`
 * reads the schedule's minute (on its weekday, if weekly). A wall time that a
 * DST jump skips runs an hour later that day.
 */
export function nextSlot(t: ScheduleTrigger, after: number, tz: string): number {
  const base = Math.floor(after / MINUTE) * MINUTE;
  const lag = wallAt(base, tz) - base;
  const day0 = Date.parse(`${localTime(base, tz).date}T00:00:00Z`);
  for (let d = 0; d <= 8; d++) {
    const wall = day0 + d * 86_400_000 + t.minute * MINUTE;
    if (t.cadence === "weekly" && new Date(wall).getUTCDay() !== t.weekday) continue;
    let at = wall - lag;
    // The offset may differ on that day (a DST change in between): correct twice to settle.
    for (let i = 0; i < 2; i++) at += wall - wallAt(at, tz);
    if (at > after) return at;
  }
  throw new Error("No slot in the next eight days");
}

/** The date `days` after `now`, as a date field stores it (YYYY-MM-DD, UTC). */
export const dueDate = (now: number, days: number) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);

/** A run's starting steps: one per action, all pending. */
export const initialSteps = (actions: readonly AutomationAction[]): Step[] => actions.map((a) => ({ kind: a.kind, status: "pending", attempts: 0 }));
