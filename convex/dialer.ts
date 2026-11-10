/**
 * The dialer (docs/dialer.md): a rep starts a session, Telnyx rings the rep's
 * own phone, and each contact the rep dials is bridged onto that call. The
 * call flow is the pure reducer in lib/dialer/bridge.ts; this file holds the
 * rows, the number lock and the effects. The Telnyx calls are in
 * convex/dialerActions.ts, and the signed webhook lands in `applyEvent`.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { readPolicy, writePolicy } from "./lib/recordingPolicy";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accessFor, sightJudge } from "./permissions";
import { callerClient, requireCaller } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser, withRole } from "./lib";
import {
  MAX_LINES, OUTCOMES, SESSION_TTL_MS, dialProblem, isLiveCall, isLiveSession, reduceAgentEvent, reduceContactEvent, rivalsToHangUp,
  type CallView, type Command, type Effects, type Outcome, type Seat, type SessionView,
} from "./lib/dialer/bridge";
import { sipUriFor, toE164, type LegState } from "./lib/dialer/telnyx";
import { callerOutreachPurpose, setSuppression, suppressionFor, suppressionRow } from "./lib/suppressions/store";
import { callingHoursProblem } from "./lib/dialer/hours";
import { convexSiteUrl, isLoopback } from "./linkedinActions";
import { saveAsCaller } from "./objects";
import { attachTargets } from "./activityTargets";
import { pickCallable, type Candidate } from "./lib/dialer/candidates";
import { canSee as canSeeAudience } from "./audiences";
export { CANDIDATES_MAX } from "./lib/dialer/candidates";

const NUMBERS_MAX = 50;
const RECENT_CALLS = 10;
const NOTES_MAX = 4000;
const INSIGHTS_SHOWN = 8;
const SESSION_CALLS_MAX = 1000;
const REAP_BATCH = 50;
const TRANSCRIPT_SHOWN = 20_000;

/** A local stack (loopback Convex site) never places a real call: dialerActions.ts simulates Telnyx. */
export const isLocalStack = () => isLoopback(convexSiteUrl());


export const telnyxConfigured = () => integrationEnabled("dialer");

const outcomeValidator = v.union(...OUTCOMES.map((o) => v.literal(o)));
export const campaignValidator = v.object({ audienceId: v.string(), name: v.string() });
export type Campaign = Infer<typeof campaignValidator>;

async function resolveCampaign(ctx: QueryCtx, user: Doc<"users">, campaign?: Campaign) {
  if (!campaign) return null;
  const id = ctx.db.normalizeId("audiences", campaign.audienceId);
  const audience = id ? await ctx.db.get(id) : null;
  const viewer = await withRole(ctx, user);
  if (!audience || !viewer || !canSeeAudience(viewer, audience)) throw new ConvexError("This call campaign is no longer available.");
  return { audienceId: audience._id, name: audience.name };
}

const isAdmin = (user: Doc<"users">) => can(user, "workspace.edit");

const sessionView = (s: Doc<"dialerSessions">): SessionView => ({
  status: s.status, agentLegId: s.agentLegId ?? null, currentCallId: s.currentCallId ?? null, expiresAt: s.expiresAt,
  racing: s.race?.length ?? 0,
});

const callView = (c: Doc<"dialerCalls">): CallView => ({
  state: c.state, legId: c.legId ?? null, answeredAt: c.answeredAt ?? null, transcriptStatus: c.transcriptStatus,
  recordingId: c.recordingId ?? null, machine: c.machine ?? null,
  detectMachine: c.detectMachine === true, voicemail: c.voicemail ?? null, voicemailStarted: c.voicemailStarted === true, voicemailLeft: c.voicemailLeft === true,
  abandoned: c.abandoned === true, record: c.record !== false, recordingStarted: c.recordingStarted === true,
});

async function latestSession(ctx: QueryCtx, userId: Id<"users">) {
  return ctx.db.query("dialerSessions").withIndex("by_userId_and_startedAt", (q) => q.eq("userId", userId)).order("desc").first();
}

/** The caller's live session in this org, if any. */
async function liveSession(ctx: QueryCtx, user: Doc<"users">, now: number) {
  const s = await latestSession(ctx, user._id);
  return s && s.orgId === user.orgId && isLiveSession(s, now) ? s : null;
}

async function numberIsFree(ctx: QueryCtx, n: Doc<"dialerNumbers">, now: number) {
  if (!n.heldBySessionId) return true;
  const holder = await ctx.db.get(n.heldBySessionId);
  return !holder || !isLiveSession(holder, now);
}

async function releaseNumber(ctx: MutationCtx, session: Doc<"dialerSessions">) {
  const n = await ctx.db.get(session.numberId);
  if (n && n.heldBySessionId === session._id) await ctx.db.patch(n._id, { heldBySessionId: undefined });
}

// ───────────────────────────── Reads ─────────────────────────────

/** The dialer as the caller sees it: whether it's set up, the workspace's numbers, and their own session. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const numbers = await ctx.db.query("dialerNumbers").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(NUMBERS_MAX);
    const last = await latestSession(ctx, user._id);
    const session = last && last.orgId === user.orgId && isLiveSession(last, now) ? last : null;
    const current = session?.currentCallId ? await ctx.db.get(session.currentCallId) : null;
    // The session's last call, while the rep hasn't confirmed its outcome: power dialing logs it, then dials on.
    const lastCall = session && !current && session.lastCallId ? await ctx.db.get(session.lastCallId) : null;
    const awaiting = lastCall && lastCall.state === "ended" && !lastCall.confirmed ? lastCall : null;
    return {
      configured: telnyxConfigured(),
      record: await recordsCalls(ctx, user.orgId),
      simulated: isLocalStack(),
      canManage: isAdmin(user),
      canManageRecording: can(user, "recording.manage"),
      numbers: await Promise.all(numbers.map(async (n) => ({ _id: n._id, number: n.number, label: n.label ?? null, free: await numberIsFree(ctx, n, now) }))),
      // The last phone number used (a browser session's SIP address isn't one to offer back).
      lastAgentPhone: last && last.audio !== "browser" ? last.agentPhone : null,
      lastAudio: last?.audio ?? "phone",
      lastError: last && !session && last.status === "failed" && now - (last.endedAt ?? last.startedAt) < 10 * 60_000 ? last.error ?? null : null,
      session: session && {
        _id: session._id, status: session.status, from: session.from, agentPhone: session.agentPhone, startedAt: session.startedAt,
        audio: session.audio ?? "phone",
      },
      // Who this session has dialed and when, so a list being worked shows who is next.
      called: session ? (await ctx.db.query("dialerCalls").withIndex("by_sessionId", (q) => q.eq("sessionId", session._id)).take(SESSION_CALLS_MAX))
        .map((c) => ({ contactId: c.contactId, at: c.startedAt })) : [],
      racing: session ? (await raceCalls(ctx, session)).map((c) => ({ _id: c._id, contactName: c.contactName, to: c.to, state: c.state })) : [],
      awaitingOutcome: awaiting && {
        _id: awaiting._id, contactId: awaiting.contactId, contactName: awaiting.contactName, outcome: awaiting.outcome ?? null, durationSeconds: awaiting.durationSeconds ?? null,
      },
      currentCall: current && {
        _id: current._id, contactId: current.contactId, contactName: current.contactName, to: current.to, state: current.state, answeredAt: current.answeredAt ?? null,
        // Answered, but detection hasn't said who: the rep hears nothing yet.
        screening: current.detectMachine === true && current.state === "answered" && current.machine === undefined,
        machine: current.machine === true,
      },
    };
  },
});

/** A contact's recent dialer calls, with the recording and the transcript's state. */
export const contactCalls = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    // A role that sees only some people: null, and the page asks contactCallsScoped (CP14).
    const r = await contactCallsAs(ctx, user, args.contactId, new Set());
    return r.pending.length ? null : r.value;
  },
});

export const contactCallsFor = internalQuery({
  args: { contactId: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? contactCallsAs(ctx, user, args.contactId, new Set(args.admitted)) : { pending: [], value: [] };
  },
});

/** contactCalls for a role that sees only some people: the contact is admitted through the caller's scoped client. */
export const contactCallsScoped = action({
  args: { contactId: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof contactCallsAs>>["value"]> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.dialer.contactCallsFor, { ...args, admitted }));
  },
});

/** A contact's calls as `user` may see them: only a contact their role sees (permissions.sightJudge). */
async function contactCallsAs(ctx: QueryCtx, user: Doc<"users">, contactId: string, admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
  if (!judge.record("contact", contactId)) return { pending: judge.pending, value: [] };
  const args = { contactId };
  {
    const rows = await ctx.db.query("dialerCalls")
      .withIndex("by_orgId_and_contactId", (q) => q.eq("orgId", user.orgId).eq("contactId", args.contactId))
      .order("desc").take(RECENT_CALLS);
    const calls = await Promise.all(rows.map(async (c) => {
      const recording = c.callRecordingId ? await ctx.db.get(c.callRecordingId) : null;
      const insights = recording
        ? await ctx.db.query("callInsights").withIndex("by_callId", (q) => q.eq("callId", recording._id)).take(INSIGHTS_SHOWN)
        : [];
      return {
      _id: c._id,
      userId: c.userId,
      mine: c.userId === user._id,
      to: c.to,
      state: c.state,
      startedAt: c.startedAt,
      durationSeconds: c.durationSeconds ?? null,
      outcome: c.outcome ?? null,
      confirmed: c.confirmed === true,
      notes: c.notes ?? null,
      error: c.error ?? null,
      transcriptStatus: c.transcriptStatus,
      recordingUrl: c.recordingStorageId ? await ctx.storage.getUrl(c.recordingStorageId) : null,
      transcript: recording?.transcriptText?.slice(0, TRANSCRIPT_SHOWN) ?? null,
      insightStatus: recording?.insightStatus ?? null,
      insights: insights.map((i) => ({ _id: i._id, type: i.type, title: i.title, evidence: i.evidence })),
      };
    }));
    return { pending: [], value: calls };
  }
}

// ───────────────────────────── Numbers ─────────────────────────────

/** Add a number the workspace bought in Telnyx and assigned to Canon's Call Control app. */
export const addNumber = mutation({
  args: { number: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!isAdmin(user)) throw new ConvexError(refusal("workspace.edit"));
    const number = toE164(args.number);
    if (!number) throw new ConvexError("Enter the number in international format, like +14155550123.");
    const taken = await ctx.db.query("dialerNumbers").withIndex("by_number", (q) => q.eq("number", number)).first();
    if (taken) throw new ConvexError(taken.orgId === user.orgId ? `${number} is already added.` : `${number} belongs to another workspace.`);
    const count = (await ctx.db.query("dialerNumbers").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(NUMBERS_MAX)).length;
    if (count >= NUMBERS_MAX) throw new ConvexError(`A workspace can have ${NUMBERS_MAX} dialer numbers.`);
    const label = args.label?.trim().slice(0, 60);
    return ctx.db.insert("dialerNumbers", { orgId: user.orgId, number, ...(label ? { label } : {}), addedBy: user._id, addedAt: Date.now() });
  },
});

export const removeNumber = mutation({
  args: { numberId: v.id("dialerNumbers") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!isAdmin(user)) throw new ConvexError(refusal("workspace.edit"));
    const n = await ctx.db.get(args.numberId);
    if (!n || n.orgId !== user.orgId) throw new ConvexError("Number not found");
    if (!(await numberIsFree(ctx, n, Date.now()))) throw new ConvexError(`${n.number} is in a live dialing session. Remove it when the session ends.`);
    await ctx.db.delete(n._id);
  },
});

// ───────────────────────────── Sessions ─────────────────────────────

/**
 * Start dialing: claim a free number (the lock), open the session, and have
 * Telnyx ring the rep's phone. Claiming and opening are one transaction, so
 * two reps can't take the same number.
 */
export const startSession = mutation({
  args: { agentPhone: v.optional(v.string()), numberId: v.optional(v.id("dialerNumbers")), audio: v.optional(v.union(v.literal("phone"), v.literal("browser"))) },
  handler: async (ctx, args): Promise<Id<"dialerSessions">> => {
    const user = await requireUser(ctx);
    if (!telnyxConfigured()) throw new ConvexError("Calling isn't set up on this deployment yet (TELNYX_API_KEY and TELNYX_CONNECTION_ID).");
    const audio = args.audio ?? "phone";
    let agentPhone: string | null;
    if (audio === "browser") {
      // The browser asked for its token first (dialerActions.browserToken), which made the credential.
      const credential = await credentialOf(ctx, user._id, user.orgId);
      if (!credential) throw new ConvexError("Browser audio isn't ready yet. Allow the microphone and try again.");
      agentPhone = sipUriFor(credential.sipUsername);
    } else {
      agentPhone = toE164(args.agentPhone);
      if (!agentPhone) throw new ConvexError("Enter your phone number in international format, like +14155550123.");
    }
    const now = Date.now();
    const live = await liveSession(ctx, user, now);
    if (live) return live._id;

    const numbers = await ctx.db.query("dialerNumbers").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(NUMBERS_MAX);
    if (numbers.length === 0) throw new ConvexError("Your workspace has no dialer numbers yet. An admin adds them under Integrations → Dialer.");
    if (numbers.some((n) => n.number === agentPhone)) throw new ConvexError("That's one of the workspace's dialer numbers. Enter the phone you'll answer on.");
    const wanted = args.numberId ? numbers.filter((n) => n._id === args.numberId) : numbers;
    let picked: Doc<"dialerNumbers"> | null = null;
    for (const n of wanted) if (await numberIsFree(ctx, n, now)) { picked = n; break; }
    if (!picked) {
      throw new ConvexError(args.numberId ? "That number is in another rep's session. Pick another." : "Every dialer number is in use. Try again when a session ends, or add a number.");
    }

    const sessionId = await ctx.db.insert("dialerSessions", {
      orgId: user.orgId, userId: user._id, numberId: picked._id, from: picked.number, agentPhone,
      status: "calling_agent", startedAt: now, expiresAt: now + SESSION_TTL_MS, ...(audio === "browser" ? { audio } : {}),
    });
    await ctx.db.patch(picked._id, { heldBySessionId: sessionId });
    await ctx.scheduler.runAfter(0, internal.dialerActions.dialAgent, { sessionId });
    return sessionId;
  },
});

/** End the caller's session: hang up their phone (Telnyx's hangup webhook closes it), or close it now if it never connected. */
export const endSession = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const session = await liveSession(ctx, user, Date.now());
    if (!session) return;
    if (session.agentLegId) {
      await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command: { op: "hangup", legId: session.agentLegId } });
      return;
    }
    await ctx.db.patch(session._id, { status: "ended", endedAt: Date.now() });
    await releaseNumber(ctx, session);
  },
});

/** Hang up the contact; the rep's phone stays on the line for the next call. */
export const hangupCall = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const session = await liveSession(ctx, user, Date.now());
    if (session && !session.currentCallId && session.race?.length) {
      // Lines still racing: hang them all up; each leg's own hangup closes its call.
      for (const c of await raceCalls(ctx, session)) {
        if (c.legId) await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command: { op: "hangup", legId: c.legId } });
        else {
          await ctx.db.patch(c._id, { state: "failed", endedAt: Date.now(), error: "Hung up before it connected" });
          await leaveRace(ctx, c);
        }
      }
      return;
    }
    const call = session?.currentCallId ? await ctx.db.get(session.currentCallId) : null;
    if (!session || !call) return;
    if (call.legId) {
      await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command: { op: "hangup", legId: call.legId } });
      return;
    }
    // Telnyx hasn't returned the leg yet: mark it failed, and dialContact hangs up the leg it gets back.
    await ctx.db.patch(call._id, { state: "failed", endedAt: Date.now(), error: "Hung up before it connected" });
    await ctx.db.patch(session._id, { currentCallId: undefined });
  },
});

/** The rep's outcome and notes for a finished call; they update its `call` activity. */
export const setOutcome = mutation({
  args: { callId: v.id("dialerCalls"), outcome: outcomeValidator, notes: v.optional(v.string()), doNotCall: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== user.orgId || call.userId !== user._id) throw new ConvexError("Call not found");
    if (isLiveCall(call.state)) throw new ConvexError("Hang up first, then log the outcome.");
    // The contact asked not to be called again: the workspace never dials this number again.
    if (args.doNotCall) await addToDoNotCall(ctx, user, call.to, call.contactId, "Asked not to be called");
    const notes = args.notes?.trim().slice(0, NOTES_MAX);
    await ctx.db.patch(call._id, { outcome: args.outcome, notes: notes || undefined, confirmed: true });
    if (call.activityStreamId) {
      await saveAsCaller(ctx, user, "call", {
        op: "update", streamId: call.activityStreamId, values: { outcome: args.outcome, notes: notes ?? "" },
      });
    } else {
      await logActivity(ctx, call, args.outcome, call.durationSeconds ?? 0, notes);
    }
  },
});

// ───────────────────────────── Internal ─────────────────────────────

/**
 * A contact call, claimed in the caller's live session before Telnyx dials
 * (dialerActions.callContact). The number comes from Canon's contact record.
 */
export const claimCall = internalMutation({
  args: {
    userId: v.id("users"), orgId: v.id("organizations"), contactId: v.string(), accountId: v.optional(v.string()), contactName: v.string(), to: v.string(),
    campaign: v.optional(campaignValidator), since: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ callId: Id<"dialerCalls">; from: string; agentLegId: string; sessionId: Id<"dialerSessions">; detectMachine: boolean }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Not authenticated");
    const now = Date.now();
    const session = await liveSession(ctx, user, now);
    if (!session) throw new ConvexError("Start a dialing session first.");
    const problem = dialProblem(sessionView(session), now);
    if (problem) throw new ConvexError(problem);
    const n = await ctx.db.get(session.numberId);
    if (!n || n.heldBySessionId !== session._id) throw new ConvexError("This session lost its number. End it and start again.");
    const blocked = await complianceProblem(ctx, args.orgId, args.to, now);
    if (blocked) throw new ConvexError(blocked);
    const profile = await profileOf(ctx, args.userId, args.orgId);
    const campaign = await resolveCampaign(ctx, user, args.campaign);
    if (args.since !== undefined && (await calledInSession(ctx, session._id, args.since)).has(args.contactId)) throw new ConvexError("That person has already been called from this queue.");
    const detectMachine = profile?.detectVoicemail === true;
    const voicemail = detectMachine ? profile?.voicemailMessage : undefined;
    const record = await recordsCalls(ctx, args.orgId);
    const callId = await ctx.db.insert("dialerCalls", {
      orgId: args.orgId, userId: args.userId, sessionId: session._id, contactId: args.contactId,
      ...(args.accountId ? { accountId: args.accountId } : {}), contactName: args.contactName, to: args.to, from: session.from,
      state: "dialing", startedAt: now, transcriptStatus: "none",
      ...(detectMachine ? { detectMachine } : {}), ...(voicemail ? { voicemail } : {}),
      record, ...(campaign ? { audienceId: campaign.audienceId } : {}),
    });
    await ctx.db.patch(session._id, { currentCallId: callId, queueAudienceId: campaign?.audienceId, queueName: campaign?.name });
    return { callId, from: session.from, agentLegId: session.agentLegId!, sessionId: session._id, detectMachine };
  },
});

/** Telnyx answered the dial request: keep the leg id. Returns false when the rep already hung up. */
export const dialed = internalMutation({
  args: { callId: v.id("dialerCalls"), legId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const call = await ctx.db.get(args.callId);
    if (!call) return false;
    if (!call.legId) await ctx.db.patch(call._id, { legId: args.legId });
    const session = await ctx.db.get(call.sessionId);
    // A racing line whose dial came back after another line took the rep has lost: hang it up.
    const lost = !!session?.currentCallId && session.currentCallId !== call._id && call.state !== "answered";
    return isLiveCall(call.state) && !!session && isLiveSession(session, Date.now()) && !lost;
  },
});

/** A leg Telnyx refused to place. */
export const dialFailed = internalMutation({
  args: { sessionId: v.id("dialerSessions"), callId: v.optional(v.id("dialerCalls")), error: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    const now = Date.now();
    if (args.callId) {
      const call = await ctx.db.get(args.callId);
      if (call && isLiveCall(call.state)) {
        await ctx.db.patch(call._id, { state: "failed", endedAt: now, error: args.error });
        await leaveRace(ctx, call);
      }
      if (session.currentCallId === args.callId) await ctx.db.patch(session._id, { currentCallId: undefined, lastCallId: args.callId });
      return;
    }
    if (session.status === "calling_agent") {
      await ctx.db.patch(session._id, { status: "failed", error: args.error, endedAt: now });
      await releaseNumber(ctx, session);
    }
  },
});

/** Telnyx placed the call to the rep's phone. Returns false when the rep ended the session meanwhile. */
export const agentDialed = internalMutation({
  args: { sessionId: v.id("dialerSessions"), legId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return false;
    if (!session.agentLegId) await ctx.db.patch(session._id, { agentLegId: args.legId });
    return isLiveSession(session, Date.now());
  },
});

export const sessionForDial = internalQuery({
  args: { sessionId: v.id("dialerSessions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.sessionId);
    return s ? { agentPhone: s.agentPhone, from: s.from, status: s.status } : null;
  },
});

export const recordingFor = internalQuery({
  args: { callId: v.id("dialerCalls") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.callId);
    return c ? { recordingStorageId: c.recordingStorageId ?? null } : null;
  },
});

export const storeRecording = internalMutation({
  args: { callId: v.id("dialerCalls"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.callId);
    if (!c || c.recordingStorageId) {
      await ctx.storage.delete(args.storageId);
      return;
    }
    await ctx.db.patch(c._id, { recordingStorageId: args.storageId });
  },
});

/** The finished call as a `call` activity on the contact, written as the rep. */
async function logActivity(ctx: MutationCtx, call: Doc<"dialerCalls">, outcome: Outcome, durationSeconds: number, notes?: string) {
  const user = await ctx.db.get(call.userId);
  if (!user) return;
  const result = await saveAsCaller(ctx, { ...user, orgId: call.orgId }, "call", {
    op: "create",
    values: {
      subject: `Call with ${call.contactName}`,
      direction: "outbound",
      outcome,
      callAt: call.startedAt,
      durationSeconds,
      ownerId: call.userId,
      contactId: call.contactId,
      ...(call.accountId ? { accountId: call.accountId } : {}),
      ...(notes ? { notes } : {}),
    },
  });
  if (result.status === "applied" || result.status === "proposed") {
    await ctx.db.patch(call._id, { activityStreamId: result.streamId as Id<"canonEntities"> });
    await attachTargets(ctx, { ...user, orgId: call.orgId }, result.streamId, [call.contactId, ...(call.accountId ? [call.accountId] : [])]);
  }
}

/** Hand the transcript to call intelligence, which extracts insights and refines them with the LLM pass. */
async function importTranscript(ctx: MutationCtx, call: Doc<"dialerCalls">, text: string) {
  const { callId } = await ctx.runMutation(internal.callIntelligence.importProviderTranscript, {
    orgId: call.orgId,
    provider: "telnyx",
    externalCallId: `dialer:${call._id}`,
    title: `Call with ${call.contactName}`,
    callDate: new Date(call.startedAt).toISOString(),
    ...(call.durationSeconds !== undefined ? { durationSeconds: call.durationSeconds } : {}),
    transcriptText: text,
    sourceMetadata: { dialerCallId: call._id, contactId: call.contactId, ...(call.accountId ? { accountId: call.accountId } : {}), userId: call.userId },
  });
  await ctx.db.patch(call._id, { callRecordingId: callId });
  await ctx.runMutation(internal.callIntelligence.analyzeImportedCall, { orgId: call.orgId, callId });
}

/** Commands that call Telnyx run in dialerActions.run; the rest are database work done here. */
async function runCommands(ctx: MutationCtx, commands: readonly Command[], call: Doc<"dialerCalls"> | null) {
  for (const command of commands) {
    switch (command.op) {
      case "speak":
      case "hangup":
      case "bridge":
      case "record":
        await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command });
        break;
      case "saveRecording":
        if (call) await ctx.scheduler.runAfter(0, internal.dialerActions.saveRecording, { callId: call._id, recordingId: command.recordingId });
        break;
      case "importTranscript":
        if (call) await importTranscript(ctx, (await ctx.db.get(call._id)) ?? call, command.text);
        break;
      case "logActivity":
        if (call) await logActivity(ctx, (await ctx.db.get(call._id)) ?? call, command.outcome, command.durationSeconds);
        break;
    }
  }
}

function patchOf<T extends Record<string, unknown>>(patch: T): T {
  // Convex drops a field patched to undefined; a null from the reducer means "clear it".
  return Object.fromEntries(Object.entries(patch).map(([k, val]) => [k, val === null ? undefined : val])) as T;
}

async function applyEffects(ctx: MutationCtx, effects: Effects, session: Doc<"dialerSessions"> | null, call: Doc<"dialerCalls"> | null) {
  const now = Date.now();
  if (session && effects.session) {
    // The call that held the rep is the one whose outcome the rep confirms next.
    if (call && effects.session.currentCallId === null && session.currentCallId === call._id) await ctx.db.patch(session._id, { lastCallId: call._id });
    const ending = effects.session.status === "ended" || effects.session.status === "failed";
    await ctx.db.patch(session._id, patchOf({ ...effects.session, ...(ending ? { endedAt: now } : {}) }) as Partial<Doc<"dialerSessions">>);
  }
  if (call && effects.call) {
    await ctx.db.patch(call._id, patchOf(effects.call) as Partial<Doc<"dialerCalls">>);
    if (effects.call.state === "ended" || effects.call.state === "failed") {
      await leaveRace(ctx, call);
    }
  }
  // The first person reached in a race takes the rep. The other lines stay in `race` until they end,
  // so a hangup of the session still reaches them.
  if (session && call && effects.takeSeat) await ctx.db.patch(session._id, { currentCallId: call._id });
  if (session && effects.releaseNumber) await releaseNumber(ctx, session);
  await runCommands(ctx, effects.commands, call);
}

const eventArgs = {
  type: v.string(),
  legId: v.string(),
  state: v.union(v.object({ k: v.literal("agent"), s: v.string() }), v.object({ k: v.literal("contact"), c: v.string() })),
  hangupCause: v.union(v.string(), v.null()),
  recordingId: v.union(v.string(), v.null()),
  transcript: v.union(v.string(), v.null()),
  machineResult: v.union(v.string(), v.null()),
};

/** One verified Telnyx webhook (convex/http.ts), or a local stack's simulated one. */
/** A race call that ended leaves the session's race; an empty race is no race. */
async function leaveRace(ctx: MutationCtx, call: Doc<"dialerCalls">) {
  const session = await ctx.db.get(call.sessionId);
  if (!session?.race?.includes(call._id)) return;
  const race = session.race.filter((id) => id !== call._id);
  await ctx.db.patch(session._id, { race: race.length ? race : undefined });
}

/** The calls racing in a session, still live. */
async function raceCalls(ctx: QueryCtx, session: Doc<"dialerSessions">) {
  const calls = await Promise.all((session.race ?? []).map((id) => ctx.db.get(id)));
  return calls.filter((c): c is Doc<"dialerCalls"> => !!c && isLiveCall(c.state));
}

/** What a person who answers after another line had the rep hears: who called, and that they'll be called back. */
async function abandonNotice(ctx: QueryCtx, call: Doc<"dialerCalls">) {
  const [user, org] = await Promise.all([ctx.db.get(call.userId), ctx.db.get(call.orgId)]);
  const who = [user?.name, org?.name].filter(Boolean).join(" with ");
  return `Hello, this is ${who || "a sales rep"}. Sorry we missed you. We'll try you again another time. Goodbye.`;
}

/** Where a call stands with the rep: alone, racing an open seat, or too late (lib/dialer/bridge.ts Seat). */
async function seatOf(ctx: QueryCtx, session: Doc<"dialerSessions"> | null, call: Doc<"dialerCalls">): Promise<Seat> {
  const agentLegId = session?.agentLegId ?? null;
  if (!session || session.currentCallId === call._id) return { agentLegId, race: "solo", rivals: [], abandonNotice: "" };
  const open = !session.currentCallId && (session.race ?? []).includes(call._id);
  const rivals = open ? rivalsToHangUp((await raceCalls(ctx, session)).map((c) => ({ id: c._id, legId: c.legId ?? null, state: c.state })), call._id) : [];
  return { agentLegId, race: open ? "open" : "taken", rivals, abandonNotice: await abandonNotice(ctx, call) };
}

export const applyEvent = internalMutation({
  args: eventArgs,
  handler: async (ctx, event): Promise<string> => {
    const now = Date.now();
    const state = event.state as LegState;
    if (state.k === "agent") {
      const sessionId = ctx.db.normalizeId("dialerSessions", state.s);
      const session = sessionId ? await ctx.db.get(sessionId) : null;
      if (!session) return "unknown session";
      const call = session.currentCallId ? await ctx.db.get(session.currentCallId) : null;
      const live = [...(call && isLiveCall(call.state) ? [call] : []), ...(await raceCalls(ctx, session))];
      const effects = reduceAgentEvent(event, sessionView(session), live.flatMap((c) => (c.legId ? [c.legId] : [])), session._id);
      if (effects.session?.status === "ended" || effects.session?.status === "failed") {
        // The contact legs' own hangups arrive too; close the calls here in case they don't.
        await ctx.db.patch(session._id, { currentCallId: undefined, race: undefined });
      }
      await applyEffects(ctx, effects, session, call);
      return `agent ${event.type}`;
    }
    const callId = ctx.db.normalizeId("dialerCalls", state.c);
    const call = callId ? await ctx.db.get(callId) : null;
    if (!call) return "unknown call";
    const session = await ctx.db.get(call.sessionId);
    const effects = reduceContactEvent(event, callView(call), call._id, await seatOf(ctx, session, call), now);
    if (effects.session && session?.currentCallId !== call._id) delete effects.session;
    await applyEffects(ctx, effects, session, call);
    return `contact ${event.type}`;
  },
});

// ───────────────────────────── Power dialing ─────────────────────────────

/**
 * Parallel lines: claim several queued contacts at once. Each gets its own
 * call row; they race for the rep (session.race) until one reaches a person.
 */
export const claimRace = internalMutation({
  args: {
    userId: v.id("users"), orgId: v.id("organizations"),
    entries: v.array(v.object({ contactId: v.string(), accountId: v.optional(v.string()), contactName: v.string(), to: v.string() })),
    since: v.optional(v.number()),
    campaign: v.optional(campaignValidator),
  },
  handler: async (ctx, args): Promise<{ sessionId: Id<"dialerSessions">; from: string; detectMachine: boolean; calls: { callId: Id<"dialerCalls">; to: string }[] }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Not authenticated");
    const now = Date.now();
    const session = await liveSession(ctx, user, now);
    if (!session) throw new ConvexError("Start a dialing session first.");
    const problem = dialProblem(sessionView(session), now);
    if (problem) throw new ConvexError(problem);
    const n = await ctx.db.get(session.numberId);
    if (!n || n.heldBySessionId !== session._id) throw new ConvexError("This session lost its number. End it and start again.");
    const profile = await profileOf(ctx, args.userId, args.orgId);
    const campaign = await resolveCampaign(ctx, user, args.campaign);
    const permittedLines = (await linesPaused(ctx, user, campaign?.audienceId)) ? 1 : linesOf(profile);
    if (args.entries.length > permittedLines) throw new ConvexError("Your parallel calling limit changed. Check the queue and try again.");
    const detectMachine = profile?.detectVoicemail === true;
    const voicemail = detectMachine ? profile?.voicemailMessage : undefined;
    const record = await recordsCalls(ctx, args.orgId);
    const calledIn = await calledInSession(ctx, session._id, args.since);
    const calls: { callId: Id<"dialerCalls">; to: string }[] = [];
    for (const entry of args.entries) {
      if (calledIn.has(entry.contactId)) continue;
      if (await complianceProblem(ctx, args.orgId, entry.to, now)) continue;
      const callId = await ctx.db.insert("dialerCalls", {
        orgId: args.orgId, userId: args.userId, sessionId: session._id, contactId: entry.contactId,
        ...(entry.accountId ? { accountId: entry.accountId } : {}), contactName: entry.contactName, to: entry.to, from: session.from,
        state: "dialing", startedAt: now, transcriptStatus: "none",
        ...(detectMachine ? { detectMachine } : {}), ...(voicemail ? { voicemail } : {}),
        record, ...(campaign ? { audienceId: campaign.audienceId } : {}),
      });
      calls.push({ callId, to: entry.to });
    }
    if (calls.length === 0) throw new ConvexError("Those people are no longer next to call.");
    await ctx.db.patch(session._id, { race: calls.map((c) => c.callId), queueAudienceId: campaign?.audienceId, queueName: campaign?.name });
    return { sessionId: session._id, from: session.from, detectMachine, calls };
  },
});

/** The people a session has dialed since `since` (the list being worked was loaded then): that list never dials one twice. */
async function calledInSession(ctx: QueryCtx, sessionId: Id<"dialerSessions">, since = 0) {
  const calls = await ctx.db.query("dialerCalls").withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId)).take(SESSION_CALLS_MAX);
  return new Set(calls.filter((c) => c.startedAt >= since).map((c) => c.contactId));
}

/**
 * The next people of a list the caller works (a module's call queue, through the `phone` component) to dial now: in
 * the list's order, not called in this session, and callable now. The phone a list holds only picks who is next; the
 * dial reads the person's own number and checks it again (claimCall, claimRace).
 */
export const nextOf = internalQuery({
  args: { userId: v.id("users"), orgId: v.id("organizations"), candidates: v.array(v.object({ contactId: v.string(), phone: v.string() })), since: v.optional(v.number()), campaign: v.optional(campaignValidator) },
  handler: async (ctx, args): Promise<{ lines: number; contactIds: string[]; held: number }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) return { lines: 1, contactIds: [], held: 0 };
    const now = Date.now();
    const session = await liveSession(ctx, user, now);
    if (!session) throw new ConvexError("Start a dialing session first.");
    return pickNext(ctx, user, session, args.candidates, now, args.since, args.campaign);
  },
});

export const nextOfList = query({
  args: { candidates: v.array(v.object({ contactId: v.string(), phone: v.string() })), since: v.optional(v.number()), campaign: v.optional(campaignValidator) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const session = await liveSession(ctx, user, now);
    return session ? pickNext(ctx, user, session, args.candidates, now, args.since, args.campaign) : null;
  },
});

async function pickNext(ctx: QueryCtx, user: Doc<"users">, session: Doc<"dialerSessions">, candidates: Candidate[], now: number, since?: number, source?: Campaign) {
  const campaign = await resolveCampaign(ctx, user, source);
  const lines = (await linesPaused(ctx, user, campaign?.audienceId)) ? 1 : linesOf(await profileOf(ctx, user._id, user.orgId));
  const called = await calledInSession(ctx, session._id, since);
  return pickCallable(candidates, lines, called, async (phone) => {
    const to = toE164(phone);
    return to !== null && !(await complianceProblem(ctx, user.orgId, to, now));
  });
}

/**
 * Sessions past their two hours (cron): hang up their legs, close them and free
 * their numbers, so an abandoned session neither keeps a call up nor holds a
 * number another rep can then claim while it still rings.
 */
export const reapExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const status of ["calling_agent", "ready"] as const) {
      const expired = await ctx.db.query("dialerSessions")
        .withIndex("by_status_and_expiresAt", (q) => q.eq("status", status).lt("expiresAt", now))
        .take(REAP_BATCH);
      for (const session of expired) {
        const call = session.currentCallId ? await ctx.db.get(session.currentCallId) : null;
        for (const c of [...(call && isLiveCall(call.state) ? [call] : []), ...(await raceCalls(ctx, session))]) {
          if (c.legId) await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command: { op: "hangup", legId: c.legId } });
        }
        if (session.agentLegId) await ctx.scheduler.runAfter(0, internal.dialerActions.run, { command: { op: "hangup", legId: session.agentLegId } });
        await ctx.db.patch(session._id, { status: "ended", endedAt: now, error: "The session ran out of time.", currentCallId: undefined, race: undefined });
        await releaseNumber(ctx, session);
      }
    }
  },
});

// ───────────────────────────── Voicemail ─────────────────────────────

const VOICEMAIL_MAX = 1000;
const ABANDON_WINDOW_MS = 30 * 24 * 60 * 60_000;
const ABANDON_READ = 2000;

/** Above this share of people reached abandoned, parallel lines pause (the TSR's 3% over 30 days). */
const ABANDON_CAP = 0.03;
/** Fewer people reached than this and the rate is noise: lines stay on. */
const ABANDON_MIN_SAMPLE = 20;

/** Abandoned calls over people reached by this rep in the last 30 days. */
async function abandonment(ctx: QueryCtx, user: Pick<Doc<"users">, "_id" | "orgId">) {
  let reached = 0;
  let calls = 0;
  let read = 0;
  const since = Date.now() - ABANDON_WINDOW_MS;
  for await (const c of ctx.db.query("dialerCalls").withIndex("by_userId_and_startedAt", (q) => q.eq("userId", user._id).gte("startedAt", since))) {
    if (c.orgId === user.orgId) {
      if (c.abandoned) calls++;
      if (c.abandoned || (c.answeredAt !== undefined && c.machine !== true)) reached++;
    }
    if (++read >= ABANDON_READ) break;
  }
  return { calls, reached };
}

/** Abandoned calls over people reached on one audience's queue calls in the last 30 days: the TSR's per-campaign rate. */
async function campaignAbandonment(ctx: QueryCtx, audienceId: Id<"audiences">) {
  let reached = 0;
  let calls = 0;
  let read = 0;
  const since = Date.now() - ABANDON_WINDOW_MS;
  for await (const c of ctx.db.query("dialerCalls").withIndex("by_audienceId_and_startedAt", (q) => q.eq("audienceId", audienceId).gte("startedAt", since))) {
    if (c.abandoned) calls++;
    if (c.abandoned || (c.answeredAt !== undefined && c.machine !== true)) reached++;
    if (++read >= ABANDON_READ) break;
  }
  return { calls, reached };
}

/** Parallel lines pause when the rep, or the campaign (the audience being worked), is over the cap. */
async function linesPaused(ctx: QueryCtx, user: Pick<Doc<"users">, "_id" | "orgId">, audienceId: Id<"audiences"> | undefined) {
  if (overAbandonCap(await abandonment(ctx, user))) return true;
  return audienceId ? overAbandonCap(await campaignAbandonment(ctx, audienceId)) : false;
}

const overAbandonCap = (a: { calls: number; reached: number }) => a.reached >= ABANDON_MIN_SAMPLE && a.calls / a.reached > ABANDON_CAP;

const linesOf = (p: Doc<"dialerProfiles"> | null) => Math.min(MAX_LINES, Math.max(1, Math.round(p?.parallelLines ?? 1)));

async function profileOf(ctx: QueryCtx, userId: Id<"users">, orgId: Id<"organizations">) {
  return ctx.db.query("dialerProfiles").withIndex("by_userId_and_orgId", (q) => q.eq("userId", userId).eq("orgId", orgId)).unique();
}

/** The caller's dialer settings. */
export const profile = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const p = await profileOf(ctx, user._id, user.orgId);
    const abandoned = await abandonment(ctx, user);
    const session = await liveSession(ctx, user, Date.now());
    const campaign = session?.queueAudienceId ? await campaignAbandonment(ctx, session.queueAudienceId) : null;
    return {
      detectVoicemail: p?.detectVoicemail === true, voicemailMessage: p?.voicemailMessage ?? "", parallelLines: linesOf(p), maxLines: MAX_LINES,
      abandoned, campaign: campaign && { name: session?.queueName ?? "This queue", ...campaign },
      linesPaused: overAbandonCap(abandoned) || (campaign ? overAbandonCap(campaign) : false),
    };
  },
});

/**
 * Voicemail detection: Telnyx listens on each contact's leg before the rep is
 * connected. A machine gets the rep's message after the beep (or a hangup,
 * with no message), and the call logs as left voicemail or no answer.
 */
export const saveProfile = mutation({
  args: { detectVoicemail: v.boolean(), voicemailMessage: v.string(), parallelLines: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const message = args.voicemailMessage.trim();
    if (message.length > VOICEMAIL_MAX) throw new ConvexError(`Keep the voicemail under ${VOICEMAIL_MAX} characters.`);
    const lines = args.parallelLines === undefined ? undefined : Math.round(args.parallelLines);
    if (lines !== undefined && (lines < 1 || lines > MAX_LINES)) throw new ConvexError(`Dial 1 to ${MAX_LINES} lines at once.`);
    const values = { detectVoicemail: args.detectVoicemail, voicemailMessage: message || undefined, updatedAt: Date.now(), ...(lines !== undefined ? { parallelLines: lines } : {}) };
    const existing = await profileOf(ctx, user._id, user.orgId);
    if (existing) await ctx.db.patch(existing._id, values);
    else await ctx.db.insert("dialerProfiles", { orgId: user.orgId, userId: user._id, ...values });
  },
});

// ───────────────────────────── Browser audio ─────────────────────────────

async function credentialOf(ctx: QueryCtx, userId: Id<"users">, orgId: Id<"organizations">) {
  return ctx.db.query("dialerCredentials").withIndex("by_userId_and_orgId", (q) => q.eq("userId", userId).eq("orgId", orgId)).unique();
}

export const credentialFor = internalQuery({
  args: { userId: v.id("users"), orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const c = await credentialOf(ctx, args.userId, args.orgId);
    return c ? { telnyxCredentialId: c.telnyxCredentialId, sipUsername: c.sipUsername } : null;
  },
});

/** Keep the rep's new credential. Two tabs racing keep the first; the second's is returned for deletion. */
export const storeCredential = internalMutation({
  args: { userId: v.id("users"), orgId: v.id("organizations"), telnyxCredentialId: v.string(), sipUsername: v.string() },
  handler: async (ctx, args): Promise<{ telnyxCredentialId: string; sipUsername: string; discarded: string | null }> => {
    const existing = await credentialOf(ctx, args.userId, args.orgId);
    if (existing) return { telnyxCredentialId: existing.telnyxCredentialId, sipUsername: existing.sipUsername, discarded: args.telnyxCredentialId };
    await ctx.db.insert("dialerCredentials", { orgId: args.orgId, userId: args.userId, telnyxCredentialId: args.telnyxCredentialId, sipUsername: args.sipUsername, createdAt: Date.now() });
    return { telnyxCredentialId: args.telnyxCredentialId, sipUsername: args.sipUsername, discarded: null };
  },
});

// ───────────────────────────── Compliance ─────────────────────────────

const DNC_LIST_MAX = 500;

async function recordsCalls(ctx: QueryCtx, orgId: Id<"organizations">) {
  return (await readPolicy(ctx, orgId)).callRecording;
}

async function onDoNotCall(ctx: QueryCtx, orgId: Id<"organizations">, number: string) {
  return (await suppressionFor(ctx, orgId, { phone: number }, await callerOutreachPurpose(ctx))).voice.blocked;
}

/** Why this number can't be dialed now: it's on the workspace's do-not-call list, or outside its calling hours. */
async function complianceProblem(ctx: QueryCtx, orgId: Id<"organizations">, number: string, now: number): Promise<string | null> {
  // Rep clicks, including Log and call next, are manual. Service-JWT callers are agents. Claims use the current E164.
  const suppressed = (await suppressionFor(ctx, orgId, { phone: number }, await callerOutreachPurpose(ctx))).voice;
  if (suppressed.blocked) return suppressed.text;
  return callingHoursProblem(number, now);
}

async function addToDoNotCall(ctx: MutationCtx, user: Doc<"users">, raw: string, contactId: string | undefined, reason: string | undefined) {
  const number = toE164(raw);
  if (!number) throw new ConvexError("Enter the number in international format, like +14155550123.");
  await setSuppression(ctx, { orgId: user.orgId, kind: "phone", value: number, source: "dnc", state: "active", actor: user._id, contactId, reason });
}

/** Whether a contact's number may be dialed: the panels show why not before the rep tries. */
export const numberStatus = query({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const number = toE164(args.phone);
    if (!user || !number) return null;
    return { doNotCall: await onDoNotCall(ctx, user.orgId, number) };
  },
});

/** The workspace's do-not-call list, newest first. */
export const doNotCallList = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const canonical = await ctx.db.query("suppressions").withIndex("by_orgId_and_source_and_state", (q) => q.eq("orgId", user.orgId).eq("source", "dnc").eq("state", "active")).take(DNC_LIST_MAX);
    const out = canonical.filter((r) => r.kind === "phone").map((r) => ({ _id: r._id as Id<"suppressions"> | Id<"dialerDoNotCall">, number: r.value, reason: r.reason ?? null, addedAt: r.addedAt }));
    const legacy = await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", user.orgId)).take(DNC_LIST_MAX);
    for (const row of legacy) {
      if (await suppressionRow(ctx, user.orgId, "phone", row.number, "dnc")) continue;
      out.push({ _id: row._id, number: row.number, reason: row.reason ?? null, addedAt: row.addedAt });
    }
    return out.sort((a, b) => b.addedAt - a.addedAt).slice(0, DNC_LIST_MAX);
  },
});

/** Any member adds a number: never calling someone is always allowed. */
export const addDoNotCall = mutation({
  args: { number: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await addToDoNotCall(ctx, user, args.number, undefined, args.reason?.trim() || "Added by hand");
  },
});

/** Only an admin takes a number off: calling someone who asked not to be is the risk this list exists for. */
export const removeDoNotCall = mutation({
  args: { id: v.union(v.id("dialerDoNotCall"), v.id("suppressions")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const access = await accessFor(ctx, user);
    if (!can(user, "suppressions.manage") || access.preview) throw new ConvexError(refusal("suppressions.manage"));
    const row = await ctx.db.get(args.id);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("Not on the list");
    const number = "number" in row ? row.number : row.kind === "phone" && row.source === "dnc" ? row.value : null;
    if (!number) throw new ConvexError("Not on the do-not-call list");
    await setSuppression(ctx, { orgId: user.orgId, kind: "phone", value: number, source: "dnc", state: "lifted", actor: user._id });
  },
});

/** Whether the workspace records calls. Recorded calls tell the person so as they're connected. */
export const saveSettings = mutation({
  args: { record: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await writePolicy(ctx, user, { callRecording: args.record });
  },
});
