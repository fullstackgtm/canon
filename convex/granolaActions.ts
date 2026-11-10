/**
 * Granola poll (every 15 minutes from crons.ts, on "Sync calls", and from the
 * scheduled-sync sweep): read the notes changed since the last poll, oldest
 * first, and for each one import its transcript into call intelligence, find
 * the people, company and open deal it was with, and log it on them. The key
 * is decrypted here and goes nowhere but Granola's Authorization header.
 *
 * Who each meeting is written as: the note's owner when they are a member of
 * the workspace, else the person who connected Granola. Their visibility
 * (CP14) bounds what the meeting is matched to, and their ChatGPT plan runs
 * the call's insight pass.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { principalClient, requireCaller } from "./records";
import { GRANOLA_STALE_POLL } from "./callIntelligence";
import { SUGGEST_VERSION } from "./lib/calls/suggestions";
import { decryptFromStorage } from "./lib/tokenHelpers";
import type { Access } from "./lib/access";
import { CALL_SYNC_STAGES } from "../engine/src/progress.ts";
import { syncRunProgressEmitter } from "./lib/syncRunProgress";
import {
  createGranolaClient, DAY_MS, externalParticipants, GranolaError, GRANOLA_NOTES_PER_POLL, GRANOLA_SEGMENTS_MAX, meetingNotes, TIMINGS_VERSION,
  type GranolaClient, type GranolaFolder, type GranolaMeeting,
} from "./lib/calls/granola";

/** Pause between polls while a backlog is read, to stay well under Granola's 5 requests a second. */
const CATCH_UP_DELAY_MS = 30_000;
/** Polls in a row a note may fail before the feed passes over it. */
const GRANOLA_NOTE_ATTEMPTS = 3;
/** People and companies a meeting is matched against, at most. */
const MATCH_MAX = 50;

type Trigger = "manual" | "scheduled" | "oauth" | "system";
type SyncState = { apiKey: string; baseUrl: string | null; cursor: string | null; window: number; lookbackDays: number; folderIds: string[]; suggestVersion: number; connectedBy: Id<"users"> | null; members: Array<{ userId: Id<"users">; email: string }> };
export type GranolaSyncResult = { calls: number; insights: number; meetingsLogged: number; linkedToDeals: number };

/** The register's contacts with these emails and companies with these domains (or theirs), as the writer sees them. */
async function matchRecords(ctx: ActionCtx, orgId: Id<"organizations">, access: Access, meeting: GranolaMeeting, memberEmails: string[]) {
  const { people, domains } = externalParticipants(meeting, memberEmails);
  if (!people.length) return { contactIds: [], companies: [] };
  const client = principalClient(ctx, orgId, [access]);
  const emails = people.slice(0, MATCH_MAX).map((p) => p.email);
  const [contacts, companies] = await Promise.all([
    client.listRegister(orgId, "contact", { filter: [{ field: "email", op: "in", value: emails }], limit: MATCH_MAX }),
    domains.length
      ? client.listRegister(orgId, "account", { filter: [{ field: "domain", op: "in", value: domains.slice(0, MATCH_MAX) }], limit: MATCH_MAX })
      : Promise.resolve({ rows: [] as Array<{ id: string; values: Record<string, unknown> }> }),
  ]);
  const byId = new Map<string, { id: string; domain?: string }>();
  for (const r of companies.rows) byId.set(r.id, { id: r.id, ...(typeof r.values.domain === "string" && r.values.domain ? { domain: r.values.domain } : {}) });
  for (const r of contacts.rows) if (r.accountId && !byId.has(r.accountId)) byId.set(r.accountId, { id: r.accountId });
  return { contactIds: contacts.rows.map((r) => r.id), companies: [...byId.values()] };
}

/** One meeting into Canon. Returns what it did, for the run's counts. */
async function importMeeting(ctx: ActionCtx, orgId: Id<"organizations">, state: SyncState, meeting: GranolaMeeting, accessOf: (userId: Id<"users">) => Promise<Access | null>) {
  const transcriptText = meeting.transcriptText || meeting.summary || "";
  if (!transcriptText.trim()) return null;
  const owner = meeting.owner ? state.members.find((m) => m.email === meeting.owner!.email) : undefined;
  const writer = owner?.userId ?? state.connectedBy;
  const access = writer ? await accessOf(writer) : null;

  const { callId } = await ctx.runMutation(internal.callIntelligence.importProviderTranscript, {
    orgId,
    provider: "granola",
    externalCallId: `granola:${meeting.noteId}`,
    granolaWindow: state.window,
    title: meeting.title,
    callDate: new Date(meeting.startAt).toISOString(),
    ...(meeting.durationSeconds !== null ? { durationSeconds: meeting.durationSeconds } : {}),
    ...(meeting.webUrl ? { recordingUrl: meeting.webUrl } : {}),
    participants: [
      ...(meeting.owner ? [{ name: meeting.owner.name, email: meeting.owner.email, role: "owner" }] : []),
      ...meeting.attendees.map((p) => ({ name: p.name, email: p.email, role: "attendee" })),
    ],
    transcriptText,
    // The sides and times of the transcript's lines; a summary standing in for a transcript has none.
    ...(meeting.transcriptText && meeting.segments.length <= GRANOLA_SEGMENTS_MAX ? { segments: meeting.segments } : {}),
    sourceMetadata: { provider: "granola", noteId: meeting.noteId, webUrl: meeting.webUrl, summary: meeting.summary, updatedAt: meeting.updatedAt, timings: TIMINGS_VERSION },
  });

  let logged: { status: string; dealId: Id<"deals"> | null } | null = null;
  if (writer && access) {
    const match = await matchRecords(ctx, orgId, access, meeting, state.members.map((m) => m.email));
    if (match.contactIds.length || match.companies.length) {
      logged = await ctx.runMutation(internal.granola.logMeeting, {
        orgId, userId: writer, callId,
        title: meeting.title, startAt: meeting.startAt, ...(meeting.endAt !== null ? { endAt: meeting.endAt } : {}),
        ...(meeting.scheduledStartAt !== null ? { scheduledStartAt: meeting.scheduledStartAt } : {}),
        notes: meetingNotes(meeting), contactIds: match.contactIds, companies: match.companies,
      });
    }
  }
  const analysis: { insights: number } = await ctx.runMutation(internal.callIntelligence.analyzeImportedCall, {
    orgId, callId, ...(writer ? { userId: writer } : {}),
  });
  // What the meeting changed (recent meetings) and what it suggests adding (lib/calls/suggestions.ts): convex/callFactActions.ts decides.
  if (writer) await ctx.scheduler.runAfter(0, internal.callFactActions.propose, { orgId, callId, userId: writer });
  return { insights: analysis.insights, logged: logged?.status === "logged" || logged?.status === "updated", linked: Boolean(logged?.dealId) };
}

async function syncGranola(ctx: ActionCtx, orgId: Id<"organizations">, trigger: Trigger): Promise<GranolaSyncResult> {
  const syncRunId: Id<"integrationSyncRuns"> = await ctx.runMutation(internal.integrations.startSyncRun, { orgId, provider: "granola", trigger });
  await ctx.runMutation(internal.callProviders.updateSyncStatus, { orgId, provider: "granola", status: "in_progress" });
  const progress = syncRunProgressEmitter(ctx, syncRunId);
  const result: GranolaSyncResult = { calls: 0, insights: 0, meetingsLogged: 0, linkedToDeals: 0 };
  let stoppedEarly: string | undefined;
  let skipped: string | undefined;
  try {
    const state: SyncState | null = await ctx.runQuery(internal.granola.syncState, { orgId });
    if (!state) throw new Error("Granola is not connected. Add your API key in Integrations.");
    const granola = createGranolaClient({ apiKey: await decryptFromStorage(state.apiKey), ...(state.baseUrl ? { baseUrl: state.baseUrl } : {}) });
    const accesses = new Map<Id<"users">, Access | null>();
    const accessOf = async (userId: Id<"users">) => {
      if (!accesses.has(userId)) accesses.set(userId, await ctx.runQuery(internal.granola.writerAccess, { orgId, userId }));
      return accesses.get(userId) ?? null;
    };

    // Meetings read under an older suggestion version are read again, once.
    if (state.suggestVersion < SUGGEST_VERSION) {
      await ctx.runMutation(internal.granola.markSuggestVersion, { orgId, version: SUGGEST_VERSION });
      await recheckMeetings(ctx, orgId);
    }
    progress.stage(CALL_SYNC_STAGES[0], 0, CALL_SYNC_STAGES.length); // notes
    const since = state.cursor ?? new Date(Date.now() - state.lookbackDays * DAY_MS).toISOString();
    const refs = await granola.changedNotes(since, GRANOLA_NOTES_PER_POLL, state.folderIds);
    progress.stage(CALL_SYNC_STAGES[1], 1, CALL_SYNC_STAGES.length); // transcripts
    let done = 0;
    for (const ref of refs) {
      // Disconnected, or a longer lookback started over, since this poll began: stop writing.
      if (!(await ctx.runQuery(internal.granola.stillCurrent, { orgId, window: state.window }))) break;
      try {
        const meeting = await granola.meeting(ref.id);
        const r = meeting ? await importMeeting(ctx, orgId, state, meeting, accessOf) : null;
        if (r) {
          result.calls += 1;
          result.insights += r.insights;
          if (r.logged) result.meetingsLogged += 1;
          if (r.linked) result.linkedToDeals += 1;
        }
      } catch (cause) {
        // Granola refusing the key or throttling stops the poll; the next one resumes from the last finished note.
        if (cause instanceof GranolaError) {
          stoppedEarly = cause.message;
          break;
        }
        // Disconnected, switching folders, or started over since this poll began: it writes nothing more.
        if (cause instanceof ConvexError && (cause.data as { kind?: string } | undefined)?.kind === GRANOLA_STALE_POLL) break;
        // Anything else stops here too, so the next poll retries this note. A note that fails
        // GRANOLA_NOTE_ATTEMPTS polls running is passed over, so one bad note never stalls the feed.
        console.error(`granola note ${ref.id} for ${orgId} failed`, cause instanceof Error ? cause.message : cause);
        const attempts: number = await ctx.runMutation(internal.granola.noteFailed, { orgId, noteId: ref.id, window: state.window });
        if (attempts < GRANOLA_NOTE_ATTEMPTS) {
          stoppedEarly = "A meeting could not be imported. The next check retries it.";
          break;
        }
        skipped = `Skipped Granola note ${ref.id} after ${attempts} failed attempts.`;
      }
      await ctx.runMutation(internal.granola.saveCursor, { orgId, cursor: ref.updatedAt, noteId: ref.id, window: state.window });
      progress.items(++done, refs.length);
    }
    progress.flush();
    // A full page of notes means more are waiting (a backfill, or a busy day): read on shortly instead of in 15 minutes.
    const more = !stoppedEarly && refs.length === GRANOLA_NOTES_PER_POLL;
    if (!stoppedEarly && !more) await restoreTimings(ctx, orgId, state.window, granola);
    await ctx.runMutation(internal.granola.setCatchingUp, { orgId, catchingUp: more, imported: result.calls, ...(stoppedEarly ? { stopped: stoppedEarly } : {}) });
    if (more) await ctx.scheduler.runAfter(CATCH_UP_DELAY_MS, internal.granolaActions.syncOrg, { orgId, trigger: "system" });
    stoppedEarly ??= skipped;
    const status = stoppedEarly ? "partial" : "success";
    await ctx.runMutation(internal.integrations.finishSyncRun, {
      syncRunId, status, counts: { calls: result.calls, insights: result.insights, meetingsLogged: result.meetingsLogged, linkedToDeals: result.linkedToDeals },
      ...(stoppedEarly ? { error: stoppedEarly } : {}),
    });
    await ctx.runMutation(internal.callProviders.updateSyncStatus, {
      orgId, provider: "granola", status, callCount: result.calls, ...(stoppedEarly ? { error: stoppedEarly } : {}),
    });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The Granola sync failed. It retries in 15 minutes.";
    await ctx.runMutation(internal.integrations.finishSyncRun, { syncRunId, status: "error", counts: { calls: result.calls, insights: result.insights }, error: message });
    await ctx.runMutation(internal.callProviders.updateSyncStatus, { orgId, provider: "granola", status: "error", error: message, callCount: result.calls });
    throw cause;
  }
}

export const syncOrg = internalAction({
  args: { orgId: v.id("organizations"), trigger: v.union(v.literal("manual"), v.literal("scheduled"), v.literal("oauth"), v.literal("system")) },
  handler: (ctx, args): Promise<GranolaSyncResult> => syncGranola(ctx, args.orgId, args.trigger),
});

/** Every connected org's poll, each in its own action so one slow or failing workspace holds up no other. */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.runQuery(internal.granola.duePolls, { now: Date.now() });
    for (const orgId of orgs) await ctx.scheduler.runAfter(0, internal.granolaActions.syncOrg, { orgId, trigger: "scheduled" });
  },
});

/** Connect Granola: the key is checked against the live API, then stored encrypted, and the first poll starts. */
export const connect = action({
  args: { apiKey: v.string(), lookbackDays: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await requireCaller(ctx);
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new ConvexError("Paste your Granola API key.");
    try {
      await createGranolaClient({ apiKey }).changedNotes(new Date().toISOString(), 1);
    } catch (cause) {
      if (cause instanceof GranolaError) throw new ConvexError(cause.message);
      throw cause;
    }
    await ctx.runMutation(internal.granola.storeKey, {
      orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, apiKey,
      ...(args.lookbackDays !== undefined ? { lookbackDays: args.lookbackDays } : {}),
    });
    return { ok: true };
  },
});

/** "Check now" on the card. */
export const syncNow = action({
  args: {},
  handler: async (ctx): Promise<GranolaSyncResult> => {
    const caller = await requireCaller(ctx);
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    try {
      return await syncGranola(ctx, caller.orgId as Id<"organizations">, "manual");
    } catch (cause) {
      throw new ConvexError(cause instanceof Error ? cause.message : "The Granola sync failed");
    }
  },
});

/** Meetings imported before Canon kept segment times that one poll reads again for them. */
const TIMINGS_PER_POLL = 10;

/**
 * Meetings imported before Canon kept each line's side and times get them from Granola, a few each quiet poll,
 * newest first. A refused key or throttling stops it until the next poll; any other failure marks the call done.
 */
async function restoreTimings(ctx: ActionCtx, orgId: Id<"organizations">, window: number, granola: GranolaClient) {
  const targets: Array<{ callId: Id<"callRecordings">; noteId: string }> = await ctx.runQuery(internal.granola.timingTargets, { orgId, limit: TIMINGS_PER_POLL });
  for (const t of targets) {
    let meeting: GranolaMeeting | null = null;
    try {
      meeting = await granola.meeting(t.noteId);
    } catch (cause) {
      if (cause instanceof GranolaError) return;
      console.error(`granola timings for note ${t.noteId} failed`, cause instanceof Error ? cause.message : cause);
    }
    const segments = meeting && meeting.segments.length <= GRANOLA_SEGMENTS_MAX ? meeting.segments : [];
    try {
      await ctx.runMutation(internal.callIntelligence.keepTimings, {
        orgId, callId: t.callId, granolaWindow: window, transcriptText: meeting?.transcriptText || null, segments,
      });
    } catch (cause) {
      if (cause instanceof ConvexError && (cause.data as { kind?: string } | undefined)?.kind === GRANOLA_STALE_POLL) return;
      throw cause;
    }
  }
}

/** Pause between re-checked meetings, so a re-check of many meetings spreads out its model calls. */
const RECHECK_SPACING_MS = 20_000;

/** Check imported meetings again for suggestions, spread out; returns how many. */
async function recheckMeetings(ctx: ActionCtx, orgId: Id<"organizations">): Promise<number> {
  const targets = await ctx.runQuery(internal.granola.recheckTargets, { orgId });
  for (const [i, t] of targets.entries()) {
    await ctx.scheduler.runAfter(i * RECHECK_SPACING_MS, internal.callFactActions.propose, { orgId, callId: t.callId, userId: t.userId });
  }
  return targets.length;
}

/** After the team list or the members-only option changed. */
export const recheckOrg = internalAction({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args): Promise<number> => recheckMeetings(ctx, args.orgId),
});

/** "Re-check imported meetings" on the Granola page. */
export const recheck = action({
  args: {},
  handler: async (ctx): Promise<{ meetings: number }> => {
    const caller = await requireCaller(ctx);
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    return { meetings: await recheckMeetings(ctx, caller.orgId as Id<"organizations">) };
  },
});

/** The Granola folders the workspace's key can read, for choosing which to import. */
export const folders = action({
  args: {},
  handler: async (ctx): Promise<GranolaFolder[]> => {
    const caller = await requireCaller(ctx, { read: true });
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const state: SyncState | null = await ctx.runQuery(internal.granola.syncState, { orgId: caller.orgId as Id<"organizations"> });
    if (!state) throw new ConvexError("Connect Granola first");
    try {
      return await createGranolaClient({ apiKey: await decryptFromStorage(state.apiKey), ...(state.baseUrl ? { baseUrl: state.baseUrl } : {}) }).folders();
    } catch (cause) {
      if (cause instanceof GranolaError) throw new ConvexError(cause.message);
      throw cause;
    }
  },
});
