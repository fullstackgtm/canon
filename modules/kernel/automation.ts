/**
 * Automation rules: the document a rule is, and the sentence a person reads it as. One trigger, up to ten conditions
 * (the list views' filters) and up to ten ordered actions. Canon's executor (convex/automations.ts) runs these;
 * nothing here reads a database. `describe` renders a rule in the words the automations page shows, so an agent can
 * show its user the same sentence before it proposes one.
 */
import { v, type Infer } from "convex/values";
import type { FilterOp } from "./reportLanguage.ts";

/** Rules one workspace keeps, and actions and conditions one rule has. */
export const RULES_MAX = 50;
export const ACTIONS_MAX = 10;
export const CONDITIONS_MAX = 10;
/** A rule's write may start another rule's run, down to this depth; an entry written at it starts nothing. */
export const MAX_DEPTH = 3;

/** Objects a rule can watch and act on in this release: the ones Convex writes whole (companies and people live in the record service). */
export const AUTOMATION_OBJECTS = ["deal", "lead", "task"] as const;
export const isAutomationObject = (o: string): boolean => (AUTOMATION_OBJECTS as readonly string[]).includes(o) || o.startsWith("custom_");

/**
 * A condition on a date may compare with `{today}`, the workspace's date when the rule checks it ("close date is
 * less than today"); on a date and time, with now. The list grammar itself has no relative dates.
 */
export const TODAY = "{today}";

const scalar = v.union(v.string(), v.number(), v.boolean());

export const triggerValidator = v.union(
  v.object({ kind: v.literal("created") }),
  /** A field changed (any field when `field` is absent), optionally from one of `from` and to one of `to`. */
  v.object({ kind: v.literal("updated"), field: v.optional(v.string()), from: v.optional(v.array(scalar)), to: v.optional(v.array(scalar)) }),
  v.object({ kind: v.literal("deleted") }),
  /**
   * Daily, or weekly on `weekday` (0 Sunday to 6 Saturday), at `minute` past local midnight in the workspace's time
   * zone: over the records that match the rule's conditions then.
   */
  v.object({ kind: v.literal("schedule"), cadence: v.union(v.literal("daily"), v.literal("weekly")), minute: v.number(), weekday: v.optional(v.number()) }),
);

export const conditionValidator = v.object({ field: v.string(), op: v.string(), value: v.optional(v.any()) });

/**
 * Who a task or a record is given to: one member; the triggering record's own owner (tasks only); or the next in
 * turn of a member list, a team, or a saved routing rule (whose rotation it advances, so those rules run here).
 */
export const ownerChoiceValidator = v.union(
  v.object({ kind: v.literal("member"), userId: v.id("users") }),
  v.object({ kind: v.literal("record_owner") }),
  v.object({ kind: v.literal("round_robin"), userIds: v.array(v.id("users")) }),
  v.object({ kind: v.literal("team"), teamId: v.id("teamGroups") }),
  v.object({ kind: v.literal("routing_rule"), routingRuleId: v.id("routingRules") }),
);

export const actionValidator = v.union(
  v.object({ kind: v.literal("set_field"), field: v.string(), value: v.union(scalar, v.null()) }),
  v.object({ kind: v.literal("create_task"), subject: v.string(), dueInDays: v.number(), owner: ownerChoiceValidator }),
  v.object({ kind: v.literal("assign_owner"), owner: ownerChoiceValidator }),
);

/** One action's progress in a run. */
export const stepValidator = v.object({
  kind: v.string(),
  status: v.union(v.literal("pending"), v.literal("done"), v.literal("failed"), v.literal("skipped")),
  attempts: v.number(),
  /** What it did ("Task created", "Owner set to Avery") or why it failed. */
  detail: v.optional(v.string()),
  /** The record it made or changed, for the run log's link. */
  streamId: v.optional(v.string()),
  at: v.optional(v.number()),
});

export type Trigger = Infer<typeof triggerValidator>;
export type ScheduleTrigger = Extract<Trigger, { kind: "schedule" }>;
export type Condition = Infer<typeof conditionValidator>;
export type OwnerChoice = Infer<typeof ownerChoiceValidator>;
export type AutomationAction = Infer<typeof actionValidator>;
export type Step = Infer<typeof stepValidator>;

/** What a rule is, without its name: the part `describe` reads. */
export type RuleShape = { object: string; trigger: Trigger; conditions: readonly Condition[]; actions: readonly AutomationAction[] };

/** A rule's whole document: what a version stores, what an agent proposes and what an admin approves. */
export const ruleDocValidator = v.object({
  name: v.string(),
  object: v.string(),
  trigger: triggerValidator,
  conditions: v.array(conditionValidator),
  actions: v.array(actionValidator),
});
export type RuleDoc = Infer<typeof ruleDocValidator>;

/**
 * A version's life: `proposed` waits for an admin; `approved` is the one in force; `superseded` was in force before a
 * later approval; `rejected` was turned down, with a reason.
 */
export const VERSION_STATUSES = ["proposed", "approved", "rejected", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * Who wrote a version: the member whose session or token sent it, and the agent client that wrote it when an agent
 * did (an MCP or CLI caller, by its OAuth client). The ledger records the same member as the actor of its writes.
 */
export const versionAuthorValidator = v.object({ userId: v.id("users"), agent: v.optional(v.string()) });
export type VersionAuthor = Infer<typeof versionAuthorValidator>;

// ───────────────────────────── The sentence ─────────────────────────────

type Scalar = string | number | boolean;

/** A field as the sentence names it, with its options' labels. */
export type DescribedField = { apiName: string; label: string; type?: string; options?: ReadonlyArray<{ value: string; label: string }> };

/** Names a sentence uses for what a rule points at. Anything missing reads as its id, or as "a former member". */
export type RuleNames = {
  object?: { label: string; fields: readonly DescribedField[] };
  members?: ReadonlyArray<{ id: string; name: string }>;
  teams?: ReadonlyArray<{ id: string; name: string }>;
  routingRules?: ReadonlyArray<{ id: string; name: string }>;
  timezone?: string;
  /** The workspace's currency (ISO 4217), for currency fields. */
  currency?: string;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/** "Deal" reads "deal" mid-sentence; a label with capitals inside ("SaaS plan") keeps them. */
const lower = (label: string) => (/^[A-Z][a-z]/.test(label) && label.slice(1) === label.slice(1).toLowerCase() ? label[0].toLowerCase() + label.slice(1) : label);
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items: readonly string[], joiner: "and" | "or") =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`;

/** How each condition operator reads, by the field's kind of value. A new operator fails to compile until it reads. */
const OPS: Record<FilterOp, { plain: string; date?: string; none?: true }> = {
  eq: { plain: "is", date: "is" },
  neq: { plain: "is not", date: "is not" },
  in: { plain: "is one of" },
  contains: { plain: "contains" },
  startsWith: { plain: "starts with" },
  gt: { plain: "is over", date: "is after" },
  gte: { plain: "is at least", date: "is on or after" },
  lt: { plain: "is under", date: "is before" },
  lte: { plain: "is at most", date: "is on or before" },
  hasAny: { plain: "includes any of" },
  hasAll: { plain: "includes all of" },
  empty: { plain: "is empty", none: true },
  notEmpty: { plain: "is not empty", none: true },
};
/** The phrases one rule's sentence is built from, over the names it was given. */
function phrases(rule: RuleShape, names: RuleNames) {
  const label = names.object?.label ?? rule.object;
  const noun = lower(label);
  const fieldOf = (apiName: string | undefined) => names.object?.fields.find((f) => f.apiName === apiName);
  const fieldName = (apiName: string) => fieldOf(apiName)?.label ?? apiName;
  const member = (id: string) => names.members?.find((m) => m.id === id)?.name ?? "a former member";
  const value = (apiName: string, x: unknown): string => {
    const f = fieldOf(apiName);
    if (x === TODAY) return "today";
    if (x === null || x === undefined || x === "") return "empty";
    if (typeof x === "boolean") return x ? "Yes" : "No";
    if (Array.isArray(x)) return list(x.map((y) => value(apiName, y)), "or");
    if (f?.options) return f.options.find((o) => o.value === x)?.label ?? String(x);
    if (f?.type === "user" && typeof x === "string") return member(x);
    // Money is stored in cents (convex/schema.ts), as a condition on it compares.
    if (typeof x === "number" && f?.type === "currency") {
      const digits = { minimumFractionDigits: x % 100 ? 2 : 0, maximumFractionDigits: 2 };
      try {
        if (names.currency) return new Intl.NumberFormat("en-US", { style: "currency", currency: names.currency, ...digits }).format(x / 100);
      } catch {
        // An unknown currency code reads as a plain amount.
      }
      return (x / 100).toLocaleString("en-US", digits);
    }
    if (typeof x === "number") return x.toLocaleString("en-US");
    return String(x);
  };
  const values = (apiName: string, xs: readonly Scalar[]) => list(xs.map((x) => value(apiName, x)), "or");
  const isDate = (apiName: string) => ["date", "datetime"].includes(fieldOf(apiName)?.type ?? "");

  const condition = (c: Condition) => {
    const op = OPS[c.op as FilterOp];
    if (!op) return `${fieldName(c.field)} ${c.op} ${value(c.field, c.value)}`;
    const words = (isDate(c.field) ? op.date : undefined) ?? op.plain;
    return op.none ? `${fieldName(c.field)} ${words}` : `${fieldName(c.field)} ${words} ${value(c.field, c.value)}`;
  };

  /** Who an owner choice names, after "for" or "to". A new kind fails to compile until it reads. */
  const OWNERS: { [K in OwnerChoice["kind"]]: (o: Extract<OwnerChoice, { kind: K }>) => string } = {
    member: (o) => member(o.userId),
    record_owner: () => `the ${noun}'s owner`,
    round_robin: (o) => (o.userIds.length ? `the next of ${list(o.userIds.map(member), "and")} in turn` : "the next member in turn (nobody picked yet)"),
    team: (o) => `the next member of the ${names.teams?.find((t) => t.id === o.teamId)?.name ?? "deleted"} team`,
    routing_rule: (o) => `whoever the routing rule ${names.routingRules?.find((r) => r.id === o.routingRuleId)?.name ?? "(deleted)"} picks`,
  };
  const owner = (o: OwnerChoice) => (OWNERS[o.kind] as (o: OwnerChoice) => string)(o);

  /** Each action as a clause. A new kind fails to compile until it reads. */
  const ACTIONS: { [K in AutomationAction["kind"]]: (a: Extract<AutomationAction, { kind: K }>) => string } = {
    set_field: (a) => (a.value === null || a.value === "" ? `clear ${fieldName(a.field)}` : `set ${fieldName(a.field)} to ${value(a.field, a.value)}`),
    create_task: (a) => `create a task "${a.subject}" for ${owner(a.owner)}, due ${a.dueInDays === 0 ? "the same day" : `in ${plural(a.dueInDays, "day")}`}`,
    assign_owner: (a) => `assign it to ${owner(a.owner)}`,
  };
  const action = (a: AutomationAction) => (ACTIONS[a.kind] as (a: AutomationAction) => string)(a);

  /** The trigger, as the sentence opens. A new kind fails to compile until it reads. */
  const TRIGGERS: { [K in Trigger["kind"]]: (t: Extract<Trigger, { kind: K }>) => string } = {
    created: () => `When ${article(noun)} ${noun} is created`,
    deleted: () => `When ${article(noun)} ${noun} is deleted`,
    updated: (t) => {
      const what = t.field ? `${article(noun)} ${noun}'s ${fieldName(t.field)} changes` : `any field of ${article(noun)} ${noun} changes`;
      const from = t.field && t.from?.length ? ` from ${values(t.field, t.from)}` : "";
      const to = t.field && t.to?.length ? ` to ${values(t.field, t.to)}` : "";
      return `When ${what}${from}${to}`;
    },
    schedule: (t) => `${t.cadence === "weekly" ? `Every ${DAYS[t.weekday ?? 1] ?? "week"}` : "Every day"} at ${clock(t.minute)}${names.timezone ? ` (${names.timezone})` : ""}, for each ${noun}`,
  };
  const trigger = (t: Trigger) => (TRIGGERS[t.kind] as (t: Trigger) => string)(t);

  return { trigger, condition, action };
}

/**
 * A rule as one sentence: "When a deal's Stage changes to Proposal and Amount is over $50,000: assign it to the
 * next member of the Enterprise team, then create a task "Send the security review" for the deal's owner, due in 2 days."
 */
export function describe(rule: RuleShape, names: RuleNames = {}): string {
  const p = phrases(rule, names);
  const conds = rule.conditions.map(p.condition);
  const joiner = rule.trigger.kind === "schedule" ? " where " : " and ";
  const actions = rule.actions.length ? rule.actions.map(p.action).join(", then ") : "do nothing yet";
  return `${p.trigger(rule.trigger)}${conds.length ? `${joiner}${conds.join(" and ")}` : ""}: ${actions}.`;
}

/** The parts of the sentence, for a view that lays them out (the canvas): the trigger, each condition, each action. */
export function describeParts(rule: RuleShape, names: RuleNames = {}): { trigger: string; conditions: string[]; actions: string[] } {
  const p = phrases(rule, names);
  return { trigger: p.trigger(rule.trigger), conditions: rule.conditions.map(p.condition), actions: rule.actions.map(p.action) };
}

/** One part of a rule that a new version changes, each side in the sentence's words (absent: the part is new or gone). */
export type RuleChange = { part: "name" | "object" | "trigger" | "condition" | "action"; before?: string; after?: string };

/**
 * What a proposed version changes against the one in force, part by part: the name, the object, the trigger, each
 * condition and each action in order. Unchanged parts are left out, so an approver reads only what moves.
 */
export function ruleChanges(before: RuleDoc | null, after: RuleDoc, names: RuleNames = {}): RuleChange[] {
  const b = before ? describeParts(before, names) : null;
  const a = describeParts(after, names);
  const out: RuleChange[] = [];
  const pair = (part: RuleChange["part"], x: string | undefined, y: string | undefined) => {
    if (x !== y) out.push({ part, ...(x !== undefined ? { before: x } : {}), ...(y !== undefined ? { after: y } : {}) });
  };
  pair("name", before?.name, after.name);
  pair("object", before?.object, after.object);
  pair("trigger", b?.trigger, a.trigger);
  const conditions = new Set(a.conditions);
  const had = new Set(b?.conditions ?? []);
  for (const c of b?.conditions ?? []) if (!conditions.has(c)) pair("condition", c, undefined);
  for (const c of a.conditions) if (!had.has(c)) pair("condition", undefined, c);
  for (let i = 0; i < Math.max(a.actions.length, b?.actions.length ?? 0); i++) pair("action", b?.actions[i], a.actions[i]);
  return out;
}
