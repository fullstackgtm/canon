/**
 * A deal's play (docs/deal-plays.md): the control plane for working a large
 * account. One play per deal holds the brief, the decision window, notes on
 * each person and the outreach plan. `get` puts these together with the
 * deal's committee, every touch with its people, and the keeper's report,
 * by the rules of the workspace's deal page recipe (recipes/, lib/recipes.ts).
 *
 * Who may do what follows the committee (convex/dealCommittee.ts): anyone who
 * sees the deal reads its play; admins, managers and the deal's owner change
 * it. The first change to a deal creates its play. Adding cited items and the
 * research run live in dealPlayActions.ts, which reads pages.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { stateForReader, stateRunOf, stageMismatch, summarizeState, summaryForReader, type StateSummary } from "./lib/plays/state";
import { mayReadText } from "./lib/conversations/intake";
import { withRole } from "./lib";
import { ConvexError, v } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { action, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { callerClient, requireCaller } from "./records";
import { isRestricted, may, type Access } from "./lib/access";
import { dealVisible, principalAccess } from "./permissions";
import { crmRolesOf, dealOfStream, mayEdit, type CrmRole } from "./dealCommittee";
import { peopleOfCompany, rowsById } from "./associations";
import { activitiesForRecord } from "./activityTargets";
import type { DealRole } from "./lib/objects/registry";
import { NAME_MAX, publicIdentifierOf } from "./lib/linkedin/cadence";
import {
  THREAD_LABEL, daysUntil, stepTarget, threadOf, touchDoing, touchesFromActivities, touchesFromLog,
  type DealStage, type Health, type KeeperReport, type Prep, type Prospect,
  type Channel, type Confidence, type Evidence, type ItemKind, type Origin, type StepState, type Thread, type Touch,
} from "./lib/plays/model";
import { draftReviewValidator, dealRole, playChannel, playConfidence, playItemKind, playStepState } from "./lib/plays/validators";
import type { DraftCheck, DraftReview, PointOfView } from "./lib/plays/drafts";
import { isBuyer } from "./lib/icpGates";
import { rankBuyers, rankingInput } from "./lib/plays/prospectSelection";
import { JEV_MODEL, jevSystemOne } from "./lib/segments/jev";
import { PEOPLE_RESEARCH_MAX, PEOPLE_RESEARCH_WAIT_MS } from "./lib/plays/peopleResearch";
import { RESEARCH_STALL_MS } from "./lib/plays/runs";
import { isNoPlays, orgRecipe, playsFor, requirePlays } from "./lib/recipes";
import type { Plays, RecipeRef } from "../recipes/index.ts";
import { agentActions, type AgentAction } from "../recipes/actions.ts";
import { runPlays } from "./lib/recipeRuntime";

/** Bounds on one play. */
export const ITEMS_MAX = 200;
export const STEPS_MAX = 100;
const PEOPLE_MAX = 100;
/** Company people a deal page lists to reach first, at most. */
const PROSPECTS_MAX = 40;
/** Committee members whose logs `get` reads, and observations per member. */
const TOUCH_CONTACTS_MAX = 30;
const TOUCH_LOG_READ = 200;
const TEXT_MAX = 2000;
const SHORT_MAX = 200;

const clip = (s: string, n = TEXT_MAX) => s.trim().slice(0, n);
const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const accessArg = v.optional(v.any());
const sees = (access: unknown, deal: Doc<"deals">) => !access || dealVisible(access as Access, deal);

export const playOf = (ctx: QueryCtx, orgId: Id<"organizations">, streamId: string) =>
  ctx.db.query("dealPlays").withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", orgId).eq("streamId", streamId)).unique();

/** The play's own rows, for `get` and the research run. Refuses (NO_PLAYS) when the workspace's recipe has no plays. */
export const load = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), access: accessArg },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const deal = user && user.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal || !sees(args.access, deal)) return null;
    const { ref: recipe, recipe: { dealPage } } = await orgRecipe(ctx, args.orgId);
    playsFor(recipe);
    const play = await playOf(ctx, args.orgId, args.streamId);
    const [items, people, steps] = play ? await Promise.all([
      ctx.db.query("dealPlayItems").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(ITEMS_MAX),
      ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", play._id)).take(PEOPLE_MAX),
      ctx.db.query("dealPlaySteps").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(STEPS_MAX),
    ]) : [[], [], []];
    const owner = deal.primaryRepId ? await ctx.db.get(deal.primaryRepId) : null;
    return {
      recipe, page: dealPage, canEdit: mayEdit(user, deal),
      deal: {
        name: deal.name, stage: deal.stage ?? null, amount: deal.amount ?? null, currency: deal.currency ?? null, closeDate: deal.closeDate ?? null,
        probability: deal.probability ?? null, companyId: deal.companyId ?? null, ownerName: owner?.name ?? null, isClosed: Boolean(deal.isClosed),
      },
      play, items, people, steps,
    };
  },
});

/** Each contact's observation log, the part a touch reads. */
export const touchLogs = internalQuery({
  args: { orgId: v.id("organizations"), contactIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, Array<Pick<Doc<"observations">, "observedAt" | "occurredAt" | "body">>> = {};
    for (const contactId of args.contactIds.slice(0, TOUCH_CONTACTS_MAX)) {
      const rows = await ctx.db.query("observations")
        .withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", args.orgId).eq("subject.contactId", contactId))
        .take(TOUCH_LOG_READ);
      out[contactId] = rows.map((o) => ({ observedAt: o.observedAt, ...(o.occurredAt === undefined ? {} : { occurredAt: o.occurredAt }), body: o.body }));
    }
    return out;
  },
});

export const roomTouchLog = internalQuery({
  args: { orgId: v.id("organizations"), domain: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("observations").withIndex("by_orgId_subjectDomain_observedAt", (q) => q.eq("orgId", args.orgId).eq("subject.domain", args.domain)).order("desc").take(TOUCH_LOG_READ);
    return rows.map((o) => ({ observedAt: o.observedAt, ...(o.occurredAt === undefined ? {} : { occurredAt: o.occurredAt }), body: o.body }));
  },
});

// ───────────────────────────── Changes ─────────────────────────────

const optText = v.optional(v.string());
const itemInput = v.object({
  kind: playItemKind, text: v.string(), quote: optText, sourceUrl: optText, occurredOn: optText,
  evidence: v.union(v.literal("verified"), v.literal("unverified"), v.literal("none")),
  person: v.optional(v.object({ name: v.string(), title: v.optional(v.string()), role: v.optional(dealRole) })),
});
export type ItemInput = {
  kind: ItemKind; text: string; quote?: string; sourceUrl?: string; occurredOn?: string; evidence: Evidence;
  person?: { name: string; title?: string; role?: DealRole };
};

const command = v.union(
  // A field left out is unchanged; an empty string clears it.
  v.object({
    op: v.literal("setBrief"), context: optText, whyNow: optText, alphaHypothesis: optText, alphaPitch: optText, windowLabel: optText, windowClosesOn: optText,
  }),
  v.object({ op: v.literal("addItems"), items: v.array(itemInput) }),
  v.object({ op: v.literal("dismissConcern"), key: v.string() }),
  v.object({ op: v.literal("dismissItem"), itemId: v.id("dealPlayItems") }),
  v.object({
    op: v.literal("setPerson"), contactId: v.string(), reportsTo: optText, persona: optText, angle: optText,
    confidence: v.optional(v.union(playConfidence, v.literal(""))),
  }),
  v.object({
    op: v.literal("saveStep"), stepId: v.optional(v.id("dealPlaySteps")), title: v.string(), channel: playChannel,
    contactId: optText, role: v.optional(v.union(dealRole, v.literal(""))), ownerUserId: v.optional(v.union(v.id("users"), v.literal(""))),
    dueOn: optText, state: v.optional(playStepState),
  }),
  v.object({ op: v.literal("removeStep"), stepId: v.id("dealPlaySteps") }),
  // A person's edit of a step's message; an empty body clears it.
  v.object({ op: v.literal("setDraft"), stepId: v.id("dealPlaySteps"), contactId: v.string(), subject: optText, body: v.string() }),
);

export async function ensurePlay(ctx: MutationCtx, orgId: Id<"organizations">, user: Doc<"users">, deal: Doc<"deals">, streamId: string): Promise<Doc<"dealPlays">> {
  const existing = await playOf(ctx, orgId, streamId);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("dealPlays", { orgId, dealId: deal._id, streamId, createdBy: user._id, createdAt: now, updatedAt: now });
  return (await ctx.db.get(id))!;
}

/** "" clears, undefined keeps, anything else is set (trimmed and clipped). */
const patchText = (value: string | undefined, max = TEXT_MAX) => (value === undefined ? undefined : value.trim() ? clip(value, max) : undefined);
const touched = (...values: Array<string | undefined>) => values.some((x) => x !== undefined);

/** Insert items into a play, refusing past ITEMS_MAX. Shared with the research run. */
export async function insertItems(ctx: MutationCtx, play: Doc<"dealPlays">, items: readonly ItemInput[], origin: Origin): Promise<number> {
  const have = (await ctx.db.query("dealPlayItems").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(ITEMS_MAX)).length;
  if (have + items.length > ITEMS_MAX) throw new ConvexError(`A play holds at most ${ITEMS_MAX} items`);
  const now = Date.now();
  for (const it of items) {
    if (!it.text.trim()) continue;
    if (it.occurredOn && !isoDate(it.occurredOn)) throw new ConvexError(`occurredOn must be YYYY-MM-DD, got ${it.occurredOn}`);
    await ctx.db.insert("dealPlayItems", {
      orgId: play.orgId, playId: play._id, kind: it.kind, text: clip(it.text), evidence: it.evidence, origin, dismissed: false, createdAt: now,
      ...(it.quote?.trim() ? { quote: clip(it.quote) } : {}),
      ...(it.sourceUrl?.trim() ? { sourceUrl: clip(it.sourceUrl, SHORT_MAX * 10) } : {}),
      ...(it.occurredOn ? { occurredOn: it.occurredOn } : {}),
      ...(it.person?.name.trim() ? { person: { name: clip(it.person.name, SHORT_MAX), ...(it.person.title ? { title: clip(it.person.title, SHORT_MAX) } : {}), ...(it.person.role ? { role: it.person.role } : {}) } } : {}),
    });
  }
  return items.length;
}

export const apply = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), command },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const deal = user && user.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal) throw new ConvexError("Deal not found");
    if (!mayEdit(user, deal)) throw new ConvexError("Only admins, managers and the deal's owner can change its play");
    const play = await ensurePlay(ctx, args.orgId, user, deal, args.streamId);
    const now = Date.now();
    const c = args.command;
    const mine = async <T extends "dealPlayItems" | "dealPlaySteps">(table: T, id: Id<T>) => {
      const row = await ctx.db.get(id);
      if (!row || row.playId !== play._id) throw new ConvexError("Not found on this deal's play");
      return row;
    };
    switch (c.op) {
      case "setBrief": {
        if (c.windowClosesOn && !isoDate(c.windowClosesOn)) throw new ConvexError("windowClosesOn must be YYYY-MM-DD");
        const patch: Partial<Doc<"dealPlays">> = { updatedAt: now };
        const keys = ["context", "whyNow", "alphaHypothesis", "alphaPitch", "windowLabel", "windowClosesOn"] as const;
        for (const k of keys) if (c[k] !== undefined) (patch as Record<string, unknown>)[k] = patchText(c[k], k === "windowLabel" || k === "windowClosesOn" ? SHORT_MAX : TEXT_MAX);
        if (touched(c.whyNow, c.alphaHypothesis, c.alphaPitch)) patch.briefBy = "user";
        await ctx.db.patch(play._id, patch);
        return null;
      }
      case "addItems":
        await insertItems(ctx, play, c.items, "user");
        break;
      case "dismissConcern":
        if (play.state) {
          const state = { ...play.state, concerns: play.state.concerns.map((risk) => risk.key === c.key ? { ...risk, dismissed: true } : risk) };
          await ctx.db.patch(play._id, { state, ...(play.stateSummary ? { stateSummary: summarizeState(state) } : {}) });
        }
        break;
      case "dismissItem":
        await mine("dealPlayItems", c.itemId);
        await ctx.db.patch(c.itemId, { dismissed: true });
        break;
      case "setPerson": {
        const row = await ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", play._id).eq("contactId", c.contactId)).unique();
        if (c.reportsTo === c.contactId) throw new ConvexError("A person can't report to themselves");
        const patch = {
          ...(c.reportsTo !== undefined ? { reportsTo: patchText(c.reportsTo, SHORT_MAX) } : {}),
          ...(c.persona !== undefined ? { persona: patchText(c.persona) } : {}),
          ...(c.angle !== undefined ? { angle: patchText(c.angle) } : {}),
          ...(c.confidence !== undefined ? { confidence: c.confidence || undefined } : {}),
          origin: "user" as const, updatedAt: now,
        };
        if (row) await ctx.db.patch(row._id, patch);
        else {
          if ((await ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", play._id)).take(PEOPLE_MAX)).length >= PEOPLE_MAX) {
            throw new ConvexError(`A play keeps notes on at most ${PEOPLE_MAX} people`);
          }
          await ctx.db.insert("dealPlayPeople", { orgId: args.orgId, playId: play._id, contactId: c.contactId, ...patch });
        }
        break;
      }
      case "saveStep": {
        if (!c.title.trim()) throw new ConvexError("A step needs a title");
        if (c.dueOn && !isoDate(c.dueOn)) throw new ConvexError("dueOn must be YYYY-MM-DD");
        if (c.ownerUserId) {
          const owner = await ctx.db.get(c.ownerUserId);
          if (!owner || owner.orgId !== args.orgId) throw new ConvexError("That owner isn't in this workspace");
        }
        const fields = {
          title: clip(c.title, SHORT_MAX), channel: c.channel,
          contactId: patchText(c.contactId, SHORT_MAX), role: c.role || undefined, ownerUserId: c.ownerUserId || undefined, dueOn: c.dueOn || undefined,
        };
        if (c.stepId) {
          const step = await mine("dealPlaySteps", c.stepId);
          const state = c.state ?? step.state;
          await ctx.db.patch(c.stepId, { ...fields, state, doneAt: state === "planned" ? undefined : step.doneAt ?? now });
        } else {
          if ((await ctx.db.query("dealPlaySteps").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(STEPS_MAX)).length >= STEPS_MAX) {
            throw new ConvexError(`A play holds at most ${STEPS_MAX} steps`);
          }
          const state = c.state ?? "planned";
          await ctx.db.insert("dealPlaySteps", {
            orgId: args.orgId, playId: play._id, ...fields, state, origin: "user", createdAt: now, ...(state === "planned" ? {} : { doneAt: now }),
          });
        }
        break;
      }
      case "removeStep":
        await mine("dealPlaySteps", c.stepId);
        await ctx.db.delete(c.stepId);
        break;
      case "setDraft": {
        await mine("dealPlaySteps", c.stepId);
        const body = c.body.trim();
        await ctx.db.patch(c.stepId, { draft: body ? { body: clip(body), contactId: c.contactId, ...(c.subject?.trim() ? { subject: clip(c.subject, SHORT_MAX) } : {}), by: "user", at: now } : undefined });
        break;
      }
    }
    await ctx.db.patch(play._id, { updatedAt: now });
    return null;
  },
});

type Command = typeof command.type;

/** Resolve the caller, check they edit deals, and apply one change to the play. */
export async function changePlay(ctx: Parameters<typeof requireCaller>[0], streamId: string, cmd: Command): Promise<null> {
  const caller = await requireCaller(ctx);
  if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
  const orgId = caller.orgId as Id<"organizations">;
  const userId = caller.userId as Id<"users">;
  // The deal must be one the caller sees (CP14); `apply` then checks they may change it.
  if (!(await ctx.runQuery(internal.dealPlays.load, { orgId, userId, streamId, access: caller.access }))) throw new ConvexError("Deal not found");
  await ctx.runMutation(internal.dealPlays.apply, { orgId, userId, streamId, command: cmd });
  return null;
}

export const setBrief = action({
  args: {
    streamId: v.string(), context: optText, whyNow: optText, alphaHypothesis: optText, alphaPitch: optText, windowLabel: optText, windowClosesOn: optText,
  },
  handler: (ctx, { streamId, ...brief }): Promise<null> => changePlay(ctx, streamId, { op: "setBrief", ...brief }),
});

export const dismissItem = action({
  args: { streamId: v.string(), itemId: v.id("dealPlayItems") },
  handler: (ctx, { streamId, itemId }): Promise<null> => changePlay(ctx, streamId, { op: "dismissItem", itemId }),
});

export const setPerson = action({
  args: { streamId: v.string(), contactId: v.string(), reportsTo: optText, persona: optText, angle: optText, confidence: v.optional(v.union(playConfidence, v.literal(""))) },
  handler: (ctx, { streamId, ...person }): Promise<null> => changePlay(ctx, streamId, { op: "setPerson", ...person }),
});

export const saveStep = action({
  args: {
    streamId: v.string(), stepId: v.optional(v.id("dealPlaySteps")), title: v.string(), channel: playChannel, contactId: optText,
    role: v.optional(v.union(dealRole, v.literal(""))), ownerUserId: v.optional(v.union(v.id("users"), v.literal(""))), dueOn: optText, state: v.optional(playStepState),
  },
  handler: (ctx, { streamId, ...step }): Promise<null> => changePlay(ctx, streamId, { op: "saveStep", ...step }),
});

export const setDraft = action({
  args: { streamId: v.string(), stepId: v.id("dealPlaySteps"), contactId: v.string(), subject: optText, body: v.string() },
  handler: (ctx, { streamId, ...draft }): Promise<null> => changePlay(ctx, streamId, { op: "setDraft", ...draft }),
});

export const removeStep = action({
  args: { streamId: v.string(), stepId: v.id("dealPlaySteps") },
  handler: (ctx, { streamId, stepId }): Promise<null> => changePlay(ctx, streamId, { op: "removeStep", stepId }),
});

// ───────────────────────────── The control plane ─────────────────────────────

export type PlayPerson = {
  contactId: string; name: string; title: string | null; role: DealRole; atCompany: boolean;
  reportsTo: string | null; persona: string | null; angle: string | null; confidence: Confidence | null; noteBy: Origin | null;
  thread: Thread; linkedinUrl: string | null; email: string | null;
};
export type PlayStep = {
  id: Id<"dealPlaySteps">; title: string; channel: Channel; contactId: string | null; role: DealRole | null; targetId: string | null;
  ownerUserId: Id<"users"> | null; dueOn: string | null; state: StepState; origin: Origin; createdAt: number; doneBy: Touch | null; queuedAt: number | null;
  /** `checks` are the recipe's rule checks on this draft, run by the recipe runtime when the plane is built. */
  draft: { subject: string | null; body: string; by: "keeper" | "user"; at: number; review: DraftReview | null; checks: DraftCheck[] } | null;
};
export type PlayItem = {
  id: Id<"dealPlayItems">; kind: ItemKind; text: string; quote: string | null; sourceUrl: string | null; evidence: Evidence; occurredOn: string | null; origin: Origin; createdAt: number;
  person: { name: string; title: string | null; role: DealRole | null } | null;
};
export type ControlPlane = {
  streamId: string;
  /** The deal page recipe the plane was built by, on the workspace's settings. */
  recipe: RecipeRef;
  /** What the recipe's deal page offers at this stage, as an agent reads it: the same buttons a person sees. */
  actions: AgentAction[];
  /** What the page shows from the recipe's data: its stage names and its people research fields. */
  recipeData: { stages: Plays["stages"]; peopleFields: Plays["people"]["fields"]; peopleSlugs: Plays["people"]["slugs"] };
  canEdit: boolean;
  started: boolean;
  deal: { name: string; stage: string | null; amount: number | null; currency: string | null; closeDate: string | null; probability: number | null; companyId: string | null; companyName: string | null; domain: string | null; ownerName: string | null; isClosed: boolean };
  brief: { context: string | null; whyNow: string | null; alphaHypothesis: string | null; alphaPitch: string | null; briefBy: Origin | null; windowLabel: string | null; windowClosesOn: string | null };
  state: Doc<"dealPlays">["state"] | null;
  /** The caller's role narrows what it sees, so it neither reads nor generates the state. */
  stateHidden: boolean;
  stateRun: Doc<"dealPlays">["stateRun"] | null;
  research: Doc<"dealPlays">["research"] | null;
  /** The last people research (lib/plays/peopleResearch.ts), without who started it. */
  peopleResearch: { status: "running" | "done" | "failed"; startedAt: number; finishedAt: number | null; contactIds: string[]; note: string | null } | null;
  /** The keeper's last daily check, when it has run. */
  keeperCheck: (NonNullable<Doc<"dealPlays">["keeper"]> & { at: number }) | null;
  /** Why the daily keeper is off for this play (an imported one), until a person runs it; null when it is on. */
  keeperPaused: string | null;
  people: PlayPerson[];
  /** What a CRM says about the deal's people where a person's choice held against it. */
  crmRoles: CrmRole[];
  /** Company people not on the deal, for adding to the map. */
  others: Array<{ id: string; name: string; title: string | null }>;
  /** Company people research suggests adding, in a role. */
  suggested: Array<{ contactId: string; name: string; title: string | null; role: DealRole; persona: string | null; angle: string | null; confidence: Confidence | null }>;
  /**
   * What the deal needs before it can move, why it's slow, and the questions those gaps raise (the recipe's prep),
   * each with the last research run's answer: `answer` null when research left it open, absent when not asked yet.
   */
  prep: Prep & { answers: Array<{ question: string; answer: string | null; quote: string | null; sourceUrl: string | null; asked: boolean }> };
  /** Where the deal is (the recipe's stage): it decides the page's job. */
  stage: DealStage;
  /** Who it could reach first, best first (the recipe's fan-out): the deal page's "Find the way in" list. */
  prospects: Prospect[];
  /** The ICP whose point of view drafts use: null when the account is in no ICP, `text` null when it has none. */
  pointOfView: PointOfView | null;
  items: PlayItem[];
  steps: PlayStep[];
  touches: Touch[];
  keeper: KeeperReport;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * A deal's control plane: its play, its people with each one's thread, its plan with the steps a touch completed,
 * every touch with its people, and the keeper's report. A deal with no play yet reads as an empty one; a workspace
 * whose recipe has no plays reads null, as a deal with no plane.
 */
export const get = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<ControlPlane | null> => {
    const caller = await requireCaller(ctx, { read: true });
    return buildPlane(ctx, caller, args.streamId).catch((error) => { if (isNoPlays(error)) return null; throw error; });
  },
});

export const cachedProspectRanking = internalQuery({
  args: { orgId: v.id("organizations"), streamId: v.string(), input: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("dealProspectRankings")
      .withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", args.orgId).eq("streamId", args.streamId)).unique();
    return row?.input === args.input && row.model === JEV_MODEL ? row.keys : null;
  },
});

export const storeProspectRanking = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), input: v.string(), keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("dealProspectRankings")
      .withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", args.orgId).eq("streamId", args.streamId)).unique();
    const value = { ...args, model: JEV_MODEL };
    if (row) await ctx.db.replace(row._id, value);
    else await ctx.db.insert("dealProspectRankings", value);
    return null;
  },
});

export const rankProspects = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<{ input: string; keys: string[]; note: string | null }> => {
    const caller = await requireCaller(ctx, { read: true });
    const plane = await buildPlane(ctx, caller, args.streamId);
    if (!plane) throw new ConvexError("Deal not found");
    const product = [plane.brief.context, plane.pointOfView?.text].filter(Boolean).join("\n") || null;
    const input = rankingInput(plane.prospects, product);
    const cacheArgs = { orgId: caller.orgId as Id<"organizations">, streamId: args.streamId, input };
    const cached: string[] | null = await ctx.runQuery(internal.dealPlays.cachedProspectRanking, cacheArgs);
    if (cached !== null) return { input, keys: cached, note: null };
    if (caller.access.preview || !may(caller.access, "deal", "edit") || !plane.canEdit) {
      return { input, keys: [], note: "No saved ranking for these buyers. A deal editor can generate it. Showing role and research order." };
    }
    const key = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
    if (!key || !product) return { input, keys: [], note: !key ? "Jev ranking unavailable. Showing role and research order." : "Add a product brief or ICP point of view to rank buyers for your product." };
    const deadline = Date.now() + 120_000;
    try {
      const keys = await rankBuyers(plane.prospects, async (a, b) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Comparison budget exhausted");
        const person = (p: Prospect) => ({ name: p.name, title: p.title, evidence: p.why });
        const result = await jevSystemOne(key, { product, left: person(a), right: person(b) }, { fit: playsFor(plane.recipe).people.fit }, { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(15_000, remaining)) }) });
        const answer = result.answers.fit;
        if (answer?.type !== "choice" || !["left", "right", "tie"].includes(answer.choice)) throw new Error("Invalid comparison");
        return answer.choice !== "right";
      });
      await ctx.runMutation(internal.dealPlays.storeProspectRanking, { ...cacheArgs, keys });
      return { input, keys, note: null };
    } catch {
      return { input, keys: [], note: "Jev ranking failed. Showing role and research order." };
    }
  },
});

export type PlaneCaller = Awaited<ReturnType<typeof requireCaller>>;

/** The caller's view of the state, its stage read compared with the CRM stage as it is now, not when the run read it. */
function stateFor(state: Doc<"dealPlays">["state"], caller: PlaneCaller, crmStage: string | null) {
  const view = stateForReader(state ?? null, { restricted: isRestricted(caller.access), mayRead: (owner) => mayReadText(caller.access, owner) });
  return view.state ? { ...view, state: { ...view.state, stage: { ...view.state.stage, crmStage, mismatch: stageMismatch(view.state.stage.label, crmStage) } } } : view;
}

/** `get` for a resolved principal: a person in the app, or a deal's owner when the keeper checks it daily. */
export async function buildPlane(ctx: ActionCtx, caller: PlaneCaller, streamId: string): Promise<ControlPlane | null> {
  const args = { streamId };
  {
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const client = callerClient(ctx, caller);
    const [loaded, committee] = await Promise.all([
      ctx.runQuery(internal.dealPlays.load, { orgId, userId, streamId: args.streamId, access: caller.access }),
      ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId, streamId: args.streamId, access: caller.access }),
    ]);
    if (!loaded || !committee) return null;
    const { play } = loaded;
    const plays = playsFor(loaded.recipe);
    // The deal's values as the caller may read them (CP14 field rules), not the projection's raw row.
    const dealRow = (await client.listObjects(caller.orgId, "deal", { filter: [{ field: "id", op: "eq", value: args.streamId }], limit: 1 })).rows[0];
    if (!dealRow) return null;
    const dv = dealRow.values;
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    const deal = {
      name: dealRow.title || loaded.deal.name, stage: str(dv.stage), amount: num(dv.amount), currency: str(dv.currency), closeDate: str(dv.closeDate),
      probability: num(dv.probability), companyId: str(dv.companyId), ownerName: str(dv.ownerId) ? loaded.deal.ownerName : null, isClosed: dv.isClosed === true,
    };
    const companyId = deal.companyId;
    // Only people the caller sees: their logs are read and their touches shown (CP14).
    const contacts = await rowsById(client, orgId, "contact", committee.members.map((m) => m.contactId));
    const restricted = isRestricted(caller.access);
    const memberIds = committee.members.map((m) => m.contactId).filter((id) => contacts.has(id) || !restricted);
    const [companyRows, companyPeople, logs, activities, icps, crmRoles] = await Promise.all([
      companyId ? rowsById(client, orgId, "account", [companyId]) : Promise.resolve(new Map()),
      companyId ? peopleOfCompany(ctx, client, orgId, companyId) : Promise.resolve([]),
      ctx.runQuery(internal.dealPlays.touchLogs, { orgId, contactIds: memberIds }),
      activitiesForRecord(ctx, caller, "deal", args.streamId).catch(() => ({ activities: [] })),
      companyId ? ctx.runQuery(internal.icps.pointsOfView, { orgId }) : Promise.resolve([]),
      crmRolesOf(ctx, client, orgId, args.streamId, committee.members),
    ]);
    const memberSet = new Set(memberIds);
    // Company people the page could reach first: their history decides whether they're untouched.
    const prospectIds = companyPeople.filter((p) => !memberSet.has(p.id)).slice(0, PROSPECTS_MAX).map((p) => p.id);
    const prospectLogs = prospectIds.length ? await ctx.runQuery(internal.dealPlays.touchLogs, { orgId, contactIds: prospectIds }) : {};
    const now = Date.now();
    const companyDomain = companyId ? companyRows.get(companyId)?.values.domain : null;
    const roomLog = typeof companyDomain === "string" ? await ctx.runQuery(internal.dealPlays.roomTouchLog, { orgId, domain: companyDomain.trim().toLowerCase() }) : [];
    const touches: Touch[] = [
      ...memberIds.flatMap((id) => touchesFromLog(id, (logs[id] ?? []) as never, args.streamId)),
      ...touchesFromLog(null, roomLog.filter((o) => o.body.type === "room" && o.body.accountId === companyId), args.streamId),
      ...touchesFromActivities(activities.activities, memberSet, now),
    ].sort((a, b) => b.at - a.at);
    const notes = new Map(loaded.people.map((p) => [p.contactId, p]));
    const atCompany = new Map(companyPeople.map((p) => [p.id, p]));
    const people: PlayPerson[] = committee.members.filter((m) => memberSet.has(m.contactId)).flatMap((m): PlayPerson[] => {
      const row = contacts.get(m.contactId);
      const name = row?.title || m.snapshot?.name;
      if (!name) return [];
      const note = notes.get(m.contactId);
      const person = atCompany.get(m.contactId);
      return [{
        contactId: m.contactId, name, title: row ? str(row.values.title) : m.snapshot?.title ?? null, role: m.role, atCompany: Boolean(person),
        reportsTo: note?.reportsTo ?? null, persona: note?.persona ?? null, angle: note?.angle ?? null, confidence: note?.confidence ?? null, noteBy: note?.origin ?? null,
        thread: threadOf(touches.filter((t) => t.contactId === m.contactId), now, plays.quietDays),
        linkedinUrl: person?.linkedinUrl ?? (row ? str(row.values.linkedinUrl) : null), email: person?.email ?? (row ? str(row.values.email) : null),
      }];
    });
    const holders = new Map<DealRole, string>();
    for (const p of people) if (p.role !== "involved" && !holders.has(p.role)) holders.set(p.role, p.contactId);
    const steps = loaded.steps.map((s) => {
      const step = { id: s._id, title: s.title, channel: s.channel, contactId: s.contactId ?? null, role: s.role ?? null, dueOn: s.dueOn ?? null, state: s.state, createdAt: s.createdAt };
      const targetId = stepTarget(step, holders);
      return {
        ...step, targetId, ownerUserId: s.ownerUserId ?? null, origin: s.origin, doneBy: touchDoing(step, targetId, touches), queuedAt: s.queuedAt ?? null,
        // A draft written for someone the step no longer targets (its role changed hands) is dropped, never sent to the new holder.
        draft: s.draft && s.draft.contactId === targetId ? { subject: s.draft.subject ?? null, body: s.draft.body, by: s.draft.by, at: s.draft.at, review: s.draft.review ?? null } : null,
      };
    }).sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.createdAt - b.createdAt);
    const items: PlayItem[] = loaded.items.filter((i) => !i.dismissed).map((i) => ({
      id: i._id, kind: i.kind, text: i.text, quote: i.quote ?? null, sourceUrl: i.sourceUrl ?? null, evidence: i.evidence, occurredOn: i.occurredOn ?? null, origin: i.origin, createdAt: i.createdAt,
      person: i.person ? { name: i.person.name, title: i.person.title ?? null, role: i.person.role ?? null } : null,
    })).sort((a, b) => (b.occurredOn ?? "").localeCompare(a.occurredOn ?? "") || b.createdAt - a.createdAt);
    const company = companyId ? companyRows.get(companyId) : undefined;
    const icpIds = company && Array.isArray(company.values.icpIds) ? company.values.icpIds.filter((x: unknown): x is string => typeof x === "string") : [];
    /** The fan-out's rows when `buyer` is who counts as a buyer here: the buyer of the ICP whose point of view the recipe picks. */
    const rowsFor = (buyer: (typeof icps)[number]["buyer"] | null): Array<Omit<Prospect, "suggested">> => [
      ...people.map((p) => ({
        key: `c:${p.contactId}`, contactId: p.contactId, itemId: null, name: p.name, title: p.title, source: "deal" as const, role: p.role,
        buyer: Boolean(buyer && p.title && isBuyer(p.title, buyer)), researched: Boolean(p.persona || p.angle), why: p.angle ?? p.persona,
        reached: p.thread.touches > 0 ? THREAD_LABEL[p.thread.state] : null, ...insightOf(notes.get(p.contactId), plays.people.centerMinConfidence),
      })),
      ...companyPeople.filter((p) => !memberSet.has(p.id)).slice(0, PROSPECTS_MAX).map((p) => {
        const note = notes.get(p.id);
        const thread = threadOf(touchesFromLog(p.id, (prospectLogs[p.id] ?? []) as never, args.streamId), now, plays.quietDays);
        const reached = thread.touches > 0 ? THREAD_LABEL[thread.state] : null;
        return {
          key: `c:${p.id}`, contactId: p.id, itemId: null, name: p.name, title: p.title, source: "company" as const, role: note?.suggestedRole ?? null,
          buyer: Boolean(buyer && p.title && isBuyer(p.title, buyer)), researched: Boolean(note?.persona || note?.angle), why: note?.angle ?? note?.persona ?? null, reached,
          ...insightOf(note, plays.people.centerMinConfidence),
        };
      }),
      ...items.filter((i) => i.kind === "gap" && i.person).map((i) => ({
        key: `i:${i.id}`, contactId: null, itemId: i.id as string, name: i.person!.name, title: i.person!.title, source: "research" as const, role: i.person!.role,
        buyer: Boolean(buyer && i.person!.title && isBuyer(i.person!.title, buyer)), researched: true, why: i.text, reached: null, center: null, capability: null,
      })),
    ];
    // The fan-out depends on which ICP's point of view the recipe picks, so it runs once per ICP the account is in and
    // the plane keeps the one picked: the whole page is one runtime call.
    const candidates = icps.filter((i) => icpIds.includes(i.id));
    const variants = candidates.length ? candidates.map((i) => ({ icpId: i.id as string | null, buyer: i.buyer })) : [{ icpId: null, buyer: null }];
    const drafted = steps.filter((s) => s.draft);
    const [pov, keeper, stage, prep, ...rest] = await runPlays(ctx, loaded.recipe, [
      { fn: "pointOfView", input: [icpIds, icps] },
      { fn: "keeper", input: [{
        now, hasCompany: Boolean(companyId), windowClosesOn: play?.windowClosesOn ?? null, windowLabel: play?.windowLabel ?? null,
        members: people.map((p) => ({ contactId: p.contactId, name: p.name, role: p.role, thread: p.thread })),
        steps: steps.map((s) => ({ ...s, doneByTouch: s.doneBy !== null })),
        researchedAt: play?.research?.status === "done" ? play.research.finishedAt ?? null : null,
        hasBrief: Boolean(play?.whyNow || items.length),
      }] },
      { fn: "stage", input: [{ probability: deal.probability, members: people }] },
      { fn: "prep", with: { windowDays: { call: 1, field: "windowDays" } }, input: [{
        now, company: company?.title ?? null, dealName: deal.name, windowLabel: play?.windowLabel ?? null, windowDays: null, hasWhyNow: Boolean(play?.whyNow),
        members: people.map((p) => ({ name: p.name, role: p.role, thread: p.thread })),
        steps: steps.map((s) => ({ channel: s.channel, dueOn: s.dueOn, state: s.state, doneByTouch: s.doneBy !== null })),
      }] },
      ...variants.map((v) => ({ fn: "fanOut" as const, input: [rowsFor(v.buyer)] as [Array<Omit<Prospect, "suggested">>] })),
      ...drafted.map((s) => ({ fn: "drafts.check" as const, input: [s.channel, s.draft!.subject, s.draft!.body] as [Channel, string | null, string] })),
    ]);
    const fanOuts = rest.slice(0, variants.length) as Prospect[][];
    const checks = new Map(drafted.map((s, i) => [s.id, rest[variants.length + i] as DraftCheck[]]));
    const picked = variants.findIndex((v) => v.icpId === (pov?.icpId ?? null));
    // A recipe may pick an ICP the account isn't in; its fan-out then takes a second call.
    const prospects = picked >= 0 ? fanOuts[picked]
      : (await runPlays(ctx, loaded.recipe, [{ fn: "fanOut", input: [rowsFor(icps.find((i) => i.id === pov?.icpId)?.buyer ?? null)] }]))[0];
    return {
      streamId: args.streamId, recipe: loaded.recipe, actions: agentActions(loaded.page, stage), canEdit: loaded.canEdit, started: Boolean(play),
      recipeData: { stages: plays.stages, peopleFields: plays.people.fields, peopleSlugs: plays.people.slugs },
      deal: { ...deal, companyName: company?.title ?? null, domain: company ? str(company.values.domain) : null },
      brief: {
        context: play?.context ?? null, whyNow: play?.whyNow ?? null, alphaHypothesis: play?.alphaHypothesis ?? null, alphaPitch: play?.alphaPitch ?? null,
        briefBy: play?.briefBy ?? null, windowLabel: play?.windowLabel ?? null, windowClosesOn: play?.windowClosesOn ?? null,
      },
      // The state was read with its generator's access: a reader whose role narrows any field or record sees it only when
      // they made it, so it can't carry what their role hides. Others with full access get it, quotes redacted per inbox.
      ...stateFor(play?.state, caller, deal.stage),
      stateRun: stateRunOf(play?.stateRun, now),
      research: play?.research ?? null,
      peopleResearch: play?.peopleResearch ? {
        status: play.peopleResearch.status, startedAt: play.peopleResearch.startedAt, finishedAt: play.peopleResearch.finishedAt ?? null,
        contactIds: play.peopleResearch.contactIds, note: play.peopleResearch.note ?? null,
      } : null,
      keeperCheck: play?.keeper && play.keeperCheckedAt ? { ...play.keeper, at: play.keeperCheckedAt } : null,
      keeperPaused: play?.keeperPaused?.reason ?? null,
      people,
      crmRoles,
      others: companyPeople.filter((p) => !memberSet.has(p.id)).map((p) => ({ id: p.id, name: p.name, title: p.title })),
      suggested: loaded.people.flatMap((n) => {
        const person = atCompany.get(n.contactId);
        return n.suggestedRole && person && !memberSet.has(n.contactId)
          ? [{ contactId: n.contactId, name: person.name, title: person.title, role: n.suggestedRole, persona: n.persona ?? null, angle: n.angle ?? null, confidence: n.confidence ?? null }]
          : [];
      }),
      items, touches: touches.slice(0, 50), keeper, stage, prospects,
      steps: steps.map((s): PlayStep => ({ ...s, draft: s.draft && { ...s.draft, checks: checks.get(s.id) ?? [] } })),
      prep: withAnswers(prep, play?.answers ?? []),
      pointOfView: company ? pov : null,
    };
  }
}

/** A person's people-research reading from their notes: the remit only when Jev was at least `minConfidence` sure. */
function insightOf(note: Doc<"dealPlayPeople"> | undefined, minConfidence: number): { center: "innovation" | "stability" | null; capability: string | null } {
  return { center: note?.center && (note.centerConfidence ?? 0) >= minConfidence ? note.center : null, capability: note?.capability ?? null };
}

/** The prep's questions, each with the last run's answer to the same question when it asked it. */
function withAnswers(prep: Prep, answers: NonNullable<Doc<"dealPlays">["answers"]>): ControlPlane["prep"] {
  return {
    ...prep,
    answers: prep.questions.map((question) => {
      const a = answers.find((x) => x.question === question);
      return { question, answer: a?.answer ?? null, quote: a?.quote ?? null, sourceUrl: a?.sourceUrl ?? null, asked: Boolean(a) };
    }),
  };
}

// ───────────────────────────── Research run state ─────────────────────────────

/** Start a research run on the deal's play, creating the play if needed. Returns the run's start time, its key. */
export const claimResearch = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const user = await ctx.db.get(args.userId);
    const deal = user && user.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal) throw new ConvexError("Deal not found");
    if (!mayEdit(user, deal)) throw new ConvexError("Only admins, managers and the deal's owner can research its account");
    const play = await ensurePlay(ctx, args.orgId, user, deal, args.streamId);
    const now = Date.now();
    if (play.research?.status === "running" && now - play.research.startedAt < RESEARCH_STALL_MS) throw new ConvexError("Research is already running for this deal");
    await ctx.db.patch(play._id, { research: { status: "running", startedAt: now, startedBy: user._id }, updatedAt: now });
    return now;
  },
});

/** The running run, or null when another run has replaced it. */
async function runningPlay(ctx: MutationCtx, orgId: Id<"organizations">, streamId: string, startedAt: number) {
  const play = await playOf(ctx, orgId, streamId);
  return play?.research?.status === "running" && play.research.startedAt === startedAt ? play : null;
}

export const failResearch = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), startedAt: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const play = await runningPlay(ctx, args.orgId, args.streamId, args.startedAt);
    if (play?.research) await ctx.db.patch(play._id, { research: { ...play.research, status: "failed", finishedAt: Date.now(), error: args.error.slice(0, 500) } });
    return null;
  },
});

/**
 * Start a deal's people research (lib/plays/peopleResearch.ts) as `userId`: the field runs over `contactIds`, the
 * play recording them so the deal can read their answers once they finish. Returns the research's start time, its key.
 */
export const claimPeopleResearch = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), contactIds: v.array(v.string()), onCredits: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ startedAt: number; runIds: Id<"researchRuns">[]; note: string | null }> => {
    const user = await ctx.db.get(args.userId);
    const deal = user && user.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user || !deal) throw new ConvexError("Deal not found");
    if (!mayEdit(user, deal)) throw new ConvexError("Only admins, managers and the deal's owner can research its people");
    const play = await ensurePlay(ctx, args.orgId, user, deal, args.streamId);
    const now = Date.now();
    const last = play.peopleResearch;
    if (last?.status === "running" && now - last.startedAt < 2 * PEOPLE_RESEARCH_WAIT_MS) throw new ConvexError("People research is already running for this deal");
    const contactIds = [...new Set(args.contactIds)].slice(0, PEOPLE_RESEARCH_MAX);
    if (!contactIds.length) throw new ConvexError("Choose people to research");
    const { runIds, skipped, busy } = await ctx.runMutation(internal.researchAgents.startPeopleRuns, { orgId: args.orgId, userId: args.userId, contactIds, ...(args.onCredits ? { onCredits: true } : {}) });
    // Nothing could run because another deal's research holds the fields: nothing is recorded, so the keeper tries
    // again at its next check, and a person sees why.
    if (!runIds.length && busy) throw new ConvexError("Another deal's people research is running. Try again in a few minutes.");
    const note = skipped.length ? `Not researched now: ${skipped.join("; ")}.` : null;
    await ctx.db.patch(play._id, {
      peopleResearch: { status: "running", startedAt: now, startedBy: user._id, contactIds, runIds, ...(note ? { note } : {}) }, updatedAt: now,
    });
    return { startedAt: now, runIds, note };
  },
});

/** The running people research, or null when another has replaced it. */
async function runningPeople(ctx: MutationCtx, orgId: Id<"organizations">, streamId: string, startedAt: number) {
  const play = await playOf(ctx, orgId, streamId);
  return play?.peopleResearch?.status === "running" && play.peopleResearch.startedAt === startedAt ? play : null;
}

/**
 * Finish a people research: each person's remit and capability as research read them. A field left without an
 * answer clears nothing a person wrote: these notes are research's own and every run rewrites them.
 */
export const savePeopleResearch = internalMutation({
  args: {
    orgId: v.id("organizations"), streamId: v.string(), startedAt: v.number(), note: v.optional(v.string()),
    people: v.array(v.object({
      contactId: v.string(),
      center: v.optional(v.union(v.literal("innovation"), v.literal("stability"))), centerConfidence: v.optional(v.number()),
      capability: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const play = await runningPeople(ctx, args.orgId, args.streamId, args.startedAt);
    if (!play?.peopleResearch) return null;
    const now = Date.now();
    for (const p of args.people) {
      const row = await ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", play._id).eq("contactId", p.contactId)).unique();
      const insight = { center: p.center, centerConfidence: p.centerConfidence, capability: p.capability ? clip(p.capability) : undefined, insightAt: now };
      if (row) await ctx.db.patch(row._id, insight);
      else await ctx.db.insert("dealPlayPeople", { orgId: args.orgId, playId: play._id, contactId: p.contactId, ...insight, origin: "research", updatedAt: now });
    }
    const note = [play.peopleResearch.note, args.note].filter(Boolean).join(" ") || undefined;
    await ctx.db.patch(play._id, { peopleResearch: { ...play.peopleResearch, status: "done", finishedAt: now, note }, updatedAt: now });
    return null;
  },
});

export const failPeopleResearch = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), startedAt: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const play = await runningPeople(ctx, args.orgId, args.streamId, args.startedAt);
    if (play?.peopleResearch) await ctx.db.patch(play._id, { peopleResearch: { ...play.peopleResearch, status: "failed", finishedAt: Date.now(), note: args.error.slice(0, 500) } });
    return null;
  },
});

/**
 * Save a run's screened findings (lib/plays/research.ts). Research replaces its own earlier items, never a person's,
 * and skips any a person dismissed. It fills the brief and people's notes only where no person wrote them, and
 * drafts steps only for a play with no plan yet.
 */
export const saveResearch = internalMutation({
  args: {
    orgId: v.id("organizations"), streamId: v.string(), startedAt: v.number(),
    brief: v.object({ whyNow: v.string(), alphaHypothesis: v.string(), alphaPitch: v.string() }),
    items: v.array(itemInput),
    people: v.array(v.object({ contactId: v.string(), persona: v.string(), angle: v.string(), confidence: playConfidence, suggestedRole: v.optional(dealRole) })),
    steps: v.array(v.object({ title: v.string(), channel: playChannel, contactId: optText, role: v.optional(dealRole), dueOn: optText })),
    stats: v.object({ searches: v.number(), pages: v.number(), dropped: v.number() }),
    answers: v.optional(v.array(v.object({ question: v.string(), answer: optText, quote: optText, sourceUrl: optText }))),
  },
  handler: async (ctx, args) => {
    const play = await runningPlay(ctx, args.orgId, args.streamId, args.startedAt);
    if (!play || !play.research) return null;
    const now = Date.now();
    if (play.briefBy !== "user") {
      await ctx.db.patch(play._id, {
        whyNow: patchText(args.brief.whyNow), alphaHypothesis: patchText(args.brief.alphaHypothesis), alphaPitch: patchText(args.brief.alphaPitch), briefBy: "research",
      });
    }
    const existing = await ctx.db.query("dealPlayItems").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(ITEMS_MAX);
    const dismissed = new Set(existing.filter((i) => i.dismissed).map((i) => i.text.toLowerCase()));
    // A person a page named stays across runs (searches differ run to run); everything else research wrote is replaced.
    const named = new Set(existing.flatMap((i) => (i.person ? [i.person.name.toLowerCase()] : [])));
    const replaced = existing.filter((i) => i.origin === "research" && !i.dismissed && !i.person);
    for (const i of replaced) await ctx.db.delete(i._id);
    const room = ITEMS_MAX - (existing.length - replaced.length);
    const fresh = args.items
      .filter((i) => !dismissed.has(clip(i.text).toLowerCase()) && !(i.person && named.has(i.person.name.toLowerCase())))
      .slice(0, Math.max(0, room));
    await insertItems(ctx, play, fresh, "research");

    for (const p of args.people) {
      const row = await ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", play._id).eq("contactId", p.contactId)).unique();
      if (row?.origin === "user") continue;
      const notes = { persona: patchText(p.persona), angle: patchText(p.angle), confidence: p.confidence, suggestedRole: p.suggestedRole, origin: "research" as const, updatedAt: now };
      if (row) await ctx.db.patch(row._id, notes);
      else await ctx.db.insert("dealPlayPeople", { orgId: args.orgId, playId: play._id, contactId: p.contactId, ...notes });
    }

    const hasSteps = Boolean(await ctx.db.query("dealPlaySteps").withIndex("by_playId", (q) => q.eq("playId", play._id)).first());
    if (!hasSteps) {
      for (const st of args.steps.slice(0, 12)) {
        await ctx.db.insert("dealPlaySteps", {
          orgId: args.orgId, playId: play._id, title: clip(st.title, SHORT_MAX), channel: st.channel, state: "planned", origin: "research", createdAt: now,
          ...(st.contactId ? { contactId: st.contactId } : st.role ? { role: st.role } : {}), ...(st.dueOn && isoDate(st.dueOn) ? { dueOn: st.dueOn } : {}),
        });
      }
    }
    // A keeper's call script predates these answers: clear it, so the next check asks what research left open.
    if (args.answers?.length) {
      for (const st of await ctx.db.query("dealPlaySteps").withIndex("by_playId", (q) => q.eq("playId", play._id)).take(200)) {
        if (st.state === "planned" && st.channel === "call" && st.draft?.by === "keeper") await ctx.db.patch(st._id, { draft: undefined });
      }
    }
    await ctx.db.patch(play._id, {
      research: { ...play.research, status: "done", finishedAt: now, searches: args.stats.searches, pages: args.stats.pages, kept: fresh.length, dropped: args.stats.dropped },
      ...(args.answers ? { answers: args.answers.slice(0, 5).map((a) => ({
        question: clip(a.question, SHORT_MAX * 2),
        ...(a.answer?.trim() ? { answer: clip(a.answer), ...(a.quote ? { quote: clip(a.quote) } : {}), ...(a.sourceUrl ? { sourceUrl: clip(a.sourceUrl, SHORT_MAX * 10) } : {}) } : {}),
      })) } : {}),
      updatedAt: now,
    });
    return null;
  },
});

// ───────────────────────────── Keeper (dealPlayKeeper.ts) ─────────────────────────────

/** Plays whose last check is older than `before`, oldest first, on open deals in workspaces with plays, with the principal the keeper acts as. */
export const duePlays = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const out: Array<{ orgId: Id<"organizations">; streamId: string; userId: Id<"users"> }> = [];
    const hasPlays = new Map<Id<"organizations">, boolean>();
    for await (const play of ctx.db.query("dealPlays").withIndex("by_keeperCheckedAt")) {
      if (out.length >= args.limit || (play.keeperCheckedAt ?? 0) >= args.before) break;
      if (!hasPlays.has(play.orgId)) hasPlays.set(play.orgId, (await orgRecipe(ctx, play.orgId)).plays !== null);
      // A workspace whose recipe has no plays has no keeper: its plays wait, unchecked, until it picks one again.
      if (!hasPlays.get(play.orgId)) continue;
      // An imported play waits until a person runs its keeper here (resumeKeeper).
      if (play.keeperPaused) continue;
      const deal = await ctx.db.get(play.dealId);
      if (!deal || deal.isClosed || deal.archivedAt !== undefined) continue;
      // The deal's owner, else whoever started the play: it reads as them and drafts on their plan.
      out.push({ orgId: play.orgId, streamId: play.streamId, userId: deal.primaryRepId ?? play.createdBy });
    }
    return out;
  },
});

/** A member as the keeper reads for them: the shape requireCaller returns. Null when they left the workspace. */
export const principalCaller = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await withRole(ctx, await ctx.db.get(args.userId));
    const access = user ? (await principalAccess(ctx, args.orgId, [args.userId]))?.[0] : undefined;
    return user && access ? { orgId: args.orgId as string, userId: user._id as string, name: user.name, role: user.role, ...(user.capabilities ? { capabilities: user.capabilities } : {}), access } : null;
  },
});

/**
 * Record a check, so the daily tick moves past this play even when the check failed. A reply's re-check
 * (`daily: false`) updates the snapshot but leaves the daily check, which drafts, on schedule.
 */
export const saveKeeper = internalMutation({
  args: {
    orgId: v.id("organizations"), streamId: v.string(), daily: v.optional(v.boolean()),
    keeper: v.object({
      lastTouch: v.optional(v.object({ at: v.number(), channel: playChannel })),
      health: v.union(v.literal("on_track"), v.literal("needs_attention"), v.literal("at_risk")),
      flagKeys: v.array(v.string()), notifiedKeys: v.optional(v.array(v.string())), drafted: v.number(),
      summary: v.optional(v.object({ people: v.number(), engaged: v.number(), repliesOwed: v.number(), coreFilled: v.number(), openSteps: v.number(), nextDue: v.optional(v.string()) })), notifiedAt: v.optional(v.number()), error: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    if (play) {
      await ctx.db.patch(play._id, {
        keeper: { ...args.keeper, flagKeys: args.keeper.flagKeys.slice(0, 40) },
        ...(args.daily === false && play.keeperCheckedAt ? {} : { keeperCheckedAt: Date.now() }),
      });
    }
    return null;
  },
});

/** A person ran the keeper on this play: one that arrived paused in an import is checked daily from now on. */
export const resumeKeeper = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string() },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    if (play?.keeperPaused) await ctx.db.patch(play._id, { keeperPaused: undefined, updatedAt: Date.now() });
    return null;
  },
});

/** Save drafts the keeper wrote, onto steps still planned whose draft no person has written. */
export const saveDrafts = internalMutation({
  args: {
    orgId: v.id("organizations"), streamId: v.string(),
    drafts: v.array(v.object({
      stepId: v.id("dealPlaySteps"), contactId: v.string(), subject: optText, body: v.string(),
      review: v.optional(draftReviewValidator),
    })),
  },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    if (!play) return 0;
    let saved = 0;
    for (const d of args.drafts) {
      const step = await ctx.db.get(d.stepId);
      if (!step || step.playId !== play._id || step.state !== "planned" || (step.draft?.by === "user" && step.draft.contactId === d.contactId)) continue;
      await ctx.db.patch(step._id, { draft: { body: clip(d.body), contactId: d.contactId, ...(d.subject ? { subject: clip(d.subject, SHORT_MAX) } : {}), by: "keeper", at: Date.now(), ...(d.review ? { review: d.review } : {}) } });
      saved++;
    }
    return saved;
  },
});

/** The org's Slack webhook, encrypted, or null when Slack isn't connected. Read only by dealPlayKeeper.ts. */
export const slackCipher = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "slack")).first();
    return row?.isActive && row.accessToken ? row.accessToken : null;
  },
});

/** Plays on open deals a contact is on, with the principal their keeper acts as: a reply from them re-checks each. */
export const playsOfContact = internalQuery({
  args: { orgId: v.id("organizations"), contactId: v.string() },
  handler: async (ctx, args) => {
    if (!(await orgRecipe(ctx, args.orgId)).plays) return [];
    const edges = await ctx.db.query("associations")
      .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", args.orgId).eq("association", "deal_contact").eq("toId", args.contactId))
      .take(20);
    const out: Array<{ streamId: string; userId: Id<"users"> }> = [];
    for (const e of edges.filter((x) => x.active)) {
      const play = await playOf(ctx, args.orgId, e.fromId);
      const deal = play ? await ctx.db.get(play.dealId) : null;
      if (play && !play.keeperPaused && deal && !deal.isClosed && deal.archivedAt === undefined) out.push({ streamId: play.streamId, userId: deal.primaryRepId ?? play.createdBy });
    }
    return out;
  },
});

// ───────────────────────────── LinkedIn steps (DP3) ─────────────────────────────

/** The variable a play's cadence sends: each person's own draft, captured when they're enrolled. */
export const PLAY_MESSAGE_VAR = "custom.play_message";

export const playCadence = internalQuery({
  args: { orgId: v.id("organizations"), streamId: v.string(), senderAccountId: v.id("linkedinAccounts") },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    const id = play?.linkedin?.find((l) => l.senderAccountId === args.senderAccountId)?.cadenceId;
    const cadence = id ? await ctx.db.get(id) : null;
    return cadence && cadence.status !== "archived" ? cadence._id : null;
  },
});

export const recordLinkedin = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), senderAccountId: v.id("linkedinAccounts"), cadenceId: v.id("linkedinCadences"), stepId: v.id("dealPlaySteps") },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    if (!play) return null;
    const others = (play.linkedin ?? []).filter((l) => l.senderAccountId !== args.senderAccountId);
    await ctx.db.patch(play._id, { linkedin: [...others, { senderAccountId: args.senderAccountId, cadenceId: args.cadenceId }] });
    const step = await ctx.db.get(args.stepId);
    if (step && step.playId === play._id) await ctx.db.patch(step._id, { queuedAt: Date.now() });
    return null;
  },
});

/**
 * Hand a LinkedIn step to the caller's LinkedIn sender: the person joins the play's cadence on that sender (an
 * invite, then the step's draft as a message; someone already connected gets the message straight away). The
 * worker sends within the sender's limits, window and warm-up, and the first LinkedIn touch completes the step.
 */
export const queueLinkedin = action({
  args: { streamId: v.string(), stepId: v.id("dealPlaySteps"), senderAccountId: v.id("linkedinAccounts") },
  handler: async (ctx, args): Promise<{ cadenceId: Id<"linkedinCadences"> }> => {
    const caller = await requireCaller(ctx);
    if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
    const orgId = caller.orgId as Id<"organizations">;
    const plane = await buildPlane(ctx, caller, args.streamId);
    if (!plane?.canEdit) throw new ConvexError(plane ? "Only admins, managers and the deal's owner can change its play" : "Deal not found");
    const step = plane.steps.find((s) => s.id === args.stepId);
    const person = step && plane.people.find((p) => p.contactId === step.targetId);
    if (!step || step.channel !== "linkedin" || step.state !== "planned") throw new ConvexError("Only a planned LinkedIn step can be queued");
    if (!person) throw new ConvexError("This step isn't for someone on the deal");
    if (!step.draft?.body.trim()) throw new ConvexError("Write or draft the message first");
    const publicIdentifier = publicIdentifierOf(person.linkedinUrl);
    if (!person.linkedinUrl || !publicIdentifier) throw new ConvexError(`${person.name} has no LinkedIn profile URL in Canon`);
    // The play's cadence on this sender, made on first use.
    let cadenceId = await ctx.runQuery(internal.dealPlays.playCadence, { orgId, streamId: args.streamId, senderAccountId: args.senderAccountId });
    if (!cadenceId) {
      cadenceId = await ctx.runMutation(api.linkedinCadences.create, {
        name: `Play · ${plane.deal.name}`.slice(0, NAME_MAX), senderAccountId: args.senderAccountId,
        steps: [{ kind: "invite" }, { kind: "message", body: `{{${PLAY_MESSAGE_VAR}}}`, delayDays: 0 }],
      });
      await ctx.runMutation(api.linkedinCadences.setStatus, { cadenceId, status: "active" });
    }
    // Every request, a reused cadence too: the caller must own the sender or be an admin, as the audience enroll checks.
    if (!(await ctx.runQuery(internal.linkedinCadences.enrollContext, { cadenceId }))) throw new ConvexError("Not authenticated");
    const out = await ctx.runMutation(internal.linkedinCadences.insertEnrollments, {
      cadenceId, userId: caller.userId as Id<"users">, at: Date.now(),
      candidates: [{ contactId: person.contactId, contactName: person.name, linkedinUrl: person.linkedinUrl, publicIdentifier, vars: { fullName: person.name, [PLAY_MESSAGE_VAR]: step.draft.body } }],
    });
    if (!out.inserted) throw new ConvexError(`${person.name} is already in a LinkedIn cadence, or was already queued from this play`);
    await ctx.runMutation(internal.dealPlays.recordLinkedin, { orgId, streamId: args.streamId, senderAccountId: args.senderAccountId, cadenceId, stepId: step.id });
    return { cadenceId };
  },
});

// ───────────────────────────── Plays list ─────────────────────────────

const LIST_MAX = 200;

/** Every play in the org with its keeper snapshot; `list` keeps those on deals the caller sees. Refuses (NO_PLAYS) like `load`. */
export const orgPlays = internalQuery({
  args: { orgId: v.id("organizations"), cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, args) => {
    await requirePlays(ctx, args.orgId);
    // Convex reads whole documents, including DS1 state. Bound each transaction's bytes as well as its rows.
    const page = await ctx.db.query("dealPlays").withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: Math.min(10, Math.max(1, args.limit)), maximumBytesRead: 2_000_000 });
    const rows = await Promise.all(page.page.map(async (p) => {
      const deal = await ctx.db.get(p.dealId);
      const owner = deal?.primaryRepId ? await ctx.db.get(deal.primaryRepId) : null;
      return {
        streamId: p.streamId, windowLabel: p.windowLabel ?? null, windowClosesOn: p.windowClosesOn ?? null,
        keeper: p.keeper ?? null, checkedAt: p.keeperCheckedAt ?? null, researchedAt: p.research?.finishedAt ?? null, ownerName: owner?.name ?? null,
        stateSummary: p.stateSummary ?? null,
      };
    }));
    return { rows, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export type PlayRow = {
  streamId: string; name: string; stage: string | null; amount: number | null; currency: string | null; closeDate: string | null; isClosed: boolean;
  ownerName: string | null; windowLabel: string | null; windowDays: number | null;
  ownerId: string | null; stateSummary: StateSummary | null; stateHidden: boolean;
  lastTouch: { at: number; channel: Channel } | null;
  health: Health | null; summary: NonNullable<Doc<"dealPlays">["keeper"]>["summary"] | null; urgent: number; checkedAt: number | null;
  /** The caller owns the deal: the deal page's queue walks these first (docs/deal-prep-loop.md PL3). */
  mine: boolean;
};

/**
 * Every play on a deal the caller sees, for the Plays page: the account-level readout of whether multi-threading
 * is working (docs/account-plays.md). Health and counts are as of each play's last keeper check.
 */
export const list = action({
  args: {},
  handler: async (ctx): Promise<PlayRow[]> => {
    const caller = await requireCaller(ctx, { read: true });
    type Page = FunctionReturnType<typeof internal.dealPlays.orgPlays>;
    const plays: Page["rows"] = [];
    let cursor: string | null = null;
    do {
      const page: Page | null = await ctx.runQuery(internal.dealPlays.orgPlays, { orgId: caller.orgId as Id<"organizations">, cursor, limit: LIST_MAX - plays.length })
        .catch((error) => { if (isNoPlays(error)) return null; throw error; });
      if (!page) return [];
      plays.push(...page.rows);
      cursor = page.isDone ? null : page.cursor;
    } while (cursor !== null && plays.length < LIST_MAX);
    if (!plays.length) return [];
    // The deals as the caller may read them (CP14): a play on a deal they can't see is left out.
    const deals = new Map((await callerClient(ctx, caller).listObjects(caller.orgId, "deal", {
      filter: [{ field: "id", op: "in", value: plays.map((p) => p.streamId) }], limit: plays.length,
    })).rows.map((r) => [r.id, r]));
    const now = Date.now();
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    const order: Record<Health, number> = { at_risk: 0, needs_attention: 1, on_track: 2 };
    const restricted = isRestricted(caller.access);
    return plays.flatMap((p): PlayRow[] => {
      const d = deals.get(p.streamId);
      if (!d) return [];
      const days = p.windowClosesOn ? daysUntil(p.windowClosesOn, now) : null;
      return [{
        streamId: p.streamId, name: d.title, stage: str(d.values.stage), amount: num(d.values.amount), currency: str(d.values.currency), closeDate: str(d.values.closeDate),
        isClosed: d.values.isClosed === true, ownerName: str(d.values.ownerId) ? p.ownerName : null,
        ownerId: str(d.values.ownerId),
        ...summaryForReader(p.stateSummary ? { ...p.stateSummary, stage: { ...p.stateSummary.stage, mismatch: stageMismatch(p.stateSummary.stage.label, str(d.values.stage)) } } : null, restricted),
        lastTouch: restricted ? null : p.keeper?.lastTouch ?? null,
        windowLabel: p.windowLabel, windowDays: days !== null && Number.isFinite(days) ? days : null,
        health: p.keeper?.health ?? null, summary: p.keeper?.summary ?? null,
        urgent: (p.keeper?.flagKeys ?? []).filter((k) => k.startsWith("replied:") || k === "window" || k === "company").length,
        checkedAt: p.checkedAt, mine: d.values.ownerId === caller.userId,
      }];
    }).sort((a, b) => Number(a.isClosed) - Number(b.isClosed) || (order[a.health ?? "needs_attention"] - order[b.health ?? "needs_attention"])
      || (a.windowDays ?? 9999) - (b.windowDays ?? 9999));
  },
});

export const dismissConcern = action({
  args: { streamId: v.string(), key: v.string() },
  handler: (ctx, args): Promise<null> => changePlay(ctx, args.streamId, { op: "dismissConcern", key: args.key }),
});
