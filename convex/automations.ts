/**
 * Automation rules (CP17): when a record changes, do something. An admin
 * builds a rule: a trigger (a record is created, a field changes, a record is
 * deleted), conditions (the list views' filters) and ordered actions (set a
 * field, create a task, assign an owner). The pure parts are in
 * lib/automations.ts. A scheduled rule (daily or weekly) acts instead on the
 * records matching its conditions at each slot ("Schedules" below).
 *
 * Driver: the ledger, as for record webhooks. Each org keeps one cursor per
 * shard (`automationCursors`). `fanout` reads the entries after it, inserts
 * one run per (rule, entry) the trigger matches and moves the cursor in ONE
 * transaction, so an entry starts each rule at most once whatever crashes. It
 * runs after every ledger append for an org with an active rule
 * (lib/automationWake.ts) and from the one-minute sweep.
 *
 * Execution: `execute` runs a run's steps in order, one mutation each. A
 * step's write and the step's `done` commit together, so a replay (the sweep
 * re-sending a run whose executor died) never repeats an action: each action
 * happens once per (rule, ledger seq, action). A step that throws is rolled
 * back and recorded `failed`; later steps wait, and Retry resumes there.
 *
 * Principal: a rule acts as its creator, with the creator's access as it is
 * now (permissions.principalAccess): a record they cannot see does not run
 * it, and every write goes through the checks the creator's own edit takes
 * (objects.requireWritable: role, visibility, field permissions; then the
 * save path's validation rules). A rule whose creator left pauses. Its writes
 * are its own source record (`automation:<ruleId>:<depth>:user:<id>`), shown
 * in history as the rule's, and never start the same rule again.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor, entitySight, principalAccess, requireWriteAccess, roleIn, workspaceMembers } from "./permissions";
import { refuseNarrowed, type Access } from "./lib/access";
import { callerClient, principalClient, requireCaller } from "./records";
import { validTimezone } from "./lib/linkedin/limits";
import type { ListFilter } from "./lib/objects/listSpec";
import { shardHeads } from "./ledgerFeed";
import { asEntry, loadDef, recordVisibleTo, requireWritable, saveAsCaller, saveDealAsCaller } from "./objects";
import { LEAD_READ_ONLY } from "./lib/objects/describe";
import { attachTargets } from "./activityTargets";
import { boundedPage } from "./lib/objects/tail";
import { foldAll, project, type EntryBody, type FoldState } from "./lib/objects/fold";
import { fromStored } from "./lib/objects/validators";
import type { Provenance } from "../recipes/templates.ts";
import { SHARDS } from "./lib/objects/write";
import { coerce, type FieldValue, type ResolvedObjectDef } from "./lib/objects/registry";
import { isCustomObjectName } from "../modules/kernel/reportLanguage";
import { archivedObjectNames } from "./lib/objects/orgDefs";
import {
  ACTIONS_MAX, AUTOMATION_OBJECTS, RULES_MAX, SLOT_CAP, actionProblem, actionValidator, conditionValidator, conditionsMet, conditionsProblem, dueDate,
  entryOrigin, initialSteps, isAutomationObject, mayTrigger, nextInTurn, nextSlot, resolveConditions, rowOf, scheduleProblem, triggerFires, triggerValidator,
  weightedCycle, type AutomationAction, type AutomationMark, type Condition, type OwnerChoice, type Step, type Trigger,
} from "./lib/automations";

/** Ledger entries one fan-out reads per shard, and stream entries it may fold in all before it hands the rest to a continuation. */
const BATCH = 25;
const SHARD_BYTES = 400_000;
const FOLD_BUDGET = 4000;
/** A record whose history is longer than this is not compared; its run says so. */
const FOLD_CAP = 500;
/** A running executor that has not moved a step this long is presumed dead. */
const LEASE_MS = 120_000;
const RUNS_SHOWN = 25;
const KEEP_RUNS_MS = 30 * 24 * 60 * 60_000;
const ERROR_MAX = 300;
const NAME_MAX = 120;
const POOL_MAX = 50;
/** Matching records a scheduled rule reads per page of its slot, and a dry run shows. */
const SLOT_PAGE = 50;
const PREVIEW_ROWS = 25;

/** The workspace's time zone, which schedules and `{today}` read; UTC when it has none that parses. */
async function timezoneOf(ctx: QueryCtx, orgId: Id<"organizations">): Promise<string> {
  const tz = (await ctx.db.get(orgId))?.timezone;
  return tz && validTimezone(tz) ? tz : "UTC";
}

/** When a rule's next slot is due: none for a rule a change triggers. */
async function slotAfter(ctx: QueryCtx, orgId: Id<"organizations">, trigger: Trigger, after: number): Promise<number | undefined> {
  return trigger.kind === "schedule" ? nextSlot(trigger, after, await timezoneOf(ctx, orgId)) : undefined;
}

// ───────────────────────────── Who may manage ─────────────────────────────

/** The signed-in admin, outside a "view as" preview (which changes nothing). */
export async function requireAdmin(ctx: MutationCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!can(user, "automations.manage")) throw new ConvexError(refusal("automations.manage"));
  // A rule and its run log reach every record of its object: never for a role that sees only part of them.
  refuseNarrowed(await requireWriteAccess(ctx, user), "Automation rules");
  return user;
}

/** The signed-in admin for a read, or null. A run log names records, so a role that sees only some of them reads none. */
async function adminReader(ctx: QueryCtx): Promise<{ user: Doc<"users">; access: Access } | null> {
  const user = await getCurrentUser(ctx);
  if (!user || !can(user, "automations.manage")) return null;
  const access = await accessFor(ctx, user);
  try {
    refuseNarrowed(access, "Automation runs");
  } catch {
    return null;
  }
  return access.preview ? null : { user, access };
}

async function ownRule(ctx: QueryCtx, orgId: Id<"organizations">, id: Id<"automationRules">) {
  const rule = await ctx.db.get(id);
  if (!rule || rule.orgId !== orgId) throw new ConvexError("Rule not found");
  return rule;
}

// ───────────────────────────── Checking a rule ─────────────────────────────

export type RuleInput = { name: string; object: string; trigger: Trigger; conditions: Condition[]; actions: AutomationAction[] };

async function activeMember(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return !!user && (await roleIn(ctx, user, orgId)) !== null;
}

async function checkOwner(ctx: QueryCtx, orgId: Id<"organizations">, owner: OwnerChoice) {
  if (owner.kind === "member" && !(await activeMember(ctx, orgId, owner.userId))) throw new ConvexError("That owner is not a member of this workspace");
  if (owner.kind === "round_robin") {
    if (!owner.userIds.length || owner.userIds.length > POOL_MAX) throw new ConvexError(`Round robin needs 1 to ${POOL_MAX} members`);
    for (const id of owner.userIds) if (!(await activeMember(ctx, orgId, id))) throw new ConvexError("Every member in the rotation must be in this workspace");
  }
  if (owner.kind === "team") {
    const team = await ctx.db.get(owner.teamId);
    if (!team || team.orgId !== orgId) throw new ConvexError("Team not found");
  }
  if (owner.kind === "routing_rule") {
    const routing = await ctx.db.get(owner.routingRuleId);
    if (!routing || routing.orgId !== orgId) throw new ConvexError("Routing rule not found");
  }
}

/** The rule as saved, or a refusal saying what is wrong with it. */
async function checkRule(ctx: QueryCtx, orgId: Id<"organizations">, input: RuleInput): Promise<RuleInput> {
  const name = input.name.trim().slice(0, NAME_MAX);
  if (!name) throw new ConvexError("Name the rule");
  if (!isAutomationObject(input.object)) throw new ConvexError(`Rules do not run on ${input.object} records yet`);
  if (isCustomObjectName(input.object) && (await archivedObjectNames(ctx, orgId)).has(input.object)) throw new ConvexError("That object is archived");
  const def = await loadDef(ctx, orgId, input.object);
  const t = input.trigger;
  if (t.kind === "updated" && t.field) {
    const f = def.byApiName.get(t.field);
    if (!f || f.system) throw new ConvexError(`${def.label} has no field ${t.field}`);
  }
  if (t.kind === "schedule") {
    const bad = scheduleProblem(t);
    if (bad) throw new ConvexError(bad);
  }
  const problem = conditionsProblem(def, input.conditions);
  if (problem) throw new ConvexError(problem);
  if (!input.actions.length) throw new ConvexError("Add at least one action");
  if (input.actions.length > ACTIONS_MAX) throw new ConvexError(`At most ${ACTIONS_MAX} actions`);
  for (const a of input.actions) {
    const bad = actionProblem(def, a);
    if (bad) throw new ConvexError(bad);
    if (a.kind === "set_field") {
      // A conversion sets these (convex/leadConversion.ts), never an edit or a rule.
      if (input.object === "lead" && (LEAD_READ_ONLY as readonly string[]).includes(a.field)) throw new ConvexError("Convert a lead to set this field");
      const coerced = coerce(def, { [a.field]: a.value }, { mode: "update" });
      if (!coerced.ok) throw new ConvexError(coerced.errors.map((e) => e.message).join("; "));
    }
    if (a.kind !== "set_field") await checkOwner(ctx, orgId, a.owner);
  }
  return { ...input, name };
}

/** Make sure the org's cursor exists. With no other active rule it restarts at the heads: there is nothing behind it to read. */
async function ensureCursor(ctx: MutationCtx, orgId: Id<"organizations">, except: Id<"automationRules"> | null) {
  const heads = await shardHeads(ctx, orgId);
  const row = await ctx.db.query("automationCursors").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
  if (!row) return void (await ctx.db.insert("automationCursors", { orgId, cursors: heads }));
  const others = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active")).take(RULES_MAX);
  if (!others.some((r) => r._id !== except)) await ctx.db.patch(row._id, { cursors: heads });
  return heads;
}

const audit = (ctx: MutationCtx, user: Doc<"users">, operation: string, details: Record<string, unknown>) =>
  ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation, status: "applied", details, createdAt: Date.now() });

// ───────────────────────────── Admin surface ─────────────────────────────

const ruleArgs = { name: v.string(), object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator), actions: v.array(actionValidator) };

/**
 * Check and store a rule as `user`. It runs from now, or with `paused` it waits for an admin to resume it, which
 * starts it from that moment (setStatus). A recipe's template installs paused, with its provenance.
 */
export async function insertRule(ctx: MutationCtx, user: Doc<"users">, input: RuleInput, opts: { paused?: string; recipe?: Provenance } = {}): Promise<Id<"automationRules">> {
  const rule = await checkRule(ctx, user.orgId, input);
  const existing = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId)).take(RULES_MAX);
  if (existing.length >= RULES_MAX) throw new ConvexError(`A workspace can have ${RULES_MAX} rules`);
  const now = Date.now();
  if (!opts.paused) await ensureCursor(ctx, user.orgId, null);
  const nextSlotAt = opts.paused ? undefined : await slotAfter(ctx, user.orgId, rule.trigger, now);
  const id = await ctx.db.insert("automationRules", {
    orgId: user.orgId, ...rule, createdBy: user._id, activeSince: now, startSeqs: await shardHeads(ctx, user.orgId),
    ...(opts.paused ? { status: "paused" as const, pausedReason: opts.paused } : { status: "active" as const }),
    ...(nextSlotAt !== undefined ? { nextSlotAt } : {}), ...(opts.recipe ? { recipe: opts.recipe } : {}), createdAt: now, updatedAt: now,
  });
  await audit(ctx, user, "automation_rule.create", { ruleId: id, name: rule.name, ...(opts.recipe ? { recipe: opts.recipe } : {}) });
  return id;
}

export const create = mutation({
  args: ruleArgs,
  handler: async (ctx, args) => insertRule(ctx, await requireAdmin(ctx), args),
});

/** Change a rule. It keeps running from where it is; a changed action list restarts its rotations. */
export const update = mutation({
  args: { id: v.id("automationRules"), ...ruleArgs },
  handler: async (ctx, { id, ...args }) => {
    const user = await requireAdmin(ctx);
    const existing = await ownRule(ctx, user.orgId, id);
    const rule = await checkRule(ctx, user.orgId, args);
    const actionsChanged = JSON.stringify(rule.actions) !== JSON.stringify(existing.actions);
    // A changed schedule takes effect from its next slot; a slot under way finishes as it began.
    const scheduleChanged = JSON.stringify(rule.trigger) !== JSON.stringify(existing.trigger);
    const now = Date.now();
    await ctx.db.patch(id, {
      ...rule, ...(actionsChanged ? { rotation: {} } : {}), ...(scheduleChanged ? { nextSlotAt: await slotAfter(ctx, user.orgId, rule.trigger, now) } : {}), updatedAt: now,
    });
    await audit(ctx, user, "automation_rule.update", { ruleId: id, name: rule.name });
    return null;
  },
});

/** Pause or resume. A resumed rule acts on changes from now on, never on what happened while it was paused. */
export const setStatus = mutation({
  args: { id: v.id("automationRules"), status: v.union(v.literal("active"), v.literal("paused")) },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const rule = await ownRule(ctx, user.orgId, args.id);
    if (rule.status === args.status) return null;
    const now = Date.now();
    if (args.status === "paused") {
      await ctx.db.patch(rule._id, { status: "paused", pausedReason: `Paused by ${user.name}`, updatedAt: now });
    } else {
      await ensureCursor(ctx, user.orgId, rule._id);
      // A resumed schedule waits for its next slot: the slots it missed while paused never run.
      await ctx.db.patch(rule._id, {
        status: "active", pausedReason: undefined, activeSince: now, startSeqs: await shardHeads(ctx, user.orgId), nextSlotAt: await slotAfter(ctx, rule.orgId, rule.trigger, now), updatedAt: now,
      });
    }
    await audit(ctx, user, `automation_rule.${args.status === "paused" ? "pause" : "resume"}`, { ruleId: rule._id, name: rule.name });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("automationRules") },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const rule = await ownRule(ctx, user.orgId, args.id);
    await ctx.db.delete(rule._id);
    await audit(ctx, user, "automation_rule.delete", { ruleId: rule._id, name: rule.name });
    return null;
  },
});

/** Run a failed run's failed action again, then the ones after it. */
export const retryRun = mutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId) throw new ConvexError("Run not found");
    if (run.status !== "failed") throw new ConvexError("Only a failed run can be retried");
    const steps = run.steps.map((s): Step => (s.status === "failed" ? { ...s, status: "pending" } : s));
    await ctx.db.patch(run._id, { status: "pending", steps, leaseUntil: Date.now() + LEASE_MS, finishedAt: undefined });
    await ctx.scheduler.runAfter(0, internal.automations.execute, { runId: run._id });
    return null;
  },
});

const ruleView = async (ctx: QueryCtx, r: Doc<"automationRules">) => {
  const last = await ctx.db.query("automationRuns").withIndex("by_ruleId_and_createdAt", (q) => q.eq("ruleId", r._id)).order("desc").first();
  const creator = await ctx.db.get(r.createdBy);
  return {
    id: r._id, name: r.name, object: r.object, trigger: r.trigger, conditions: r.conditions, actions: r.actions, status: r.status,
    pausedReason: r.pausedReason ?? null, createdBy: creator?.name ?? "A former member", createdAt: r.createdAt, recipe: r.recipe ?? null,
    lastRun: last ? { status: last.status, at: last.createdAt } : null,
    nextSlotAt: r.status === "active" ? r.nextSlotAt ?? null : null,
    lastSlot: r.slotRun ? { at: r.slotRun.slot, runs: r.slotRun.count, done: r.slotRun.done, note: r.slotRun.note ?? null } : null,
  };
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    const rules = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", admin.user.orgId)).take(RULES_MAX);
    const out = [];
    for (const r of rules.sort((a, b) => a.createdAt - b.createdAt)) out.push(await ruleView(ctx, r));
    return out;
  },
});

/** What the builder offers: the objects rules run on and their fields, members, teams and saved routing rules. */
export const workspace = query({
  args: {},
  handler: async (ctx) => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    const orgId = admin.user.orgId;
    const customs = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId)).take(100);
    const archived = await archivedObjectNames(ctx, orgId);
    const names = [...AUTOMATION_OBJECTS, ...customs.flatMap((c) => (c.object && !archived.has(c.apiName) ? [c.apiName] : []))];
    const objects = [];
    for (const name of names) {
      const def = await loadDef(ctx, orgId, name);
      objects.push({
        apiName: def.apiName, label: def.label, pluralLabel: def.pluralLabel,
        fields: def.fields.filter((f) => !f.system && f.archivedAt === undefined).map((f) => ({
          apiName: f.apiName, label: f.label, type: f.type,
          ...("options" in f && f.options ? { options: f.options.filter((o) => o.active !== false).map((o) => ({ value: o.value, label: o.label })) } : {}),
        })),
      });
    }
    const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(100);
    const routing = await ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(50);
    return {
      objects,
      timezone: await timezoneOf(ctx, orgId),
      members: (await workspaceMembers(ctx, orgId)).map((m) => ({ id: m.id, name: m.name })),
      teams: teams.map((t) => ({ id: t._id, name: t.name, size: t.memberIds.length })),
      routingRules: routing.map((r) => ({ id: r._id, name: r.name, size: r.assignees.length, isActive: r.isActive })),
    };
  },
});

/** A rule's latest runs: each trigger, whether the record met the conditions, and each action's outcome. */
export const runs = query({
  args: { ruleId: v.id("automationRules") },
  handler: async (ctx, args) => {
    const admin = await adminReader(ctx);
    const rule = admin ? await ctx.db.get(args.ruleId) : null;
    if (!admin || !rule || rule.orgId !== admin.user.orgId) return [];
    const rows = await ctx.db.query("automationRuns").withIndex("by_ruleId_and_createdAt", (q) => q.eq("ruleId", rule._id)).order("desc").take(RUNS_SHOWN);
    return rows.map((r) => ({
      id: r._id, streamId: r.streamId, object: r.object, title: r.title, event: r.event, change: r.change ?? null, matched: r.matched,
      status: r.status, reason: r.reason ?? null, depth: r.depth, steps: r.steps, createdAt: r.createdAt, finishedAt: r.finishedAt ?? null, triggeredAt: r.triggeredAt ?? null,
    }));
  },
});

/** Rule names, for history lines a rule wrote ("Rule: Proposal follow-up"). Any member: a name says nothing about a record. */
export const labels = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rules = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId)).take(RULES_MAX);
    return rules.map((r) => ({ id: r._id as string, name: r.name }));
  },
});

// ───────────────────────────── Principal ─────────────────────────────

type Principal = { user: Doc<"users">; access: Access };

/** The rule's creator as they act now in its workspace, or null once they are no longer a member. */
async function principalOf(ctx: QueryCtx, rule: Doc<"automationRules">): Promise<Principal | null> {
  const creator = await ctx.db.get(rule.createdBy);
  const role = creator ? await roleIn(ctx, creator, rule.orgId) : null;
  const accesses = creator && role ? await principalAccess(ctx, rule.orgId, [creator._id]) : null;
  if (!creator || !role || !accesses) return null;
  return { user: { ...creator, orgId: rule.orgId, role }, access: accesses[0] };
}

async function pause(ctx: MutationCtx, rule: Doc<"automationRules">, reason: string) {
  await ctx.db.patch(rule._id, { status: "paused", pausedReason: reason, updatedAt: Date.now() });
}

const CREATOR_GONE = "Paused: the rule's creator is no longer a member of this workspace";

// ───────────────────────────── Fan-out: ledger to runs ─────────────────────────────

/** A field value as a document stores it (lists mutable). */
const stored = (x: FieldValue) => (Array.isArray(x) ? [...x] : x) as string | number | boolean | string[] | null;

export type StreamStates = { before: FoldState | null; after: FoldState } | "too_long" | null;

/**
 * A record before and after one ledger entry's save: after is through the last entry the same save wrote (a deal's
 * create and its values), before is through the entry ahead of it. `read`: stream entries read. Automations' fan-out
 * and a module's deal feed (convex/moduleJobs.ts) both compare the two.
 */
export async function statesAround(ctx: QueryCtx, streamId: Id<"canonEntities">, version: number, observedAt: number): Promise<{ states: StreamStates; read: number }> {
  const rows = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", streamId)).take(FOLD_CAP + 1);
  if (rows.length > FOLD_CAP) return { states: "too_long", read: rows.length };
  const entries = rows.map(asEntry).sort((a, b) => a.version - b.version);
  const through = entries.filter((e) => e.version <= version || e.observedAt === observedAt);
  const after = foldAll(through.filter((e, i) => e.version === i + 1));
  const before = foldAll(entries.filter((e) => e.version < version));
  return { states: after ? { before, after } : null, read: rows.length };
}

/** A deal's owner is its row's `primaryRepId` (convex/lib/canon/dealLedger.ts), which the projection does not always carry. */
async function dealOwner(ctx: QueryCtx, streamId: Id<"canonEntities">): Promise<string | null> {
  const entity = await ctx.db.get(streamId);
  const dealId = entity?.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  return deal?.primaryRepId ?? null;
}

export const fanout = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    let rules = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active")).take(RULES_MAX);
    if (!rules.length) return null;
    const cursorRow = await ctx.db.query("automationCursors").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
    if (!cursorRow) {
      await ctx.db.insert("automationCursors", { orgId, cursors: await shardHeads(ctx, orgId) });
      return null;
    }
    const cursors = { ...cursorRow.cursors };
    const defs = new Map<string, ResolvedObjectDef>();
    const defOf = async (object: string) => defs.get(object) ?? defs.set(object, await loadDef(ctx, orgId, object)).get(object)!;
    const principals = new Map<string, Principal | null>();
    const states = new Map<string, StreamStates>();
    const toRun: Id<"automationRuns">[] = [];
    let folded = 0;
    let more = false;
    let tz: string | undefined;
    const now = Date.now();

    /** The record before and after the entry's save: after is through the last entry the same save wrote (a deal's create and its values). */
    async function statesAt(streamId: Id<"canonEntities">, version: number, observedAt: number): Promise<StreamStates> {
      const key = `${streamId}@${version}`;
      if (states.has(key)) return states.get(key)!;
      const out = await statesAround(ctx, streamId, version, observedAt);
      folded += out.read;
      return states.set(key, out.states).get(key)!;
    }

    async function consider(row: Doc<"ledgerEntries">) {
      if (row.redactedAt !== undefined) return;
      const origin = entryOrigin(row.source, row.actor);
      if (!origin.ok) return;
      const body = fromStored<EntryBody>(row.body);
      for (const rule of rules) {
        if (rule.trigger.kind === "schedule") continue;
        if (rule.object !== row.object || row.observedAt < rule.activeSince || row.seq <= (rule.startSeqs[String(row.shard)] ?? 0)) continue;
        // A rule's own writes never start it again: an action that sets its own trigger field runs once.
        if (origin.mark?.ruleId === rule._id) continue;
        const def = await defOf(rule.object);
        if (!mayTrigger(rule.trigger, def, row.version, body)) continue;
        const st = await statesAt(row.streamId, row.version, row.observedAt);
        if (!st) continue;
        const base = { orgId, ruleId: rule._id, shard: row.shard, seq: row.seq, streamId: row.streamId, object: row.object, event: rule.trigger.kind, depth: origin.depth, triggeredAt: row.observedAt, createdAt: now };
        if (st === "too_long") {
          await ctx.db.insert("automationRuns", { ...base, title: "", matched: false, status: "skipped", reason: "The record's history is too long to compare", steps: [], leaseUntil: now, finishedAt: now });
          continue;
        }
        const owner = row.object === "deal" ? { ownerId: await dealOwner(ctx, row.streamId) } : undefined;
        const after = rowOf(def, st.after, owner);
        const fired = triggerFires(rule.trigger, def, st.before ? project(def, st.before).values : null, after.values);
        if (!fired.fires) continue;
        if (!principals.has(rule._id)) principals.set(rule._id, await principalOf(ctx, rule));
        const principal = principals.get(rule._id)!;
        if (!principal) {
          await pause(ctx, rule, CREATOR_GONE);
          rules = rules.filter((r) => r._id !== rule._id);
          continue;
        }
        const change = rule.trigger.kind === "updated" && fired.to !== undefined
          ? { change: { field: rule.trigger.field ?? "", from: stored(fired.from ?? null), to: stored(fired.to) } }
          : {};
        const entity = await ctx.db.get(row.streamId);
        const sight = entity ? await entitySight(ctx, [principal.access], entity) : { seen: false };
        // A record the rule's creator cannot see does not run it (CP14). The run says so, without the record's name.
        if (!("seen" in sight) || !sight.seen) {
          await ctx.db.insert("automationRuns", { ...base, title: "", matched: false, status: "skipped", reason: "Outside the creator's access", steps: [], leaseUntil: now, finishedAt: now });
          continue;
        }
        const matched = conditionsMet(def, after, rule.conditions, now, tz ??= await timezoneOf(ctx, orgId));
        const id = await ctx.db.insert("automationRuns", {
          ...base, ...change, title: after.title.slice(0, 200), matched,
          status: matched ? "pending" : "skipped", ...(matched ? {} : { reason: "Conditions not met", finishedAt: now }),
          steps: matched ? initialSteps(rule.actions) : [], ...(matched ? { actions: rule.actions } : {}), leaseUntil: matched ? now + LEASE_MS : now,
        });
        if (matched) toRun.push(id);
      }
    }

    outer: for (let shard = 0; shard < SHARDS; shard++) {
      const after = cursors[String(shard)] ?? 0;
      const page = await boundedPage(ctx.db.query("ledgerEntries")
        .withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", orgId).eq("shard", shard).gt("seq", after)), { limit: BATCH, maxBytes: SHARD_BYTES });
      for (const row of page.items) {
        if (row.seq <= after) continue;
        if (folded >= FOLD_BUDGET || !rules.length) {
          more = rules.length > 0;
          break outer;
        }
        await consider(row);
        cursors[String(shard)] = row.seq;
      }
      more ||= page.more;
    }
    if (JSON.stringify(cursors) !== JSON.stringify(cursorRow.cursors)) await ctx.db.patch(cursorRow._id, { cursors });
    for (const runId of toRun) await ctx.scheduler.runAfter(0, internal.automations.execute, { runId });
    if (more) await ctx.scheduler.runAfter(0, internal.automations.fanout, { orgId });
    return null;
  },
});

// ───────────────────────────── Actions ─────────────────────────────

/** The current owner of a run's record: a deal's row owner, else its hot row's `ownerId`. */
async function recordOwner(ctx: QueryCtx, run: Doc<"automationRuns">): Promise<string | null> {
  if (run.object === "deal") return dealOwner(ctx, run.streamId);
  const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", run.orgId).eq("streamId", run.streamId)).unique();
  const owner = row ? fromStored<Record<string, unknown>>(row.values).ownerId : null;
  return typeof owner === "string" ? owner : null;
}

/** Who an owner choice names for this run. Round robin takes the next active member in turn and moves the rotation in the same transaction. */
async function resolveOwner(ctx: MutationCtx, rule: Doc<"automationRules">, run: Doc<"automationRuns">, choice: OwnerChoice, index: number): Promise<Id<"users">> {
  const orgId = rule.orgId;
  const nameOf = async (id: Id<"users">) => (await ctx.db.get(id))?.name ?? "That member";
  if (choice.kind === "member") {
    if (!(await activeMember(ctx, orgId, choice.userId))) throw new ConvexError(`${await nameOf(choice.userId)} is no longer a member of this workspace`);
    return choice.userId;
  }
  if (choice.kind === "record_owner") {
    const owner = await recordOwner(ctx, run);
    const id = owner ? ctx.db.normalizeId("users", owner) : null;
    if (!id || !(await activeMember(ctx, orgId, id))) throw new ConvexError("The record has no owner who is a member");
    return id;
  }
  let pool: Id<"users">[];
  let start: number;
  let save: (next: number) => Promise<void>;
  if (choice.kind === "routing_rule") {
    const routing = await ctx.db.get(choice.routingRuleId);
    if (!routing || routing.orgId !== orgId) throw new ConvexError("The routing rule was deleted");
    if (!routing.isActive) throw new ConvexError(`Routing rule ${routing.name} is turned off`);
    // A weighted rule gives each member `weight` turns per rotation; any other method rotates evenly.
    pool = routing.method === "weighted" ? weightedCycle(routing.assignees) : routing.assignees.map((a) => a.userId);
    start = routing.lastAssignedIndex ?? 0;
    save = (next) => ctx.db.patch(routing._id, { lastAssignedIndex: next, updatedAt: Date.now() });
  } else {
    if (choice.kind === "team") {
      const team = await ctx.db.get(choice.teamId);
      if (!team || team.orgId !== orgId) throw new ConvexError("The team was deleted");
      pool = team.memberIds;
    } else pool = choice.userIds;
    start = rule.rotation?.[String(index)] ?? 0;
    save = (next) => ctx.db.patch(rule._id, { rotation: { ...(rule.rotation ?? {}), [String(index)]: next } });
  }
  const active = new Set<string>();
  for (const id of pool) if (await activeMember(ctx, orgId, id)) active.add(id);
  const pick = nextInTurn(pool, start, (id) => active.has(id));
  if (!pick) throw new ConvexError("Nobody in the rotation is a member any more");
  await save(pick.next);
  return pick.userId;
}

const saveError = (r: { status: string; errors?: Array<{ message: string }> }) =>
  new ConvexError(r.errors?.map((e) => e.message).join("; ") || `Not saved (${r.status})`);

/** Change the run's record as the rule's creator would, through the same checks as their own edit. */
async function writeRecord(ctx: MutationCtx, p: Principal, run: Doc<"automationRuns">, values: Record<string, FieldValue>, mark: AutomationMark): Promise<string> {
  if (run.object === "lead" && Object.keys(values).some((k) => (LEAD_READ_ONLY as readonly string[]).includes(k))) throw new ConvexError("Convert a lead to set this field");
  await requireWritable(ctx, p.user, p.access, run.object, "edit", run.streamId, values);
  const result = run.object === "deal"
    ? await saveDealAsCaller(ctx, p.user, run.streamId, values, undefined, mark)
    : await saveAsCaller(ctx, p.user, run.object, { op: "update", streamId: run.streamId, values }, { automation: mark });
  if (result.status === "invalid" || result.status === "conflict") throw saveError(result as { status: string; errors?: Array<{ message: string }> });
  return result.status === "unchanged" ? "Already set" : "Saved";
}

const TARGETS: ReadonlySet<string> = new Set(["deal", "lead"]);

async function perform(ctx: MutationCtx, p: Principal, rule: Doc<"automationRules">, run: Doc<"automationRuns">, a: AutomationAction, index: number): Promise<{ detail: string; streamId?: string }> {
  const mark: AutomationMark = { ruleId: rule._id, depth: run.depth + 1 };
  // The record must still be one the creator sees now, whatever the action (a retry can come long after the trigger).
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, run.streamId))) throw new ConvexError("Record not found");
  if (a.kind === "set_field") return { detail: `${await writeRecord(ctx, p, run, { [a.field]: a.value }, mark)}: ${a.field}` };
  if (a.kind === "assign_owner") {
    const owner = await resolveOwner(ctx, rule, run, a.owner, index);
    const said = await writeRecord(ctx, p, run, { ownerId: owner }, mark);
    return { detail: `${said === "Saved" ? "Owner set to" : "Owner already"} ${(await ctx.db.get(owner))?.name ?? owner}` };
  }
  const owner = await resolveOwner(ctx, rule, run, a.owner, index);
  const values: Record<string, FieldValue> = {
    subject: a.subject.replaceAll("{record}", run.title || "the record").slice(0, 500), dueDate: dueDate(Date.now(), a.dueInDays), ownerId: owner, status: "not_started",
    ...(run.object === "deal" ? { dealId: run.streamId } : {}),
  };
  await requireWritable(ctx, p.user, p.access, "task", "create", undefined, values);
  const made = await saveAsCaller(ctx, p.user, "task", { op: "create", values }, { automation: mark });
  if (made.status !== "applied" && made.status !== "proposed") throw saveError(made as { status: string; errors?: Array<{ message: string }> });
  if (TARGETS.has(run.object)) await attachTargets(ctx, p.user, made.streamId, [run.streamId]);
  return { detail: `Task for ${(await ctx.db.get(owner))?.name ?? owner}, due ${values.dueDate}`, streamId: made.streamId };
}

/** Run the next pending step of a run, its write and its `done` in one transaction. */
export const step = internalMutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args): Promise<{ done: boolean }> => {
    const run = await ctx.db.get(args.runId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return { done: true };
    const now = Date.now();
    const index = run.steps.findIndex((s) => s.status === "pending");
    if (index < 0) {
      await ctx.db.patch(run._id, { status: run.steps.some((s) => s.status === "failed") ? "failed" : "done", finishedAt: now, leaseUntil: now });
      return { done: true };
    }
    const rule = await ctx.db.get(run.ruleId);
    // A run does what the rule said when it was triggered: an edit since then does not change it.
    const action = (run.actions ?? rule?.actions)?.[index];
    if (!rule || !action || action.kind !== run.steps[index].kind) throw new ConvexError(rule ? "The rule's actions changed since this run started" : "The rule was deleted");
    if (rule.status !== "active") throw new ConvexError(rule.pausedReason ?? "The rule is paused");
    const p = await principalOf(ctx, rule);
    if (!p) {
      await pause(ctx, rule, CREATOR_GONE);
      throw new ConvexError("The rule's creator is no longer a member of this workspace");
    }
    const out = await perform(ctx, p, rule, run, action, index);
    const steps = run.steps.map((s, i): Step => (i === index ? { ...s, status: "done", attempts: s.attempts + 1, detail: out.detail.slice(0, ERROR_MAX), at: now, ...(out.streamId ? { streamId: out.streamId } : {}) } : s));
    const last = !steps.some((s) => s.status === "pending");
    await ctx.db.patch(run._id, { steps, status: last ? "done" : "running", leaseUntil: last ? now : now + LEASE_MS, ...(last ? { finishedAt: now } : {}) });
    return { done: last };
  },
});

/** Record that the next pending step failed: it and the run stop there until Retry. */
export const failStep = internalMutation({
  args: { runId: v.id("automationRuns"), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return null;
    const now = Date.now();
    const index = run.steps.findIndex((s) => s.status === "pending");
    const steps = run.steps.map((s, i): Step => (i === index ? { ...s, status: "failed", attempts: s.attempts + 1, detail: args.error.slice(0, ERROR_MAX), at: now } : s));
    await ctx.db.patch(run._id, { steps, status: "failed", finishedAt: now, leaseUntil: now });
    return null;
  },
});

const messageOf = (cause: unknown) => (cause instanceof ConvexError ? String(cause.data) : cause instanceof Error ? cause.message : "The action failed");

export const execute = internalAction({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args): Promise<void> => {
    for (let i = 0; i <= ACTIONS_MAX; i++) {
      try {
        const r: { done: boolean } = await ctx.runMutation(internal.automations.step, args);
        if (r.done) return;
      } catch (cause) {
        await ctx.runMutation(internal.automations.failStep, { runId: args.runId, error: messageOf(cause) });
        return;
      }
    }
  },
});

// ───────────────────────────── Schedules ─────────────────────────────
//
// A scheduled rule acts on the records that match its conditions at each
// slot (daily or weekly, at a time in the workspace's time zone). The sweep
// starts a due slot: it records the slot on the rule (`slotRun`) and moves
// `nextSlotAt` on in one transaction, so a slot starts once. `runSlot` lists
// the matching records a page at a time through the creator's scoped record
// client (the list views' query, so a condition means what the same filter
// means on a list, and a record they cannot see is never listed), and
// `slotPage` makes one run per (rule, slot, record): a page read twice makes
// nothing new. Each page moves the slot's cursor and schedules the next, up
// to SLOT_CAP runs per slot; a page that never lands is sent again when the
// slot's lease runs out. The runs then execute like any other.

/** Start a rule's due slot. Slots missed while nothing ran (a pause, an outage) are not made up: the next is after now. */
async function startSlot(ctx: MutationCtx, rule: Doc<"automationRules">, now: number) {
  if (rule.trigger.kind !== "schedule" || rule.nextSlotAt === undefined) return;
  const slot = rule.nextSlotAt;
  await ctx.db.patch(rule._id, {
    nextSlotAt: nextSlot(rule.trigger, now, await timezoneOf(ctx, rule.orgId)),
    slotRun: { slot, cursor: null, count: 0, done: false, leaseUntil: now + LEASE_MS },
  });
  await ctx.scheduler.runAfter(0, internal.automations.runSlot, { ruleId: rule._id, slot });
}

/** What the next page of a slot reads: the creator's access, the conditions with `{today}` as of the slot, and where the list continues. */
export const slotJob = internalQuery({
  args: { ruleId: v.id("automationRules"), slot: v.number() },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    const run = rule?.slotRun;
    if (!rule || rule.status !== "active" || !run || run.slot !== args.slot || run.done) return null;
    const p = await principalOf(ctx, rule);
    if (!p) return { gone: true as const };
    const def = await loadDef(ctx, rule.orgId, rule.object);
    return {
      gone: false as const, orgId: rule.orgId, object: rule.object, access: p.access, cursor: run.cursor,
      filter: resolveConditions(def, rule.conditions, args.slot, await timezoneOf(ctx, rule.orgId)),
    };
  },
});

export const runSlot = internalAction({
  args: { ruleId: v.id("automationRules"), slot: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(internal.automations.slotJob, args);
    if (!job) return;
    if (job.gone) return void (await ctx.runMutation(internal.automations.slotPage, { ...args, from: null, rows: [], next: null, error: CREATOR_GONE }));
    try {
      const client = principalClient(ctx, job.orgId, [job.access]);
      const page = await client.listObjects(job.orgId, job.object, {
        filter: job.filter as ListFilter[], sort: { field: "createdAt", dir: "asc" }, limit: SLOT_PAGE, ...(job.cursor ? { cursor: job.cursor } : {}),
      });
      await ctx.runMutation(internal.automations.slotPage, {
        ...args, from: job.cursor, rows: page.rows.map((r) => ({ streamId: r.id, title: r.title.slice(0, 200) })), next: page.nextCursor,
      });
    } catch (cause) {
      await ctx.runMutation(internal.automations.slotPage, { ...args, from: job.cursor, rows: [], next: null, error: messageOf(cause) });
    }
  },
});

/**
 * One page of a slot: a run per listed record that has none for this slot,
 * then the cursor moves and the next page is scheduled, or the slot ends (no
 * more records, the cap, or an error). A page read from a cursor the slot has
 * already moved past is a duplicate and changes nothing.
 */
export const slotPage = internalMutation({
  args: {
    ruleId: v.id("automationRules"), slot: v.number(), from: v.union(v.string(), v.null()),
    rows: v.array(v.object({ streamId: v.string(), title: v.string() })), next: v.union(v.string(), v.null()), error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    const state = rule?.slotRun;
    if (!rule || rule.status !== "active" || !state || state.slot !== args.slot || state.done || state.cursor !== args.from) return null;
    const now = Date.now();
    const p = args.error === CREATOR_GONE ? null : await principalOf(ctx, rule);
    if (!p) {
      await ctx.db.patch(rule._id, { status: "paused", pausedReason: CREATOR_GONE, slotRun: { ...state, done: true, note: CREATOR_GONE }, updatedAt: now });
      return null;
    }
    if (args.error) return void (await ctx.db.patch(rule._id, { slotRun: { ...state, done: true, leaseUntil: now, note: args.error.slice(0, ERROR_MAX) } }));
    let count = state.count;
    let capped = false;
    for (const row of args.rows) {
      const streamId = ctx.db.normalizeId("canonEntities", row.streamId);
      const entity = streamId ? await ctx.db.get(streamId) : null;
      if (!streamId || !entity || entity.orgId !== rule.orgId) continue;
      const seen = await ctx.db.query("automationRuns").withIndex("by_ruleId_and_slot_and_streamId", (q) => q.eq("ruleId", rule._id).eq("slot", args.slot).eq("streamId", streamId)).first();
      if (seen) continue;
      if (count >= SLOT_CAP) {
        capped = true;
        break;
      }
      // The list was read through the creator's scoped client; judge the record here too, so a run is only ever about one they see.
      const sight = await entitySight(ctx, [p.access], entity);
      if (!("seen" in sight) || !sight.seen) continue;
      const runId = await ctx.db.insert("automationRuns", {
        orgId: rule.orgId, ruleId: rule._id, shard: -1, seq: args.slot, slot: args.slot, streamId, object: rule.object, title: row.title, event: "schedule",
        matched: true, status: "pending", depth: 0, triggeredAt: args.slot, steps: initialSteps(rule.actions), actions: rule.actions, leaseUntil: now + LEASE_MS, createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.automations.execute, { runId });
      count++;
    }
    const done = capped || args.next === null || count >= SLOT_CAP;
    const note = capped || (count >= SLOT_CAP && args.next !== null) ? `Stopped at ${SLOT_CAP} records; the rest wait for the next slot` : undefined;
    await ctx.db.patch(rule._id, { slotRun: { slot: args.slot, cursor: args.next, count, done, leaseUntil: done ? now : now + LEASE_MS, ...(note ? { note } : {}) } });
    if (!done) await ctx.scheduler.runAfter(0, internal.automations.runSlot, { ruleId: rule._id, slot: args.slot });
    return null;
  },
});

// ───────────────────────────── Dry run ─────────────────────────────

/** An admin's dry run: who asks, their access, and the conditions as list filters (`{today}` as of `at`). Null for anyone else. */
export const previewJob = internalQuery({
  args: { object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator) },
  handler: async (ctx, args) => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    const orgId = admin.user.orgId;
    if (!isAutomationObject(args.object)) throw new ConvexError(`Rules do not run on ${args.object} records yet`);
    const def = await loadDef(ctx, orgId, args.object);
    const problem = conditionsProblem(def, args.conditions) ?? (args.trigger.kind === "schedule" ? scheduleProblem(args.trigger) : null);
    if (problem) throw new ConvexError(problem);
    const now = Date.now();
    const at = (await slotAfter(ctx, orgId, args.trigger, now)) ?? now;
    return { orgId: orgId as string, nextSlotAt: args.trigger.kind === "schedule" ? at : null, filter: resolveConditions(def, args.conditions, at, await timezoneOf(ctx, orgId)) };
  },
});

/**
 * Dry run: the existing records a rule's conditions match now (for a
 * schedule, as of its next slot, which is when `{today}` is read), as the
 * admin sees them. Nothing is written and no action runs.
 */
export const preview = action({
  args: { object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator) },
  handler: async (ctx, args): Promise<{ total: number; rows: Array<{ streamId: string; title: string }>; nextSlotAt: number | null; capped: boolean }> => {
    const caller = await requireCaller(ctx, { read: true });
    const job = await ctx.runQuery(internal.automations.previewJob, args);
    if (!job) throw new ConvexError("Only admins manage automation rules");
    const page = await callerClient(ctx, caller).listObjects(job.orgId, args.object, { filter: job.filter as ListFilter[], sort: { field: "createdAt", dir: "asc" }, limit: PREVIEW_ROWS });
    return { total: page.total, rows: page.rows.map((r) => ({ streamId: r.id, title: r.title })), nextSlotAt: job.nextSlotAt, capped: page.total > SLOT_CAP };
  },
});

// ───────────────────────────── Sweep ─────────────────────────────

/**
 * Every minute: wake the fan-out for each org with an active rule (a lost
 * wake-up costs a minute, not a run), start scheduled rules' due slots, send
 * runs whose executor died (their lease ran out; finished steps are not
 * repeated), and drop old runs.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db.query("automationRules").withIndex("by_status", (q) => q.eq("status", "active")).take(500);
    for (const orgId of new Set(active.map((r) => r.orgId))) await ctx.scheduler.runAfter(0, internal.automations.fanout, { orgId });
    // Scheduled rules: start each due slot; send again a slot whose page never landed.
    const due = await ctx.db.query("automationRules").withIndex("by_status_and_nextSlotAt", (q) => q.eq("status", "active").gte("nextSlotAt", 0).lte("nextSlotAt", now)).take(50);
    for (const rule of due) if (rule.nextSlotAt !== undefined && rule.nextSlotAt <= now) await startSlot(ctx, rule, now);
    for (const rule of active) {
      const s = rule.slotRun;
      if (!s || s.done || s.leaseUntil >= now || due.some((d) => d._id === rule._id)) continue;
      await ctx.db.patch(rule._id, { slotRun: { ...s, leaseUntil: now + LEASE_MS } });
      await ctx.scheduler.runAfter(0, internal.automations.runSlot, { ruleId: rule._id, slot: s.slot });
    }
    for (const status of ["pending", "running"] as const) {
      const stuck = await ctx.db.query("automationRuns").withIndex("by_status_and_leaseUntil", (q) => q.eq("status", status).lt("leaseUntil", now)).take(100);
      for (const run of stuck) {
        if (run.leaseUntil >= now) continue;
        await ctx.db.patch(run._id, { leaseUntil: now + LEASE_MS });
        await ctx.scheduler.runAfter(0, internal.automations.execute, { runId: run._id });
      }
    }
    for (const status of ["done", "failed", "skipped"] as const) {
      const old = await ctx.db.query("automationRuns").withIndex("by_status_and_leaseUntil", (q) => q.eq("status", status).lt("leaseUntil", now - KEEP_RUNS_MS)).take(100);
      for (const run of old) if (run.leaseUntil < now - KEEP_RUNS_MS) await ctx.db.delete(run._id);
    }
    return null;
  },
});
