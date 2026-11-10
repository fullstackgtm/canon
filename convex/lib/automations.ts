/**
 * Automation rules (CP17): the pure parts of running one. What a rule is (its
 * document and its sentence) is the kernel's, modules/kernel/automation.ts.
 * Here: which ledger entries may start it, whether an entry is the change its trigger names,
 * whether the record passes its conditions and an If's, and who round robin picks next.
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
  CONDITIONS_MAX, MAX_DEPTH, TODAY, WAIT_DAYS_MAX, relatedField,
  type AutomationAction, type Branch, type Condition, type IfStep, type LeafAction, type RuleStep, type ScheduleTrigger, type Step, type Trigger,
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

// ───────────────────────────── Ifs ─────────────────────────────

/** A related record as an If reads it: its object's definition (the list views' one), and its row, or null when it is missing or out of the member's sight. */
export type Related = { def: ResolvedObjectDef; row: ListRow | null };

/** The lookup and related field a condition on `def` names, or null for one of its own fields (relatedField). */
export const relatedOf = (def: ResolvedObjectDef, field: string) => relatedField(field, (apiName) => def.byApiName.has(apiName));

/** The lookups an If's conditions read through (`companyId` for `companyId.industry`). */
export const relatedVias = (def: ResolvedObjectDef, conditions: readonly Condition[]): string[] => [...new Set(conditions.flatMap((c) => relatedOf(def, c.field)?.via ?? []))];

/**
 * Whether an If's conditions hold: the record's own fields from `row`, a related record's from `related` by the
 * lookup. A related record that is missing or that the member can't see reads as one whose every field is empty.
 */
export function ifHolds(def: ResolvedObjectDef, row: ListRow, conditions: readonly Condition[], related: Readonly<Record<string, Related>>, now: number, tz: string): boolean {
  return conditions.every((c) => {
    const rel = relatedOf(def, c.field);
    if (!rel) return conditionsMet(def, row, [c], now, tz);
    const r = related[rel.via];
    const blank: ListRow = { id: "", object: r?.def.apiName ?? "", version: 0, status: "active", title: "", createdAt: 0, updatedAt: 0, deletedAt: null, values: {} };
    return !!r && conditionsMet(r.def, r.row ?? blank, [{ ...c, field: rel.field }], now, tz);
  });
}

/** The way through a rule's Ifs, each decided by `holds`, as a run takes it: an If's ref and the branch it took, in order. */
export function pathThrough(steps: readonly RuleStep[], holds: (s: IfStep) => boolean, prefix = ""): Array<{ ref: string; took: Branch }> {
  return steps.flatMap((s, i) => {
    if (s.kind !== "if") return [];
    const ref = `${prefix}${i}`;
    const took: Branch = holds(s) ? "then" : "else";
    return [{ ref, took }, ...pathThrough(s[took] ?? [], holds, `${ref}.${took}.`)];
  });
}

// ───────────────────────────── Actions ─────────────────────────────

/** Why an action cannot run on this object, or null. */
export function actionProblem(def: ResolvedObjectDef, a: LeafAction): string | null {
  if (a.kind === "notify_slack") {
    if (!SLACK_NAME.test(a.channel.replace(/^#/, "").toLowerCase())) return "Name the Slack channel as Settings > Outbound maps it";
    return messageProblem(a.message);
  }
  if (a.kind === "notify_email") return a.subject.trim() && a.subject.length <= SUBJECT_MAX ? messageProblem(a.message) : `An email needs a subject of up to ${SUBJECT_MAX} characters`;
  if (a.kind === "call_webhook") return a.endpointId ? null : "Pick a webhook";
  if (a.kind === "wait") {
    if ((a.days === undefined) === (a.until === undefined)) return "A wait is a number of days or a date field, not both";
    if (a.days !== undefined) return Number.isInteger(a.days) && a.days >= 1 && a.days <= WAIT_DAYS_MAX ? null : `Wait 1 to ${WAIT_DAYS_MAX} days`;
    const f = def.byApiName.get(a.until!);
    return f && (f.type === "date" || f.type === "datetime") && f.archivedAt === undefined ? null : `${def.label} has no date field ${a.until}`;
  }
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

// ───────────────────────────── Messages ─────────────────────────────

/** A Slack channel's name as Settings > Outbound maps it (convex/outbound.ts mapSlack). */
export const SLACK_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const MESSAGE_MAX = 2000;
const SUBJECT_MAX = 200;
const messageProblem = (m: string) => (m.trim() && m.length <= MESSAGE_MAX ? null : `A message has 1 to ${MESSAGE_MAX} characters`);

/** A field's value as a message reads it: an option's label, money in whole units, Yes or No, a list joined. Empty reads "". */
function plainValue(def: ResolvedObjectDef, apiName: string, value: FieldValue | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const f = def.byApiName.get(apiName);
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (f && "options" in f && f.options) return f.options.find((o) => o.value === value)?.label ?? String(value);
  if (f?.type === "currency" && typeof value === "number") return (value / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(value);
}

/**
 * A notify step's text, filled from the record as the rule's member sees it: `{record}` is its name, `{<field>}` a
 * field's value (a field hidden from them, or one the record doesn't have, reads empty). Other braces stay as written.
 */
export function renderMessage(template: string, def: ResolvedObjectDef, row: ListRow): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (all, name: string) => {
    if (name === "record") return row.title || "the record";
    const f = def.byApiName.get(name);
    return f ? plainValue(def, name, row.values[f.fieldId]) : all;
  }).slice(0, MESSAGE_MAX);
}

/** The instant a date (YYYY-MM-DD) starts in `tz`: its local midnight. */
export function startOfDay(date: string, tz: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  let at = wall - (wallAt(wall, tz) - wall);
  // The offset may differ on that day (a DST change in between): correct once more to settle.
  at += wall - wallAt(at, tz);
  return at;
}

/**
 * When a Wait step that `now` reaches resumes: `days` later, or at the record's date (`value`, its `until` field as the
 * member sees it: a date starts at its local midnight, a date and time is that moment). Null when there is nothing to
 * wait for: an empty date, or one that has passed.
 */
export function resumeAt(step: { days?: number; until?: string }, value: FieldValue | undefined, now: number, tz: string): number | null {
  if (step.days !== undefined) return now + step.days * 86_400_000;
  const at = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? startOfDay(value, tz) : null;
  return at !== null && at > now ? at : null;
}

/** The date `days` after `now`, as a date field stores it (YYYY-MM-DD, UTC). */
export const dueDate = (now: number, days: number) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);

/** A run's starting steps: one per action, all pending. An If's branch joins the steps when the run reaches it. */
export const initialSteps = (actions: readonly AutomationAction[]): Step[] => actions.map((a, i) => ({ kind: a.kind, status: "pending", attempts: 0, ref: String(i) }));

/** The pending steps of the branch an If took, right after it, each with its ref. */
export const branchSteps = (ref: string, took: Branch, steps: readonly RuleStep[]): Step[] =>
  steps.map((a, i) => ({ kind: a.kind, status: "pending", attempts: 0, ref: `${ref}.${took}.${i}` }));
