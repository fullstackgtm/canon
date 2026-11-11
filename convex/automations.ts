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
 * Principal: a rule acts as the admin who approved its version in force
 * (`actsAs`; a rule from before versions, as its creator), with their access as
 * it is now (permissions.principalAccess): a record they cannot see does not
 * run it, and every write goes through the checks their own edit takes
 * (objects.requireWritable: role, visibility, field permissions; then the
 * save path's validation rules). A rule whose member left pauses. Its writes
 * are its own source record (`automation:<ruleId>:<depth>:user:<id>`), shown
 * in history as the rule's, and never start the same rule again.
 *
 * Versions: an agent proposes a rule's document; only a person approves,
 * rejects, pauses, resumes, retries or deletes (requirePerson, "Versions").
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { accessFor, entitySight, principalAccess, requireWriteAccess, roleIn, workspaceMembers } from "./permissions";
import { refuseNarrowed, type Access } from "./lib/access";
import { callerClient, principalClient, requireCaller } from "./records";
import { localTime, validTimezone } from "./lib/linkedin/limits";
import { isRegisterObject, listViewDef, type ListFilter, type ListRow } from "./lib/objects/listSpec";
import { may, withoutHidden } from "./lib/access";
import { shardHeads } from "./ledgerFeed";
import { asEntry, convexObjectStore, loadDef, recordVisibleTo, requireWritable, saveAsCaller, saveDealAsCaller } from "./objects";
import { LEAD_READ_ONLY } from "./lib/objects/describe";
import { attachTargets } from "./activityTargets";
import { hostOf, sendStep } from "./lib/automationOutbound";
import { boundedPage } from "./lib/objects/tail";
import { foldAll, project, type EntryBody, type FoldState } from "./lib/objects/fold";
import { fromStored } from "./lib/objects/validators";
import type { Provenance } from "../recipes/templates.ts";
import { SHARDS } from "./lib/objects/write";
import { coerce, type FieldValue, type ResolvedObjectDef } from "./lib/objects/registry";
import { isCustomObjectName } from "../modules/kernel/reportLanguage";
import { archivedObjectNames } from "./lib/objects/orgDefs";
import { ID, normalizeDomain, normalizeEmail } from "./lib/canon/identity";
import { ASK_AGENT } from "./lib/automationAgent";
import { recipeAgentStandIn } from "./lib/recipeAgentStandIn";
import { uniqueClaimKeys, uniqueClaimProvider } from "./lib/objects/write";
import { encryptForStorage, decryptFromStorage } from "./lib/tokenHelpers";
import { sealedV } from "./lib/sealed";
import { eventKeyOf, verifyWebhook } from "./lib/agents/webhook";
import {
  SLOT_CAP, actionProblem, branchSteps, companyField, conditionsMet, conditionsProblem, dueDate, entryOrigin, ifHolds, initialSteps, mayTrigger, nextInTurn, nextSlot, pathThrough,
  relatedOf, relatedVias, resolveConditions, resumeAt, rowOf, scheduleProblem, triggerFires, weightedCycle, type AutomationMark, type Related,
} from "./lib/automations";
import {
  ACTIONS_MAX, AUTOMATION_OBJECTS, CONDITIONS_MAX, MAX_DEPTH, RULES_MAX, STEPS_MAX, actionValidator, replaySummaryValidator, conditionValidator, describe, describeConditions,
  isAutomationObject, isOnDemand, isRegisterAutomationObject, reachNote, stepAt, triggerValidator, walkSteps,
  type AutomationAction, type Branch, type Condition, type IfStep, type LeafAction, type OwnerChoice, type RuleNames, type RuleStep, type Step, type Trigger,
} from "../modules/kernel/automation";

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

/** Why an agent is refused a decision: it may propose a rule, never decide one. */
export const AGENT_REFUSED = "An agent can propose an automation rule, but only a person approves, rejects, turns on, pauses, retries or deletes one, on the Automations page.";

declare const inPersonBrand: unique symbol;
/** An admin acting in person, never an agent: only `inPerson` makes one, so a decision that takes a Person cannot run for an agent. */
export type Person = Doc<"users"> & { readonly [inPersonBrand]: true };

/**
 * The admin as a person, or null when an agent made the call. Canon can't tell the person typing from their agent on
 * a call that carries its service token (/mcp, the canon CLI: agentClientOf), so every such call counts as an agent's.
 */
async function inPerson(ctx: MutationCtx, admin: Doc<"users">): Promise<Person | null> {
  return (await agentClientOf(ctx)) ? null : (admin as Person);
}

/** The signed-in admin, in person. Every decision on a rule (approve, reject, pause, resume, retry, delete) starts here. */
export async function requirePerson(ctx: MutationCtx): Promise<Person> {
  const p = await inPerson(ctx, await requireAdmin(ctx));
  if (!p) throw new ConvexError(AGENT_REFUSED);
  return p;
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
  if (isRegisterAutomationObject(def.apiName) && (t.kind === "created" || t.kind === "schedule")) {
    const plural = def.pluralLabel.toLowerCase();
    throw new ConvexError(t.kind === "created"
      ? `Canon doesn't record ${plural} being added, so a rule on ${plural} starts when one is changed or deleted`
      : `A schedule doesn't run on ${plural}: a rule on ${plural} starts when one is changed or deleted`);
  }
  if (t.kind === "updated" && t.field) {
    const f = def.byApiName.get(t.field);
    if (!f || f.system) throw new ConvexError(`${def.label} has no field ${t.field}`);
  }
  if (t.kind === "schedule") {
    const bad = scheduleProblem(t);
    if (bad) throw new ConvexError(bad);
  }
  if (t.kind === "webhook" && !matchable(def).includes(t.match)) throw new ConvexError(`A webhook names ${def.pluralLabel.toLowerCase()} by id or by a unique field: ${matchable(def).join(", ")}`);
  if (input.conditions.some((c) => relatedOf(def, c.field))) throw new ConvexError("A condition on a related record's field goes in an If step");
  const problem = conditionsProblem(def, input.conditions);
  if (problem) throw new ConvexError(problem);
  if (!input.actions.length) throw new ConvexError("Add at least one action");
  if (walkSteps(input.actions).length > STEPS_MAX) throw new ConvexError(`A rule has at most ${STEPS_MAX} steps, counting each If and the steps in its branches`);
  await checkSteps(ctx, orgId, def, input.actions);
  return { ...input, name };
}

/** The record a lookup points at, as an If's condition reads it: its object and that object's list definition. */
async function relationOf(ctx: QueryCtx, orgId: Id<"organizations">, def: ResolvedObjectDef, via: string): Promise<{ object: string; def: ResolvedObjectDef }> {
  const f = def.byApiName.get(via);
  if (!f || f.type !== "lookup" || !("lookupTo" in f) || f.system || f.archivedAt !== undefined) throw new ConvexError(`${def.label} has no lookup ${via}`);
  const target = await loadDef(ctx, orgId, f.lookupTo).catch(() => null);
  if (!target) throw new ConvexError(`${f.label} points at records a rule can't read`);
  return { object: f.lookupTo, def: listViewDef(f.lookupTo, target) };
}

/** Each step as a save checks it: an action against the object, an If's conditions (a related record's against its object) and both its branches. */
async function checkSteps(ctx: QueryCtx, orgId: Id<"organizations">, def: ResolvedObjectDef, steps: readonly RuleStep[]) {
  if (steps.length > ACTIONS_MAX) throw new ConvexError(`At most ${ACTIONS_MAX} steps in a row`);
  for (const a of steps) {
    if (a.kind === "if") {
      if (!a.conditions.length || a.conditions.length > CONDITIONS_MAX) throw new ConvexError(`An If checks 1 to ${CONDITIONS_MAX} conditions`);
      const own = conditionsProblem(def, a.conditions.filter((c) => !relatedOf(def, c.field)));
      if (own) throw new ConvexError(own);
      for (const c of a.conditions) {
        const rel = relatedOf(def, c.field);
        const bad = rel ? conditionsProblem((await relationOf(ctx, orgId, def, rel.via)).def, [{ ...c, field: rel.field }]) : null;
        if (bad) throw new ConvexError(bad);
      }
      if (!a.then.length && !a.else?.length) throw new ConvexError("An If needs a step under Then or Otherwise");
      await checkSteps(ctx, orgId, def, a.then);
      await checkSteps(ctx, orgId, def, a.else ?? []);
      continue;
    }
    const bad = actionProblem(def, a);
    if (bad) throw new ConvexError(bad);
    if (a.kind === "set_field") {
      // A conversion sets these (convex/leadConversion.ts), never an edit or a rule.
      if (def.apiName === "lead" && (LEAD_READ_ONLY as readonly string[]).includes(a.field)) throw new ConvexError("Convert a lead to set this field");
      const coerced = coerce(def, { [a.field]: a.value }, { mode: "update" });
      if (!coerced.ok) throw new ConvexError(coerced.errors.map((e) => e.message).join("; "));
    }
    if ("owner" in a) await checkOwner(ctx, orgId, a.owner);
    if (a.kind === "notify_email") await checkOwner(ctx, orgId, a.to);
    if (a.kind === "notify_slack") {
      const name = a.channel.replace(/^#/, "").toLowerCase();
      const mapped = await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", orgId).eq("channel", "slack").eq("name", name)).first();
      if (!mapped) throw new ConvexError(`No Slack channel is mapped to ${name}. An admin maps it in Settings > Outbound.`);
    }
    if (a.kind === "call_webhook") {
      const endpoint = a.endpointId ? await ctx.db.get(a.endpointId) : null;
      if (!endpoint || endpoint.orgId !== orgId) throw new ConvexError("That webhook isn't one of this workspace's record webhooks");
    }
  }
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

// ───────────────────────────── Versions ─────────────────────────────
//
// A rule is a document a person or an agent proposes and an admin approves (automationVersions). A proposal is
// checked as a save would be and stored; nothing runs. Approving it replaces the rule's document and makes the
// approver the member the rule acts as. A person's own change in the app is approved as it is saved: they are the
// admin who decides. An agent's call is never a decision (requirePerson).

const ruleArgs = { name: v.string(), object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator), actions: v.array(actionValidator) };
const NOTE_MAX = 1000;
const REASON_MAX = 500;
/** Proposals one workspace keeps waiting at once. */
const OPEN_MAX = 20;

/**
 * Check and store a rule. It runs from now, or with `paused` it waits for an admin to resume it, which starts it from
 * that moment (setStatus). A recipe's template installs paused, with its provenance. `actsAs` is who it acts as,
 * absent for its creator.
 */
export async function insertRule(
  ctx: MutationCtx, user: Doc<"users">, input: RuleInput,
  opts: { paused?: string; recipe?: Provenance; version?: number; actsAs?: Id<"users">; createdBy?: Id<"users"> } = {},
): Promise<Id<"automationRules">> {
  const rule = await checkRule(ctx, user.orgId, input);
  const existing = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId)).take(RULES_MAX);
  if (existing.length >= RULES_MAX) throw new ConvexError(`A workspace can have ${RULES_MAX} rules`);
  const now = Date.now();
  if (!opts.paused) await ensureCursor(ctx, user.orgId, null);
  const nextSlotAt = opts.paused ? undefined : await slotAfter(ctx, user.orgId, rule.trigger, now);
  const id = await ctx.db.insert("automationRules", {
    orgId: user.orgId, ...rule, createdBy: opts.createdBy ?? user._id, activeSince: now, startSeqs: await shardHeads(ctx, user.orgId),
    ...(opts.paused ? { status: "paused" as const, pausedReason: opts.paused } : { status: "active" as const }),
    ...(nextSlotAt !== undefined ? { nextSlotAt } : {}), ...(opts.recipe ? { recipe: opts.recipe } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}), ...(opts.actsAs ? { actsAs: opts.actsAs } : {}), createdAt: now, updatedAt: now,
  });
  await audit(ctx, user, "automation_rule.create", { ruleId: id, name: rule.name, ...(opts.recipe ? { recipe: opts.recipe } : {}) });
  return id;
}

/** Where an active rule starts reading again: the ledger's heads now, so nothing before this moment ever starts it. */
async function restartAt(ctx: MutationCtx, rule: Doc<"automationRules">, trigger: Trigger, now: number) {
  await ensureCursor(ctx, rule.orgId, rule._id);
  return { activeSince: now, startSeqs: await shardHeads(ctx, rule.orgId), nextSlotAt: await slotAfter(ctx, rule.orgId, trigger, now) };
}

/** The number after every version the rule has had. */
async function nextVersion(ctx: QueryCtx, rule: Doc<"automationRules">): Promise<number> {
  const last = await ctx.db.query("automationVersions").withIndex("by_ruleId_and_version", (q) => q.eq("ruleId", rule._id)).order("desc").first();
  return Math.max(last?.version ?? 0, rule.version ?? 0) + 1;
}

/** Store a proposed version, checked as a save is: a proposal naming a field, member or team that doesn't exist never waits. */
async function proposeVersion(
  ctx: MutationCtx, user: Doc<"users">, doc: RuleInput, opts: { ruleId?: Id<"automationRules">; note?: string; agent: string | null },
): Promise<Doc<"automationVersions">> {
  const spec = await checkRule(ctx, user.orgId, doc);
  const rule = opts.ruleId ? await ownRule(ctx, user.orgId, opts.ruleId) : null;
  const open = await ctx.db.query("automationVersions").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId).eq("status", "proposed")).take(OPEN_MAX);
  if (open.length >= OPEN_MAX) throw new ConvexError(`${OPEN_MAX} proposals are waiting for an admin; approve or reject some first`);
  const id = await ctx.db.insert("automationVersions", {
    orgId: user.orgId, ...(rule ? { ruleId: rule._id } : {}), version: rule ? await nextVersion(ctx, rule) : 1, parent: rule ? rule.version ?? 0 : null,
    spec, note: (opts.note ?? "").trim().slice(0, NOTE_MAX), author: { userId: user._id, ...(opts.agent ? { agent: opts.agent.slice(0, 200) } : {}) },
    status: "proposed", createdAt: Date.now(),
  });
  await audit(ctx, user, "automation_rule.propose", { versionId: id, ruleId: rule?._id ?? null, name: spec.name, ...(opts.agent ? { agent: opts.agent } : {}) });
  return (await ctx.db.get(id))!;
}

/**
 * Approve a proposed version as `p`, in person. The rule's document becomes the version's and `p` the member it acts
 * as: a rule never acts with an agent's identity, nor with more access than the admin who approved it. A version for a
 * rule that has moved on since it was proposed is refused. A running rule keeps running on the new version from now
 * on: its start moves to the ledger's heads, as on resume, so the new version never acts on what happened before.
 */
async function approveVersion(ctx: MutationCtx, p: Person, row: Doc<"automationVersions">): Promise<Id<"automationRules">> {
  if (row.orgId !== p.orgId) throw new ConvexError("Proposal not found");
  if (row.status !== "proposed") throw new ConvexError(`This proposal was already ${row.status}`);
  const spec = await checkRule(ctx, p.orgId, row.spec);
  const now = Date.now();
  let ruleId: Id<"automationRules">;
  if (row.ruleId) {
    const rule = await ctx.db.get(row.ruleId);
    if (!rule || rule.orgId !== p.orgId) throw new ConvexError("The rule was deleted since this was proposed; propose it again as a new rule");
    if ((rule.version ?? 0) !== row.parent) {
      throw new ConvexError(`The rule changed since this was proposed: version ${rule.version ?? 0} is in force, and this proposal changes version ${row.parent}. Ask for a fresh proposal.`);
    }
    const actionsChanged = JSON.stringify(spec.actions) !== JSON.stringify(rule.actions);
    const restart = rule.status === "active" ? await restartAt(ctx, rule, spec.trigger, now) : {};
    await ctx.db.patch(rule._id, { ...spec, version: row.version, actsAs: p._id, ...(actionsChanged ? { rotation: {} } : {}), ...restart, updatedAt: now });
    const before = await ctx.db.query("automationVersions").withIndex("by_ruleId_and_version", (q) => q.eq("ruleId", rule._id).eq("version", row.parent ?? 0)).first();
    if (before?.status === "approved") await ctx.db.patch(before._id, { status: "superseded" });
    ruleId = rule._id;
  } else {
    ruleId = await insertRule(ctx, p, spec, { version: row.version, actsAs: p._id, createdBy: row.author.userId });
  }
  await ctx.db.patch(row._id, { status: "approved", ruleId, decidedBy: p._id, decidedAt: now });
  await audit(ctx, p, "automation_rule.approve", { versionId: row._id, ruleId, version: row.version, name: spec.name });
  return ruleId;
}

/**
 * Propose a rule, or a new version of one (`ruleId`), with a note saying why. An agent's proposal waits for an admin
 * and does nothing until one approves it. A person's is their own decision and is approved as it is saved.
 */
export const propose = mutation({
  args: { ruleId: v.optional(v.id("automationRules")), ...ruleArgs, note: v.optional(v.string()) },
  handler: async (ctx, { ruleId, note, ...doc }) => {
    const admin = await requireAdmin(ctx);
    const p = await inPerson(ctx, admin);
    const row = await proposeVersion(ctx, admin, doc, { ruleId, note, agent: p ? null : await agentClientOf(ctx) });
    const sentence = describe(row.spec, await namesFor(ctx, admin.orgId, row.spec.object));
    if (!p) {
      // The approver sees what it would have done over the last two weeks without asking for it.
      if (row.spec.trigger.kind !== "schedule" && !isOnDemand(row.spec.trigger)) await ctx.scheduler.runAfter(0, internal.automations.replayVersion, { versionId: row._id });
      return { versionId: row._id, version: row.version, ruleId: row.ruleId ?? null, status: "proposed" as const, sentence };
    }
    return { versionId: row._id, version: row.version, ruleId: await approveVersion(ctx, p, row), status: "approved" as const, sentence };
  },
});

/**
 * Store a rule Ask Canon wrote for the signed-in admin (convex/automationAgent.ts) as a proposal from the agent
 * "ask-canon", with its replay: it waits for an admin to approve it like any agent's, even the one who asked.
 */
export const proposeAsked = internalMutation({
  args: { ruleId: v.optional(v.id("automationRules")), doc: v.object(ruleArgs), note: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const row = await proposeVersion(ctx, admin, args.doc, { ruleId: args.ruleId, note: args.note, agent: ASK_AGENT });
    if (row.spec.trigger.kind !== "schedule" && !isOnDemand(row.spec.trigger)) await ctx.scheduler.runAfter(0, internal.automations.replayVersion, { versionId: row._id });
    return { versionId: row._id, sentence: describe(row.spec, await namesFor(ctx, admin.orgId, row.spec.object)) };
  },
});

export const approve = mutation({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args) => {
    const p = await requirePerson(ctx);
    const row = await ctx.db.get(args.versionId);
    if (!row || row.orgId !== p.orgId) throw new ConvexError("Proposal not found");
    return { ruleId: await approveVersion(ctx, p, row) };
  },
});

export const reject = mutation({
  args: { versionId: v.id("automationVersions"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const p = await requirePerson(ctx);
    const row = await ctx.db.get(args.versionId);
    if (!row || row.orgId !== p.orgId) throw new ConvexError("Proposal not found");
    if (row.status !== "proposed") throw new ConvexError(`This proposal was already ${row.status}`);
    const reason = args.reason?.trim().slice(0, REASON_MAX);
    await ctx.db.patch(row._id, { status: "rejected", decidedBy: p._id, decidedAt: Date.now(), ...(reason ? { reason } : {}) });
    await audit(ctx, p, "automation_rule.reject", { versionId: row._id, ruleId: row.ruleId ?? null, name: row.spec.name });
    return null;
  },
});

/** Pause or resume. A resumed rule acts on changes from now on, never on what happened while it was paused. */
export const setStatus = mutation({
  args: { id: v.id("automationRules"), status: v.union(v.literal("active"), v.literal("paused")) },
  handler: async (ctx, args) => {
    const user = await requirePerson(ctx);
    const rule = await ownRule(ctx, user.orgId, args.id);
    if (rule.status === args.status) return null;
    const now = Date.now();
    if (args.status === "paused") {
      await ctx.db.patch(rule._id, { status: "paused", pausedReason: `Paused by ${user.name}`, updatedAt: now });
    } else {
      // A resumed schedule waits for its next slot: the slots it missed while paused never run.
      await ctx.db.patch(rule._id, { status: "active", pausedReason: undefined, ...(await restartAt(ctx, rule, rule.trigger, now)), updatedAt: now });
    }
    await audit(ctx, user, `automation_rule.${args.status === "paused" ? "pause" : "resume"}`, { ruleId: rule._id, name: rule.name });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("automationRules") },
  handler: async (ctx, args) => {
    const user = await requirePerson(ctx);
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
    const user = await requirePerson(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId) throw new ConvexError("Run not found");
    if (run.status !== "failed") throw new ConvexError("Only a failed run can be retried");
    const steps = run.steps.map((s): Step => (s.status === "failed" ? { ...s, status: "pending" } : s));
    await ctx.db.patch(run._id, { status: "pending", steps, leaseUntil: Date.now() + LEASE_MS, finishedAt: undefined });
    await ctx.scheduler.runAfter(0, internal.automations.execute, { runId: run._id });
    return null;
  },
});

const nameOf = async (ctx: QueryCtx, id: Id<"users"> | undefined) => (id ? (await ctx.db.get(id))?.name : undefined) ?? "A former member";

const ruleView = async (ctx: QueryCtx, r: Doc<"automationRules">) => {
  const last = await ctx.db.query("automationRuns").withIndex("by_ruleId_and_createdAt", (q) => q.eq("ruleId", r._id)).order("desc").first();
  return {
    id: r._id, name: r.name, object: r.object, trigger: r.trigger, conditions: r.conditions, actions: r.actions, status: r.status,
    pausedReason: r.pausedReason ?? null, createdBy: await nameOf(ctx, r.createdBy), actsAs: await nameOf(ctx, r.actsAs ?? r.createdBy),
    version: r.version ?? 0, createdAt: r.createdAt, recipe: r.recipe ?? null,
    lastRun: last ? { status: last.status, at: last.createdAt } : null,
    nextSlotAt: r.status === "active" ? r.nextSlotAt ?? null : null,
    lastSlot: r.slotRun ? { at: r.slotRun.slot, runs: r.slotRun.count, done: r.slotRun.done, note: r.slotRun.note ?? null } : null,
    // Where a webhook rule takes requests, and whether it has a secret yet (never the secret itself).
    webhook: r.trigger.kind === "webhook" ? { url: automationWebhookUrl(r._id), hasSecret: (await secretOf(ctx, r._id)) !== null } : null,
  };
};

/** The words a rule's sentence uses in this workspace: the object's fields and options, members, teams, routing rules, time zone and currency. */
async function namesFor(ctx: QueryCtx, orgId: Id<"organizations">, object: string): Promise<RuleNames> {
  const def = isAutomationObject(object) ? await loadDef(ctx, orgId, object).catch(() => null) : null;
  const related: Record<string, { label: string; fields: ReturnType<typeof namedFields> }> = {};
  for (const r of def ? await relationsOf(ctx, orgId, def) : []) related[r.via] = { label: r.label, fields: r.fields };
  const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(100);
  const routing = await ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(50);
  return {
    ...(def ? { object: { label: def.label, fields: namedFields(def) }, related } : {}),
    members: (await workspaceMembers(ctx, orgId)).map((m) => ({ id: m.id, name: m.name })),
    teams: teams.map((t) => ({ id: t._id, name: t.name })),
    routingRules: routing.map((r) => ({ id: r._id, name: r.name })),
    webhooks: (await webhooksOf(ctx, orgId)).map((w) => ({ id: w.id, name: w.name })),
    timezone: await timezoneOf(ctx, orgId),
    currency: (await ctx.db.get(orgId))?.defaultCurrency ?? "USD",
  };
}

/** The record webhooks an admin registered, by where they send: what a webhook step may call. */
async function webhooksOf(ctx: QueryCtx, orgId: Id<"organizations">) {
  const rows = await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(20);
  return rows.map((e) => ({ id: e._id, name: hostOf(e.url), enabled: e.enabled }));
}

/** A definition's fields as a sentence and the builder name them, with their options' labels. */
const namedFields = (def: ResolvedObjectDef) => def.fields.map((f) => ({
  apiName: f.apiName, label: f.label, type: f.type, ...("options" in f && f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
}));

/** The records an object's lookups point at, which an If's conditions can read: by lookup, with the related object's fields. */
async function relationsOf(ctx: QueryCtx, orgId: Id<"organizations">, def: ResolvedObjectDef) {
  const out = [];
  for (const f of def.fields) {
    if (f.type !== "lookup" || f.system || f.archivedAt !== undefined) continue;
    const rel = await relationOf(ctx, orgId, def, f.apiName).catch(() => null);
    if (rel) out.push({ via: f.apiName, label: f.label, object: rel.object, fields: namedFields({ ...rel.def, fields: rel.def.fields.filter((x) => x.archivedAt === undefined) }) });
  }
  return out;
}

/** A replay's listed runs that `access` sees now: a summary kept on a proposal never names a record its reader can't see. */
async function seenRuns(ctx: QueryCtx, access: Access, runs: ReadonlyArray<{ streamId: string; at: number; title: string }>) {
  const out = [];
  for (const run of runs) {
    const id = ctx.db.normalizeId("canonEntities", run.streamId);
    const entity = id ? await ctx.db.get(id) : null;
    if (entity && (await seesRecord(ctx, access, entity))) out.push({ ...run, recordId: isRegisterAutomationObject(entity.entityType) ? await registerIdOf(ctx, entity._id) : null });
  }
  return out;
}

/** Whether `access` sees a record: as entitySight says, and a company or person the record service would decide by its owner on the ledger. */
async function seesRecord(ctx: QueryCtx, access: Access, entity: Doc<"canonEntities">): Promise<boolean> {
  const sight = await entitySight(ctx, [access], entity);
  return "seen" in sight ? sight.seen : recordVisibleTo(ctx, access, entity.orgId, entity._id);
}

/** A company's or person's record-service id (`acc_…`, `con_…`), which its page and a task's Account or Person field name it by; null for any other record. */
async function registerIdOf(ctx: QueryCtx, streamId: Id<"canonEntities"> | string): Promise<string | null> {
  const id = ctx.db.normalizeId("canonEntities", streamId);
  const entity = id ? await ctx.db.get(id) : null;
  if (!entity || !isRegisterAutomationObject(entity.entityType)) return null;
  if (entity.projectionTable === "recordAccounts" || entity.projectionTable === "recordContacts") return entity.projectionId;
  const provider = entity.entityType === "account" ? ID.recordAccount : ID.recordContact;
  const ext = (await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entity._id)).take(20)).find((e) => e.provider === provider);
  return ext?.externalId ?? null;
}

/** A version as the proposals list and an agent read it: the document, who wrote it and why, its replay, and how it was decided. */
const versionView = async (ctx: QueryCtx, access: Access, row: Doc<"automationVersions">, head: Doc<"automationRules"> | null) => ({
  replay: row.replay ? { ...row.replay, by: await nameOf(ctx, row.replay.by), runs: await seenRuns(ctx, access, row.replay.runs) } : null,
  id: row._id, ruleId: row.ruleId ?? null, version: row.version, parent: row.parent, spec: row.spec, note: row.note, status: row.status,
  author: { name: await nameOf(ctx, row.author.userId), agent: row.author.agent ?? null },
  // A proposal written against a version that is no longer in force can't be approved.
  stale: row.status === "proposed" && row.ruleId !== undefined && (head?.version ?? 0) !== row.parent,
  ruleGone: row.ruleId !== undefined && !head,
  decidedBy: row.decidedBy ? await nameOf(ctx, row.decidedBy) : null, decidedAt: row.decidedAt ?? null, reason: row.reason ?? null, createdAt: row.createdAt,
  sentence: describe(row.spec, await namesFor(ctx, row.orgId, row.spec.object)),
});

/** Proposals waiting for an admin, each with the rule in force it would change, then the latest decided ones. */
export const proposals = query({
  args: {},
  handler: async (ctx) => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    const orgId = admin.user.orgId;
    const rowsOf = (status: "proposed" | "approved" | "rejected", n: number) =>
      ctx.db.query("automationVersions").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", status)).order("desc").take(n);
    const view = async (row: Doc<"automationVersions">) => {
      const head = row.ruleId ? await ctx.db.get(row.ruleId) : null;
      return { ...(await versionView(ctx, admin.access, row, head)), current: head ? { name: head.name, object: head.object, trigger: head.trigger, conditions: head.conditions, actions: head.actions, version: head.version ?? 0 } : null };
    };
    const open = await Promise.all((await rowsOf("proposed", OPEN_MAX)).map(view));
    const decided = [...(await rowsOf("approved", 10)), ...(await rowsOf("rejected", 10))].sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 10);
    return { open, decided: await Promise.all(decided.map(view)) };
  },
});

/** One rule, its sentence and its latest versions. */
export const get = query({
  args: { id: v.id("automationRules") },
  handler: async (ctx, args) => {
    const admin = await adminReader(ctx);
    const rule = admin ? await ctx.db.get(args.id) : null;
    if (!admin || !rule || rule.orgId !== admin.user.orgId) return null;
    const versions = await ctx.db.query("automationVersions").withIndex("by_ruleId_and_version", (q) => q.eq("ruleId", rule._id)).order("desc").take(20);
    return {
      ...(await ruleView(ctx, rule)), sentence: describe(rule, await namesFor(ctx, rule.orgId, rule.object)),
      versions: await Promise.all(versions.map((row) => versionView(ctx, admin.access, row, rule))),
    };
  },
});

/**
 * Check a rule document as a proposal would be checked, and say what it does in a sentence, without storing anything:
 * what an agent shows its user before it proposes.
 */
export const check = query({
  args: { ruleId: v.optional(v.id("automationRules")), ...ruleArgs },
  handler: async (ctx, { ruleId, ...doc }): Promise<{ ok: true; sentence: string; note?: string } | { ok: false; problem: string } | null> => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    try {
      if (ruleId) await ownRule(ctx, admin.user.orgId, ruleId);
      const spec = await checkRule(ctx, admin.user.orgId, doc);
      const note = reachNote(spec.object, (await loadDef(ctx, admin.user.orgId, spec.object)).pluralLabel);
      return { ok: true, sentence: describe(spec, await namesFor(ctx, admin.user.orgId, spec.object)), ...(note ? { note } : {}) };
    } catch (cause) {
      return { ok: false, problem: cause instanceof ConvexError ? String(cause.data) : cause instanceof Error ? cause.message : "Invalid rule" };
    }
  },
});

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
        // The records its lookups point at, whose fields an If's conditions can read.
        relations: await relationsOf(ctx, orgId, def),
        // Whether a task or owner can go to the record's company owner, and what a rule on it sees.
        companyOwner: companyField(def) !== null, reach: reachNote(def.apiName, def.pluralLabel),
        // What a webhook may name its records by.
        matchable: matchable(def),
      });
    }
    const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(100);
    const routing = await ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(50);
    return {
      objects,
      timezone: await timezoneOf(ctx, orgId),
      currency: (await ctx.db.get(orgId))?.defaultCurrency ?? "USD",
      members: (await workspaceMembers(ctx, orgId)).map((m) => ({ id: m.id, name: m.name })),
      teams: teams.map((t) => ({ id: t._id, name: t.name, size: t.memberIds.length })),
      routingRules: routing.map((r) => ({ id: r._id, name: r.name, size: r.assignees.length, isActive: r.isActive })),
      // Where a notify or webhook step may send: the Slack channels an admin mapped, the record webhooks an admin registered.
      slackChannels: (await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", orgId).eq("channel", "slack")).take(20)).map((t) => t.name),
      webhooks: await webhooksOf(ctx, orgId),
      // Ask Canon answers with a stand-in on a local stack, so a local check never spends a real plan (convex/automationAgent.ts).
      askStandIn: recipeAgentStandIn(),
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
    const linked = new Map<string, string | null>();
    for (const r of rows) if (isRegisterAutomationObject(r.object) && !linked.has(r.streamId)) linked.set(r.streamId, await registerIdOf(ctx, r.streamId));
    return rows.map((r) => ({
      id: r._id, streamId: r.streamId, recordId: linked.get(r.streamId) ?? null, object: r.object, title: r.title, event: r.event, change: r.change ?? null, matched: r.matched,
      status: r.status, reason: r.reason ?? null, depth: r.depth, steps: r.steps, resumeAt: r.resumeAt ?? null, version: r.version ?? null, createdAt: r.createdAt, finishedAt: r.finishedAt ?? null, triggeredAt: r.triggeredAt ?? null,
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

/**
 * The member the rule acts as, as they act now in its workspace, or null once they are no longer a member: whoever
 * approved its version in force (`actsAs`), else its creator, as before versions.
 */
async function principalOf(ctx: QueryCtx, rule: Doc<"automationRules">, as: Id<"users"> = actsAsOf(rule)): Promise<Principal | null> {
  const creator = await ctx.db.get(as);
  const role = creator ? await roleIn(ctx, creator, rule.orgId) : null;
  const accesses = creator && role ? await principalAccess(ctx, rule.orgId, [creator._id]) : null;
  if (!creator || !role || !accesses) return null;
  return { user: { ...creator, orgId: rule.orgId, role }, access: accesses[0] };
}

/** Who the rule acts as now: the admin who approved its version in force, else its creator. */
const actsAsOf = (rule: Doc<"automationRules">) => rule.actsAs ?? rule.createdBy;

async function pause(ctx: MutationCtx, rule: Doc<"automationRules">, reason: string) {
  await ctx.db.patch(rule._id, { status: "paused", pausedReason: reason, updatedAt: Date.now() });
}

const CREATOR_GONE = "Paused: the member this rule acts as is no longer in this workspace";

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

const TOO_LONG = "The record's history is too long to compare";
const OUTSIDE = "Outside the creator's access";
const NOT_MET = "Conditions not met";

/** What judging entries reads, cached across one pass: object definitions, records folded around an entry (counting what that read), the time zone. */
function reader(ctx: QueryCtx, orgId: Id<"organizations">) {
  const defs = new Map<string, ResolvedObjectDef>();
  const states = new Map<string, StreamStates>();
  let tz: string | undefined;
  const r = {
    folded: 0,
    defOf: async (object: string) => defs.get(object) ?? defs.set(object, await loadDef(ctx, orgId, object)).get(object)!,
    /** The record before and after the entry's save: after is through the last entry the same save wrote (a deal's create and its values). */
    statesAt: async (streamId: Id<"canonEntities">, version: number, observedAt: number): Promise<StreamStates> => {
      const key = `${streamId}@${version}`;
      if (states.has(key)) return states.get(key)!;
      const out = await statesAround(ctx, streamId, version, observedAt);
      r.folded += out.read;
      return states.set(key, out.states).get(key)!;
    },
    tz: async () => (tz ??= await timezoneOf(ctx, orgId)),
  };
  return r;
}
type Reader = ReturnType<typeof reader>;

type Change = { field: string; from: ReturnType<typeof stored>; to: ReturnType<typeof stored> };
/** One rule against one entry: not its trigger's change; the member it acts as is gone; a run that is skipped; or a run, with whether the record met the conditions. */
type Verdict = { kind: "none" } | { kind: "gone" } | { kind: "skipped"; reason: string } | { kind: "run"; matched: boolean; title: string; change?: Change; row: ListRow };

/**
 * Whether a ledger entry starts a rule's run, and what the run is. The fan-out writes the verdict as a run, and a
 * replay over past entries counts it: the same checks in the same order. `access` is whose sight decides (the member
 * the rule acts as; for a replay, who asked for it), null once that member left; `now` is when `{today}` is read.
 * Who wrote the entry (entryOrigin) and the rule's own start are the caller's to check first.
 */
async function judge(
  ctx: QueryCtx, r: Reader, rule: { object: string; trigger: Trigger; conditions: Condition[] }, row: Doc<"ledgerEntries">, body: EntryBody,
  access: () => Promise<Access | null>, now: number,
): Promise<Verdict> {
  const def = await r.defOf(rule.object);
  if (!mayTrigger(rule.trigger, def, row.version, body)) return { kind: "none" };
  const st = await r.statesAt(row.streamId, row.version, row.observedAt);
  if (!st) return { kind: "none" };
  if (st === "too_long") return { kind: "skipped", reason: TOO_LONG };
  const owner = row.object === "deal" ? { ownerId: await dealOwner(ctx, row.streamId) } : undefined;
  const after = rowOf(def, st.after, owner);
  const fired = triggerFires(rule.trigger, def, st.before ? project(def, st.before).values : null, after.values);
  if (!fired.fires) return { kind: "none" };
  const sees = await access();
  if (!sees) return { kind: "gone" };
  const entity = await ctx.db.get(row.streamId);
  // A record the rule's member cannot see does not run it (CP14). The run says so, without the record's name.
  if (!entity || !(await seesRecord(ctx, sees, entity))) return { kind: "skipped", reason: OUTSIDE };
  const change = rule.trigger.kind === "updated" && fired.to !== undefined ? { change: { field: rule.trigger.field ?? "", from: stored(fired.from ?? null), to: stored(fired.to) } } : {};
  return { kind: "run", matched: conditionsMet(def, after, rule.conditions, now, await r.tz()), title: after.title.slice(0, 200), ...change, row: after };
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
    const r = reader(ctx, orgId);
    const principals = new Map<string, Principal | null>();
    const toRun: Id<"automationRuns">[] = [];
    let more = false;
    const now = Date.now();

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
        const access = async () => {
          if (!principals.has(rule._id)) principals.set(rule._id, await principalOf(ctx, rule));
          return principals.get(rule._id)?.access ?? null;
        };
        const verdict = await judge(ctx, r, rule, row, body, access, now);
        if (verdict.kind === "none") continue;
        if (verdict.kind === "gone") {
          await pause(ctx, rule, CREATOR_GONE);
          rules = rules.filter((x) => x._id !== rule._id);
          continue;
        }
        const base = {
          orgId, ruleId: rule._id, shard: row.shard, seq: row.seq, streamId: row.streamId, object: row.object, event: rule.trigger.kind, depth: origin.depth, triggeredAt: row.observedAt, createdAt: now,
          ...(rule.version !== undefined ? { version: rule.version } : {}), actsAs: actsAsOf(rule),
        };
        if (verdict.kind === "skipped") {
          await ctx.db.insert("automationRuns", { ...base, title: "", matched: false, status: "skipped", reason: verdict.reason, steps: [], leaseUntil: now, finishedAt: now });
          continue;
        }
        const { matched } = verdict;
        const id = await ctx.db.insert("automationRuns", {
          ...base, ...(verdict.change ? { change: verdict.change } : {}), title: verdict.title, matched,
          status: matched ? "pending" : "skipped", ...(matched ? {} : { reason: NOT_MET, finishedAt: now }),
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
        if (r.folded >= FOLD_BUDGET || !rules.length) {
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
async function resolveOwner(ctx: MutationCtx, rule: Doc<"automationRules">, run: Doc<"automationRuns">, choice: OwnerChoice, ref: string, companyOwner: string | null = null): Promise<Id<"users">> {
  const orgId = rule.orgId;
  const nameOf = async (id: Id<"users">) => (await ctx.db.get(id))?.name ?? "That member";
  if (choice.kind === "member") {
    if (!(await activeMember(ctx, orgId, choice.userId))) throw new ConvexError(`${await nameOf(choice.userId)} is no longer a member of this workspace`);
    return choice.userId;
  }
  if (choice.kind === "record_owner" || choice.kind === "company_owner") {
    const owner = choice.kind === "record_owner" ? await recordOwner(ctx, run) : companyOwner;
    const id = owner ? ctx.db.normalizeId("users", owner) : null;
    if (!id || !(await activeMember(ctx, orgId, id))) throw new ConvexError(choice.kind === "record_owner" ? "The record has no owner who is a member" : "The record's company has no owner who is a member");
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
    start = rule.rotation?.[ref] ?? 0;
    save = (next) => ctx.db.patch(rule._id, { rotation: { ...(rule.rotation ?? {}), [ref]: next } });
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

async function perform(
  ctx: MutationCtx, p: Principal, rule: Doc<"automationRules">, run: Doc<"automationRuns">, a: Exclude<LeafAction, { kind: "wait" }>, ref: string, companyOwner: string | null,
): Promise<{ detail: string; streamId?: string }> {
  const mark: AutomationMark = { ruleId: rule._id, depth: run.depth + 1 };
  // The record must still be one the creator sees now, whatever the action (a retry can come long after the trigger).
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, run.streamId))) throw new ConvexError("Record not found");
  if (a.kind === "notify_slack" || a.kind === "notify_email" || a.kind === "call_webhook") {
    const def = await loadDef(ctx, rule.orgId, run.object);
    let row = await recordNow(ctx, def, p.access, run.streamId, run.object);
    let to: Id<"users"> | null = null;
    if (a.kind === "notify_email") {
      to = await resolveOwner(ctx, rule, run, a.to, ref);
      // The email says what the record holds: only to a member who sees it, and only the fields both they and the admin see.
      const [theirs] = (await principalAccess(ctx, rule.orgId, [to])) ?? [];
      if (!theirs || !(await recordVisibleTo(ctx, theirs, rule.orgId, run.streamId))) throw new ConvexError(`${(await ctx.db.get(to))?.name ?? "That member"} can't see this record`);
      row = { ...row, values: withoutHidden(theirs, run.object, row.values) };
    }
    return sendStep(ctx, { rule, run, ref, actsAs: p.user._id, def, row }, a, to);
  }
  if (a.kind === "set_field") return { detail: `${await writeRecord(ctx, p, run, { [a.field]: a.value }, mark)}: ${a.field}` };
  if (a.kind === "assign_owner") {
    const owner = await resolveOwner(ctx, rule, run, a.owner, ref, companyOwner);
    const said = await writeRecord(ctx, p, run, { ownerId: owner }, mark);
    return { detail: `${said === "Saved" ? "Owner set to" : "Owner already"} ${(await ctx.db.get(owner))?.name ?? owner}` };
  }
  const owner = await resolveOwner(ctx, rule, run, a.owner, ref, companyOwner);
  // A company's or person's task names it by its record-service id, as its page lists tasks by.
  const party = isRegisterAutomationObject(run.object) ? await registerIdOf(ctx, run.streamId) : null;
  const values: Record<string, FieldValue> = {
    subject: a.subject.replaceAll("{record}", run.title || "the record").slice(0, 500), dueDate: dueDate(Date.now(), a.dueInDays), ownerId: owner, status: "not_started",
    ...(run.object === "deal" ? { dealId: run.streamId } : {}), ...(party ? { [run.object === "account" ? "accountId" : "contactId"]: party } : {}),
  };
  await requireWritable(ctx, p.user, p.access, "task", "create", undefined, values);
  const made = await saveAsCaller(ctx, p.user, "task", { op: "create", values }, { automation: mark });
  if (made.status !== "applied" && made.status !== "proposed") throw saveError(made as { status: string; errors?: Array<{ message: string }> });
  if (TARGETS.has(run.object)) await attachTargets(ctx, p.user, made.streamId, [run.streamId]);
  return { detail: `Task for ${(await ctx.db.get(owner))?.name ?? owner}, due ${values.dueDate}`, streamId: made.streamId };
}

// ───────────────────────────── Ifs ─────────────────────────────

/** The related records an If needs before it can decide, and whose sight reads them: the executor reads them and sends them back. */
type Lookups = { ref: string; orgId: Id<"organizations">; access: Access; items: Array<{ via: string; object: string; id: string | null }> };
/** Related rows as the executor read them, as JSON (a list row's values are keyed by field), for the If at `ref`. */
const relatedArg = v.object({ ref: v.string(), rows: v.array(v.object({ via: v.string(), row: v.union(v.string(), v.null()) })) });
type RelatedRows = { ref: string; rows: Array<{ via: string; row: string | null }> };

/** The record now, as a list row its member's sight leaves: the If reads its own fields from it. */
async function recordNow(ctx: QueryCtx, def: ResolvedObjectDef, access: Access, streamId: Id<"canonEntities">, object: string): Promise<ListRow> {
  const st = (await statesAround(ctx, streamId, Number.MAX_SAFE_INTEGER, Number.NaN)).states;
  if (st === "too_long") throw new ConvexError(TOO_LONG);
  if (!st) throw new ConvexError("Record not found");
  const row = rowOf(def, st.after, object === "deal" ? { ownerId: await dealOwner(ctx, streamId) } : undefined);
  return { ...row, values: withoutHidden(access, object, row.values) };
}

/** The id each lookup an If reads holds on `row`: the related record to read, or null when the lookup is empty. */
async function lookupsOf(ctx: QueryCtx, orgId: Id<"organizations">, def: ResolvedObjectDef, row: ListRow, conditions: readonly Condition[]) {
  const out = [];
  for (const via of relatedVias(def, conditions)) {
    const rel = await relationOf(ctx, orgId, def, via);
    const id = row.values[def.byApiName.get(via)!.fieldId];
    out.push({ via, object: rel.object, id: typeof id === "string" && id ? id : null });
  }
  return out;
}

/** The related records an If reads, with their definitions, from the rows the executor read (null: missing or out of sight). */
async function relatedFrom(ctx: QueryCtx, orgId: Id<"organizations">, def: ResolvedObjectDef, conditions: readonly Condition[], rows: RelatedRows["rows"]) {
  const out: Record<string, Related> = {};
  for (const via of relatedVias(def, conditions)) {
    const found = rows.find((r) => r.via === via)?.row;
    out[via] = { def: (await relationOf(ctx, orgId, def, via)).def, row: found ? (JSON.parse(found) as ListRow) : null };
  }
  return out;
}

/**
 * Decide an If as the rule's member: the record as it is now (after the run's earlier steps), and each related record
 * as they see it now. Without the related rows it asks for them first; a related record they can't see reads empty.
 */
async function decide(
  ctx: QueryCtx, p: Principal, rule: Doc<"automationRules">, run: Doc<"automationRuns">, step: IfStep, ref: string, related: RelatedRows | undefined,
): Promise<{ took: Branch; detail: string } | { lookups: Lookups }> {
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, run.streamId))) throw new ConvexError("Record not found");
  const def = await loadDef(ctx, rule.orgId, run.object);
  const row = await recordNow(ctx, def, p.access, run.streamId, run.object);
  const rows = related?.ref === ref ? related.rows : null;
  if (relatedVias(def, step.conditions).length && !rows) {
    return { lookups: { ref, orgId: rule.orgId, access: p.access, items: await lookupsOf(ctx, rule.orgId, def, row, step.conditions) } };
  }
  const holds = ifHolds(def, row, step.conditions, await relatedFrom(ctx, rule.orgId, def, step.conditions, rows ?? []), Date.now(), await timezoneOf(ctx, rule.orgId));
  const words = describeConditions(run.object, step.conditions, await namesFor(ctx, rule.orgId, run.object));
  return { took: holds ? "then" : "else", detail: holds ? `Yes: ${words}` : `No: ${words}${step.else?.length ? "" : "; nothing to do"}` };
}

/** The related records an If asked for, read through its member's scoped client: one they can't see, or that is gone, comes back null. */
async function readRelated(ctx: ActionCtx, l: Lookups): Promise<RelatedRows> {
  const client = principalClient(ctx, l.orgId, [l.access]);
  const rows = [];
  for (const item of l.items) {
    const req = { filter: [{ field: "id", op: "eq" as const, value: item.id }], limit: 1 };
    const page = !item.id ? null : isRegisterObject(item.object) ? await client.listRegister(l.orgId, item.object, req) : await client.listObjects(l.orgId, item.object, req);
    rows.push({ via: item.via, row: page?.rows[0] ? JSON.stringify(page.rows[0]) : null });
  }
  return { ref: l.ref, rows };
}

/**
 * The owner of the run's record's company, for a step that gives a task or the record to the company owner: a
 * company's own owner, else the owner of the company its company lookup names, read through the rule's member's
 * scoped client (as an If reads a related record), so a company they can't see has no owner. Without the company's
 * row it asks for it first. Null when the step gives nothing to the company owner.
 */
async function companyOwnerFor(
  ctx: QueryCtx, p: Principal, rule: Doc<"automationRules">, run: Doc<"automationRuns">, a: LeafAction, ref: string, related: RelatedRows | undefined,
): Promise<{ owner: string | null } | { lookups: Lookups } | null> {
  const choice = a.kind === "create_task" || a.kind === "assign_owner" ? a.owner : null;
  if (choice?.kind !== "company_owner") return null;
  const def = await loadDef(ctx, rule.orgId, run.object);
  const via = companyField(def);
  if (via === "self") return { owner: await recordOwner(ctx, run) };
  if (!via) throw new ConvexError(`${def.pluralLabel} have no company to take an owner from`);
  if (related?.ref === ref) {
    const row = related.rows.find((r) => r.via === via)?.row;
    const owner = row ? (JSON.parse(row) as ListRow).values[(await loadDef(ctx, rule.orgId, "account")).byApiName.get("ownerId")?.fieldId ?? "ownerId"] : null;
    return { owner: typeof owner === "string" ? owner : null };
  }
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, run.streamId))) throw new ConvexError("Record not found");
  const id = (await recordNow(ctx, def, p.access, run.streamId, run.object)).values[def.byApiName.get(via)!.fieldId];
  if (typeof id !== "string" || !id) return { owner: null };
  return { lookups: { ref, orgId: rule.orgId, access: p.access, items: [{ via, object: "account", id }] } };
}

// ───────────────────────────── Waits ─────────────────────────────

/** How long a due run of a paused rule waits before the sweep looks at it again. */
const HELD_MS = 15 * 60_000;

/** When a Wait step that a run reaches now lets it go on: null when there is nothing to wait for (an empty or past date). */
async function waitUntil(ctx: QueryCtx, p: Principal, rule: Doc<"automationRules">, run: Doc<"automationRuns">, step: { days?: number; until?: string }, now: number) {
  const tz = await timezoneOf(ctx, rule.orgId);
  if (step.days !== undefined) return { at: resumeAt(step, undefined, now, tz), tz };
  // The date is read as the member sees the record now: a field hidden from them reads empty, so the run doesn't wait.
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, run.streamId))) throw new ConvexError("Record not found");
  const def = await loadDef(ctx, rule.orgId, run.object);
  const row = await recordNow(ctx, def, p.access, run.streamId, run.object);
  const f = def.byApiName.get(step.until!);
  return { at: resumeAt(step, f ? row.values[f.fieldId] : undefined, now, tz), tz };
}

/** Why a waiting run can't go on with its record, or null: the record was archived or deleted while it waited. */
async function recordGone(ctx: QueryCtx, run: Doc<"automationRuns">): Promise<string | null> {
  const st = (await statesAround(ctx, run.streamId, Number.MAX_SAFE_INTEGER, Number.NaN)).states;
  if (st === "too_long") return null;
  return !st || st.after.lifecycle.status !== "active" ? "The record was archived while this run waited" : null;
}

/**
 * Send a due waiting run on, if it can go: a rule deleted since ends it, a paused rule holds it (looked at again in
 * HELD_MS, so a resumed rule's runs go on), and a record archived since ends it with that reason. Its remaining steps
 * are then skipped.
 */
async function resumeRun(ctx: MutationCtx, run: Doc<"automationRuns">, now: number) {
  const rule = await ctx.db.get(run.ruleId);
  const end = (reason: string) => ctx.db.patch(run._id, {
    status: "skipped", reason, resumeAt: undefined, leaseUntil: now, finishedAt: now,
    steps: run.steps.map((s): Step => (s.status === "pending" ? { ...s, status: "skipped" } : s)),
  });
  if (!rule) return end("The rule was deleted while this run waited");
  if (rule.status !== "active") return void (await ctx.db.patch(run._id, { resumeAt: now + HELD_MS, leaseUntil: now + HELD_MS }));
  const gone = await recordGone(ctx, run);
  if (gone) return end(gone);
  await ctx.db.patch(run._id, { status: "pending", resumeAt: undefined, leaseUntil: now + LEASE_MS });
  await ctx.scheduler.runAfter(0, internal.automations.execute, { runId: run._id });
}

/** A step's place in the run's rule: its ref, or on a run from before Ifs, its position. */
const refOf = (s: Step, index: number) => s.ref ?? String(index);

/**
 * Run the next pending step of a run, its write and its `done` in one transaction. An If records the branch it took
 * and puts that branch's steps next, so a run's steps are its path through the rule. An If that reads a related
 * record returns what to read (`lookups`) and writes nothing: the executor reads them and calls again with `related`.
 */
export const step = internalMutation({
  args: { runId: v.id("automationRuns"), related: v.optional(relatedArg) },
  handler: async (ctx, args): Promise<{ done: boolean; lookups?: Lookups }> => {
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
    const ref = refOf(run.steps[index], index);
    const action = stepAt(run.actions ?? rule?.actions ?? [], ref);
    if (!rule || !action || action.kind !== run.steps[index].kind) throw new ConvexError(rule ? "The rule's actions changed since this run started" : "The rule was deleted");
    if (rule.status !== "active") throw new ConvexError(rule.pausedReason ?? "The rule is paused");
    // A run does its version's actions as the admin who approved that version, never as whoever approved a later one.
    const as = run.actsAs ?? actsAsOf(rule);
    const p = await principalOf(ctx, rule, as);
    if (!p) {
      if (as !== actsAsOf(rule)) throw new ConvexError("The admin who approved the version this run started under is no longer a member of this workspace");
      await pause(ctx, rule, CREATOR_GONE);
      throw new ConvexError("The rule's creator is no longer a member of this workspace");
    }
    let steps: Step[];
    if (action.kind === "if") {
      const out = await decide(ctx, p, rule, run, action, ref, args.related);
      if ("lookups" in out) return { done: false, lookups: out.lookups };
      const done: Step = { ...run.steps[index], ref, status: "done", attempts: run.steps[index].attempts + 1, detail: out.detail.slice(0, ERROR_MAX), at: now, branch: out.took };
      steps = [...run.steps.slice(0, index), done, ...branchSteps(ref, out.took, action[out.took] ?? []), ...run.steps.slice(index + 1)];
    } else if (action.kind === "wait") {
      const { at, tz } = await waitUntil(ctx, p, rule, run, action, now);
      const t = at !== null ? localTime(at, tz) : null;
      const detail = t ? `Until ${t.date} ${String(Math.floor(t.minute / 60)).padStart(2, "0")}:${String(t.minute % 60).padStart(2, "0")} (${tz})` : "No wait: the date is empty or has passed";
      steps = run.steps.map((s, i): Step => (i === index ? { ...s, ref, status: "done", attempts: s.attempts + 1, detail, at: now } : s));
      if (at !== null && steps.some((s) => s.status === "pending")) {
        await ctx.db.patch(run._id, { steps, status: "waiting", resumeAt: at, leaseUntil: at });
        return { done: true };
      }
    } else {
      const company = await companyOwnerFor(ctx, p, rule, run, action, ref, args.related);
      if (company && "lookups" in company) return { done: false, lookups: company.lookups };
      const out = await perform(ctx, p, rule, run, action, ref, company?.owner ?? null);
      steps = run.steps.map((s, i): Step => (i === index ? { ...s, status: "done", attempts: s.attempts + 1, detail: out.detail.slice(0, ERROR_MAX), at: now, ...(out.streamId ? { streamId: out.streamId } : {}) } : s));
    }
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
    let related: RelatedRows | undefined;
    // Each step once, and each If that reads a related record twice.
    for (let i = 0; i <= 2 * STEPS_MAX; i++) {
      try {
        const r: { done: boolean; lookups?: Lookups } = await ctx.runMutation(internal.automations.step, { ...args, ...(related ? { related } : {}) });
        if (r.done) return;
        related = r.lookups ? await readRelated(ctx, r.lookups) : undefined;
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
        ...(rule.version !== undefined ? { version: rule.version } : {}), actsAs: actsAsOf(rule),
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
    const client = callerClient(ctx, caller);
    const req = { filter: job.filter as ListFilter[], sort: { field: "createdAt", dir: "asc" as const }, limit: PREVIEW_ROWS };
    // A company or person is listed from the register, by its record-service id, which its page takes.
    const page = isRegisterObject(args.object) ? await client.listRegister(job.orgId, args.object, req) : await client.listObjects(job.orgId, args.object, req);
    return { total: page.total, rows: page.rows.map((r) => ({ streamId: r.id, title: r.title })), nextSlotAt: job.nextSlotAt, capped: page.total > SLOT_CAP };
  },
});

// ───────────────────────────── Replay ─────────────────────────────
//
// What a rule would have done over the last two weeks of its object's ledger, before it goes live: the fan-out's own
// checks (judge) on each past entry, writing nothing and running no action. It runs as one member, with their access
// now: whoever asks, or for an agent's proposal, the member whose token the agent used. A record they can't see is
// counted, never named. A schedule acts on what matches at each slot, so it has the dry run (preview) instead.

const REPLAY_DAYS = 14;
const DAY_MS = 86_400_000;
/** Entries one page reads; pages one replay reads before it says it is partial; runs it lists. */
const REPLAY_PAGE = 100;
const REPLAY_PAGES = 10;
const REPLAY_LISTED = 50;

/** Why a past change would not have run the rule, in words. `who` names the member the replay ran as. */
const REPLAY_REASONS = {
  conditions: () => NOT_MET,
  outside: (who: string) => `A record ${who} can't see`,
  tooLong: () => TOO_LONG,
  integration: () => "Brought in by an import or a CRM sync, which never starts a rule",
  depth: () => `Written by a chain of ${MAX_DEPTH} rules, where rules stop`,
} as const;
type ReplayReason = keyof typeof REPLAY_REASONS;

const replayDoc = { object: v.string(), trigger: triggerValidator, conditions: v.array(conditionValidator) };
type Path = Array<{ ref: string; took: Branch }>;
type ReplayRun = { streamId: string; at: number; title: string; change?: Change; path?: Path; recordId?: string };
/** A run a replay found, with what its Ifs read: the record right after the change (JSON) and the related records it looks up. */
type FoundRun = ReplayRun & { row?: string; lookups?: Lookups["items"] };
type ReplayPageOut = { runs: FoundRun[]; skipped: Array<{ reason: ReplayReason; at: number }>; scanned: number; through: number | null; cursor: string | null; done: boolean; access: Access; plural: string };

/**
 * One page of a replay: the object's entries from `since` on, each judged as the fan-out judges it, as `userId` sees
 * records now. It stops early at `foldBudget` stream entries read, and then can't continue (`cursor` null).
 */
export const replayPage = internalQuery({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), ruleId: v.optional(v.id("automationRules")), ...replayDoc,
    since: v.number(), cursor: v.union(v.string(), v.null()), foldBudget: v.optional(v.number()),
    /** The rule's Ifs' conditions, when it has any: each run then carries what they read. */
    ifConditions: v.optional(v.array(conditionValidator)),
  },
  handler: async (ctx, args): Promise<ReplayPageOut | null> => {
    const accesses = await principalAccess(ctx, args.orgId, [args.userId]);
    if (!accesses) return null;
    const r = reader(ctx, args.orgId);
    const budget = Math.min(args.foldBudget ?? FOLD_BUDGET, FOLD_BUDGET);
    const page = await ctx.db.query("ledgerEntries")
      .withIndex("by_orgId_object_observedAt", (q) => q.eq("orgId", args.orgId).eq("object", args.object).gte("observedAt", args.since))
      .paginate({ numItems: REPLAY_PAGE, cursor: args.cursor });
    const def = await r.defOf(args.object);
    const out: ReplayPageOut = { runs: [], skipped: [], scanned: 0, through: null, cursor: page.isDone ? null : page.continueCursor, done: page.isDone, access: accesses[0], plural: def.pluralLabel };
    for (const row of page.page) {
      if (r.folded >= budget) return { ...out, cursor: null, done: false };
      out.scanned++;
      out.through = row.observedAt;
      if (row.redactedAt !== undefined) continue;
      const body = fromStored<EntryBody>(row.body);
      const origin = entryOrigin(row.source, row.actor);
      if (!origin.ok) {
        // Only an entry that is the trigger's kind of change is worth saying was skipped.
        if (mayTrigger(args.trigger, def, row.version, body)) out.skipped.push({ reason: origin.reason === "depth" ? "depth" : "integration", at: row.observedAt });
        continue;
      }
      // A rule's own writes never start it again.
      if (args.ruleId && origin.mark?.ruleId === args.ruleId) continue;
      const verdict = await judge(ctx, r, args, row, body, async () => accesses[0], row.observedAt);
      if (verdict.kind === "none" || verdict.kind === "gone") continue;
      if (verdict.kind === "skipped") out.skipped.push({ reason: verdict.reason === OUTSIDE ? "outside" : "tooLong", at: row.observedAt });
      else if (!verdict.matched) out.skipped.push({ reason: "conditions", at: row.observedAt });
      else {
        const ifs = args.ifConditions && out.runs.length < REPLAY_LISTED
          ? { row: JSON.stringify({ ...verdict.row, values: withoutHidden(accesses[0], args.object, verdict.row.values) }), lookups: await lookupsOf(ctx, args.orgId, def, verdict.row, args.ifConditions) }
          : {};
        const recordId = isRegisterAutomationObject(args.object) ? await registerIdOf(ctx, row.streamId) : null;
        out.runs.push({ streamId: row.streamId, at: row.observedAt, title: verdict.title, ...(verdict.change ? { change: verdict.change } : {}), ...(recordId ? { recordId } : {}), ...ifs });
      }
    }
    return out;
  },
});

/** What a replay found: how often the rule would have run and on what, what it would have skipped and why, and whether it read the whole window. */
export type ReplayResult = {
  schedule: false; since: number; until: number; wouldRun: number; runs: ReplayRun[]; skipped: Array<{ reason: string; count: number }>;
  partial: boolean; through: number | null; scanned: number; notes: string[]; asked: string;
};
type ReplayJob = {
  orgId: Id<"organizations">; userId: Id<"users">; userName: string; ruleId?: Id<"automationRules">; versionId?: Id<"automationVersions">;
  object: string; trigger: Trigger; conditions: Condition[]; actions?: AutomationAction[];
};

/** What the replay reads now rather than as it was at each change, in words: the caveats an approver should know. */
function replayNotes(job: Pick<ReplayJob, "object" | "trigger" | "conditions" | "actions">): string[] {
  const notes = ["Each change is checked against the record as it was right after it, and \"today\" as of that day. Nothing was written and no action ran."];
  const ifs = ifConditionsOf(job.actions ?? []);
  const owner = [...job.conditions, ...ifs].some((c) => c.field === "ownerId") || (job.trigger.kind === "updated" && job.trigger.field === "ownerId");
  if (job.object === "deal" && owner) notes.push("A deal's owner is read as it is now, not as it was at each change.");
  if (ifs.length) notes.push("Each If is checked against the record right after the change, before the rule's own actions.");
  if (walkSteps(job.actions ?? []).some(({ step }) => step.kind === "wait")) notes.push("A Wait step is reported, not simulated: each run is counted when it would have started, and what it would do after the wait is read as at the change.");
  return notes;
}

/** Every condition of every If in a rule. */
const ifConditionsOf = (actions: readonly RuleStep[]) => walkSteps(actions).flatMap(({ step }) => (step.kind === "if" ? step.conditions : []));

/**
 * The way each found run would go through the rule's Ifs: its record right after the change, and the related records
 * read now (`related`, by stream or register id) as the replay's member sees them. Also says which related fields
 * were read as they are now, in the sentence's words.
 */
export const replayPaths = internalQuery({
  args: {
    orgId: v.id("organizations"), object: v.string(), actions: v.array(actionValidator),
    runs: v.array(v.object({ at: v.number(), row: v.string(), lookups: v.array(v.object({ via: v.string(), object: v.string(), id: v.union(v.string(), v.null()) })) })),
    related: v.array(v.object({ object: v.string(), id: v.string(), row: v.union(v.string(), v.null()) })),
  },
  handler: async (ctx, args): Promise<{ paths: Path[]; note: string | null }> => {
    const def = await loadDef(ctx, args.orgId, args.object);
    const tz = await timezoneOf(ctx, args.orgId);
    const conditions = ifConditionsOf(args.actions);
    const paths = [];
    for (const run of args.runs) {
      const rows = run.lookups.map((l) => ({ via: l.via, row: args.related.find((r) => r.object === l.object && r.id === l.id)?.row ?? null }));
      const related = await relatedFrom(ctx, args.orgId, def, conditions, rows);
      const row = JSON.parse(run.row) as ListRow;
      paths.push(pathThrough(args.actions, (s) => ifHolds(def, row, s.conditions, related, run.at, tz)));
    }
    const dotted = conditions.filter((c) => relatedOf(def, c.field));
    const names = dotted.length ? await namesFor(ctx, args.orgId, args.object) : {};
    // A field's name as the sentence says it: the words before " is not empty".
    const named = [...new Set(dotted.map((c) => describeConditions(args.object, [{ field: c.field, op: "notEmpty" }], names).replace(/ is not empty$/, "")))];
    return { paths, note: named.length ? `${named.join(", ")} ${named.length === 1 ? "is" : "are"} read as ${named.length === 1 ? "it is" : "they are"} now, not as at each change.` : null };
  },
});

/** Read the window page by page, up to REPLAY_PAGES, and sum it up. */
export async function runReplay(ctx: ActionCtx, job: ReplayJob, foldBudget?: number): Promise<ReplayResult> {
  const until = Date.now();
  const since = until - REPLAY_DAYS * DAY_MS;
  const runs: FoundRun[] = [];
  const reasons = new Map<ReplayReason, number>();
  const ifConditions = ifConditionsOf(job.actions ?? []);
  let access: Access | null = null;
  let plural = job.object;
  let cursor: string | null = null;
  let scanned = 0;
  let through: number | null = null;
  let partial = true;
  for (let i = 0; i < REPLAY_PAGES; i++) {
    const page: ReplayPageOut | null = await ctx.runQuery(internal.automations.replayPage, {
      orgId: job.orgId, userId: job.userId, ...(job.ruleId ? { ruleId: job.ruleId } : {}), object: job.object, trigger: job.trigger, conditions: job.conditions, since, cursor,
      ...(foldBudget !== undefined ? { foldBudget } : {}), ...(ifConditions.length && runs.length < REPLAY_LISTED ? { ifConditions } : {}),
    });
    if (!page) throw new ConvexError(`${job.userName} is no longer a member of this workspace`);
    access = page.access;
    plural = page.plural;
    runs.push(...page.runs);
    for (const sk of page.skipped) reasons.set(sk.reason, (reasons.get(sk.reason) ?? 0) + 1);
    scanned += page.scanned;
    through = page.through ?? through;
    if (page.done) {
      partial = false;
      break;
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  const listed: ReplayRun[] = runs.slice(0, REPLAY_LISTED).map(({ row: _row, lookups: _lookups, ...run }) => run);
  const notes = replayNotes(job);
  const reach = reachNote(job.object, plural);
  if (reach) notes.push(`${reach} Only ${plural.toLowerCase()} someone has worked in Canon have changes to replay.`);
  const traced = runs.slice(0, REPLAY_LISTED).filter((r) => r.row !== undefined);
  if (job.actions && traced.length && access) {
    // The related records each If reads, read once each, now, as the replay's member sees them.
    const wanted = new Map(traced.flatMap((r) => r.lookups ?? []).filter((l) => l.id).map((l) => [`${l.object}:${l.id}`, l]));
    const read = await readRelated(ctx, { ref: "", orgId: job.orgId, access, items: [...wanted.values()] });
    const related = [...wanted.values()].map((l, i) => ({ object: l.object, id: l.id!, row: read.rows[i].row }));
    const out: { paths: Path[]; note: string | null } = await ctx.runQuery(internal.automations.replayPaths, {
      orgId: job.orgId, object: job.object, actions: job.actions, runs: traced.map((r) => ({ at: r.at, row: r.row!, lookups: r.lookups ?? [] })), related,
    });
    traced.forEach((r, i) => (listed[runs.indexOf(r)].path = out.paths[i]));
    if (out.note) notes.push(out.note);
  }
  return {
    schedule: false, since, until, wouldRun: runs.length, runs: listed, partial, through, scanned, notes, asked: job.userName,
    skipped: [...reasons].map(([reason, count]) => ({ reason: REPLAY_REASONS[reason](job.userName), count })),
  };
}

/** Who asks for a replay (an admin), and the rule document it reads: a proposal's, a rule's, or one given inline. */
export const replayJob = internalQuery({
  args: {
    versionId: v.optional(v.id("automationVersions")), ruleId: v.optional(v.id("automationRules")),
    object: v.optional(v.string()), trigger: v.optional(triggerValidator), conditions: v.optional(v.array(conditionValidator)), actions: v.optional(v.array(actionValidator)),
  },
  handler: async (ctx, args): Promise<ReplayJob | null> => {
    const admin = await adminReader(ctx);
    if (!admin) return null;
    const orgId = admin.user.orgId;
    const asked = { orgId, userId: admin.user._id, userName: admin.user.name };
    if (args.versionId) {
      const row = await ctx.db.get(args.versionId);
      if (!row || row.orgId !== orgId) throw new ConvexError("Proposal not found");
      return { ...asked, ...(row.ruleId ? { ruleId: row.ruleId } : {}), ...(row.status === "proposed" ? { versionId: row._id } : {}), object: row.spec.object, trigger: row.spec.trigger, conditions: row.spec.conditions, actions: row.spec.actions };
    }
    if (args.ruleId) {
      const rule = await ownRule(ctx, orgId, args.ruleId);
      return { ...asked, ruleId: rule._id, object: rule.object, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions };
    }
    if (!args.object || !args.trigger) throw new ConvexError("Name a proposal (versionId), a rule (ruleId), or a rule's object, trigger and conditions");
    if (!isAutomationObject(args.object)) throw new ConvexError(`Rules do not run on ${args.object} records yet`);
    const problem = conditionsProblem(await loadDef(ctx, orgId, args.object), args.conditions ?? []);
    if (problem) throw new ConvexError(problem);
    return { ...asked, object: args.object, trigger: args.trigger, conditions: args.conditions ?? [], ...(args.actions ? { actions: args.actions } : {}) };
  },
});

/** The replay an agent's proposal gets when it arrives: as the member whose token the agent used, with their access. */
export const replayVersionJob = internalQuery({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args): Promise<ReplayJob | null> => {
    const row = await ctx.db.get(args.versionId);
    if (!row || row.status !== "proposed") return null;
    return {
      orgId: row.orgId, userId: row.author.userId, userName: await nameOf(ctx, row.author.userId), ...(row.ruleId ? { ruleId: row.ruleId } : {}), versionId: row._id,
      object: row.spec.object, trigger: row.spec.trigger, conditions: row.spec.conditions, actions: row.spec.actions,
    };
  },
});

const replaySummary = (result: ReplayResult, by: Id<"users">) => ({
  at: result.until, by, since: result.since, wouldRun: result.wouldRun, skipped: result.skipped, partial: result.partial, through: result.through, scanned: result.scanned,
  notes: result.notes, runs: result.runs.slice(0, REPLAY_LISTED).map((x) => ({ streamId: x.streamId, at: x.at, title: x.title, ...(x.path ? { path: x.path } : {}) })),
});

/** Keep a replay on the proposal it was run for, so the approver sees it without running it again. A decided proposal keeps the one it had. */
export const saveReplay = internalMutation({
  args: { versionId: v.id("automationVersions"), replay: replaySummaryValidator },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.versionId);
    if (row?.status === "proposed") await ctx.db.patch(row._id, { replay: args.replay });
    return null;
  },
});

export const replayVersion = internalAction({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args): Promise<void> => {
    const job: ReplayJob | null = await ctx.runQuery(internal.automations.replayVersionJob, args);
    if (!job || job.trigger.kind === "schedule" || isOnDemand(job.trigger)) return;
    await ctx.runMutation(internal.automations.saveReplay, { versionId: args.versionId, replay: replaySummary(await runReplay(ctx, job), job.userId) });
  },
});

/**
 * Replay a proposal (`versionId`), a rule (`ruleId`) or a rule document over the last 14 days of its object's
 * history, as the caller sees records. Writes nothing but the summary on a proposal. A schedule answers
 * `{ schedule: true }`: use the dry run (preview) for what it would act on.
 */
export const replay = action({
  args: {
    versionId: v.optional(v.id("automationVersions")), ruleId: v.optional(v.id("automationRules")),
    object: v.optional(v.string()), trigger: v.optional(triggerValidator), conditions: v.optional(v.array(conditionValidator)), actions: v.optional(v.array(actionValidator)),
  },
  handler: async (ctx, args): Promise<ReplayResult | { schedule: true } | { onDemand: true }> => {
    await requireCaller(ctx, { read: true });
    const job: ReplayJob | null = await ctx.runQuery(internal.automations.replayJob, args);
    if (!job) throw new ConvexError("Only admins manage automation rules");
    if (job.trigger.kind === "schedule") return { schedule: true };
    if (isOnDemand(job.trigger)) return { onDemand: true };
    const result = await runReplay(ctx, job);
    if (job.versionId) await ctx.runMutation(internal.automations.saveReplay, { versionId: job.versionId, replay: replaySummary(result, job.userId) });
    return result;
  },
});

// ───────────────────────────── On demand ─────────────────────────────
//
// A rule whose trigger is "manual" runs on one record when a member who can edit it asks, from its page or an agent's
// tool; a "webhook" rule runs on the record a signed POST to its own URL names. Either way it runs as its approver,
// like any rule: the approver must still be a member and see the record, and the record must meet its conditions.
// A webhook rule's signing secret is a person's to make (shown once) and never moves with an imported workspace.

export const AUTOMATION_WEBHOOK_PREFIX = "/automations/webhook/";
export const automationWebhookUrl = (id: Id<"automationRules">) => `${(process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "")}${AUTOMATION_WEBHOOK_PREFIX}${id}`;

/** What a webhook may name records of `def` by: their id, or a unique field (a company's domain, a person's email). */
function matchable(def: ResolvedObjectDef): string[] {
  if (def.apiName === "account") return ["id", "domain"];
  if (def.apiName === "contact") return ["id", "email"];
  return ["id", ...def.fields.filter((f) => !f.system && f.archivedAt === undefined && "unique" in f && f.unique === true).map((f) => f.apiName)];
}

const secretOf = async (ctx: QueryCtx, ruleId: Id<"automationRules">) => ctx.db.query("automationWebhookSecrets").withIndex("by_ruleId", (q) => q.eq("ruleId", ruleId)).unique();

/** The object a stream is a record of, as rules name objects. */
const objectOfEntity = (e: Doc<"canonEntities">) => (e.entityType === "opportunity" ? "deal" : e.entityType);

/**
 * The stream of the record of `object` that `value` names: by id (a stream id; a company's or person's record-service
 * id too) or by a unique field. Null when none does, or when it is archived. A company or person nobody has worked in
 * Canon has no stream, so a rule can't run on it.
 */
async function recordNamed(ctx: MutationCtx, orgId: Id<"organizations">, def: ResolvedObjectDef, match: string, value: unknown): Promise<Id<"canonEntities"> | null> {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return null;
  const store = convexObjectStore(ctx);
  const find = async (provider: string, key: string) => {
    const id = await store.findByExternalId(orgId, provider, key);
    return id ? ctx.db.normalizeId("canonEntities", id) : null;
  };
  let streamId: Id<"canonEntities"> | null;
  if (match === "id") {
    streamId = ctx.db.normalizeId("canonEntities", value)
      ?? (def.apiName === "account" ? await find(ID.recordAccount, value) : def.apiName === "contact" ? await find(ID.recordContact, value) : null);
  } else if (def.apiName === "account" || def.apiName === "contact") {
    streamId = def.apiName === "account" ? await find(ID.domain, normalizeDomain(value)) : await find(ID.email, normalizeEmail(value));
  } else {
    const f = def.byApiName.get(match);
    const key = f ? uniqueClaimKeys(def, f.fieldId, value)[0]?.key : undefined;
    streamId = f && key ? await find(uniqueClaimProvider(def, f.fieldId), key) : null;
  }
  const entity = streamId ? await ctx.db.get(streamId) : null;
  if (!entity || entity.orgId !== orgId || objectOfEntity(entity) !== def.apiName) return null;
  const st = (await statesAround(ctx, entity._id, Number.MAX_SAFE_INTEGER, Number.NaN)).states;
  return st && st !== "too_long" && st.after.lifecycle.status === "active" ? entity._id : null;
}

/**
 * Start a run of an on-demand rule on one record, as its approver: refused when the approver left (the rule pauses),
 * can't see the record, or the record doesn't meet the rule's conditions.
 */
async function startOnDemand(
  ctx: MutationCtx, rule: Doc<"automationRules">, streamId: Id<"canonEntities">, extra: { startedBy?: Id<"users">; eventKey?: string },
): Promise<Id<"automationRuns">> {
  const p = await principalOf(ctx, rule);
  if (!p) {
    await pause(ctx, rule, CREATOR_GONE);
    throw new ConvexError(CREATOR_GONE);
  }
  if (!(await recordVisibleTo(ctx, p.access, rule.orgId, streamId))) throw new ConvexError(`${p.user.name}, who this rule acts as, can't see this record`);
  const def = await loadDef(ctx, rule.orgId, rule.object);
  const row = await recordNow(ctx, def, p.access, streamId, rule.object);
  if (!conditionsMet(def, row, rule.conditions, Date.now(), await timezoneOf(ctx, rule.orgId))) {
    throw new ConvexError(`The record doesn't meet the rule's conditions: ${describeConditions(rule.object, rule.conditions, await namesFor(ctx, rule.orgId, rule.object))}`);
  }
  const now = Date.now();
  const runId = await ctx.db.insert("automationRuns", {
    orgId: rule.orgId, ruleId: rule._id, shard: -2, seq: now, streamId, object: rule.object, title: row.title.slice(0, 200), event: rule.trigger.kind,
    matched: true, status: "pending", depth: 0, triggeredAt: now, steps: initialSteps(rule.actions), actions: rule.actions, leaseUntil: now + LEASE_MS, createdAt: now,
    ...(rule.version !== undefined ? { version: rule.version } : {}), actsAs: actsAsOf(rule), ...extra,
  });
  await ctx.scheduler.runAfter(0, internal.automations.execute, { runId });
  return runId;
}

/**
 * Run a "manual" rule on one record (`id`: its stream id, or a company's or person's record-service id). Any member who
 * can edit the record may, in person or through their agent; the rule still acts as the admin who approved it.
 */
const CANT_RUN = "You can run a rule only on a record you can edit";
export const runOnRecord = mutation({
  args: { ruleId: v.id("automationRules"), id: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const rule = await ownRule(ctx, user.orgId, args.ruleId);
    if (rule.trigger.kind !== "manual") throw new ConvexError("This rule runs on its own trigger, not on request");
    if (rule.status !== "active") throw new ConvexError(rule.pausedReason ?? "The rule is paused");
    const streamId = await recordNamed(ctx, user.orgId, await loadDef(ctx, user.orgId, rule.object), "id", args.id);
    const access = await accessFor(ctx, user);
    // Whoever starts it must be able to edit the record themselves: the rule's actions are its approver's, not a way round their own role.
    // A company or person nobody has worked in Canon has no history for a rule to read; any other id names nothing.
    if (!streamId) throw new ConvexError(isRegisterAutomationObject(rule.object) ? "A rule runs on a company or person once someone has worked it in Canon: edit it once, then run the rule" : CANT_RUN);
    if (!may(access, rule.object, "edit") || !(await recordVisibleTo(ctx, access, user.orgId, streamId))) {
      throw new ConvexError(CANT_RUN);
    }
    const agent = await agentClientOf(ctx);
    const runId = await startOnDemand(ctx, rule, streamId, { startedBy: user._id });
    await audit(ctx, user, "automation_rule.run", { ruleId: rule._id, runId, streamId, ...(agent ? { agent } : {}) });
    return { runId };
  },
});

/** The rules a member may run on a record of `object` now: active "manual" rules, by name and sentence. */
export const manualRules = query({
  args: { object: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rules = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId).eq("status", "active")).take(RULES_MAX);
    const mine = rules.filter((r) => r.object === args.object && r.trigger.kind === "manual");
    const names = mine.length ? await namesFor(ctx, user.orgId, args.object) : {};
    return mine.map((r) => ({ id: r._id, name: r.name, sentence: describe(r, names) }));
  },
});

/**
 * Make a webhook rule's signing secret, replacing any it had. A person does, in person; the secret is returned here
 * once and kept encrypted.
 */
export const rotateWebhookSecret = action({
  args: { ruleId: v.id("automationRules") },
  handler: async (ctx, args): Promise<{ secret: string; url: string }> => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    await ctx.runMutation(internal.automations.saveWebhookSecret, { ruleId: args.ruleId, secret: await encryptForStorage(secret) });
    return { secret, url: automationWebhookUrl(args.ruleId) };
  },
});

export const saveWebhookSecret = internalMutation({
  args: { ruleId: v.id("automationRules"), secret: sealedV },
  handler: async (ctx, args) => {
    const p = await requirePerson(ctx);
    const rule = await ownRule(ctx, p.orgId, args.ruleId);
    if (rule.trigger.kind !== "webhook") throw new ConvexError("Only a rule a webhook starts has a signing secret");
    const old = await secretOf(ctx, rule._id);
    if (old) await ctx.db.delete(old._id);
    await ctx.db.insert("automationWebhookSecrets", { orgId: p.orgId, ruleId: rule._id, secret: args.secret, createdBy: p._id, createdAt: Date.now() });
    await audit(ctx, p, "automation_rule.rotate_webhook_secret", { ruleId: rule._id });
    return null;
  },
});

/** For the webhook route only: the stored (encrypted) secret of an active webhook rule. */
export const webhookSecret = internalQuery({
  args: { ruleId: v.string() },
  handler: async (ctx, args) => {
    const ruleId = ctx.db.normalizeId("automationRules", args.ruleId);
    const rule = ruleId ? await ctx.db.get(ruleId) : null;
    if (!rule || rule.status !== "active" || rule.trigger.kind !== "webhook") return null;
    const row = await secretOf(ctx, rule._id);
    return row ? { ruleId: rule._id, secret: row.secret } : null;
  },
});

/**
 * One signed request to a webhook rule: the record its body names, once per event key (a redelivery starts nothing new).
 * A record that isn't there, or that the rule's member can't see, gets the same answer.
 */
export const receiveWebhook = internalMutation({
  args: { ruleId: v.id("automationRules"), eventKey: v.string(), value: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ status: "started"; runId: Id<"automationRuns"> } | { status: "duplicate" } | { status: "refused"; error: string; code: 404 | 409 | 422 }> => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule || rule.status !== "active" || rule.trigger.kind !== "webhook") return { status: "refused", error: "This rule isn't taking requests", code: 409 };
    const seen = await ctx.db.query("automationRuns").withIndex("by_ruleId_and_eventKey", (q) => q.eq("ruleId", rule._id).eq("eventKey", args.eventKey)).first();
    if (seen) return { status: "duplicate" };
    if (args.value === undefined) return { status: "refused", error: `The body needs "${rule.trigger.match}": the record's ${rule.trigger.match === "id" ? "id" : rule.trigger.match}`, code: 422 };
    const streamId = await recordNamed(ctx, rule.orgId, await loadDef(ctx, rule.orgId, rule.object), rule.trigger.match, args.value);
    const p = await principalOf(ctx, rule);
    if (streamId && p && !(await recordVisibleTo(ctx, p.access, rule.orgId, streamId))) return { status: "refused", error: "No record matches", code: 404 };
    if (!streamId) return { status: "refused", error: "No record matches", code: 404 };
    try {
      return { status: "started", runId: await startOnDemand(ctx, rule, streamId, { eventKey: args.eventKey }) };
    } catch (cause) {
      return { status: "refused", error: messageOf(cause), code: 422 };
    }
  },
});

/** Check a webhook request against its rule's secret, then start its run: what the HTTP route calls (lib/automationWebhookRoute.ts). */
export async function handleAutomationWebhook(
  ctx: ActionCtx, ruleId: string, body: string, headers: { timestamp: string | null; signature: string | null }, now = Date.now(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const stored: { ruleId: Id<"automationRules">; secret: string } | null = await ctx.runQuery(internal.automations.webhookSecret, { ruleId });
  const verdict = stored ? await verifyWebhook({ secret: await decryptFromStorage(stored.secret), body, nowMs: now, ...headers }) : { ok: false as const, reason: "bad_signature" as const };
  if (!stored || !verdict.ok) return { status: 401, body: { error: verdict.ok ? "bad_signature" : verdict.reason } };
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 422, body: { error: "The body is not JSON." } };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { status: 422, body: { error: "The body must be a JSON object." } };
  const rule = await ctx.runQuery(internal.automations.webhookMatch, { ruleId: stored.ruleId });
  const value = rule ? (payload as Record<string, unknown>)[rule.match] : undefined;
  const out: { status: "started"; runId: string } | { status: "duplicate" } | { status: "refused"; error: string; code: number } = await ctx.runMutation(internal.automations.receiveWebhook, {
    ruleId: stored.ruleId, eventKey: await eventKeyOf(payload, body), ...(typeof value === "string" ? { value } : {}),
  });
  if (out.status === "refused") return { status: out.code, body: { error: out.error } };
  return out.status === "started" ? { status: 202, body: { status: "started", runId: out.runId } } : { status: 200, body: { status: "duplicate" } };
}

/** The body key a webhook rule reads its record from. */
export const webhookMatch = internalQuery({
  args: { ruleId: v.id("automationRules") },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    return rule?.trigger.kind === "webhook" ? { match: rule.trigger.match } : null;
  },
});

// ───────────────────────────── Sweep ─────────────────────────────

/**
 * Every minute: wake the fan-out for each org with an active rule (a lost
 * wake-up costs a minute, not a run), start scheduled rules' due slots, send
 * runs whose executor died (their lease ran out; finished steps are not
 * repeated), send on waiting runs that are due, and drop old runs.
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
    // Waiting runs that are due go on (or end, or wait for their paused rule).
    const resuming = await ctx.db.query("automationRuns").withIndex("by_status_and_resumeAt", (q) => q.eq("status", "waiting").gte("resumeAt", 0).lte("resumeAt", now)).take(100);
    for (const run of resuming) if (run.resumeAt !== undefined && run.resumeAt <= now) await resumeRun(ctx, run, now);
    for (const status of ["done", "failed", "skipped"] as const) {
      const old = await ctx.db.query("automationRuns").withIndex("by_status_and_leaseUntil", (q) => q.eq("status", status).lt("leaseUntil", now - KEEP_RUNS_MS)).take(100);
      for (const run of old) if (run.leaseUntil < now - KEEP_RUNS_MS) await ctx.db.delete(run._id);
    }
    return null;
  },
});
