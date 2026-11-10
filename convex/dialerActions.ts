/**
 * The dialer's Telnyx calls (docs/dialer.md). Canon's key goes nowhere but the
 * Authorization header (lib/dialer/telnyx.ts).
 *
 * A local stack never places a real call. It plays Telnyx's part instead: it
 * schedules the webhooks Telnyx would send (the rep answers, the contact
 * answers, a transcript arrives after hangup) into the same `applyEvent`, so
 * the whole flow runs end to end without a phone.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createTelnyxClient, TelnyxError, toE164, type LegState, type TelnyxClient } from "./lib/dialer/telnyx";
import { CANDIDATES_MAX, campaignValidator, isLocalStack, type Campaign } from "./dialer";
import { callerClient, requireCaller } from "./records";

function telnyx(): TelnyxClient {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!apiKey || !connectionId) throw new ConvexError("Calling isn't set up on this deployment yet (TELNYX_API_KEY and TELNYX_CONNECTION_ID).");
  return createTelnyxClient({ apiKey, connectionId });
}

/** Why Telnyx refused a dial, in words for the rep. Never the response body. */
function dialError(cause: unknown): string {
  if (cause instanceof ConvexError) return String(cause.data);
  if (!(cause instanceof TelnyxError)) return "Couldn't reach Telnyx. Nothing was dialled; try again.";
  // The logs keep Telnyx's reason for whoever sets the dialer up; the rep sees it too.
  console.error(`telnyx dial refused: HTTP ${cause.status} code=${cause.code ?? "-"} title=${cause.title ?? "-"}`);
  if (cause.status === 401) return "Telnyx rejected Canon's key. An admin needs to check the dialer setup.";
  return `${cause.message} Nothing was dialled.`;
}

const SIMULATED_TRANSCRIPT = [
  "Rep: Hi, this is a simulated call from Canon's local stack.",
  "Customer: Sure, what is this about?",
  "Rep: We help teams keep their CRM clean. Is that something you're working on?",
  "Customer: We use HubSpot today and the data is a mess. Pricing would matter, and we'd need to see it next week.",
  "Rep: Great, I'll send a time for a demo next Tuesday.",
].join("\n");

type Simulated = { type: string; legId: string; state: LegState; hangupCause?: string; recordingId?: string; transcript?: string; machineResult?: string };

async function simulate(ctx: ActionCtx, delayMs: number, e: Simulated) {
  await ctx.scheduler.runAfter(delayMs, internal.dialer.applyEvent, {
    type: e.type, legId: e.legId, state: e.state, hangupCause: e.hangupCause ?? null, recordingId: e.recordingId ?? null, transcript: e.transcript ?? null, machineResult: e.machineResult ?? null,
  });
}

/** Ring the rep's own phone: the session's agent leg. */
export const dialAgent = internalAction({
  args: { sessionId: v.id("dialerSessions") },
  handler: async (ctx, args) => {
    if (!integrationEnabled("dialer")) return;
    const session = await ctx.runQuery(internal.dialer.sessionForDial, { sessionId: args.sessionId });
    if (!session || session.status !== "calling_agent") return;
    const state: LegState = { k: "agent", s: args.sessionId };
    let legId: string;
    try {
      if (isLocalStack()) {
        legId = `local-agent-${args.sessionId}`;
        await simulate(ctx, 1500, { type: "call.answered", legId, state });
      } else {
        legId = await telnyx().dial({ to: session.agentPhone, from: session.from, state, timeoutSecs: 45 });
      }
    } catch (cause) {
      await ctx.runMutation(internal.dialer.dialFailed, { sessionId: args.sessionId, error: dialError(cause) });
      return;
    }
    const live = await ctx.runMutation(internal.dialer.agentDialed, { sessionId: args.sessionId, legId });
    if (!live) await hangup(ctx, legId);
  },
});

type Caller = Awaited<ReturnType<typeof requireCaller>>;

/**
 * A local stack plays the contact: a number ending in 0 never answers, one
 * ending in 9 is a voicemail box, and the others answer after a delay set by
 * the last digit, so parallel lines race and one can answer too late.
 */
async function simulateContact(ctx: ActionCtx, legId: string, state: LegState, to: string, detectMachine: boolean) {
  await simulate(ctx, 400, { type: "call.initiated", legId, state });
  if (to.endsWith("0")) {
    await simulate(ctx, 3000, { type: "call.hangup", legId, state, hangupCause: "timeout" });
    return;
  }
  const answerAt = 1500 + Number(to.slice(-1)) * 300;
  await simulate(ctx, answerAt, { type: "call.answered", legId, state });
  if (!detectMachine) return;
  const machine = to.endsWith("9");
  await simulate(ctx, answerAt + 1000, { type: "call.machine.detection.ended", legId, state, machineResult: machine ? "machine" : "human" });
  if (machine) await simulate(ctx, answerAt + 2500, { type: "call.machine.greeting.ended", legId, state, machineResult: "beep_detected" });
}

/**
 * Dial one contact into the caller's session. The number is the contact's
 * own, read from Canon now, never from the client or the queue's copy. A
 * local stack simulates the contact: a number ending in 0 never answers, and
 * one ending in 9 is a voicemail box, so a queue shows every outcome.
 */
async function placeContactCall(ctx: ActionCtx, caller: Caller, contactId: string, from: { campaign?: Campaign; since?: number } = {}): Promise<{ callId: Id<"dialerCalls"> }> {
  const contact = await callerClient(ctx, caller).getContact(caller.orgId, contactId);
  if (!contact) throw new ConvexError("Contact not found");
  const to = toE164(contact.phone);
  if (!to) throw new ConvexError(contact.phone ? `${contact.phone} isn't a number Canon can dial. Use international format, like +14155550123.` : "This contact has no phone number.");
  const claim = await ctx.runMutation(internal.dialer.claimCall, {
    userId: caller.userId as Id<"users">,
    orgId: caller.orgId as Id<"organizations">,
    contactId,
    ...(contact.accountId ? { accountId: contact.accountId } : {}),
    contactName: contact.fullName,
    to,
    ...(from.campaign ? { campaign: from.campaign } : {}),
    ...(from.since !== undefined ? { since: from.since } : {}),
  });
  const state: LegState = { k: "contact", c: claim.callId };
  let legId: string;
  try {
    if (isLocalStack()) {
      legId = `local-contact-${claim.callId}`;
      await simulateContact(ctx, legId, state, to, claim.detectMachine);
    } else {
      legId = await telnyx().dial({ to, from: claim.from, state, timeoutSecs: 30, detectMachine: claim.detectMachine });
    }
  } catch (cause) {
    const error = dialError(cause);
    await ctx.runMutation(internal.dialer.dialFailed, { sessionId: claim.sessionId, callId: claim.callId, error });
    throw new ConvexError(error);
  }
  const live = await ctx.runMutation(internal.dialer.dialed, { callId: claim.callId, legId });
  if (!live) await hangup(ctx, legId);
  return { callId: claim.callId };
}

/** Dial a contact into the caller's session. */
export const callContact = action({
  args: { contactId: v.string() },
  handler: async (ctx, args): Promise<{ callId: Id<"dialerCalls"> }> => placeContactCall(ctx, await requireCaller(ctx), args.contactId),
});

/**
 * Browser audio (docs/dialer.md, D2): the rep's own Telnyx telephony credential,
 * made on first use on the WebRTC credential connection, and a short-lived
 * login token for the browser SDK. A session in browser mode rings that
 * credential, so the rep's leg is this browser tab. A local stack makes a
 * stand-in credential and no token: its calls are simulated anyway.
 */
export const browserToken = action({
  args: {},
  handler: async (ctx): Promise<{ token: string | null; simulated: boolean }> => {
    const caller = await requireCaller(ctx);
    const ids = { userId: caller.userId as Id<"users">, orgId: caller.orgId as Id<"organizations"> };
    const stored = await ctx.runQuery(internal.dialer.credentialFor, ids);
    if (isLocalStack()) {
      if (!stored) await ctx.runMutation(internal.dialer.storeCredential, { ...ids, telnyxCredentialId: `local-${caller.userId}`, sipUsername: `local-${caller.userId}` });
      return { token: null, simulated: true };
    }
    const connection = process.env.TELNYX_CREDENTIAL_CONNECTION_ID;
    if (!connection) throw new ConvexError("Browser audio isn't set up on this deployment yet (TELNYX_CREDENTIAL_CONNECTION_ID). Use your phone instead.");
    const client = telnyx();
    let credentialId = stored?.telnyxCredentialId;
    try {
      if (!credentialId) {
        const made = await client.createCredential(connection, `canon-${caller.orgId}-${caller.userId}`);
        const kept = await ctx.runMutation(internal.dialer.storeCredential, { ...ids, telnyxCredentialId: made.id, sipUsername: made.sipUsername });
        // Another tab made one first: keep theirs and remove ours from Telnyx.
        if (kept.discarded) await client.deleteCredential(kept.discarded).catch(() => {});
        credentialId = kept.telnyxCredentialId;
      }
      return { token: await client.credentialToken(credentialId), simulated: false };
    } catch (cause) {
      throw new ConvexError(cause instanceof TelnyxError ? `Telnyx couldn't set up browser audio (${cause.message}) Use your phone instead.` : "Couldn't reach Telnyx for browser audio. Use your phone instead.");
    }
  },
});

/**
 * Dial the next people of a list the caller works, such as a module's call queue (the `phone` page component): the
 * first callable ones in the list's order that this session hasn't called, one or a race of the rep's lines.
 * `campaign` names the audience the list came from, which the abandoned-call cap counts by. Every dial reads the
 * person's own number as the caller sees them and passes the same compliance checks as any other call.
 */
export const dialContacts = action({
  args: {
    candidates: v.array(v.object({ contactId: v.string(), phone: v.string() })),
    campaign: v.optional(campaignValidator),
    /** When the list was loaded: people called before then may be called again. */
    since: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ callId: Id<"dialerCalls"> | null }> => {
    const caller = await requireCaller(ctx);
    const ids = { userId: caller.userId as Id<"users">, orgId: caller.orgId as Id<"organizations"> };
    const source = { ...(args.campaign ? { campaign: args.campaign } : {}), ...(args.since !== undefined ? { since: args.since } : {}) };
    const next = await ctx.runQuery(internal.dialer.nextOf, { ...ids, candidates: args.candidates.slice(0, CANDIDATES_MAX), ...source });
    if (next.contactIds.length === 0) {
      if (next.held > 0) throw new ConvexError(heldMessage(next.held));
      return { callId: null };
    }
    if (next.contactIds.length !== args.candidates.length || next.contactIds.some((id, i) => id !== args.candidates[i]?.contactId)) throw new ConvexError("The next people or parallel calling limit changed. Check the queue and try again.");
    if (next.lines === 1 || next.contactIds.length === 1) return placeContactCall(ctx, caller, next.contactIds[0]!, source);
    return raceContacts(ctx, caller, next.contactIds.map((contactId) => ({ contactId })), source);
  },
});

const heldMessage = (held: number) =>
  `The ${held === 1 ? "contact left is" : `${held} contacts left are`} outside calling hours (8 AM to 9 PM their time) or on your do-not-call list. Try again later.`;

/** Parallel lines: each number re-read from Canon as the caller sees the contact; a contact who lost theirs is skipped. */
async function raceContacts(ctx: ActionCtx, caller: Caller, picked: readonly { contactId: string }[], source: { campaign?: Campaign; since?: number }): Promise<{ callId: Id<"dialerCalls"> | null }> {
  const ids = { userId: caller.userId as Id<"users">, orgId: caller.orgId as Id<"organizations"> };
  const client = callerClient(ctx, caller);
  const entries = [];
  for (const item of picked) {
    const contact = await client.getContact(caller.orgId, item.contactId);
    const to = toE164(contact?.phone);
    if (!contact || !to) continue;
    entries.push({ contactId: item.contactId, ...(contact.accountId ? { accountId: contact.accountId } : {}), contactName: contact.fullName, to });
  }
  if (entries.length === 0) return { callId: null };
  const race = await ctx.runMutation(internal.dialer.claimRace, { ...ids, entries, ...source });
  await Promise.all(race.calls.map(async ({ callId, to }) => {
    const state: LegState = { k: "contact", c: callId };
    let legId: string;
    try {
      if (isLocalStack()) {
        legId = `local-contact-${callId}`;
        await simulateContact(ctx, legId, state, to, race.detectMachine);
      } else {
        legId = await telnyx().dial({ to, from: race.from, state, timeoutSecs: 30, detectMachine: race.detectMachine });
      }
    } catch (cause) {
      await ctx.runMutation(internal.dialer.dialFailed, { sessionId: race.sessionId, callId, error: dialError(cause) });
      return;
    }
    if (!(await ctx.runMutation(internal.dialer.dialed, { callId, legId }))) await hangup(ctx, legId);
  }));
  return { callId: race.calls[0]?.callId ?? null };
}

async function hangup(ctx: ActionCtx, legId: string) {
  if (legId.startsWith("local-")) {
    if (!isLocalStack()) return;
    const [, kind, id] = legId.split("-");
    const state: LegState = kind === "agent" ? { k: "agent", s: id } : { k: "contact", c: id };
    await simulate(ctx, 200, { type: "call.hangup", legId, state, hangupCause: "normal_clearing" });
    if (state.k === "contact") {
      // Telnyx's recording webhooks follow a hangup; the reducer ignores them for a call nobody answered.
      await simulate(ctx, 700, { type: "call.recording.saved", legId, state, recordingId: `local-rec-${id}` });
      await simulate(ctx, 1200, { type: "call.recording.transcription.saved", legId, state, transcript: SIMULATED_TRANSCRIPT });
    }
    return;
  }
  try {
    await telnyx().hangup(legId);
  } catch (cause) {
    // 422: the call already ended, which is what a hangup wants.
    if (!(cause instanceof TelnyxError && cause.status === 422)) throw cause;
  }
}

const commandValidator = v.union(
  v.object({ op: v.literal("speak"), legId: v.string(), text: v.string(), state: v.union(v.object({ k: v.literal("agent"), s: v.string() }), v.object({ k: v.literal("contact"), c: v.string() })), commandId: v.optional(v.string()) }),
  v.object({ op: v.literal("hangup"), legId: v.string() }),
  v.object({ op: v.literal("bridge"), agentLegId: v.string(), contactLegId: v.string() }),
  v.object({ op: v.literal("record"), legId: v.string(), state: v.union(v.object({ k: v.literal("agent"), s: v.string() }), v.object({ k: v.literal("contact"), c: v.string() })), commandId: v.string() }),
);

/** One Telnyx command from the reducer (lib/dialer/bridge.ts). */
export const run = internalAction({
  args: { command: commandValidator },
  handler: async (ctx, { command }): Promise<void> => {
    if (!integrationEnabled("dialer")) return;
    if (command.op === "hangup") return hangup(ctx, command.legId);
    if (command.op === "bridge") {
      // A simulated call needs no bridge: there is no audio.
      if (!command.agentLegId.startsWith("local-")) await telnyx().bridge(command.agentLegId, command.contactLegId);
      return;
    }
    // A simulated leg: its recording webhooks come with its hangup, and a voicemail takes three seconds to say.
    if (command.legId.startsWith("local-")) {
      if (command.op === "speak" && command.state.k === "contact" && isLocalStack()) {
        await simulate(ctx, 3000, { type: "call.speak.ended", legId: command.legId, state: command.state });
      }
      return;
    }
    if (command.op === "speak") await telnyx().speak(command.legId, command.text, command.state, command.commandId);
    else await telnyx().recordStart(command.legId, command.state, command.commandId);
  },
});

/** Copy a recording into Canon's storage: Telnyx's download links expire in about ten minutes. */
export const saveRecording = internalAction({
  args: { callId: v.id("dialerCalls"), recordingId: v.string() },
  handler: async (ctx, args) => {
    if (args.recordingId.startsWith("local-")) return;
    const existing = await ctx.runQuery(internal.dialer.recordingFor, { callId: args.callId });
    if (!existing || existing.recordingStorageId) return;
    const url = await telnyx().recordingUrl(args.recordingId);
    if (!url) return;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Recording download failed (HTTP ${response.status})`);
    const storageId = await ctx.storage.store(await response.blob());
    await ctx.runMutation(internal.dialer.storeRecording, { callId: args.callId, storageId });
  },
});
