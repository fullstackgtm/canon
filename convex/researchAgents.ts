/**
 * Research agents (AI fields): org-defined questions about accounts, answered
 * by reading each account's website, or about contacts, answered per person from
 * their company's site and their profile page. Every answer is a proposed fact on
 * `custom.<slug>` with a quote found word for word in a saved page; the
 * write gate (canonGate.ts) decides whether it lands. By default an admin's
 * new field auto-accepts an answer when Jev confirms the quote supports it
 * (DEFAULT_AUTO_ACCEPT); everything else waits in the review queue.
 *
 * Each field is run by an org-owned agent (convex/agents.ts) with one
 * accountable owner. A run starts, continues and lands answers only while that
 * agent is active, checked in the transaction that acts.
 *
 * Runs are manual, over a TAM scope, capped at RUN_CAP accounts; accounts that
 * already have an answer for the field, or were tried without one in the last
 * 30 days, are skipped, so a re-run continues.
 *
 * A field may also refresh itself weekly or monthly (startDueRefreshes, from a
 * cron). A refresh re-asks only accepted answers older than the cadence, at
 * most RUN_CAP per run, on the agent OWNER's ChatGPT plan: never the server's
 * key. With the agent paused or the owner not connected it does not run; the
 * field shows why (refreshHold) and the next due check tries again.
 * The research itself runs in convex/researchAgentActions.ts (Node).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { callerClient, requireCaller } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap, requireUser } from "./lib";
import { filterValidator, type ContactScope, type RunScope } from "./lib/scopeValidators";
import { proposedFactValidator, scheduleReapply, submitProposalBatch } from "./canonGate";
import { listedDef } from "./savedViews";
import { ID } from "./lib/canon/identity";
import { dayColumnsOf, expandDayFilters } from "./lib/objects/views";
import { actingAgent, ensureFieldAgent, fieldAgentView, ownerFactsOf, standing } from "./agents";
import { standingOf, type Standing } from "./lib/agents/standing";
import { PEOPLE_RESEARCH_MAX } from "./lib/plays/peopleResearch";
import { enabledFor, enablementRow, orgRecipe, playsFor, recipeIn, requirePlays, type FoundRecipe } from "./lib/recipes";
import { contributionsOf, type PeopleField, type Settings } from "../recipes/index.ts";
import { resolveField, type RecipeField, type ResolvedField } from "../recipes/fields.ts";
import { isFactualField, RUN_CAP, SAVE_BATCH_PAGES, SAVED_PAGE_CHARS, attributeFor, agentSlug, checkSpec, type AgentSpec } from "./lib/research/agentLoop";
import { RECORD_CREDITS, RECORD_MICRO, REFRESH_CADENCES, cadenceMs, type RefreshCadence } from "./lib/research/runPlan";
import { chargeLanded, creditState } from "./credits";
import { canonResearchLlm } from "./lib/canonModel";
import { MICRO } from "./lib/creditPacks";
import { PROBE_SIZE } from "./lib/research/probe";
import { probeVerdict } from "./lib/research/probe";
import { traceValidator } from "./lib/research/validators";
import { watchRun } from "./lib/research/watch";
import { piEligible } from "./lib/research/piProtocol";
import { piResearchEnabled } from "./lib/research/piEnablement";
import { researchRecords } from "./lib/research/runVisibility";
import { accessFor, entitySight, principalAccess, sightAdmits, type PendingSight } from "./permissions";
import { agentPrincipals, hiddenFields, narrowsReads, seesRunRecords, type Access } from "./lib/access";
export { RUN_CAP };

export const MAX_AGENTS = 50;
/** An admin's new field auto-accepts answers Jev scores at least this. */
export const DEFAULT_AUTO_ACCEPT = 0.8;
/** An account researched without an answer is skipped by later runs for this long. */
const RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;
/** A running run with no progress for this long is treated as dead. */
const STALL_MS = 10 * 60_000;
/** Fields one due check starts at most; the rest stay due and go next tick. */
const REFRESH_BATCH = 25;
/** A field that could not run (busy, paused, owner not connected) is looked at again after this. */
const REFRESH_RETRY_MS = 6 * 60 * 60_000;
/**
 * A refresh treats answers (and "tried" marks) from the previous cycle's run as stale even if they
 * landed a little after it started, so a cycle never slips by the run's own duration.
 */
const STALE_GRACE_MS = 6 * 60 * 60_000;

const optionValidator = v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) });
const kindValidator = v.union(v.literal("classify"), v.literal("qa"));
const answerTypeValidator = v.union(v.literal("text"), v.literal("number"), v.literal("boolean"));

const entityTypeValidator = v.union(v.literal("account"), v.literal("contact"));
/** Rows a selected-rows scope may name; a run still researches at most RUN_CAP of them. */
const MAX_SCOPE_IDS = 1000;
/** Which contacts a contact field's run covers: every contact, a saved view's, or chosen rows (record-service ids). */
export const contactScopeValidator = v.union(
  v.object({ kind: v.literal("all") }),
  v.object({ kind: v.literal("view"), viewId: v.id("savedViews") }),
  v.object({ kind: v.literal("ids"), ids: v.array(v.string()) }),
);
export async function resolveContactScope(ctx: QueryCtx, user: Doc<"users">, scope: typeof contactScopeValidator.type): Promise<ContactScope> {
  if (scope.kind === "all") return { filter: [] };
  if (scope.kind === "ids") {
    const ids = [...new Set(scope.ids)].slice(0, MAX_SCOPE_IDS);
    if (!ids.length) throw new ConvexError("Select at least one contact.");
    return { ids };
  }
  const view = await ctx.db.get(scope.viewId);
  if (!view || view.orgId !== user.orgId || view.object !== "contact" || !(view.shared || view.createdBy === user._id)) throw new ConvexError("View not found");
  return { filter: expandDayFilters(view.spec.filter, dayColumnsOf(await listedDef(ctx, user.orgId, "contact"))) };
}

function specOf(a: Doc<"researchAgents">): AgentSpec {
  return { entityType: a.entityType, label: a.label, kind: a.kind, question: a.question, options: a.options, answerType: a.answerType, ...(a.judgment ? { judgment: true } : {}) };
}

/** The owner a field's agent answers to: its agent's, or for a field not linked yet its creator (who becomes the owner on link). */
const fieldOwner = (field: Doc<"researchAgents">, linked: Doc<"agents"> | null) => linked?.ownerUserId ?? field.createdBy;

/**
 * A run as people read it. The records it read (its traces and its probe's
 * sample) are shown to a viewer only when `seesRunRecords` (CP14): one of its
 * principals, or a viewer whose role narrows nothing. Anyone else sees counts.
 */
export function publicResearchRun(r: Doc<"researchRuns">, field: Doc<"researchAgents">, viewer: { access: Access; ownerUserId: string }) {
  const probe = r.trigger === "probe";
  const records = seesRunRecords(viewer.access, agentPrincipals({ ownerUserId: viewer.ownerUserId, startedBy: r.createdBy }));
  return {
    id: r._id, status: r.status, inScope: r.inScope, planned: r.planned, done: r.done, skipped: r.skipped,
    answered: r.answered, unknown: r.unknown, noEvidence: r.noEvidence, inferred: r.inferred ?? 0, errors: r.errors,
    pagesRead: r.pagesRead, llmCalls: r.llmCalls, error: r.error ?? null, stop: r.watch ?? null,
    credits: { cap: r.capMicro === undefined ? null : r.capMicro / MICRO, spent: (r.spentMicro ?? 0) / MICRO },
    scheduled: r.trigger === "refresh", probe, createdAt: r.createdAt, updatedAt: r.updatedAt,
    runtime: r.runtime ?? "convex",
    sample: probe ? (records ? (r.sample ?? []).map(({ entityId: _e, ...row }) => row) : []) : null,
    verdict: probe ? probeVerdict(r.sample ?? [], field, r.status !== "running") : null,
  };
}

async function agentBySlug(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, slug: string) {
  return ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
}

async function autoAcceptThresholds(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">) {
  const rules = await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500);
  return (attribute: string, entityType: "account" | "contact") =>
    rules.find((r) => r.sourceKind === "agent_run" && r.entityType === entityType && r.attribute === attribute && r.enabled)?.minConfidence ?? null;
}

async function setRule(ctx: MutationCtx, user: Doc<"users">, attribute: string, minConfidence: number | null, entityType: "account" | "contact") {
  const rows = await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
  const existing = rows.find((r) => r.sourceKind === "agent_run" && r.attribute === attribute && r.entityType === entityType);
  const doc = {
    orgId: user.orgId, sourceKind: "agent_run" as const, entityType, attribute,
    minConfidence: minConfidence ?? existing?.minConfidence ?? DEFAULT_AUTO_ACCEPT, enabled: minConfidence !== null,
    updatedBy: user._id, updatedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, doc);
  else if (minConfidence !== null) await ctx.db.insert("canonAutoAcceptRules", doc);
}

// ───────────────────────────── Reads ─────────────────────────────

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { agents: [], canEditGate: false, canRefresh: false };
    return fieldsFor(ctx, user, await accessFor(ctx, user));
  },
});

export async function fieldsFor(ctx: QueryCtx, user: Doc<"users"> & { capabilities?: readonly string[] }, access: Access) {
  const agents = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(MAX_AGENTS);
  const threshold = await autoAcceptThresholds(ctx, user.orgId);
  const recipeTitleById = new Map<string, string>();
  for (const id of new Set(agents.flatMap((a) => (a.recipe ? [a.recipe.id] : [])))) recipeTitleById.set(id, (await recipeIn(ctx, user.orgId, id))?.recipe.title ?? id);
  const out = [];
  for (const a of agents) {
    const latest = await ctx.db.query("researchRuns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", a._id)).order("desc").first();
    const linked = a.agentId ? await ctx.db.get(a.agentId) : null;
    out.push({
      id: a._id, slug: a.slug, attribute: attributeFor(a.slug), label: a.label, kind: a.kind, question: a.question,
      options: a.options ?? null, answerType: a.answerType ?? null, judgment: a.judgment ?? false, autoAcceptMinConfidence: threshold(attributeFor(a.slug), a.entityType), entityType: a.entityType,
      refresh: { cadence: a.refreshCadence ?? null, nextAt: a.refreshNextAt ?? null, hold: a.refreshHold ?? null },
      recipe: a.recipe ? { id: a.recipe.id, version: a.recipe.version, title: recipeTitleById.get(a.recipe.id)! } : null,
      createdAt: a.createdAt, latestRun: latest ? publicResearchRun(latest, a, { access, ownerUserId: fieldOwner(a, linked) }) : null, agent: await fieldAgentView(ctx, user, a),
    });
  }
  return { agents: out, canEditGate: can(user, "writeGate.edit"), canRefresh: can(user, "strategy.edit") };
}

/**
 * A field's most recent answers across its accounts or contacts, newest
 * first, for the records every one of `accesses` sees (CP14). An answer on a
 * company or person whose record-service id is not in `admitted` is left out
 * and its id listed in `pending`, for an action to admit through the caller's
 * scoped client (answersScoped). A hidden field shows none.
 */
async function answersAs(ctx: QueryCtx, orgId: Id<"organizations">, accesses: readonly Access[], slug: string, limit: number | undefined, admitted: ReadonlySet<string>) {
  const attribute = attributeFor(slug);
  const want = Math.min(Math.max(limit ?? 50, 1), 200);
  // A narrowed viewer sees some of them: read past the limit, up to the most a page shows.
  const facts = await ctx.db.query("facts")
    .withIndex("by_orgId_attribute_observedAt", (q) => q.eq("orgId", orgId).eq("attribute", attribute))
    .order("desc")
    .take(accesses.some(narrowsReads) ? 200 : want);
  const rows = [];
  const pending: PendingSight[] = [];
  for (const f of facts) {
    const entity = await ctx.db.get(f.entityId);
    if (!entity || entity.orgId !== orgId) continue;
    // Judged by the record's own type, so a field deleted since (its facts stay) keeps its rules.
    if (accesses.some((a) => hiddenFields(a, entity.entityType).includes(attribute))) continue;
    const sight = await entitySight(ctx, accesses, entity);
    if (!sightAdmits(sight, admitted)) {
      if (!("seen" in sight)) pending.push(sight);
      continue;
    }
    if (rows.length >= want) continue;
    rows.push({
      factId: f._id, entityId: f.entityId, account: entity.label ?? null, value: f.value, status: f.status,
      evidence: f.evidence ?? null, confidence: f.confidence, verification: f.verification?.score ?? null,
      // "read": the answer is Jev's inference and the score its read of the record.
      verifiedBy: f.verification?.kind ?? (f.verification ? "evidence" : null),
      observedAt: f.observedAt, decidedBy: f.decidedBy ?? null,
    });
  }
  return { rows, pending };
}

/**
 * A field's most recent answers across its accounts or contacts, newest
 * first, on the records the caller sees. Null when some of them are
 * companies or people only the record service can judge (a role that sees
 * only some of them): answersScoped serves those callers.
 */
export const answers = query({
  args: { slug: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const { rows, pending } = await answersAs(ctx, user.orgId, [await accessFor(ctx, user)], args.slug, args.limit, new Set());
    return pending.length ? null : rows;
  },
});

/** answersAs for an action (answersScoped), with the record ids it admitted. */
export const answersFor = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()), slug: v.string(), limit: v.optional(v.number()), admitted: v.array(v.string()) },
  handler: (ctx, args) => answersAs(ctx, args.orgId, args.accesses as Access[], args.slug, args.limit, new Set(args.admitted)),
});

const MAX_ANSWER_ROWS = 500;
type ShownAnswer = { value: string | number | boolean | null; status: "accepted" | "proposed"; evidence: string | null };

/**
 * Contact AI field answers by contact then field slug, for the contacts every
 * one of `accesses` sees (CP14): the accepted answer, else the newest one
 * still waiting for review. A contact only the record service can judge is
 * left out unless `admitted` holds its record-service id; `pending` lists
 * those ids. A field hidden from the caller is left out.
 */
async function contactAnswersAs(ctx: QueryCtx, orgId: Id<"organizations">, accesses: readonly Access[], slugs: readonly string[], recordIds: readonly string[], admitted: ReadonlySet<string>) {
  if (slugs.length > MAX_AGENTS || recordIds.length > MAX_ANSWER_ROWS) throw new ConvexError("Too many rows or fields");
  const hidden = new Set(accesses.flatMap((a) => hiddenFields(a, "contact")));
  const shown = slugs.filter((slug) => !hidden.has(attributeFor(slug)));
  const answers: Record<string, Record<string, ShownAnswer>> = {};
  const pending: PendingSight[] = [];
  const since = new Map<string, number>();
  for (const slug of shown) since.set(slug, (await agentBySlug(ctx, orgId, slug))?.questionSince ?? 0);
  for (const id of new Set(recordIds)) {
    const entityId = ctx.db.normalizeId("canonEntities", id);
    const ext = entityId ? null : await ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId).eq("provider", ID.recordContact).eq("externalId", id)).first();
    const entity = entityId ?? ext?.entityId;
    const doc = entity && (await ctx.db.get(entity));
    if (!doc || doc.orgId !== orgId || doc.entityType !== "contact") continue;
    const sight = await entitySight(ctx, accesses, doc);
    if (!sightAdmits(sight, admitted)) {
      if (!("seen" in sight)) pending.push(sight);
      continue;
    }
    for (const slug of shown) {
      const recent = await ctx.db.query("facts")
        .withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", doc._id).eq("attribute", attributeFor(slug)).gte("observedAt", since.get(slug)!)).order("desc").take(10);
      const fact = recent.find((f) => f.status === "accepted") ?? recent.find((f) => f.status === "proposed");
      if (fact && !Array.isArray(fact.value)) (answers[id] ??= {})[slug] = { value: fact.value, status: fact.status as "accepted" | "proposed", evidence: fact.evidence ?? null };
    }
  }
  return { answers, pending };
}

/**
 * Contact AI field answers for a page of contacts (record-service ids; Canon entity ids also work), by
 * contact then field slug: the accepted answer, else the newest one still waiting for review. Rejected
 * and superseded answers are not shown. `evidence` is the quote and source (evidenceText). Null when the
 * caller sees only some contacts: contactAnswersScoped admits them through their scope.
 */
export const contactAnswers = query({
  args: { slugs: v.array(v.string()), recordIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return {};
    const { answers, pending } = await contactAnswersAs(ctx, user.orgId, [await accessFor(ctx, user)], args.slugs, args.recordIds, new Set());
    return pending.length ? null : answers;
  },
});

type Answers = Awaited<ReturnType<typeof answersAs>>;
type ContactAnswers = Awaited<ReturnType<typeof contactAnswersAs>>;

/**
 * `answers` for a caller who sees only some of the field's records: the
 * companies or people the query could not judge are admitted through the
 * caller's scoped client (records.callerClient), the rest judged as there.
 */
export const answersScoped = action({
  args: { slug: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Answers["rows"]> => {
    const caller = await requireCaller(ctx, { read: true });
    const orgId = caller.orgId as Id<"organizations">;
    const read = (admitted: string[]): Promise<Answers> => ctx.runQuery(internal.researchAgents.answersFor, { orgId, accesses: [caller.access], slug: args.slug, limit: args.limit, admitted });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, async (admitted) => {
      const r = await read(admitted);
      return { pending: r.pending, value: r.rows };
    });
  },
});

/** `contactAnswers` for a caller who sees only some contacts: their ids are admitted through the caller's scoped client. */
export const contactAnswersScoped = action({
  args: { slugs: v.array(v.string()), recordIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<ContactAnswers["answers"]> => {
    const caller = await requireCaller(ctx, { read: true });
    const orgId = caller.orgId as Id<"organizations">;
    const read = (admitted: string[]): Promise<ContactAnswers> => ctx.runQuery(internal.researchAgents.contactAnswersFor, { orgId, accesses: [caller.access], ...args, admitted });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, async (admitted) => {
      const r = await read(admitted);
      return { pending: r.pending, value: r.answers };
    });
  },
});

/** contactAnswersAs for an action (contactAnswersScoped), with the record ids it admitted. */
export const contactAnswersFor = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()), slugs: v.array(v.string()), recordIds: v.array(v.string()), admitted: v.array(v.string()) },
  handler: (ctx, args) => contactAnswersAs(ctx, args.orgId, args.accesses as Access[], args.slugs, args.recordIds, new Set(args.admitted)),
});

export const runs = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return researchRunsFor(ctx, user, await accessFor(ctx, user), args.slug);
  },
});

export async function researchRunsFor(ctx: QueryCtx, user: Doc<"users">, access: Access, slug: string, selectedRun?: string) {
  const agent = await agentBySlug(ctx, user.orgId, slug);
  if (!agent) return [];
  const selectedId = selectedRun === undefined ? null : ctx.db.normalizeId("researchRuns", selectedRun);
  const selected = selectedId ? await ctx.db.get(selectedId) : null;
  const rows = selectedRun === undefined
    ? await ctx.db.query("researchRuns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", agent._id)).order("desc").take(10)
    : selected && selected.orgId === user.orgId && selected.agentId === agent._id ? [selected] : [];
  const linked = agent.agentId ? await ctx.db.get(agent.agentId) : null;
  const viewer = { access, ownerUserId: fieldOwner(agent, linked) };
  return rows.map((r) => publicResearchRun(r, agent, viewer));
}

/** How a run researched each record, for a viewer who may see its records (CP14). */
export const traces = query({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!user || !run || run.orgId !== user.orgId) return [];
    return (await researchRecords(ctx, user.orgId, await accessFor(ctx, user), run)).records;
  },
});

// ───────────────────────────── Definitions ─────────────────────────────

export const create = mutation({
  args: {
    label: v.string(),
    kind: kindValidator,
    question: v.string(),
    options: v.optional(v.array(optionValidator)),
    answerType: v.optional(answerTypeValidator),
    /** What the field is answered about; accounts when absent. */
    entityType: v.optional(entityTypeValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const entityType = args.entityType ?? "account";
    let spec: AgentSpec;
    try { spec = checkSpec(args); } catch (e) { throw new ConvexError(e instanceof Error ? e.message : String(e)); }
    const existing = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(MAX_AGENTS + 1);
    if (existing.length >= MAX_AGENTS) throw new ConvexError(`A workspace can have up to ${MAX_AGENTS} AI fields.`);
    const slug = await freeSlug(ctx, user.orgId, spec.label, existing);
    // Only an admin may change the write gate, so only an admin's field starts with auto-accept on.
    const autoAccept = can(user, "writeGate.edit") ? DEFAULT_AUTO_ACCEPT : undefined;
    const now = Date.now();
    const fieldId = await ctx.db.insert("researchAgents", {
      orgId: user.orgId, slug, label: spec.label, entityType, kind: spec.kind, question: spec.question,
      ...(spec.options ? { options: spec.options } : {}), ...(spec.answerType ? { answerType: spec.answerType } : {}),
      ...(autoAccept !== undefined ? { autoAcceptMinConfidence: autoAccept } : {}),
      createdBy: user._id, createdAt: now, updatedAt: now,
    });
    await ensureFieldAgent(ctx, (await ctx.db.get(fieldId))!);
    if (autoAccept !== undefined) await setRule(ctx, user, attributeFor(slug), autoAccept, entityType);
    return { slug, attribute: attributeFor(slug) };
  },
});

/**
 * Edit a field's name, question and option wording. Its slug (the ledger attribute), what it applies to, its type and
 * its answer type stay: answers already recorded are keyed by them. Options may be added but not removed, since answers
 * hold option keys. `askAgain` starts the question over (questionSince): answers recorded before stop counting and the
 * next run asks every record again. Without it, a reworded question keeps its answers.
 */
export const update = mutation({
  args: { slug: v.string(), label: v.string(), question: v.string(), options: v.optional(v.array(optionValidator)), askAgain: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const field = await agentBySlug(ctx, user.orgId, args.slug);
    if (!field) throw new ConvexError("Unknown field");
    if (await hasLiveRun(ctx, field._id)) throw new ConvexError("Stop the run in progress before editing this field.");
    let spec: AgentSpec;
    try { spec = checkSpec({ ...specOf(field), label: args.label, question: args.question, ...(field.kind === "classify" ? { options: args.options ?? field.options } : {}) }); }
    catch (e) { throw new ConvexError(e instanceof Error ? e.message : String(e)); }
    const kept = new Set(spec.options?.map((o) => o.key));
    const dropped = (field.options ?? []).filter((o) => !kept.has(o.key));
    if (dropped.length > 0) throw new ConvexError(`Answers already recorded may use ${dropped.map((o) => `“${o.label}”`).join(" or ")}, so options can't be removed. Create a new field for a different set.`);
    const now = Date.now();
    await ctx.db.patch(field._id, {
      label: spec.label, question: spec.question, ...(spec.options ? { options: spec.options } : {}),
      ...(args.askAgain ? { questionSince: now } : {}), updatedAt: now,
    });
    const agentId = await ensureFieldAgent(ctx, field);
    await ctx.db.patch(agentId, { label: spec.label, updatedAt: now });
    return null;
  },
});

/** Turn auto-accept on (with a Jev threshold) or off for one field. Admins only, like the rest of the write gate. */
export const setAutoAccept = mutation({
  args: { slug: v.string(), minConfidence: v.union(v.number(), v.null()) },
  handler: setResearchAutoAccept,
});

export async function setResearchAutoAccept(ctx: MutationCtx, args: { slug: string; minConfidence: number | null }) {
  const user = await requireUser(ctx);
  if (!can(user, "writeGate.edit")) throw new ConvexError(refusal("writeGate.edit"));
  if (args.minConfidence !== null && !(args.minConfidence >= 0.5 && args.minConfidence <= 1)) throw new ConvexError("The threshold must be between 0.5 and 1");
  const agent = await agentBySlug(ctx, user.orgId, args.slug);
  if (!agent) throw new ConvexError("Unknown field");
  await ensureFieldAgent(ctx, agent);
  await ctx.db.patch(agent._id, { autoAcceptMinConfidence: args.minConfidence ?? undefined, updatedAt: Date.now() });
  await setRule(ctx, user, attributeFor(agent.slug), args.minConfidence, agent.entityType);
  // A lower threshold also accepts the field's waiting answers whose stored Jev score now clears it.
  await scheduleReapply(ctx, user.orgId, "agent_run", attributeFor(agent.slug), agent.entityType, args.minConfidence !== null);
  return null;
}

/**
 * A slug no live field uses and no deleted field left behind. A deleted field's
 * facts and rule stay in the ledger, so reusing its slug would show its old
 * answers under a new question and skip those accounts.
 */
async function freeSlug(ctx: MutationCtx, orgId: Id<"organizations">, label: string, existing: Array<Doc<"researchAgents">>) {
  const taken = new Set(existing.map((a) => a.slug));
  const rules = await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500);
  for (const r of rules) if (r.attribute.startsWith("custom.")) taken.add(r.attribute.slice("custom.".length));
  for (;;) {
    const slug = agentSlug(label, taken);
    const used = await ctx.db.query("facts")
      .withIndex("by_orgId_attribute_observedAt", (q) => q.eq("orgId", orgId).eq("attribute", attributeFor(slug))).first()
      ?? await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).first();
    if (!used) return slug;
    taken.add(slug);
  }
}

/**
 * Delete a field's definition. Its facts stay in the ledger (append-only); its
 * auto-accept rule is turned off; its agent is archived, never deleted, since
 * facts and plans point at it.
 */
export const remove = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const agent = await agentBySlug(ctx, user.orgId, args.slug);
    if (!agent) return null;
    const running = await ctx.db.query("researchRuns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", agent._id)).order("desc").take(5);
    for (const r of running) if (r.status === "running") await ctx.db.patch(r._id, { status: "cancelled", updatedAt: Date.now() });
    // Turning a gate off only narrows it, so a manager may; an orphaned rule would keep auto-accepting.
    await setRule(ctx, user, attributeFor(agent.slug), null, agent.entityType);
    const agentId = await ensureFieldAgent(ctx, agent);
    await ctx.db.patch(agentId, { archivedAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId, userId: user._id, agentId, verb: "do", operation: "agent.archive", status: "applied",
      details: { fieldSlug: agent.slug }, createdAt: Date.now(),
    });
    await ctx.db.delete(agent._id);
    return null;
  },
});

// ───────────────────────────── Runs ─────────────────────────────

/** Whether a run of this field is in progress. A run whose action died (deploy, crash) never reports back; it is failed here so it can't block forever. */
async function hasLiveRun(ctx: MutationCtx, fieldId: Id<"researchAgents">): Promise<boolean> {
  const recent = await ctx.db.query("researchRuns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", fieldId)).order("desc").take(5);
  let live = false;
  for (const r of recent) {
    if (r.status !== "running") continue;
    if (Date.now() - r.updatedAt > STALL_MS) {
      await ctx.db.patch(r._id, { status: "failed", error: "Stalled", updatedAt: Date.now() });
      // Its action died mid-page: give back what that page held.
      await ctx.scheduler.runAfter(0, internal.credits.meterRun, { spender: { researchRunId: r._id }, provider: "research", releaseAll: true });
    } else live = true;
  }
  return live;
}

/**
 * Research a TAM scope with one field. Runs on the caller's ChatGPT plan. A paused agent's refusal is returned, not thrown, so the
 * pause it may latch commits.
 */
// An account field takes `filter` (a TAM scope); a contact field takes `contacts`.
/** Research without a ChatGPT plan needs at least one record's credits to start. */
export async function requireResearchCredits(ctx: QueryCtx, orgId: Id<"organizations">): Promise<void> {
  const org = await ctx.db.get(orgId);
  const state = org && creditState(org, Date.now());
  const spendable = state ? state.paidMicro + state.freeLeftMicro : 0;
  if (spendable < RECORD_MICRO) {
    throw new ConvexError(`Without a ChatGPT plan, researching a record costs ${credits(RECORD_CREDITS)} and the workspace has ${Math.floor(spendable / MICRO)} left. Sign in with ChatGPT under Integrations → ChatGPT to research for free, or an admin can buy credits under Settings → Billing & usage.`);
  }
}

/**
 * A person found to have left the company (lib/jobChange.ts): a "no longer works here" answer on the recipe's
 * still-at-company field, proposed as that field's agent with the check's summary as its evidence, so the deal
 * reads them as gone (lib/plays/peopleResearch.ts employment). Returns false when the field's agent can't act.
 */
export const recordDeparture = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), slug: v.string(), recordId: v.string(), entityId: v.id("canonEntities"), evidence: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const field = await agentBySlug(ctx, args.orgId, args.slug);
    if (!field) return false;
    const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, field));
    if (!acting.ok) return false;
    await submitProposalBatch(ctx, {
      attribution: { kind: "agent", agent: acting.agent, triggeredBy: args.userId },
      sourceKind: "agent_run",
      title: `${field.label}: a job change`,
      reason: `A job change check found they left (AI field "${field.label}")`,
      facts: [{ entityType: "contact", entityId: args.entityId, attribute: attributeFor(field.slug), value: false, evidence: args.evidence.slice(0, 4000), confidence: 1 }],
      admitted: [args.recordId],
    });
    return true;
  },
});

/** requireResearchCredits for an action. */
export const checkResearchCredits = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => requireResearchCredits(ctx, args.orgId).then(() => null),
});

const credits = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

// `capCredits`: the most a run may spend (RECORD_CREDITS per record researched); absent, enough for a whole run.
const runArgs = { slug: v.string(), filter: v.optional(filterValidator), contacts: v.optional(contactScopeValidator), capCredits: v.optional(v.number()) };
type RunStart = { runId: Id<"researchRuns">; refused: null } | { runId: null; refused: string };

export const startRun = mutation({
  args: runArgs,
  handler: (ctx, args): Promise<RunStart> => startResearchRun(ctx, args),
});

/**
 * Try a field on a random sample of the records a run of this scope would research
 * (lib/research/probe.ts). Its answers land like any run's, so a full run afterwards
 * continues past them.
 */
export const startProbe = mutation({
  args: runArgs,
  handler: (ctx, args): Promise<RunStart> => probeResearchRun(ctx, args),
});

type ResearchStartArgs = { slug: string; filter?: typeof filterValidator.type; contacts?: typeof contactScopeValidator.type; capCredits?: number };

export const startResearchRun = (ctx: MutationCtx, args: ResearchStartArgs): Promise<RunStart> => start(ctx, args, false);
export const probeResearchRun = (ctx: MutationCtx, args: ResearchStartArgs): Promise<RunStart> => start(ctx, args, true);

async function start(ctx: MutationCtx, args: ResearchStartArgs, probe: boolean): Promise<RunStart> {
  const user = await requireUser(ctx);
  if (!integrationEnabled("chatgpt") && !integrationEnabled("openrouter")) return { runId: null, refused: "AI research is off. Configure TOKEN_ENCRYPTION_KEY or OPENROUTER_API_KEY." };
  // A probe researches its sample, so it may spend that much; a run what its cap allows, in whole records.
  const capMicro = probe ? PROBE_SIZE * RECORD_MICRO : Math.round((args.capCredits ?? RUN_CAP * RECORD_CREDITS) * MICRO);
  if (!Number.isFinite(capMicro) || capMicro < RECORD_MICRO) throw new ConvexError(`Set a cap of at least ${credits(RECORD_CREDITS)}, the cost of researching one record.`);
  // Research on the starter's own ChatGPT plan costs no credits. Without one, it runs on Canon's research model
  // and spends credits, decided here once so a run never switches how it is paid.
  const plan = await ctx.db.query("chatgptAuth").withIndex("by_userId", (q) => q.eq("userId", user._id)).unique();
  const onCredits = !integrationEnabled("chatgpt") || plan?.status !== "connected";
  if (onCredits) {
    if (!canonResearchLlm()) throw new ConvexError("No AI model is connected. Sign in with ChatGPT under Integrations → ChatGPT.");
    await requireResearchCredits(ctx, user.orgId);
  }
  const agent = await agentBySlug(ctx, user.orgId, args.slug);
  if (!agent) throw new ConvexError("Unknown field");
  if (agent.entityType === "contact" && !args.contacts) throw new ConvexError("Choose which contacts to research.");
  const scope: RunScope = agent.entityType === "contact"
    ? { entity: "contact", scope: await resolveContactScope(ctx, user, args.contacts!) }
    : { entity: "account", filter: args.filter ?? {} };
  const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, agent));
  if (!acting.ok) return { runId: null, refused: acting.message };
  if (await hasLiveRun(ctx, agent._id)) throw new ConvexError("A run for this field is already in progress.");
  const now = Date.now();
  const pi = piResearchEnabled(user.orgId) && piEligible({ trigger: probe ? "probe" : undefined, onCredits }, specOf(agent));
  const runId = await ctx.db.insert("researchRuns", {
    orgId: user.orgId, agentId: agent._id, filter: scope.entity === "contact" ? scope.scope : scope.filter, scope, status: "running",
    inScope: 0, planned: 0, done: 0, skipped: 0, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 0, llmCalls: 0,
    ...(probe ? { trigger: "probe" as const } : {}), ...(onCredits ? { onCredits: true } : {}), capMicro, spentMicro: 0, createdBy: user._id, createdAt: now, updatedAt: now,
    ...(pi ? { runtime: "pi" as const, piStep: 0 } : {}),
  });
  if (pi) await ctx.scheduler.runAfter(0, internal.piRuntime.start, { runId });
  else await ctx.scheduler.runAfter(0, internal.researchAgentActions.runSlice, { runId });
  return { runId, refused: null };
}

/**
 * A recipe's AI field (recipes/fields.ts) as the workspace's row, made with `user` as its owner when the workspace
 * doesn't have it: they pay for its refreshes, every `refresh` (the field's own, else `fallbackRefresh`). Auto-accept
 * starts at the recipe's suggested threshold only when `user` is an admin, who alone may change the write gate.
 * A field the workspace has under the slug is used as it is: its slug is its attribute, so its answers stay. One no
 * recipe made yet takes this recipe's provenance. Otherwise it says why there's none: the workspace is full, or someone
 * deleted the field (its agent keeps the slug's identity, and the deletion is theirs to undo, not a recipe's).
 */
export async function ensureField(ctx: MutationCtx, user: Doc<"users">, recipe: { id: string; version: string }, spec: ResolvedField, fallbackRefresh?: RefreshCadence): Promise<FieldMade> {
  const provenance = { id: recipe.id, version: recipe.version, key: spec.slug };
  const found = await agentBySlug(ctx, user.orgId, spec.slug);
  if (found) {
    // A field from an earlier recipe version takes the recipe's judgment flag, and its question if it still
    // asks a retired default; a question someone wrote stays as it is.
    const retired = spec.replaces?.includes(found.question) ?? false;
    const judged = (spec.judgment ?? false) !== (found.judgment ?? false);
    if (judged || retired || !found.recipe) {
      // A new question starts over: answers and attempts under the old one no longer count (questionSince).
      const now = Date.now();
      await ctx.db.patch(found._id, {
        ...(judged || retired ? { ...(spec.judgment ? { judgment: true } : { judgment: undefined }), updatedAt: now } : {}),
        ...(retired ? { question: spec.question, questionSince: now } : {}),
        ...(found.recipe ? {} : { recipe: provenance }),
      });
      return { ok: true, field: (await ctx.db.get(found._id))! };
    }
    return { ok: true, field: found };
  }
  const retired = await ctx.db.query("agents").withIndex("by_orgId_and_ledgerKey", (q) => q.eq("orgId", user.orgId).eq("ledgerKey", `research:${spec.slug}`)).first();
  if (retired) return { ok: false, why: "deleted", message: `${spec.label} (deleted from AI fields)` };
  const existing = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(MAX_AGENTS + 1);
  if (existing.length >= MAX_AGENTS) return { ok: false, why: "full", message: `${spec.label} (the workspace has ${MAX_AGENTS} AI fields)` };
  const autoAccept = can(user, "writeGate.edit") ? spec.autoAccept : undefined;
  const refresh = spec.refresh ?? fallbackRefresh;
  const now = Date.now();
  const fieldId = await ctx.db.insert("researchAgents", {
    orgId: user.orgId, slug: spec.slug, label: spec.label, entityType: spec.object, kind: spec.kind, question: spec.question,
    ...(spec.kind === "classify" ? { options: spec.options } : { answerType: spec.answerType ?? "text" }),
    ...(spec.judgment ? { judgment: true } : {}),
    ...(autoAccept !== undefined ? { autoAcceptMinConfidence: autoAccept } : {}),
    // A deal's research only fills people not answered yet: the field's own refresh keeps the answers current.
    ...(refresh ? { refreshCadence: refresh, refreshNextAt: now + cadenceMs(refresh) } : {}),
    recipe: provenance, createdBy: user._id, createdAt: now, updatedAt: now,
  });
  if (autoAccept !== undefined) await setRule(ctx, user, attributeFor(spec.slug), autoAccept, spec.object);
  await ensureFieldAgent(ctx, (await ctx.db.get(fieldId))!);
  return { ok: true, field: (await ctx.db.get(fieldId))! };
}
export type FieldMade = { ok: true; field: Doc<"researchAgents"> } | { ok: false; why: "deleted" | "full" | "off"; message: string };

/**
 * The people field `spec` of the deal page recipe `found`, for people research. Its contribution to the `fields`
 * point must be on: one nobody decided is turned on here, by `user`, the first time it is used, unless another
 * recipe's field with the slug is already on, whose row it then shares. One someone turned off isn't used.
 */
export async function peopleField(ctx: MutationCtx, user: Doc<"users">, found: FoundRecipe, settings: Settings, spec: PeopleField, refresh: RefreshCadence): Promise<FieldMade> {
  // fieldsOf makes every people field a contribution, the ones a recipe writes inline in its people block too.
  const contribution = contributionsOf(found.recipe).find((c) => c.point === "fields" && c.key === spec.slug)!;
  const row = await enablementRow(ctx, user.orgId, "fields", found.recipe.id, spec.slug);
  if (row && !row.enabled) return { ok: false, why: "off", message: `${spec.label} (turned off on the Customization page)` };
  if (!row && !(await enabledFor(ctx, user.orgId, "fields")).some((e) => e.contribution.key === spec.slug)) {
    await ctx.db.insert("recipeEnablements", { orgId: user.orgId, point: "fields", recipeId: found.recipe.id, contributionKey: spec.slug, enabled: true, by: user._id, at: Date.now() });
  }
  // The question, judgment and replaced questions people research reads are the field's, on the workspace's settings.
  const field = { ...resolveField(contribution.declares as RecipeField, settings), question: spec.question, judgment: spec.judgment, replaces: spec.replaces ? [...spec.replaces] : undefined };
  return ensureField(ctx, user, found.recipe, field, refresh);
}

/**
 * A deal's people research (lib/plays/peopleResearch.ts): a run of each of the recipe's people fields over `contactIds`, as
 * `userId`, on their ChatGPT plan, each field turned on and made if the workspace lacks it (peopleField). A field
 * that can't run now (its agent paused, or a run of it already going) is named in `skipped`.
 */
export const startPeopleRuns = internalMutation({
  // `onCredits`: a person started it without a ChatGPT plan, so the runs use Canon's research model and spend credits.
  args: { orgId: v.id("organizations"), userId: v.id("users"), contactIds: v.array(v.string()), onCredits: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ runIds: Id<"researchRuns">[]; skipped: string[]; busy: boolean }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Not a member of this workspace");
    if (args.onCredits) await requireResearchCredits(ctx, user.orgId);
    const found = await orgRecipe(ctx, args.orgId);
    const { people } = playsFor(found.ref);
    const ids = [...new Set(args.contactIds)].slice(0, PEOPLE_RESEARCH_MAX);
    if (!ids.length) return { runIds: [], skipped: [], busy: false };
    const runIds: Id<"researchRuns">[] = [];
    const skipped: string[] = [];
    let busy = false;
    const now = Date.now();
    for (const spec of people.fields) {
      const made = await peopleField(ctx, user, found, found.ref.settings, spec, people.refresh);
      if (!made.ok) { skipped.push(made.message); continue; }
      const { field } = made;
      if (field.entityType !== "contact") { skipped.push(`${field.label} (an account field)`); continue; }
      const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, field));
      if (!acting.ok) { skipped.push(`${field.label} (${acting.message})`); continue; }
      if (await hasLiveRun(ctx, field._id)) { busy = true; skipped.push(`${field.label} (another run of it is going)`); continue; }
      const scope: RunScope = { entity: "contact", scope: { ids } };
      const runId = await ctx.db.insert("researchRuns", {
        orgId: args.orgId, agentId: field._id, filter: scope.scope, scope, status: "running",
        inScope: 0, planned: 0, done: 0, skipped: 0, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 0, llmCalls: 0,
        // At most every chosen person, once.
        capMicro: ids.length * RECORD_MICRO, spentMicro: 0, ...(args.onCredits ? { onCredits: true } : {}), createdBy: user._id, createdAt: now, updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.researchAgentActions.runSlice, { runId });
      runIds.push(runId);
    }
    return { runIds, skipped, busy };
  },
});

/** Whether each of `runIds` is still going (a stalled one counts as finished). */
export const runsLive = internalQuery({
  args: { runIds: v.array(v.id("researchRuns")) },
  handler: async (ctx, args): Promise<boolean> => {
    for (const id of args.runIds) {
      const r = await ctx.db.get(id);
      if (r?.status === "running" && Date.now() - r.updatedAt <= STALL_MS) return true;
    }
    return false;
  },
});

/** The people fields' answers for contacts a deal's caller already sees (its plane admitted them). */
export const peopleAnswers = internalQuery({
  args: { orgId: v.id("organizations"), access: v.any(), recordIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { people } = playsFor(await requirePlays(ctx, args.orgId));
    const { answers } = await contactAnswersAs(ctx, args.orgId, [args.access as Access], people.fields.map((f) => f.slug), args.recordIds, new Set(args.recordIds));
    return answers;
  },
});

export const cancelRun = mutation({
  args: { runId: v.id("researchRuns") },
  handler: stopResearchRun,
});

export async function stopResearchRun(ctx: MutationCtx, args: { runId: Id<"researchRuns"> }) {
  const user = await requireUser(ctx);
  const run = await ctx.db.get(args.runId);
  if (!run || run.orgId !== user.orgId) throw new ConvexError("Run not found");
  if (run.status === "running") await ctx.db.patch(args.runId, { status: "cancelled", updatedAt: Date.now() });
  return null;
}

/**
 * A run, its field, whether the field's agent may act (without latching; see
 * stopIfInactive), and the access of the run's principals (CP14): it reads
 * only what its owner and its starter both see. Null principals: one of them
 * is no longer a member, and the run does not read.
 */
export async function loadResearchRun(ctx: QueryCtx, runId: Id<"researchRuns">) {
  const run = await ctx.db.get(runId);
  if (!run) return null;
  const agent = await ctx.db.get(run.agentId);
  if (!agent) return { run, agent: null, spec: null, standing: null, principals: null };
  const linked = agent.agentId ? await ctx.db.get(agent.agentId) : null;
  const s: Standing = linked ? await standing(ctx, linked) : standingOf({}, await ownerFactsOf(ctx, agent.orgId, agent.createdBy));
  const principals = await principalAccess(ctx, run.orgId, agentPrincipals({ ownerUserId: fieldOwner(agent, linked), startedBy: run.createdBy }));
  return { run, agent, spec: specOf(agent), standing: s, principals };
}

export const getRun = internalQuery({
  args: { runId: v.id("researchRuns") },
  handler: (ctx, args) => loadResearchRun(ctx, args.runId),
});

async function stopRun(ctx: MutationCtx, run: Doc<"researchRuns">, message: string) {
  await ctx.db.patch(run._id, { status: "cancelled", error: message, updatedAt: Date.now() });
}

/** Stop a run whose field's agent may not act, latching an owner-caused pause. True when the run was stopped. */
export const stopIfInactive = internalMutation({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return true;
    const field = await ctx.db.get(run.agentId);
    if (!field) return true;
    const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, field));
    if (acting.ok) return false;
    await stopRun(ctx, run, acting.message);
    return true;
  },
});

const countsValidator = v.object({
  done: v.number(), skipped: v.number(), answered: v.number(), unknown: v.number(), noEvidence: v.number(), inferred: v.optional(v.number()),
  errors: v.number(), pagesRead: v.number(), llmCalls: v.number(),
});

export const progressRun = internalMutation({
  args: {
    runId: v.id("researchRuns"),
    set: v.object({
      inScope: v.optional(v.number()),
      planned: v.optional(v.number()),
      cursor: v.optional(v.string()),
      status: v.optional(v.union(v.literal("done"), v.literal("failed"))),
      error: v.optional(v.string()),
      /** A probe's chosen records, before any is researched. */
      sample: v.optional(v.array(v.object({ recordId: v.string(), entityId: v.id("canonEntities"), label: v.string() }))),
    }),
    add: v.optional(countsValidator),
    /** How each record of this page was researched; a probe's sample rows also take their outcomes. */
    traces: v.optional(v.array(traceValidator)),
    /** A run on credits: the page's charge, made here as its answers are recorded, so nothing is paid before then. */
    chargeRef: v.optional(v.string()),
    /** Records of this page that got an answer (a record without one costs nothing). */
    charged: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<"running" | "stopped"> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return "stopped";
    const add = args.add;
    const traces = args.traces ?? [];
    const outcomes = new Map(run.trigger === "probe" ? traces.map(({ recordId, label: _l, steps: _s, ms: _m, calls: _c, model: _mo, promptVersion: _p, ...o }) => [recordId, o]) : []);
    const sample = args.set.sample ?? run.sample;
    await ctx.db.patch(args.runId, {
      ...args.set,
      ...(sample && outcomes.size ? { sample: sample.map((row) => ({ ...row, ...outcomes.get(row.recordId) })) } : {}),
      ...(add
        ? {
            done: run.done + add.done, skipped: run.skipped + add.skipped, answered: run.answered + add.answered,
            unknown: run.unknown + add.unknown, noEvidence: run.noEvidence + add.noEvidence, errors: run.errors + add.errors,
            ...(add.inferred ? { inferred: (run.inferred ?? 0) + add.inferred } : {}),
            pagesRead: run.pagesRead + add.pagesRead, llmCalls: run.llmCalls + add.llmCalls,
          }
        : {}),
      updatedAt: Date.now(),
    });
    const at = Date.now();
    for (const t of traces) await ctx.db.insert("researchTraces", { orgId: run.orgId, runId: run._id, ...t, at });
    if (args.chargeRef) {
      await chargeLanded(ctx, run, { ref: args.chargeRef, amountMicro: (args.charged ?? 0) * RECORD_MICRO, unitMicro: RECORD_MICRO, note: `${(await ctx.db.get(run.agentId))?.label ?? "AI field"}: answers found` });
    }
    if (!args.set.status && run.trigger !== "probe" && add) {
      const counts = { done: run.done + add.done, answered: run.answered + add.answered, inferred: (run.inferred ?? 0) + (add.inferred ?? 0), errors: run.errors + add.errors };
      const stop = watchRun(counts, [...traces].reverse().find((t) => t.status === "error")?.reason);
      if (stop) {
        await ctx.db.patch(args.runId, { status: "cancelled", watch: stop, updatedAt: at });
        return "stopped";
      }
    }
    return args.set.status ? "stopped" : "running";
  },
});

/**
 * End a run for credits: its cap is spent (it finished what it could pay for) or the workspace's balance
 * can't pay for its next page. Its answers so far stay; running again continues past them.
 */
export const stopForCredits = internalMutation({
  args: { runId: v.id("researchRuns"), reason: v.union(v.literal("cap"), v.literal("credits")) },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return null;
    const records = `${run.done.toLocaleString("en-US")} record${run.done === 1 ? "" : "s"}`;
    const watch = args.reason === "cap"
      ? { rule: "cap" as const, message: `Reached its cap of ${((run.capMicro ?? 0) / MICRO).toLocaleString("en-US")} credits after ${records}. Run again to research more.` }
      : { rule: "credits" as const, message: `The workspace ran out of credits after ${records}. An admin can buy more under Settings → Billing & usage; then run again to continue.` };
    await ctx.db.patch(args.runId, { status: args.reason === "cap" ? "done" : "cancelled", watch, updatedAt: Date.now() });
    return null;
  },
});

/** Entities that already have any fact for the attribute (answered, pending or rejected): a re-run skips them. */
/**
 * Entities a run should skip: those with a fact for the field, and those a run
 * researched without an answer in the last RETRY_AFTER_MS. Without the second,
 * a scope whose best-fit accounts never yield an answer would re-research them
 * on every run and never reach the rest.
 */
export const skippedEntities = internalQuery({
  // `picked`: the records were chosen one by one (a deal's people, selected rows), so a recent attempt without an
  // answer doesn't skip them; only an answer does. The attempt skip is how a run over a list moves on to others.
  args: { agentId: v.id("researchAgents"), entityIds: v.array(v.id("canonEntities")), attribute: v.string(), picked: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const out: Array<Id<"canonEntities">> = [];
    const asked = (await ctx.db.get(args.agentId))?.questionSince ?? 0;
    const since = args.picked ? Infinity : Math.max(Date.now() - RETRY_AFTER_MS, asked);
    for (const entityId of args.entityIds) {
      const f = await ctx.db.query("facts")
        .withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", entityId).eq("attribute", args.attribute).gte("observedAt", asked))
        .first();
      const tried = f ? null : await ctx.db.query("researchAttempts")
        .withIndex("by_agentId_and_entityId", (q) => q.eq("agentId", args.agentId).eq("entityId", entityId))
        .unique();
      if (f || (tried && tried.attemptedAt >= since)) out.push(entityId);
    }
    return out;
  },
});

/** Remember entities researched without an answer (errors are left out, so they are retried). */
export const recordAttempts = internalMutation({
  args: { runId: v.id("researchRuns"), entityIds: v.array(v.id("canonEntities")) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return null;
    const now = Date.now();
    for (const entityId of args.entityIds) {
      const row = await ctx.db.query("researchAttempts")
        .withIndex("by_agentId_and_entityId", (q) => q.eq("agentId", run.agentId).eq("entityId", entityId))
        .unique();
      if (row) await ctx.db.patch(row._id, { attemptedAt: now });
      else await ctx.db.insert("researchAttempts", { orgId: run.orgId, agentId: run.agentId, entityId, attemptedAt: now });
    }
    return null;
  },
});

/**
 * Submit a slice's answers only if the run is still going, its field still
 * exists and its agent may act, in the same transaction, so a stop, delete or
 * pause during research can't land (or auto-accept) answers afterwards. Null
 * when the run was stopped.
 */
export const submitAnswers = internalMutation({
  // `reads`: per fact, Jev's read of the record when the answer is Jev's inference (submitProposalBatch).
  // `admitted`: the record-service ids of the slice, read through the run's principals' scoped client.
  args: { runId: v.id("researchRuns"), facts: v.array(proposedFactValidator), reads: v.optional(v.array(v.union(v.number(), v.null()))), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return null;
    const field = await ctx.db.get(run.agentId);
    if (!field) return null;
    const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, field));
    if (!acting.ok) {
      await stopRun(ctx, run, acting.message);
      return null;
    }
    const n = args.facts.length;
    return submitProposalBatch(ctx, {
      attribution: { kind: "agent", agent: acting.agent, triggeredBy: run.createdBy },
      sourceKind: "agent_run",
      title: `${field.label}: ${n} answer${n === 1 ? "" : "s"}`,
      reason: `AI field "${field.label}": ${field.question}`,
      facts: args.facts,
      admitted: args.admitted,
      ...(args.reads ? { reads: args.reads } : {}),
    });
  },
});

/** Save pages a run read; a new row only when a URL's text changed. */
/** The latest saved text of a page, if any (an enrichment's profile is saved under the person's profile URL). */
export const savedPage = internalQuery({
  args: { orgId: v.id("organizations"), url: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("researchPages").withIndex("by_orgId_and_url", (q) => q.eq("orgId", args.orgId).eq("url", args.url.slice(0, 2000))).order("desc").first();
    return row ? { url: row.url, text: row.text, fetchedAt: row.fetchedAt } : null;
  },
});

export const savePages = internalMutation({
  args: { orgId: v.id("organizations"), pages: v.array(v.object({ url: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const p of args.pages.slice(0, SAVE_BATCH_PAGES)) {
      const url = p.url.slice(0, 2000);
      const latest = await ctx.db.query("researchPages").withIndex("by_orgId_and_url", (q) => q.eq("orgId", args.orgId).eq("url", url)).order("desc").first();
      if (latest?.text === p.text) continue;
      await ctx.db.insert("researchPages", { orgId: args.orgId, url, text: p.text.slice(0, SAVED_PAGE_CHARS), fetchedAt: now });
    }
    return null;
  },
});

// ───────────────────────────── Scheduled refresh ─────────────────────────────

/** Manager: turn a field's scheduled refresh on (weekly or monthly) or off. The first refresh is one cadence from now. */
export const setRefresh = mutation({
  args: { slug: v.string(), cadence: v.union(...REFRESH_CADENCES.map((c) => v.literal(c)), v.null()) },
  handler: setResearchRefresh,
});

export async function setResearchRefresh(ctx: MutationCtx, args: { slug: string; cadence: RefreshCadence | null }) {
  const user = await requireCap(ctx, "strategy.edit");
  const field = await agentBySlug(ctx, user.orgId, args.slug);
  if (!field) throw new ConvexError("Unknown field");
  if (args.cadence === (field.refreshCadence ?? null)) return null;
  await ctx.db.patch(field._id, {
    refreshCadence: args.cadence ?? undefined,
    refreshNextAt: args.cadence ? Date.now() + cadenceMs(args.cadence) : undefined,
    refreshHold: undefined,
    updatedAt: Date.now(),
  });
  return null;
}

/**
 * Cron: start a refresh run for every field that is due. The field's next due
 * time moves forward in the same transaction that starts the run, so a second
 * tick can't start another. A field that can't run (agent paused or archived,
 * owner without a ChatGPT connection) is held with the reason, and looked at
 * again later; it never falls back to a server key. `now` is for tests.
 */
export const startDueRefreshes = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!integrationEnabled("chatgpt")) return { started: 0, held: 0, busy: 0 };
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("researchAgents")
      .withIndex("by_refreshNextAt", (q) => q.gte("refreshNextAt", 0).lte("refreshNextAt", now)).take(REFRESH_BATCH);
    const out = { started: 0, held: 0, busy: 0 };
    for (const field of due) {
      const cadence = field.refreshCadence;
      if (!cadence) { await ctx.db.patch(field._id, { refreshNextAt: undefined }); continue; }
      const again = (hold?: string) => ctx.db.patch(field._id, {
        refreshNextAt: now + REFRESH_RETRY_MS, refreshHold: hold ? { message: hold, at: now } : undefined,
      });
      const acting = await actingAgent(ctx, await ensureFieldAgent(ctx, field));
      if (!acting.ok) { await again(acting.message); out.held++; continue; }
      const ownerId = acting.agent.ownerUserId;
      const plan = await ctx.db.query("chatgptAuth").withIndex("by_userId", (q) => q.eq("userId", ownerId)).unique();
      if (plan?.status !== "connected") {
        await again("The agent's owner has not connected ChatGPT. Refresh resumes once they sign in under Integrations → ChatGPT.");
        out.held++;
        continue;
      }
      if (await hasLiveRun(ctx, field._id)) { await again(); out.busy++; continue; }
      const runId = await ctx.db.insert("researchRuns", {
        orgId: field.orgId, agentId: field._id, filter: {}, status: "running", trigger: "refresh",
        staleBefore: now - cadenceMs(cadence) + STALE_GRACE_MS,
        inScope: 0, planned: RUN_CAP, done: 0, skipped: 0, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 0, llmCalls: 0,
        createdBy: ownerId, createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(field._id, { refreshNextAt: now + cadenceMs(cadence), refreshHold: undefined });
      await ctx.scheduler.runAfter(0, internal.researchAgentActions.runSlice, { runId });
      out.started++;
    }
    return out;
  },
});

/** A refresh run found it can't run (no model for the owner): hold the field with the reason. */
export const holdRefresh = internalMutation({
  args: { runId: v.id("researchRuns"), message: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    // The cron already moved the next due time a full cadence out; look again soon, as for any other hold.
    if (run) await ctx.db.patch(run.agentId, { refreshHold: { message: args.message, at: Date.now() }, refreshNextAt: Date.now() + REFRESH_RETRY_MS });
    return null;
  },
});

/**
 * The next accounts a refresh run should re-ask: the latest accepted answer
 * is older than the run's `staleBefore`, and no run has tried it since.
 * Scans the field's oldest answers first and resumes from the run's cursor.
 */
export const staleBatch = internalQuery({
  args: { runId: v.id("researchRuns"), numItems: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const field = run && await ctx.db.get(run.agentId);
    if (!run || !field || run.staleBefore === undefined) return { entities: [], scanned: 0, nextCursor: null };
    const attribute = attributeFor(field.slug);
    const staleBefore = run.staleBefore;
    const page = await ctx.db.query("facts")
      .withIndex("by_orgId_attribute_observedAt", (q) => q.eq("orgId", run.orgId).eq("attribute", attribute).lt("observedAt", staleBefore))
      .paginate({ numItems: args.numItems, cursor: run.cursor ?? null });
    const entities: Array<{ entityId: Id<"canonEntities">; recordId: string }> = [];
    for (const f of page.page) {
      if (f.status !== "accepted") continue;
      // The latest ACCEPTED answer: a newer proposal or rejection doesn't change what is live.
      const recent = await ctx.db.query("facts")
        .withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", f.entityId).eq("attribute", attribute)).order("desc").take(20);
      if (recent.find((r) => r.status === "accepted")?._id !== f._id) continue;
      const entity = await ctx.db.get(f.entityId);
      if (!entity || entity.mergedInto) continue;
      // The record-service id to re-read: an account's projection, or the id a contact's entity (possibly a ledger stream) is linked by.
      const recordId = field.entityType === "contact"
        ? (await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", f.entityId)).take(20)).find((x) => x.provider === ID.recordContact)?.externalId
        : entity.projectionTable === "recordAccounts" ? entity.projectionId : undefined;
      if (!recordId) continue;
      const tried = await ctx.db.query("researchAttempts").withIndex("by_agentId_and_entityId", (q) => q.eq("agentId", field._id).eq("entityId", f.entityId)).unique();
      if (tried && tried.attemptedAt >= staleBefore) continue;
      entities.push({ entityId: f.entityId, recordId });
    }
    return { entities, scanned: page.page.length, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/** What the run preview needs about the field and the caller (the record count comes from the record service). A contact field's scope is resolved here. */
export const previewContext = internalQuery({
  args: { slug: v.string(), contacts: v.optional(contactScopeValidator) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const field = await agentBySlug(ctx, user.orgId, args.slug);
    if (!field) return null;
    const plan = await ctx.db.query("chatgptAuth").withIndex("by_userId", (q) => q.eq("userId", user._id)).unique();
    const threshold = (await autoAcceptThresholds(ctx, user.orgId))(attributeFor(field.slug), field.entityType);
    const scope = field.entityType === "contact" && args.contacts ? await resolveContactScope(ctx, user, args.contacts) : null;
    const recent = await ctx.db.query("researchRuns").withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", field._id)).order("desc").take(10);
    const probe = recent.find((r) => r.trigger === "probe");
    const latestProbe = probe ? { at: probe.createdAt, status: probe.status, verdict: probeVerdict(probe.sample ?? [], field, probe.status !== "running") } : null;
    const factual = isFactualField(specOf(field));
    const jevReads = field.kind === "classify" || field.answerType === "boolean";
    // A run reads as its owner too (getRun), so the count is of the records both see.
    const linked = field.agentId ? await ctx.db.get(field.agentId) : null;
    const ownerAccess = await principalAccess(ctx, user.orgId, [fieldOwner(field, linked)]);
    return { ownerAccess, userId: user._id, orgId: user.orgId as string, label: field.label, entityType: field.entityType, scope, autoAccept: threshold !== null, jevReads, factual, chatgptConnected: plan?.status === "connected", latestProbe };
  },
});
