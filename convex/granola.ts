/**
 * Granola meetings into Canon (convex/granolaActions.ts polls): what a poll
 * needs from the database, and the one write per meeting. That write logs
 * the meeting on the people and company it was with and on their open deal,
 * as the rep whose note it is, so it shows on every one of their timelines.
 */
import { NO_CREDENTIAL } from "./lib/sealed";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";
import type { Doc, Id } from "./_generated/dataModel";
import { saveAsCaller } from "./objects";
import { calendarMeetingFor } from "./lib/calendar/links";
import { attachTargets } from "./activityTargets";
import { dealsOfCompany } from "./deals";
import { accessFor, dealVisible } from "./permissions";
import { convexLedgerStore, mirrorDecidedFacts } from "./canon";
import { decideFacts } from "./lib/canon/ledger";
import { settlePlan } from "./canonGate";
import type { Access } from "./lib/access";
import { DAY_MS, GRANOLA_DEFAULT_LOOKBACK_DAYS, GRANOLA_FOLDERS_MAX, GRANOLA_LOOKBACK_DAYS, pickDeal, TIMINGS_VERSION, type CandidateDeal } from "./lib/calls/granola";
import { isOurSide, OUR_TEAM_MAX, teamEntry, teamOf } from "./lib/calls/suggestions";

type Company = { id: string; domain?: string };

/** Workspace members whose emails mark a meeting's internal side. */
const MEMBERS_MAX = 500;
/** Deal edges read per matched person. */
const DEALS_PER_CONTACT = 50;
/** A poll still marked running after this is taken to have died, and the next one runs. */
export const GRANOLA_STALE_RUN_MS = 30 * 60 * 1000;

const granolaIntegration = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "granola")).first();

/** The Granola folders imports are limited to; none means every note the key reads. */
const foldersOf = (config: Record<string, unknown> | undefined): Array<{ id: string; name: string }> =>
  (Array.isArray(config?.granolaFolders) ? (config.granolaFolders as Array<{ id: string; name: string }>) : []);

/** Extra "our team" entries an admin keeps on the Granola page. */
const ourTeamOf = (config: Record<string, unknown> | undefined) => (Array.isArray(config?.granolaOurTeam) ? (config.granolaOurTeam as string[]) : []);
/** Imported meetings the disconnect warning counts exactly; past it, it says "at least". */
const IMPORTED_COUNT_MAX = 1000;
/** Imported meetings one re-check covers. */
const RECHECK_MAX = 200;

/** Meetings the card lists. */
const RECENT_MAX = 5;
/** Latest imports read to find the newest meetings among them. */
const RECENT_SCAN = 50;
/** Imported meetings the meetings table lists. */
const MEETINGS_MAX = 500;
/** Proposed facts the card scans for those from calls. */
const PENDING_SCAN = 200;
/** Deal fields a call may set on its own once an admin turns it on (each still checked by Jev against its quote). */
export const AUTO_APPLY_ATTRIBUTES = ["nextStep", "closeDate"] as const;

/** The Integrations card: whether Granola is connected, how the last poll went, and the latest meetings with their deals. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const row = user && (await granolaIntegration(ctx, user.orgId));
    if (!user || !row?.isActive) return { connected: false as const };
    const calls = await ctx.db.query("callRecordings").withIndex("by_orgId_provider", (q) => q.eq("orgId", user.orgId).eq("provider", "granola")).order("desc").take(RECENT_SCAN);
    const access = await accessFor(ctx, user);
    // Newest meeting first: a backfill imports old meetings after new ones.
    const latest = calls
      .map((c) => ({ c, at: c.callDate ? Date.parse(c.callDate) : c.createdAt }))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_MAX)
      .map(({ c }) => c);
    const recent = await Promise.all(latest.map(async (c) => {
      const deal = c.dealId ? await ctx.db.get(c.dealId) : null;
      const shown = deal && deal.orgId === user.orgId && dealVisible(access, deal) ? deal : null;
      const metadata = (c.sourceMetadata ?? {}) as Record<string, unknown>;
      const check = metadata.suggestionCheck as { reason?: string; count?: number } | undefined;
      return {
        id: c._id, title: c.title, at: c.callDate ? Date.parse(c.callDate) : c.createdAt,
        deal: shown ? { name: shown.name } : null,
        logged: typeof metadata.meetingStreamId === "string",
        suggestions: check?.reason ? { reason: check.reason, count: check.count ?? 0 } : null,
      };
    }));
    // Owners of meetings that did not count as ours: the likely missing "our team" entries (a Granola account on another address).
    const team = teamOf((await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(MEMBERS_MAX)).filter((m) => m.isActive).map((m) => m.email), ourTeamOf(row.syncConfig));
    const outsideOwners = [...new Set(calls.flatMap((c) => {
      const check = (c.sourceMetadata as Record<string, unknown> | undefined)?.suggestionCheck as { reason?: string } | undefined;
      const owner = Array.isArray(c.participants) ? (c.participants as Array<Record<string, unknown>>).find((p) => p.role === "owner")?.email : undefined;
      return check?.reason === "not_our_meeting" && typeof owner === "string" && !isOurSide(team, owner) ? [owner.toLowerCase()] : [];
    }))].slice(0, 5);
    // Updates calls proposed (convex/callFacts.ts) still waiting in Fact Review, and whether next step and close date apply on their own.
    const waiting = await ctx.db.query("facts").withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", "proposed")).order("desc").take(PENDING_SCAN);
    const rules = await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    const autoApply = AUTO_APPLY_ATTRIBUTES.every((a) => rules.some((r) => r.sourceKind === "call" && r.attribute === a && r.enabled && !r.entityType));
    return {
      connected: true as const,
      lookbackDays: lookbackOf(row.syncConfig?.granolaLookbackDays),
      catchingUp: row.syncConfig?.granolaCatchingUp === true,
      suggestMembersOnly: row.syncConfig?.granolaSuggestMembersOnly !== false,
      ourTeam: ourTeamOf(row.syncConfig),
      folders: foldersOf(row.syncConfig),
      rescoping: row.syncConfig?.granolaRescoping === true,
      // What a disconnect deletes: the meetings imported (counted up to IMPORTED_COUNT_MAX).
      imported: (await ctx.db.query("callRecordings").withIndex("by_orgId_provider", (q) => q.eq("orgId", user.orgId).eq("provider", "granola")).take(IMPORTED_COUNT_MAX)).length,
      outsideOwners,
      canManage: can(user, "integrations.manage"),
      updates: { pending: waiting.filter((f) => f.sourceKind === "call").length, autoApply, canEdit: can(user, "writeGate.edit") },
      lastSyncAt: row.lastSyncAt ?? null,
      lastSyncStatus: row.lastSyncStatus ?? null,
      lastSyncError: row.lastSyncError ?? null,
      recent,
    };
  },
});

/** Every imported meeting, newest first, for the meetings table on the Granola page (searched, sorted and filtered there). */
export const meetings = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    // By meeting date, not import order: a backfill imports old meetings after new ones.
    const calls = await ctx.db.query("callRecordings").withIndex("by_orgId_callDate", (q) => q.eq("orgId", user.orgId)).order("desc").filter((q) => q.eq(q.field("provider"), "granola")).take(MEETINGS_MAX);
    const access = await accessFor(ctx, user);
    const deals = new Map<string, string | null>();
    const rows = await Promise.all(calls.map(async (c) => {
      if (c.dealId && !deals.has(c.dealId)) {
        const deal = await ctx.db.get(c.dealId);
        deals.set(c.dealId, deal && deal.orgId === user.orgId && dealVisible(access, deal) ? deal.name : null);
      }
      const metadata = (c.sourceMetadata ?? {}) as Record<string, unknown>;
      const check = metadata.suggestionCheck as { reason?: string; count?: number } | undefined;
      const people = Array.isArray(c.participants) ? (c.participants as Array<Record<string, unknown>>) : [];
      const owner = people.find((p) => p.role === "owner");
      const deal = c.dealId ? deals.get(c.dealId) ?? null : null;
      return {
        id: c._id, title: c.title, at: c.callDate ? Date.parse(c.callDate) : c.createdAt,
        owner: typeof owner?.name === "string" && owner.name ? owner.name : typeof owner?.email === "string" ? owner.email : null,
        people: people.length,
        deal,
        outcome: deal ? "deal" as const : typeof metadata.meetingStreamId === "string" ? "logged" as const : "unmatched" as const,
        suggestions: check?.reason ? { reason: check.reason, count: check.count ?? 0 } : null,
      };
    }));
    return rows.sort((a, b) => b.at - a.at);
  },
});

/** Store a key the action checked against Granola; the first poll starts now. A reconnect keeps where the last poll stopped. */
export const storeKey = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), apiKey: v.string(), baseUrl: v.optional(v.string()), lookbackDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await granolaIntegration(ctx, args.orgId);
    const config = { ...(existing?.syncConfig ?? {}) } as Record<string, unknown>;
    delete config.granolaRescoping; // a re-scope a disconnect cut short does not hold a reconnect's polls
    // A first connection starts its window here; a reconnect keeps where its polls got to, and looks further back only if asked to.
    const days = lookbackOf(args.lookbackDays ?? config.granolaLookbackDays);
    const window = rewoundWindow(config, days, now);
    const fields = {
      accessToken: await encryptForStorage(args.apiKey), refreshToken: await encryptForStorage(""),
      ...(args.baseUrl ? { instanceUrl: args.baseUrl } : {}),
      scopes: ["notes:read"], isActive: true, connectedBy: args.userId, connectedAt: now, lastSyncError: undefined, updatedAt: now,
      syncConfig: withWindow(config, window, days),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("integrations", { orgId: args.orgId, provider: "granola", ...fields, createdAt: now });
    await ctx.scheduler.runAfter(0, internal.granolaActions.syncOrg, { orgId: args.orgId, trigger: "system" });
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await granolaIntegration(ctx, user.orgId);
    if (!row) return;
    const now = Date.now();
    // Settings stay (lookback, team, options); where imports got to does not: a reconnect starts over from its lookback.
    const config = { ...(row.syncConfig ?? {}) } as Record<string, unknown>;
    const jobId = typeof config.granolaJobId === "string" ? ctx.db.normalizeId("backgroundJobs", config.granolaJobId) : null;
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (job?.orgId === user.orgId && job.status !== "completed") {
      await ctx.db.patch(job._id, { status: "completed", error: undefined, detail: `Stopped: Granola was disconnected. ${job.detail ?? ""}`.trim(), updatedAt: now, completedAt: now });
    }
    for (const k of ["granolaCursor", "granolaCoveredFrom", "granolaRetry", "granolaCatchingUp", "granolaRescoping", "granolaJobId"]) delete config[k];
    await ctx.db.patch(row._id, {
      isActive: false, accessToken: NO_CREDENTIAL, refreshToken: NO_CREDENTIAL, lastSyncStatus: undefined, lastSyncError: undefined, lastSyncAt: undefined, lastSyncDealCount: undefined,
      syncConfig: { ...config, granolaWindow: (typeof config.granolaWindow === "number" ? config.granolaWindow : 0) + 1 }, updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.granola.purgeImported, { orgId: user.orgId, userId: user._id, before: now });
  },
});

/** Imported meetings one purge step takes, and transcript lines it deletes per meeting. */
const PURGE_CALLS = 10;
const PURGE_SEGMENTS = 400;
/** When the purge looks once more, after a poll running at the disconnect has stopped. */
const PURGE_SWEEP_DELAY_MS = 10 * 60 * 1000;

/**
 * Delete what Granola imported before `before` (a disconnect): each meeting's call recording, transcript,
 * insights and suggestions, and the meeting entry it logged on timelines (a ledger delete, as `userId`).
 * Companies, people and deals stay, and so do values already accepted onto them. A reconnect imports anew,
 * after `before`, and is never purged by this run.
 */
export const purgeImported = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), before: v.number(), final: v.optional(v.boolean()),
    /** The folders changed (setFolders): when the old imports are gone, import anew from the chosen folders. */
    rescope: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    // Still disconnected: everything Granola left is this purge's, including what a poll running at the
    // disconnect wrote after it. Reconnected: only what was imported before the disconnect.
    const integration = await granolaIntegration(ctx, args.orgId);
    const stillOff = !integration?.isActive;
    const calls = (await ctx.db.query("callRecordings").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).take(PURGE_CALLS * 5))
      .filter((c) => stillOff || c._creationTime < args.before)
      .slice(0, PURGE_CALLS);
    for (const call of calls) {
      const segments = await ctx.db.query("callTranscriptSegments").withIndex("by_callId", (q) => q.eq("callId", call._id)).take(PURGE_SEGMENTS);
      for (const s of segments) await ctx.db.delete(s._id);
      if (segments.length === PURGE_SEGMENTS) {
        // A long transcript: the rest of it, and then this meeting, in the next step.
        await ctx.scheduler.runAfter(0, internal.granola.purgeImported, args);
        return;
      }
      for (const i of await ctx.db.query("callInsights").withIndex("by_callId", (q) => q.eq("callId", call._id)).take(500)) await ctx.db.delete(i._id);
      for (const s of await ctx.db.query("callSuggestions").withIndex("by_callId", (q) => q.eq("callId", call._id)).take(200)) await ctx.db.delete(s._id);
      // Field updates it proposed and nobody decided yet are rejected, as the person disconnecting; accepted values stay.
      const plan = ((call.sourceMetadata as Record<string, unknown> | undefined)?.callFacts as { patchPlanId?: string } | undefined)?.patchPlanId;
      const planId = plan ? ctx.db.normalizeId("patchPlans", plan) : null;
      if (planId && user && user.orgId === args.orgId) {
        const pending = (await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", planId)).take(500)).filter((f) => f.status === "proposed");
        if (pending.length) {
          const at = Date.now();
          const decider = { kind: "user" as const, userId: user._id };
          const out = await decideFacts(convexLedgerStore(ctx), { orgId: args.orgId, decisions: pending.map((f) => ({ factId: f._id, status: "rejected" as const })), decider, at });
          await mirrorDecidedFacts(ctx, out.decided, decider, at);
          await settlePlan(ctx, planId, user._id, at);
        }
      }
      const meeting = (call.sourceMetadata as Record<string, unknown> | undefined)?.meetingStreamId;
      if (typeof meeting === "string" && user && user.orgId === args.orgId) {
        // Best-effort: a meeting someone already deleted, or one this person may not delete, is left as it is.
        await saveAsCaller(ctx, user, "meeting", { op: "delete", streamId: meeting }).catch(() => undefined);
      }
      await ctx.db.delete(call._id);
    }
    if (calls.length === PURGE_CALLS) await ctx.scheduler.runAfter(0, internal.granola.purgeImported, args);
    // Done for now: one more pass later picks up anything a poll that was mid-note at the disconnect still wrote.
    else if (args.rescope) await finishRescope(ctx, args.orgId);
    else if (!args.final) await ctx.scheduler.runAfter(PURGE_SWEEP_DELAY_MS, internal.granola.purgeImported, { ...args, final: true });
  },
});

/** The re-scope's second half: the old imports are gone, so read the lookback window again from the chosen folders. */
async function finishRescope(ctx: MutationCtx, orgId: Id<"organizations">) {
  const row = await granolaIntegration(ctx, orgId);
  if (!row?.isActive) return;
  const config = { ...(row.syncConfig ?? {}) } as Record<string, unknown>;
  delete config.granolaRescoping;
  const from = new Date(Date.now() - lookbackOf(config.granolaLookbackDays) * DAY_MS).toISOString();
  await ctx.db.patch(row._id, { syncConfig: { ...config, granolaCursor: from, granolaCoveredFrom: from, granolaWindow: windowOf(config) + 1 }, updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.granolaActions.syncOrg, { orgId, trigger: "system" });
}

/**
 * Import only from these Granola folders (and their subfolders), or from every note the key reads (none).
 * A change starts over: polls pause, what was imported is deleted as on a disconnect (companies, people
 * and deals stay), and the lookback window is read again from the chosen folders.
 */
export const setFolders = mutation({
  args: { folders: v.array(v.object({ id: v.string(), name: v.string() })) },
  handler: async (ctx, args): Promise<{ rescoping: boolean }> => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await granolaIntegration(ctx, user.orgId);
    if (!row?.isActive) throw new ConvexError("Connect Granola first");
    if (args.folders.length > GRANOLA_FOLDERS_MAX) throw new ConvexError(`Choose at most ${GRANOLA_FOLDERS_MAX} folders`);
    if (args.folders.some((f) => !/^fol_[A-Za-z0-9]+$/.test(f.id))) throw new ConvexError("That is not a Granola folder");
    const folders = [...new Map(args.folders.map((f) => [f.id, { id: f.id, name: f.name.trim().slice(0, 120) || f.id }])).values()];
    const config = { ...(row.syncConfig ?? {}) } as Record<string, unknown>;
    const same = JSON.stringify(foldersOf(config).map((f) => f.id).sort()) === JSON.stringify(folders.map((f) => f.id).sort());
    if (same) {
      await ctx.db.patch(row._id, { syncConfig: { ...config, granolaFolders: folders }, updatedAt: Date.now() });
      return { rescoping: false };
    }
    const now = Date.now();
    // A new window generation stops a running poll at its next note; rescoping pauses the scheduled ones.
    await ctx.db.patch(row._id, {
      syncConfig: { ...config, granolaFolders: folders, granolaRescoping: true, granolaWindow: windowOf(config) + 1, granolaCatchingUp: false },
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.granola.purgeImported, { orgId: user.orgId, userId: user._id, before: now, rescope: true });
    return { rescoping: true };
  },
});

/** Whether a poll that began under window generation `window` may still write: Granola is connected and no rewind or disconnect came since. */
export const stillCurrent = internalQuery({
  args: { orgId: v.id("organizations"), window: v.number() },
  handler: async (ctx, args) => {
    const row = await granolaIntegration(ctx, args.orgId);
    return Boolean(row?.isActive) && row?.syncConfig?.granolaRescoping !== true && windowOf(row?.syncConfig) === args.window;
  },
});

/** A lookback the Granola page offers, else the default. */
function lookbackOf(days: unknown): number {
  return (GRANOLA_LOOKBACK_DAYS as readonly number[]).includes(days as number) ? (days as number) : GRANOLA_DEFAULT_LOOKBACK_DAYS;
}

/**
 * The cursor and covered start for a window of `days`, when it reaches further back than what was already
 * imported (or nothing was): the next polls then read every note changed since, oldest first. Meetings
 * already imported are matched by their note id, so reading them again adds nothing twice. Empty when the
 * window is already covered.
 */
function rewoundWindow(config: Record<string, unknown>, days: number, now: number): Record<string, unknown> {
  const from = new Date(now - days * DAY_MS).toISOString();
  const covered = typeof config.granolaCoveredFrom === "string" ? config.granolaCoveredFrom : null;
  if (covered && Date.parse(covered) <= Date.parse(from)) return {};
  // A new window generation: a poll still running under the old one can no longer move this cursor (saveCursor).
  return { granolaCursor: from, granolaCoveredFrom: from, granolaWindow: windowOf(config) + 1 };
}

/** The window generation a poll reads under; a rewind starts a new one. */
const windowOf = (config: Record<string, unknown> | undefined) => (typeof config?.granolaWindow === "number" ? config.granolaWindow : 0);

/** `config` with `window` applied; a rewound window also drops a failing note's retry count, as its polls start over. */
function withWindow(config: Record<string, unknown>, window: Record<string, unknown>, days: number): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, granolaLookbackDays: days, ...window };
  if (Object.keys(window).length) delete next.granolaRetry;
  return next;
}

/** How far back Granola imports reach. Looking further back than before imports the older meetings over the next polls. */
export const setLookback = mutation({
  args: { days: v.number() },
  handler: async (ctx, args): Promise<{ rewound: boolean }> => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    if (!(GRANOLA_LOOKBACK_DAYS as readonly number[]).includes(args.days)) throw new ConvexError("Choose one of the offered lookbacks");
    const row = await granolaIntegration(ctx, user.orgId);
    if (!row?.isActive) throw new ConvexError("Connect Granola first");
    const config = { ...(row.syncConfig ?? {}) } as Record<string, unknown>;
    const window = rewoundWindow(config, args.days, Date.now());
    await ctx.db.patch(row._id, { syncConfig: withWindow(config, window, args.days), updatedAt: Date.now() });
    const rewound = Object.keys(window).length > 0;
    if (rewound && row.lastSyncStatus !== "in_progress") await ctx.scheduler.runAfter(0, internal.granolaActions.syncOrg, { orgId: user.orgId, trigger: "manual" });
    return { rewound };
  },
});

/**
 * Whether new companies, people and deals are suggested only from meetings someone from the
 * workspace was on (the note's owner or an attendee is a member). On unless turned off.
 */
export const setSuggestMembersOnly = mutation({
  args: { membersOnly: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await granolaIntegration(ctx, user.orgId);
    if (!row?.isActive) throw new ConvexError("Connect Granola first");
    await ctx.db.patch(row._id, { syncConfig: { ...(row.syncConfig ?? {}), granolaSuggestMembersOnly: args.membersOnly }, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.granolaActions.recheckOrg, { orgId: user.orgId });
  },
});

/**
 * Extra emails or domains that count as this workspace's side of a meeting, beside its members and their
 * companies: a Granola account on another address (ryan@oldcompany.com), or a team not yet invited.
 * Imported meetings are checked again for suggestions with the new list.
 */
export const setOurTeam = mutation({
  args: { entries: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await granolaIntegration(ctx, user.orgId);
    if (!row?.isActive) throw new ConvexError("Connect Granola first");
    const entries: string[] = [];
    for (const raw of args.entries) {
      if (!raw.trim()) continue;
      const entry = teamEntry(raw);
      if (!entry) throw new ConvexError(`"${raw.trim()}" is not an email or a domain such as acme.com`);
      if (!entries.includes(entry)) entries.push(entry);
    }
    if (entries.length > OUR_TEAM_MAX) throw new ConvexError(`List at most ${OUR_TEAM_MAX} emails or domains`);
    await ctx.db.patch(row._id, { syncConfig: { ...(row.syncConfig ?? {}), granolaOurTeam: entries }, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.granolaActions.recheckOrg, { orgId: user.orgId });
  },
});

/** Calls scanned for ones still without segment times, newest first. */
const TIMINGS_SCAN = 200;

/** Imported meetings whose segments may still lack Granola's sides and times (lib/calls/granola.ts), newest first. */
export const timingTargets = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.number() },
  handler: async (ctx, args): Promise<Array<{ callId: Id<"callRecordings">; noteId: string }>> => {
    const calls = await ctx.db.query("callRecordings").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).order("desc").take(TIMINGS_SCAN);
    const out: Array<{ callId: Id<"callRecordings">; noteId: string }> = [];
    for (const c of calls) {
      const meta = (c.sourceMetadata ?? {}) as Record<string, unknown>;
      if (meta.timings === TIMINGS_VERSION || typeof meta.noteId !== "string") continue;
      out.push({ callId: c._id, noteId: meta.noteId });
      if (out.length === args.limit) break;
    }
    return out;
  },
});

/** Imported meetings to check again for suggestions, newest first, each with whom it is checked as. */
export const recheckTargets = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<Array<{ callId: Id<"callRecordings">; userId: Id<"users"> }>> => {
    const row = await granolaIntegration(ctx, args.orgId);
    if (!row?.isActive) return [];
    const calls = await ctx.db.query("callRecordings").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).order("desc").take(RECHECK_MAX);
    const out: Array<{ callId: Id<"callRecordings">; userId: Id<"users"> }> = [];
    for (const c of calls) {
      const owner = Array.isArray(c.participants) ? (c.participants as Array<Record<string, unknown>>).find((p) => p.role === "owner")?.email : undefined;
      const member = typeof owner === "string"
        ? await ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", args.orgId).eq("email", owner)).first()
        : null;
      const writer = c.ownerId ?? (member?.isActive ? member._id : null) ?? row.connectedBy ?? null;
      if (writer) out.push({ callId: c._id, userId: writer });
    }
    return out;
  },
});

/** Every org with Granola connected whose last poll is not still running. */
export const duePolls = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("integrations").withIndex("by_provider", (q) => q.eq("provider", "granola")).take(1000);
    return rows
      .filter((r) => r.isActive && r.accessToken && r.syncConfig?.granolaRescoping !== true && !(r.lastSyncStatus === "in_progress" && args.now - r.updatedAt < GRANOLA_STALE_RUN_MS))
      .map((r) => r.orgId);
  },
});

/** The key, where the last poll stopped, and the workspace's members (by lowercased email) a note can belong to. */
export const syncState = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const integration = await granolaIntegration(ctx, args.orgId);
    if (!integration?.isActive || !integration.accessToken) return null;
    const members = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(MEMBERS_MAX);
    const active = members.filter((m) => m.isActive);
    const cursor = typeof integration.syncConfig?.granolaCursor === "string" ? (integration.syncConfig.granolaCursor as string) : null;
    return {
      apiKey: integration.accessToken,
      baseUrl: integration.instanceUrl ?? null,
      cursor,
      window: windowOf(integration.syncConfig),
      lookbackDays: lookbackOf(integration.syncConfig?.granolaLookbackDays),
      folderIds: foldersOf(integration.syncConfig).map((f) => f.id),
      suggestVersion: typeof integration.syncConfig?.granolaSuggestVersion === "number" ? (integration.syncConfig.granolaSuggestVersion as number) : 1,
      connectedBy: integration.connectedBy ?? null,
      members: active.map((m) => ({ userId: m._id, email: m.email.toLowerCase() })),
    };
  },
});

/** The note's owner when they are a member, else the person who connected Granola: whom the meeting is logged as. */
export const writerAccess = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  handler: async (ctx, args): Promise<Access | null> => {
    const user = await ctx.db.get(args.userId);
    return user && user.orgId === args.orgId && user.isActive ? accessFor(ctx, user) : null;
  },
});

/** Where the next poll starts: the last note it finished. */
export const saveCursor = internalMutation({
  args: { orgId: v.id("organizations"), cursor: v.string(), noteId: v.string(), window: v.number() },
  handler: async (ctx, args) => {
    const integration = await granolaIntegration(ctx, args.orgId);
    if (!integration) return;
    const config = { ...(integration.syncConfig ?? {}) } as Record<string, unknown>;
    // A poll that began before a longer lookback was chosen must not undo its rewind.
    if (windowOf(config) !== args.window) return;
    // Polls move the cursor forward only; only a longer lookback (setLookback) moves it back.
    if (typeof config.granolaCursor === "string" && Date.parse(config.granolaCursor) > Date.parse(args.cursor)) return;
    // Past the note that was failing: its count is done.
    if ((config.granolaRetry as { noteId?: string } | undefined)?.noteId === args.noteId) delete config.granolaRetry;
    await ctx.db.patch(integration._id, { syncConfig: { ...config, granolaCursor: args.cursor }, updatedAt: Date.now() });
  },
});

/** The workspace's meetings are being read under this suggestion version (lib/calls/suggestions.ts SUGGEST_VERSION). */
export const markSuggestVersion = internalMutation({
  args: { orgId: v.id("organizations"), version: v.number() },
  handler: async (ctx, args) => {
    const integration = await granolaIntegration(ctx, args.orgId);
    if (!integration) return;
    await ctx.db.patch(integration._id, { syncConfig: { ...(integration.syncConfig ?? {}), granolaSuggestVersion: args.version } });
  },
});

/** A catching-up job waits this long for the next poll (30 s away, plus the poll itself) before the tray calls it stalled. */
const CATCH_UP_WAIT_MS = 20 * 60 * 1000;

/**
 * Whether the last poll stopped with more notes to read (a backfill catching up), for the Granola page, and the
 * background tray's job while it catches up: started by the first poll that leaves more to read, moved on by each
 * poll after it (`imported` meetings), finished by the one that reads the last note, or failed with why a poll
 * `stopped` early (the next poll reopens it).
 */
export const setCatchingUp = internalMutation({
  args: { orgId: v.id("organizations"), catchingUp: v.boolean(), imported: v.optional(v.number()), stopped: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const integration = await granolaIntegration(ctx, args.orgId);
    if (!integration) return;
    const config = { ...(integration.syncConfig ?? {}) } as Record<string, unknown>;
    const now = Date.now();
    const stored = typeof config.granolaJobId === "string" ? ctx.db.normalizeId("backgroundJobs", config.granolaJobId) : null;
    let job = stored ? await ctx.db.get(stored) : null;
    if (job?.orgId !== args.orgId) job = null;
    if (!job && args.catchingUp) {
      const jobId = await ctx.db.insert("backgroundJobs", {
        orgId: args.orgId, kind: "meeting_import", title: "Importing Granola meetings", href: "/dashboard/integrations/granola",
        phases: [], status: "processing", startedAt: now, updatedAt: now, counters: { read: 0 },
      });
      config.granolaJobId = jobId;
      job = await ctx.db.get(jobId);
    }
    if (job) {
      const read = (job.counters?.read ?? 0) + (args.imported ?? 0);
      const so = `${read.toLocaleString("en-US")} ${read === 1 ? "meeting" : "meetings"}`;
      if (args.catchingUp) {
        await ctx.db.patch(job._id, { status: "processing", error: undefined, completedAt: undefined, detail: `Imported ${so} so far`, counters: { ...job.counters, read, waitingUntil: now + CATCH_UP_WAIT_MS }, updatedAt: now });
      } else if (args.stopped) {
        await ctx.db.patch(job._id, { status: "failed", error: args.stopped, detail: `${args.stopped} The next check, within 15 minutes, reads on. Imported ${so} so far.`, counters: { ...job.counters, read }, updatedAt: now, completedAt: now });
      } else {
        await ctx.db.patch(job._id, { status: "completed", error: undefined, detail: `Imported ${so}. New meetings come in every 15 minutes.`, counters: { ...job.counters, read }, updatedAt: now, completedAt: now });
        delete config.granolaJobId;
      }
    }
    config.granolaCatchingUp = args.catchingUp;
    if (JSON.stringify(config) !== JSON.stringify(integration.syncConfig ?? {})) await ctx.db.patch(integration._id, { syncConfig: config });
  },
});

/** A note failed to import: how many polls running it has now failed (the cursor stays before it until it is passed over). */
export const noteFailed = internalMutation({
  args: { orgId: v.id("organizations"), noteId: v.string(), window: v.number() },
  handler: async (ctx, args): Promise<number> => {
    const integration = await granolaIntegration(ctx, args.orgId);
    if (!integration) return 0;
    const config = (integration.syncConfig ?? {}) as Record<string, unknown>;
    if (windowOf(config) !== args.window) return 0; // a rewind started over: this poll's count is moot
    const last = config.granolaRetry as { noteId?: string; attempts?: number } | undefined;
    const attempts = last?.noteId === args.noteId ? (last.attempts ?? 0) + 1 : 1;
    await ctx.db.patch(integration._id, { syncConfig: { ...config, granolaRetry: { noteId: args.noteId, attempts } }, updatedAt: Date.now() });
    return attempts;
  },
});

async function dealOfStream(ctx: QueryCtx, orgId: Id<"organizations">, streamId: string): Promise<Doc<"deals"> | null> {
  const id = ctx.db.normalizeId("canonEntities", streamId);
  const entity = id ? await ctx.db.get(id) : null;
  if (!entity || entity.orgId !== orgId || entity.projectionTable !== "deals") return null;
  const dealId = ctx.db.normalizeId("deals", entity.projectionId);
  const deal = dealId ? await ctx.db.get(dealId) : null;
  return deal && deal.orgId === orgId ? deal : null;
}

/** The deals the meeting's people are on and its companies have, that the writer sees. */
export async function candidateDeals(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, contactIds: string[], companies: Company[]) {
  const byStream = new Map<string, CandidateDeal>();
  const add = (streamId: string, deal: Doc<"deals">, kind: "contact" | "company") => {
    if (!dealVisible(access, deal)) return;
    const c = byStream.get(streamId) ?? { streamId, dealId: deal._id, isClosed: deal.isClosed, updatedAt: deal.updatedAt, matchedContacts: 0, companyMatch: false };
    if (kind === "contact") c.matchedContacts += 1;
    else c.companyMatch = true;
    byStream.set(streamId, c);
  };
  for (const contactId of contactIds) {
    const edges = await ctx.db.query("associations")
      .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", orgId).eq("association", "deal_contact").eq("toId", contactId))
      .take(DEALS_PER_CONTACT);
    for (const e of edges) {
      if (!e.active) continue;
      const deal = await dealOfStream(ctx, orgId, e.fromId);
      if (deal) add(e.fromId, deal, "contact");
    }
  }
  for (const company of companies) {
    for (const deal of await dealsOfCompany(ctx, orgId, { companyId: company.id, ...(company.domain ? { domain: company.domain } : {}) })) {
      const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", deal._id)).first();
      if (entity) add(entity._id, deal, "company");
    }
  }
  return [...byStream.values()];
}

/**
 * Log one Granola meeting: a `meeting` activity, written as `userId`, about
 * the matched people, their companies and their open deal; the call recording
 * is linked to that deal. A note seen again (Granola regenerated its summary)
 * updates its meeting instead of adding a second, and so does a note of a
 * meeting the writer's calendar logged (lib/calendar/links.ts calendarMeetingFor).
 */
export const logMeeting = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    callId: v.id("callRecordings"),
    title: v.string(),
    startAt: v.number(),
    endAt: v.optional(v.number()),
    /** When the calendar had it (Granola's calendar_event): how a meeting the calendar logged is found. */
    scheduledStartAt: v.optional(v.number()),
    notes: v.string(),
    contactIds: v.array(v.string()),
    /** Register companies (acc_ ids) with their domains: a CRM-synced deal is found through its company's domain. */
    companies: v.array(v.object({ id: v.string(), domain: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<{ status: "logged" | "updated" | "skipped"; dealId: Id<"deals"> | null; reason?: string }> => {
    const user = await ctx.db.get(args.userId);
    const call = await ctx.db.get(args.callId);
    if (!user || user.orgId !== args.orgId || !user.isActive || !call || call.orgId !== args.orgId) {
      return { status: "skipped", dealId: null, reason: "writer or call is gone" };
    }
    const access = await accessFor(ctx, user);
    const deal = pickDeal(await candidateDeals(ctx, args.orgId, access, args.contactIds, args.companies));
    const accountIds = args.companies.map((c) => c.id);
    const metadata = (call.sourceMetadata ?? {}) as Record<string, unknown>;
    const values: Record<string, unknown> = {
      title: args.title.slice(0, 500),
      startAt: args.startAt,
      ...(args.endAt !== undefined && args.endAt > args.startAt ? { endAt: args.endAt } : {}),
      outcome: "completed",
      notes: args.notes,
      ...(args.contactIds[0] ? { contactId: args.contactIds[0] } : {}),
      ...(accountIds[0] ? { accountId: accountIds[0] } : {}),
      ...(deal ? { dealId: deal.streamId } : {}),
    };
    const targets = [...args.contactIds, ...accountIds, ...(deal ? [deal.streamId] : [])];
    const known = typeof metadata.meetingStreamId === "string" ? metadata.meetingStreamId
      : await calendarMeetingFor(ctx, user._id, args.scheduledStartAt ?? args.startAt, args.contactIds);

    const result = known
      ? await saveAsCaller(ctx, user, "meeting", { op: "update", streamId: known, values })
      : await saveAsCaller(ctx, user, "meeting", { op: "create", values: { ...values, ownerId: user._id } });
    if (result.status === "invalid" || result.status === "conflict") {
      return { status: "skipped", dealId: null, reason: result.status === "invalid" ? result.errors.map((e) => e.message).join("; ") : "conflict" };
    }
    await attachTargets(ctx, user, result.streamId, targets);
    await ctx.db.patch(call._id, {
      ownerId: user._id,
      ...(deal ? { dealId: deal.dealId as Id<"deals"> } : {}),
      sourceMetadata: { ...metadata, meetingStreamId: result.streamId, contactIds: args.contactIds, accountIds, ...(args.scheduledStartAt !== undefined ? { scheduledStartAt: args.scheduledStartAt } : {}) },
      updatedAt: Date.now(),
    });
    if (deal) await ctx.scheduler.runAfter(0, internal.dealState.onDeal, { dealId: deal.dealId as Id<"deals"> });
    return { status: known ? "updated" : "logged", dealId: deal ? (deal.dealId as Id<"deals">) : null };
  },
});
