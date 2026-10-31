"use node";

/**
 * The keeper as an agent (docs/deal-plays.md, DP2). Once a day per play on an
 * open deal it reads the control plane as the deal's owner, drafts the touches
 * coming due on the owner's ChatGPT plan, records its health and flags, and
 * tells the org's Slack when a new urgent flag appears. It never sends a
 * message: a person reviews each draft and sends it. Without a ChatGPT plan it
 * still checks and notifies; it just doesn't draft.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { requireCaller } from "./records";
import { may } from "./lib/access";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { postToSlack } from "./lib/agents/slack";
import { appUrl } from "./lib/operatorConfig";
import { buildPlane, type ControlPlane, type PlaneCaller, type PlayStep } from "./dealPlays";
import { HEALTH_LABEL, summaryOf } from "./lib/plays/model";
import { FIRST_TOUCH_BATCH } from "./lib/plays/prospectSelection";
import { peopleResearchDue } from "./lib/plays/peopleResearch";
import { checkDealPeople, startPeopleResearch } from "./dealPlayActions";
import { cleanDraft, cleanReview, termReviewPrompt, type DraftReview } from "./lib/plays/drafts";
import { DRAFT_TOOL, REVIEW_TOOL, draftInputOf, draftSchema, firstTouchChannel, researchDue, reviewSchema, scheduledBuyers } from "./lib/plays/runs";
import { playsFor, termsFor } from "./lib/recipes";
import { startState } from "./dealStateActions";
import { runPlays } from "./lib/recipeRuntime";

/** A check is due this long after the last one; plays one tick checks before handing on to the next. */
const CHECK_EVERY_MS = 20 * 3_600_000;
const PLAYS_PER_TICK = 8;
const DAY = 86_400_000;

/** Steps worth drafting: planned, not yet done by a touch, for a person, on a drafted channel, with no draft. */
function draftable(plane: ControlPlane, s: PlayStep, horizon: string | null): boolean {
  return s.state === "planned" && !s.doneBy && !s.draft && Boolean(s.targetId) && playsFor(plane.recipe).drafts.channels.includes(s.channel)
    && plane.people.some((p) => p.contactId === s.targetId) && (horizon === null || (s.dueOn !== null && s.dueOn <= horizon));
}

/**
 * Draft one step on `userId`'s plan, then have the model review it (emails and LinkedIn notes). A review that
 * fails leaves the draft without one; the rule checks still run on it.
 */
async function writeDraft(ctx: ActionCtx, userId: Id<"users">, plane: ControlPlane, step: PlayStep, sender: string): Promise<{ subject?: string; body: string; review?: DraftReview } | null> {
  const llm = await resolveLlm(ctx, userId);
  if (!llm) return null;
  const plays = playsFor(plane.recipe);
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];
  const input = draftInputOf(plane, step, sender, Date.now(), plays);
  // A prompt per call: each waits on the model's draft before it, which takes seconds against the runtime's milliseconds.
  const [prompt] = await runPlays(ctx, plane.recipe, [{ fn: "drafts.prompt", input: [input] }]);
  const draft = cleanDraft(step.channel, await forcedToolCall(prompt, DRAFT_TOOL, draftSchema(plays, plane.recipe.settings), model, llm));
  if (!draft || !plays.drafts.reviewed.includes(step.channel)) return draft;
  const [reviewPrompt] = await runPlays(ctx, plane.recipe, [{ fn: "drafts.reviewPrompt", input: [input, draft] }]);
  const review = await forcedToolCall(termReviewPrompt(reviewPrompt, draft, termsFor(plays)), REVIEW_TOOL, reviewSchema(plays, plane.recipe.settings), model, llm)
    .then((raw) => cleanReview(raw, input.pointOfView !== null, termsFor(plays)))
    .catch((cause) => { console.warn(`keeper review ${plane.streamId}: ${cause instanceof Error ? cause.message : cause}`); return null; });
  return review ? { ...draft, review } : draft;
}

/**
 * Prep before the rep lands (docs/deal-prep-loop.md PL1): research the deal's open questions on the owner's plan when
 * it has never run or is as old as the recipe's cadence, which is shorter once the gaps ask something it didn't.
 * Returns whether a run started.
 */
async function researchIfDue(ctx: ActionCtx, caller: PlaneCaller, plane: ControlPlane, userId: Id<"users">): Promise<boolean> {
  if (!plane.deal.companyId || !plane.deal.domain || plane.deal.isClosed || !plane.prep.questions.length) return false;
  const due = researchDue(plane.research, plane.prep.answers.some((a) => !a.asked), Date.now(), playsFor(plane.recipe));
  if (!due || !(await resolveLlm(ctx, userId))) return false;
  const orgId = caller.orgId as Id<"organizations">;
  const startedAt = await ctx.runMutation(internal.dealPlays.claimResearch, { orgId, userId, streamId: plane.streamId });
  await ctx.scheduler.runAfter(0, internal.dealPlayActions.runResearch, { orgId, userId, streamId: plane.streamId, startedAt, access: caller.access, questions: plane.prep.questions });
  return true;
}

/**
 * The account research plan's people half (issue #394): on the recipe's cadence, research the deal's best-placed
 * buyers on the owner's plan, alongside the account research above. Returns whether it started.
 */
async function peopleResearchIfDue(ctx: ActionCtx, caller: PlaneCaller, plane: ControlPlane, userId: Id<"users">): Promise<boolean> {
  const plays = playsFor(plane.recipe);
  if (plane.deal.isClosed || !peopleResearchDue(plane.peopleResearch, Date.now(), plays.people.everyDays)) return false;
  const buyers = scheduledBuyers(plane.prospects, plays);
  if (!buyers.length || !(await resolveLlm(ctx, userId))) return false;
  // Whether each still works there first (8 credits a check, at most monthly; Ryan, 2026-10-14): someone who left is
  // marked gone, moved to their new company, and not researched here.
  const { departed, note } = await checkDealPeople(ctx, caller, plane.deal, plane.recipeData.peopleSlugs.employed, buyers);
  if (note) console.log(`keeper job changes ${plane.streamId}: ${note}`);
  const staying = buyers.filter((id) => !departed.has(id));
  if (staying.length) await startPeopleResearch(ctx, caller, plane.streamId, staying);
  return staying.length > 0;
}

/**
 * One check of one play as `caller`: draft the recipe's few steps per check due soon (on `llmUserId`'s plan, when given),
 * record health and flags, and with `notify` tell Slack about urgent flags that weren't raised last time.
 */
async function check(ctx: ActionCtx, caller: PlaneCaller, streamId: string, opts: { llmUserId: Id<"users"> | null; notify: boolean; daily?: boolean }) {
  const orgId = caller.orgId as Id<"organizations">;
  const plane = await buildPlane(ctx, caller, streamId);
  if (!plane) return null;
  const plays = playsFor(plane.recipe);
  const highs = new Set(plane.keeper.flags.filter((f) => f.severity === "high").map((f) => f.key));
  // Flags already posted, while they stay raised: a flag that clears and comes back is posted again.
  const told = (plane.keeperCheck?.notifiedKeys ?? []).filter((k) => highs.has(k));
  const horizon = new Date(Date.now() + plays.drafts.aheadDays * DAY).toISOString().slice(0, 10);
  let drafted = 0;
  let error: string | undefined;
  // Research first: a call drafted while it runs would miss the questions it leaves open. Calls wait for the
  // answers, and saveResearch clears the keeper's call drafts so the next check rewrites them with the open questions.
  let researching = plane.research?.status === "running";
  if (opts.llmUserId && opts.daily !== false) {
    await startState(ctx, caller, streamId).catch((cause) => console.warn(`keeper deal state ${streamId}: ${cause instanceof Error ? cause.message : cause}`));
    const started = await researchIfDue(ctx, caller, plane, opts.llmUserId).catch((cause) => {
      console.warn(`keeper research ${streamId}: ${cause instanceof Error ? cause.message : cause}`);
      return false;
    });
    if (started) console.log(`keeper research ${streamId}: started for ${plane.prep.questions.length} questions`);
    researching ||= started;
    if (await peopleResearchIfDue(ctx, caller, plane, opts.llmUserId).catch((cause) => {
      console.warn(`keeper people research ${streamId}: ${cause instanceof Error ? cause.message : cause}`);
      return false;
    })) console.log(`keeper people research ${streamId}: started`);
  }
  if (opts.llmUserId) {
    const drafts: Array<{ stepId: Id<"dealPlaySteps">; contactId: string; subject?: string; body: string; review?: DraftReview }> = [];
    for (const step of plane.steps.filter((s) => draftable(plane, s, horizon) && !(researching && s.channel === "call")).slice(0, plays.drafts.perCheck)) {
      try {
        const d = await writeDraft(ctx, opts.llmUserId, plane, step, caller.name ?? "the account owner");
        if (d) drafts.push({ stepId: step.id, contactId: step.targetId!, ...d });
      } catch (cause) {
        error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
      }
    }
    if (drafts.length) drafted = await ctx.runMutation(internal.dealPlays.saveDrafts, { orgId, streamId, drafts });
  }
  const urgent = plane.keeper.flags.filter((f) => highs.has(f.key) && !told.includes(f.key));
  let notifiedAt: number | undefined;
  if (opts.notify && urgent.length) {
    const cipher = await ctx.runQuery(internal.dealPlays.slackCipher, { orgId });
    if (cipher) {
      const origin = appUrl();
      const name = origin ? `<${origin}/dashboard/records/deal/${streamId}|${plane.deal.name}>` : plane.deal.name;
      const text = [`*Keeper* · ${name} · ${HEALTH_LABEL[plane.keeper.health]}`, ...urgent.map((f) => `• ${f.text}`), drafted ? `${drafted} draft${drafted === 1 ? "" : "s"} ready to review.` : ""]
        .filter(Boolean).join("\n");
      const sent = await postToSlack(await decryptFromStorage(cipher), text).catch(() => ({ ok: false }));
      if (sent.ok) notifiedAt = Date.now();
    }
  }
  await ctx.runMutation(internal.dealPlays.saveKeeper, {
    orgId, streamId, ...(opts.daily === false ? { daily: false } : {}),
    keeper: {
      health: plane.keeper.health, flagKeys: plane.keeper.flags.map((f) => f.key), drafted,
      ...(plane.touches[0] ? { lastTouch: { at: plane.touches[0].at, channel: plane.touches[0].channel } } : {}),
      summary: summaryOf(plane.people, plane.steps.map((s) => ({ state: s.state, dueOn: s.dueOn, doneByTouch: s.doneBy !== null })), plays.coreRoles),
      notifiedKeys: notifiedAt ? [...told, ...urgent.map((f) => f.key)] : told, ...(notifiedAt ? { notifiedAt } : {}), ...(error ? { error } : {}) },
  });
  return { drafted, health: plane.keeper.health, error: error ?? null };
}

/** Hourly: check the plays due, oldest first, as each deal's owner; hand on to another run while more are due. */
export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!integrationEnabled("chatgpt")) return null;
    const due = await ctx.runQuery(internal.dealPlays.duePlays, { before: Date.now() - CHECK_EVERY_MS, limit: PLAYS_PER_TICK + 1 });
    for (const p of due.slice(0, PLAYS_PER_TICK)) {
      const caller = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: p.orgId, userId: p.userId });
      try {
        // The owner no longer sees the deal (or left): record the check anyway, so the queue moves on.
        const out = caller ? await check(ctx, caller, p.streamId, { llmUserId: p.userId, notify: true }) : null;
        if (caller && !out) await ctx.runMutation(internal.dealPlays.saveKeeper, { orgId: p.orgId, streamId: p.streamId, keeper: { health: "needs_attention", flagKeys: [], drafted: 0, error: "The deal's owner can't see this deal." } });
        if (!caller) await ctx.runMutation(internal.dealPlays.saveKeeper, { orgId: p.orgId, streamId: p.streamId, keeper: { health: "needs_attention", flagKeys: [], drafted: 0, error: "The deal's owner is no longer a member of this workspace." } });
      } catch (cause) {
        console.warn(`keeper: ${p.streamId} failed: ${cause instanceof Error ? cause.message : cause}`);
        await ctx.runMutation(internal.dealPlays.saveKeeper, { orgId: p.orgId, streamId: p.streamId, keeper: { health: "needs_attention", flagKeys: [], drafted: 0, error: "The check failed; it runs again tomorrow." } });
      }
    }
    if (due.length > PLAYS_PER_TICK) await ctx.scheduler.runAfter(60_000, internal.dealPlayKeeper.tick, {});
    return null;
  },
});

/** A reply from a contact (DP4): re-check every open play they're on now, so Slack hears "replied, your move" at once. */
export const onReply = internalAction({
  args: { orgId: v.id("organizations"), contactId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    for (const p of await ctx.runQuery(internal.dealPlays.playsOfContact, args)) {
      const caller = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: args.orgId, userId: p.userId });
      if (caller) await check(ctx, caller, p.streamId, { llmUserId: null, notify: true, daily: false }).catch((cause) => console.warn(`keeper reply check ${p.streamId}: ${cause}`));
    }
    return null;
  },
});

async function editor(ctx: ActionCtx, streamId: string) {
  const caller = await requireCaller(ctx);
  if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
  const loaded = await ctx.runQuery(internal.dealPlays.load, { orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, streamId, access: caller.access });
  if (!loaded?.canEdit) throw new ConvexError(loaded ? "Only admins, managers and the deal's owner can change its play" : "Deal not found");
  return caller;
}

/** Run the keeper now, as the caller and on their plan: drafts the steps due in the next few days. Never notifies. */
export const checkNow = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<{ drafted: number; error: string | null }> => {
    const caller = await editor(ctx, args.streamId);
    const out = await check(ctx, caller, args.streamId, { llmUserId: caller.userId as Id<"users">, notify: false });
    if (!out) throw new ConvexError("Deal not found");
    return { drafted: out.drafted, error: out.error };
  },
});

/** Draft one step now on the caller's plan, whatever its due date. Replaces a keeper draft, never a person's. */
export const draftStep = action({
  args: { streamId: v.string(), stepId: v.id("dealPlaySteps") },
  handler: async (ctx, args): Promise<{ subject?: string; body: string; review?: DraftReview }> => {
    const caller = await editor(ctx, args.streamId);
    const plane = await buildPlane(ctx, caller, args.streamId);
    const step = plane?.steps.find((s) => s.id === args.stepId);
    if (!plane || !step) throw new ConvexError("Step not found");
    if (!draftable(plane, { ...step, draft: step.draft?.by === "keeper" ? null : step.draft }, null)) {
      throw new ConvexError("Only a planned email, LinkedIn or call step for someone on the deal can be drafted");
    }
    const userId = caller.userId as Id<"users">;
    if (!(await resolveLlm(ctx, userId))) throw new ConvexError("Drafts are written on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT.");
    const draft = await writeDraft(ctx, userId, plane, step, caller.name ?? "the account owner");
    if (!draft) throw new ConvexError("The model returned no draft. Try again.");
    await ctx.runMutation(internal.dealPlays.saveDrafts, { orgId: caller.orgId as Id<"organizations">, streamId: args.streamId, drafts: [{ stepId: step.id, contactId: step.targetId!, ...draft }] });
    return draft;
  },
});

/** People one "first touches" call puts on the deal and drafts for. */
export const FIRST_TOUCHES_MAX = FIRST_TOUCH_BATCH;

/**
 * Find the way in (docs/deal-prep-loop.md): for each person picked, put them on the deal (as Involved, unless they
 * already are), give them a first-touch step on the recipe's channel Canon can reach them on, and draft it on the caller's
 * plan. A person who already has an open step keeps it; a person's own draft is never replaced. Never sends.
 */
export const firstTouches = action({
  args: { streamId: v.string(), contactIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ drafted: number; error: string | null }> => {
    const caller = await editor(ctx, args.streamId);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    if (!(await resolveLlm(ctx, userId))) throw new ConvexError("Drafts are written on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT.");
    let plane = await buildPlane(ctx, caller, args.streamId);
    if (!plane) throw new ConvexError("Deal not found");
    // Only people this deal's page offers: on the deal already, or at its company and visible to the caller.
    const offered = new Set(plane.prospects.flatMap((p) => (p.contactId ? [p.contactId] : [])));
    const ids = [...new Set(args.contactIds)].filter((id) => offered.has(id));
    if (!ids.length) throw new ConvexError("Pick someone at the account first");
    if (ids.length > FIRST_TOUCHES_MAX) throw new ConvexError(`Draft first touches for at most ${FIRST_TOUCHES_MAX} people at a time`);
    for (const contactId of ids) {
      if (plane.people.some((p) => p.contactId === contactId)) continue;
      const out = await ctx.runMutation(internal.dealCommittee.apply, { orgId, userId, streamId: args.streamId, command: { op: "setRole", contactId, role: "involved", reason: "Picked for a first touch" } });
      if (out.status === "invalid") throw new ConvexError(out.message);
    }
    plane = (await buildPlane(ctx, caller, args.streamId))!;
    const today = new Date().toISOString().slice(0, 10);
    for (const contactId of ids) {
      const person = plane.people.find((p) => p.contactId === contactId);
      if (!person || plane.steps.some((s) => s.targetId === contactId && s.state === "planned" && !s.doneBy)) continue;
      const channel = firstTouchChannel(person, playsFor(plane.recipe));
      if (!channel) throw new ConvexError("This workspace's package names no first-touch channel. An admin can pick one in the package's settings.");
      await ctx.runMutation(internal.dealPlays.apply, { orgId, userId, streamId: args.streamId, command: { op: "saveStep", title: `First touch: ${person.name}`, channel, contactId, dueOn: today } });
    }
    plane = (await buildPlane(ctx, caller, args.streamId))!;
    const drafts: Array<{ stepId: Id<"dealPlaySteps">; contactId: string; subject?: string; body: string; review?: DraftReview }> = [];
    let error: string | null = null;
    for (const step of plane.steps.filter((s) => s.targetId && ids.includes(s.targetId) && draftable(plane!, { ...s, draft: s.draft?.by === "keeper" ? null : s.draft }, null))) {
      try {
        const d = await writeDraft(ctx, userId, plane, step, caller.name ?? "the account owner");
        if (d) drafts.push({ stepId: step.id, contactId: step.targetId!, ...d });
      } catch (cause) {
        error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
      }
    }
    const drafted = drafts.length ? await ctx.runMutation(internal.dealPlays.saveDrafts, { orgId, streamId: args.streamId, drafts }) : 0;
    return { drafted, error };
  },
});

