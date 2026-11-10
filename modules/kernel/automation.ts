/**
 * Automation rules: the document a rule is, and the sentence a person reads it as. One trigger, up to ten conditions
 * (the list views' filters) and up to ten ordered actions, where an If step branches on the record (two Ifs deep at
 * most). Canon's executor (convex/automations.ts) runs these;
 * nothing here reads a database. `describe` renders a rule in the words the automations page shows, so an agent can
 * show its user the same sentence before it proposes one.
 */
import { v, type Infer } from "convex/values";
import type { FilterOp } from "./reportLanguage.ts";

/** Rules one workspace keeps, and actions and conditions one rule has. */
export const RULES_MAX = 50;
export const ACTIONS_MAX = 10;
export const CONDITIONS_MAX = 10;
/** Steps one rule has in all: every action, every If and every step in an If's branches. */
export const STEPS_MAX = 25;
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

/** The actions that each do one thing. */
const LEAVES = [
  v.object({ kind: v.literal("set_field"), field: v.string(), value: v.union(scalar, v.null()) }),
  v.object({ kind: v.literal("create_task"), subject: v.string(), dueInDays: v.number(), owner: ownerChoiceValidator }),
  v.object({ kind: v.literal("assign_owner"), owner: ownerChoiceValidator }),
  /**
   * Wait `days` whole days, or until the date in the record's own date field `until` (start of that day in the
   * workspace's time zone; a date and time, that moment), then go on. Exactly one of the two. An empty or past date
   * doesn't wait.
   */
  v.object({ kind: v.literal("wait"), days: v.optional(v.number()), until: v.optional(v.string()) }),
] as const;
export const leafActionValidator = v.union(...LEAVES);

/**
 * An If step: when the record, as it is when the run reaches the step, passes `conditions`, the run goes on into
 * `then`; otherwise into `else`, or past the step when it has none. A condition may name a field of a record the
 * record looks up, as `<lookup>.<field>` (a deal's `companyId.industry`), read as the rule's member sees it. An If
 * holds another If one level down, and that one holds only actions.
 */
const innerIfValidator = v.object({ kind: v.literal("if"), conditions: v.array(conditionValidator), then: v.array(leafActionValidator), else: v.optional(v.array(leafActionValidator)) });
const branchStepValidator = v.union(...LEAVES, innerIfValidator);
export const ifStepValidator = v.object({ kind: v.literal("if"), conditions: v.array(conditionValidator), then: v.array(branchStepValidator), else: v.optional(v.array(branchStepValidator)) });

export const actionValidator = v.union(...LEAVES, ifStepValidator);

/** The two ways out of an If. */
export const BRANCHES = ["then", "else"] as const;
export type Branch = (typeof BRANCHES)[number];
const branchValidator = v.union(v.literal("then"), v.literal("else"));

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
  /** Where the step sits in the rule (`stepAt`); absent on a run from before Ifs, where it is the step's position. */
  ref: v.optional(v.string()),
  /** An If's way out: the run's path through the rule is its Ifs' branches, in order. */
  branch: v.optional(branchValidator),
});

export type Trigger = Infer<typeof triggerValidator>;
export type ScheduleTrigger = Extract<Trigger, { kind: "schedule" }>;
export type Condition = Infer<typeof conditionValidator>;
export type OwnerChoice = Infer<typeof ownerChoiceValidator>;
export type AutomationAction = Infer<typeof actionValidator>;
export type LeafAction = Infer<typeof leafActionValidator>;
export type Step = Infer<typeof stepValidator>;

/** Days one Wait step may wait. */
export const WAIT_DAYS_MAX = 365;

/** A step anywhere in a rule: an action, or an If with its branches. */
export type RuleStep = LeafAction | IfStep;
export type IfStep = { kind: "if"; conditions: readonly Condition[]; then: readonly RuleStep[]; else?: readonly RuleStep[] };

/**
 * Where a step sits in a rule, as a ref: "2" is the third action, "2.then.0" the first step of its Then, and
 * "2.else.1.then.0" one If deeper. Null when the ref names no step.
 */
export function stepAt(steps: readonly RuleStep[], ref: string): RuleStep | null {
  const parts = ref.split(".");
  let list: readonly RuleStep[] | undefined = steps;
  let node: RuleStep | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    node = list && Number.isInteger(n) ? list[n] ?? null : null;
    if (!node) return null;
    if (i + 1 < parts.length) {
      if (node.kind !== "if") return null;
      list = parts[i + 1] === "then" ? node.then : parts[i + 1] === "else" ? node.else : undefined;
    }
  }
  return node;
}

/** Every step of a rule with its ref and how many Ifs it sits in, each If before its branches. */
export function walkSteps(steps: readonly RuleStep[], prefix = "", depth = 0): Array<{ ref: string; step: RuleStep; depth: number }> {
  return steps.flatMap((step, i) => {
    const ref = `${prefix}${i}`;
    const inner = step.kind === "if" ? BRANCHES.flatMap((b) => walkSteps(step[b] ?? [], `${ref}.${b}.`, depth + 1)) : [];
    return [{ ref, step, depth }, ...inner];
  });
}

/**
 * The lookup and the related record's field a condition names (`companyId.industry`), or null for the record's own
 * field. A custom field's own name has a dot (`custom.priority`), so a name that is one of the record's fields (`own`)
 * is its own; otherwise the lookup is the first dotted prefix that is (`custom.account.custom.tier`).
 */
export function relatedField(field: string, own: (apiName: string) => boolean): { via: string; field: string } | null {
  if (own(field)) return null;
  for (let dot = field.indexOf("."); dot > 0; dot = field.indexOf(".", dot + 1)) {
    if (own(field.slice(0, dot))) return { via: field.slice(0, dot), field: field.slice(dot + 1) };
  }
  return null;
}

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
 * What a replay found, as a proposal keeps it: how often the rule would have run over the window (`since` to `at`)
 * and on which records (the first ones, with when), how many changes it would have skipped and why, whether it read
 * the whole window (`partial`, read `through` when not), and what it read as it is now rather than as it was.
 */
export const replaySummaryValidator = v.object({
  at: v.number(),
  by: v.id("users"),
  since: v.number(),
  wouldRun: v.number(),
  /** `path`: the way it would have gone through the rule's Ifs. */
  runs: v.array(v.object({ streamId: v.string(), at: v.number(), title: v.string(), path: v.optional(v.array(v.object({ ref: v.string(), took: branchValidator }))) })),
  skipped: v.array(v.object({ reason: v.string(), count: v.number() })),
  partial: v.boolean(),
  through: v.union(v.number(), v.null()),
  scanned: v.number(),
  notes: v.array(v.string()),
});
export type ReplaySummary = Infer<typeof replaySummaryValidator>;

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
  /** The record each of the object's lookups points at, by the lookup's field: what `<lookup>.<field>` names. */
  related?: Readonly<Record<string, { label: string; fields: readonly DescribedField[] }>>;
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
  const own = (apiName: string | undefined) => names.object?.fields.find((f) => f.apiName === apiName);
  // Without the object's fields every name reads as its own.
  const isOwn = (apiName: string) => !names.object || own(apiName) !== undefined;
  const fieldOf = (apiName: string | undefined) => {
    const rel = apiName ? relatedField(apiName, isOwn) : null;
    return rel ? names.related?.[rel.via]?.fields.find((f) => f.apiName === rel.field) : own(apiName);
  };
  const fieldName = (apiName: string) => {
    const rel = relatedField(apiName, isOwn);
    if (!rel) return own(apiName)?.label ?? apiName;
    return `${own(rel.via)?.label ?? names.related?.[rel.via]?.label ?? rel.via}'s ${fieldOf(apiName)?.label ?? rel.field}`;
  };
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

  const conditions = (cs: readonly Condition[]) => cs.map(condition).join(" and ");
  const branch = (steps: readonly RuleStep[]) => (steps.length ? steps.map(action).join(", then ") : "do nothing");

  /** Each step as a clause; an If's in brackets, so a nested one reads unambiguously. A new kind fails to compile until it reads. */
  const ACTIONS: { [K in RuleStep["kind"]]: (a: Extract<RuleStep, { kind: K }>) => string } = {
    set_field: (a) => (a.value === null || a.value === "" ? `clear ${fieldName(a.field)}` : `set ${fieldName(a.field)} to ${value(a.field, a.value)}`),
    create_task: (a) => `create a task "${a.subject}" for ${owner(a.owner)}, due ${a.dueInDays === 0 ? "the same day" : `in ${plural(a.dueInDays, "day")}`}`,
    assign_owner: (a) => `assign it to ${owner(a.owner)}`,
    wait: (a) => (a.until ? `wait until the ${noun}'s ${fieldName(a.until)}` : `wait ${plural(a.days ?? 0, "day")}`),
    if: (a) => `if ${conditions(a.conditions)} (${branch(a.then)}${a.else?.length ? `; otherwise ${branch(a.else)}` : ""})`,
  };
  function action(a: RuleStep): string {
    return (ACTIONS[a.kind] as (a: RuleStep) => string)(a);
  }

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

  return { trigger, condition, conditions, action };
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

/** An If's conditions in the sentence's words ("Account's Industry is SaaS and Amount is over $50,000"). */
export function describeConditions(object: string, conditions: readonly Condition[], names: RuleNames = {}): string {
  return phrases({ object, trigger: { kind: "created" }, conditions: [], actions: [] }, names).conditions(conditions);
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
