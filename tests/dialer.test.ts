import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTelnyxSignature } from "../convex/lib/dialer/signature.ts";
import { callingHoursProblem } from "../convex/lib/dialer/hours.ts";
import { createTelnyxClient, decodeLegState, encodeLegState, toE164 } from "../convex/lib/dialer/telnyx.ts";
import {
  dialProblem, outcomeOf, parseEvent, reduceAgentEvent, reduceContactEvent,
  RECORDING_NOTICE, rivalsToHangUp, type CallView, type DialerEvent, type Seat, type SessionView,
} from "../convex/lib/dialer/bridge.ts";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

test("Telnyx signatures: raw and SPKI keys verify; a changed body, an old timestamp or no headers do not", async () => {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = b64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const spki = b64(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1000);
  const body = '{"data":{"event_type":"call.answered"}}';
  const sig = b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(`${timestamp}|${body}`))));
  const check = (over: Partial<Parameters<typeof verifyTelnyxSignature>[0]>) =>
    verifyTelnyxSignature({ publicKey: raw, body, timestamp, signature: sig, nowMs: now, ...over });

  assert.equal(await check({}), "ok");
  assert.equal(await check({ publicKey: spki }), "ok");
  assert.equal(await check({ body: body.replace("answered", "hangup") }), "bad_signature");
  assert.equal(await check({ nowMs: now + 301_000 }), "stale");
  assert.equal(await check({ signature: null }), "unsigned");
});

const session = (over: Partial<SessionView> = {}): SessionView => ({ status: "ready", agentLegId: "agent-1", currentCallId: null, expiresAt: Infinity, racing: 0, ...over });
const solo: Seat = { agentLegId: "agent-1", race: "solo", rivals: [], abandonNotice: "" };
const call = (over: Partial<CallView> = {}): CallView => ({ state: "dialing", legId: null, answeredAt: null, transcriptStatus: "none", recordingId: null, machine: null, detectMachine: false, voicemail: null, voicemailStarted: false, voicemailLeft: false, abandoned: false, record: true, recordingStarted: false, ...over });
const event = (type: string, legId: string, over: Partial<DialerEvent> = {}): DialerEvent => ({
  type, legId, state: null, hangupCause: null, recordingId: null, transcript: null, machineResult: null, ...over,
});

test("a call runs: the rep answers, the contact answers and is recorded, hangs up, and the transcript lands once", () => {
  const answered = reduceAgentEvent(event("call.answered", "agent-1"), session({ status: "calling_agent", agentLegId: null }), [], "s1");
  assert.equal(answered.session?.status, "ready");
  assert.equal(answered.session?.agentLegId, "agent-1");
  assert.deepEqual(answered.commands.map((c) => c.op), ["speak"]);
  assert.equal(dialProblem(session(), 0), null);
  assert.match(dialProblem(session({ currentCallId: "c1" }), 0)!, /Finish the current call/);

  const up = reduceContactEvent(event("call.answered", "leg-1"), call({ state: "ringing" }), "c1", solo, 1_000);
  assert.equal(up.call?.state, "answered");
  // Bridged from the rep's leg, so the rep's leg is the one parked when the contact hangs up.
  assert.deepEqual(up.commands, [
    { op: "bridge", agentLegId: "agent-1", contactLegId: "leg-1" },
    // A recorded call tells the person first; the recording starts once the notice has played.
    { op: "speak", legId: "leg-1", text: RECORDING_NOTICE, state: { k: "contact", c: "c1" }, commandId: "notice-c1" },
  ]);
  const noticed = reduceContactEvent(event("call.speak.ended", "leg-1"), call({ state: "answered", legId: "leg-1", answeredAt: 1_000 }), "c1", solo, 2_000);
  assert.deepEqual(noticed, { call: { recordingStarted: true }, commands: [{ op: "record", legId: "leg-1", state: { k: "contact", c: "c1" }, commandId: "rec-c1" }] });

  const live = call({ state: "answered", legId: "leg-1", answeredAt: 1_000, recordingStarted: true });
  const down = reduceContactEvent(event("call.hangup", "leg-1", { hangupCause: "normal_clearing" }), live, "c1", solo, 43_400);
  assert.equal(down.call?.durationSeconds, 42);
  assert.equal(down.call?.outcome, "connected");
  assert.deepEqual(down.session, { currentCallId: null });
  assert.deepEqual(down.commands, [{ op: "logActivity", outcome: "connected", durationSeconds: 42 }]);
  // Telnyx retries: a second hangup changes nothing.
  assert.deepEqual(reduceContactEvent(event("call.hangup", "leg-1"), { ...live, state: "ended" }, "c1", solo, 50_000), { commands: [] });

  const ended = { ...live, state: "ended" as const };
  const saved = reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "rec-9" }), ended, "c1", solo, 0);
  assert.deepEqual(saved.commands, [{ op: "saveRecording", recordingId: "rec-9" }]);
  const text = reduceContactEvent(event("call.recording.transcription.saved", "leg-1", { transcript: " Rep: hi " }), { ...ended, transcriptStatus: "pending" }, "c1", solo, 0);
  assert.deepEqual(text.commands, [{ op: "importTranscript", text: "Rep: hi" }]);
  assert.deepEqual(reduceContactEvent(event("call.recording.transcription.saved", "leg-1", { transcript: "again" }), { ...ended, transcriptStatus: "ready" }, "c1", solo, 0).commands, []);
  // The transcript can land before the recording: the audio is still saved, and the transcript stays ready.
  const early = reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "rec-9" }), { ...ended, transcriptStatus: "ready" }, "c1", solo, 0);
  assert.deepEqual(early.call, { recordingId: "rec-9" });
  assert.deepEqual(early.commands, [{ op: "saveRecording", recordingId: "rec-9" }]);
  assert.deepEqual(reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "rec-9" }), { ...ended, recordingId: "rec-9" }, "c1", solo, 0).commands, []);
  // Webhooks for a recording Canon never started (recording off, or the notice never finished) are ignored.
  assert.deepEqual(reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "r" }), { ...ended, recordingStarted: false }, "c1", solo, 0).commands, []);
  // A leg nobody answered has nothing to record.
  assert.deepEqual(reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "r" }), call({ state: "ended" }), "c1", solo, 0).commands, []);
  // An event for another leg of the call is ignored.
  assert.deepEqual(reduceContactEvent(event("call.hangup", "leg-2"), live, "c1", solo, 0).commands, []);
});

test("the rep hanging up ends the session, frees the number and drops a contact still on the line", () => {
  const effects = reduceAgentEvent(event("call.hangup", "agent-1"), session({ currentCallId: "c1" }), ["leg-1"], "s1");
  assert.equal(effects.session?.status, "ended");
  assert.equal(effects.releaseNumber, true);
  assert.deepEqual(effects.commands, [{ op: "hangup", legId: "leg-1" }]);
  const missed = reduceAgentEvent(event("call.hangup", "agent-1", { hangupCause: "timeout" }), session({ status: "calling_agent", agentLegId: null }), [], "s1");
  assert.equal(missed.session?.status, "failed");
  assert.match(missed.session?.error ?? "", /didn't answer/);
});

test("outcomes follow the hangup cause and machine detection", () => {
  assert.equal(outcomeOf(true, null, true, true), "left_voicemail");
  assert.equal(outcomeOf(true, null, true, false), "no_answer");
  assert.equal(outcomeOf(false, "USER_BUSY", null), "busy");
  assert.equal(outcomeOf(false, "unallocated_number", null), "wrong_number");
  assert.equal(outcomeOf(false, "timeout", null), "no_answer");
});

test("the Telnyx client bridges from the rep's leg and parks it, and webhooks come back with Canon's state", async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const client = createTelnyxClient({
    apiKey: "KEY", connectionId: "app-1",
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return Response.json({ data: { call_control_id: "leg-9" } });
    }) as typeof fetch,
  });
  const legId = await client.dial({ to: "+14155550142", from: "+14155550100", state: { k: "contact", c: "c1" } });
  assert.equal(legId, "leg-9");
  assert.equal(sent!.url, "https://api.telnyx.com/v2/calls");
  assert.equal((sent!.init.headers as Record<string, string>).Authorization, "Bearer KEY");
  const body = JSON.parse(String(sent!.init.body));
  assert.equal(body.connection_id, "app-1");
  assert.equal(body.park_after_unbridge, undefined);

  await client.bridge("agent-1", "leg-9");
  assert.equal(sent!.url, "https://api.telnyx.com/v2/calls/agent-1/actions/bridge");
  assert.deepEqual(JSON.parse(String(sent!.init.body)), { call_control_id: "leg-9", park_after_unbridge: "self" });

  const parsed = parseEvent({ data: { event_type: "call.hangup", payload: { call_control_id: "leg-9", client_state: body.client_state, hangup_cause: "normal_clearing" } } });
  assert.deepEqual(parsed?.state, { k: "contact", c: "c1" });
  assert.equal(parsed?.hangupCause, "normal_clearing");
  assert.equal(decodeLegState(encodeLegState({ k: "agent", s: "s1" }))?.k, "agent");
  assert.equal(decodeLegState(btoa('{"k":"other"}')), null);
});

test("phone numbers normalise to E.164", () => {
  assert.equal(toE164("(415) 555-0142"), "+14155550142");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("0044 20 7946 0958"), "+442079460958");
  assert.equal(toE164("555-0142"), null);
  assert.equal(toE164(""), null);
});

test("with detection on, a person is bridged after the verdict and a machine gets the rep's voicemail after the beep", () => {
  const screened = call({ state: "ringing", detectMachine: true, voicemail: "Hi, it's Ryan from Canon." });
  const answered = reduceContactEvent(event("call.answered", "leg-1"), screened, "c1", solo, 1_000);
  assert.deepEqual(answered.commands, [], "the rep isn't connected until detection says who answered");

  const live = { ...screened, state: "answered" as const, legId: "leg-1", answeredAt: 1_000 };
  const human = reduceContactEvent(event("call.machine.detection.ended", "leg-1", { machineResult: "not_sure" }), live, "c1", solo, 0);
  assert.deepEqual(human.commands.map((c) => c.op), ["bridge", "speak"]);

  const machine = reduceContactEvent(event("call.machine.detection.ended", "leg-1", { machineResult: "machine" }), live, "c1", solo, 0);
  assert.deepEqual(machine, { call: { machine: true }, commands: [] });
  const box = { ...live, machine: true };
  const greeted = reduceContactEvent(event("call.machine.greeting.ended", "leg-1"), box, "c1", solo, 0);
  assert.deepEqual(greeted, {
    call: { voicemailStarted: true },
    commands: [{ op: "speak", legId: "leg-1", text: "Hi, it's Ryan from Canon.", state: { k: "contact", c: "c1" }, commandId: "vm-c1" }],
  });
  // A retried greeting webhook doesn't start the message twice.
  assert.deepEqual(reduceContactEvent(event("call.machine.greeting.ended", "leg-1"), { ...box, voicemailStarted: true }, "c1", solo, 0).commands, []);
  const spoken = reduceContactEvent(event("call.speak.ended", "leg-1"), { ...box, voicemailStarted: true }, "c1", solo, 0);
  assert.deepEqual(spoken, { call: { voicemailLeft: true }, commands: [{ op: "hangup", legId: "leg-1" }] });
  const done = reduceContactEvent(event("call.hangup", "leg-1"), { ...box, voicemailLeft: true }, "c1", solo, 31_000);
  assert.equal(done.call?.outcome, "left_voicemail");
  assert.deepEqual(reduceContactEvent(event("call.recording.saved", "leg-1", { recordingId: "r" }), { ...box, state: "ended" }, "c1", solo, 0).commands, []);

  // The verdict can land before the answer: it's kept, and the answer connects the person at once.
  const early = reduceContactEvent(event("call.machine.detection.ended", "leg-1", { machineResult: "human" }), screened, "c1", solo, 0);
  assert.deepEqual(early, { call: { machine: false }, commands: [] });
  assert.deepEqual(reduceContactEvent(event("call.answered", "leg-1"), { ...screened, machine: false }, "c1", solo, 1_000).commands.map((c) => c.op), ["bridge", "speak"]);

  // No voicemail to leave: a machine is hung up at once and logs as no answer.
  const silent = reduceContactEvent(event("call.machine.detection.ended", "leg-1", { machineResult: "machine" }), { ...live, voicemail: null }, "c1", solo, 0);
  assert.deepEqual(silent.commands, [{ op: "hangup", legId: "leg-1" }]);
});

test("parallel lines: the first person reached takes the rep and the other lines hang up; one who answers late is an abandoned call", () => {
  const open: Seat = { agentLegId: "agent-1", race: "open", rivals: ["leg-2", "leg-3"], abandonNotice: "Hello, this is Ryan with Canon." };
  const first = reduceContactEvent(event("call.answered", "leg-1"), call({ state: "ringing" }), "c1", open, 1_000);
  assert.equal(first.takeSeat, true);
  assert.deepEqual(first.commands.map((c) => (c.op === "hangup" ? `hangup ${c.legId}` : c.op)), ["bridge", "speak", "hangup leg-2", "hangup leg-3"]);

  const late = reduceContactEvent(event("call.answered", "leg-2"), call({ state: "ringing" }), "c2", { ...open, race: "taken", rivals: [] }, 1_200);
  assert.equal(late.takeSeat, undefined);
  assert.equal(late.call?.abandoned, true);
  assert.deepEqual(late.commands, [{ op: "speak", legId: "leg-2", text: "Hello, this is Ryan with Canon.", state: { k: "contact", c: "c2" }, commandId: "ab-c2" }]);
  const told = call({ state: "answered", legId: "leg-2", answeredAt: 1_200, abandoned: true });
  assert.deepEqual(reduceContactEvent(event("call.speak.ended", "leg-2"), told, "c2", solo, 0).commands, [{ op: "hangup", legId: "leg-2" }]);
  assert.equal(reduceContactEvent(event("call.hangup", "leg-2"), told, "c2", solo, 9_000).call?.outcome, "no_answer");

  // A machine on a racing line gets the voicemail on its own and never takes the rep.
  const box = call({ state: "answered", legId: "leg-3", answeredAt: 1_000, detectMachine: true, voicemail: "Hi" });
  const machine = reduceContactEvent(event("call.machine.detection.ended", "leg-3", { machineResult: "machine" }), box, "c3", open, 0);
  assert.equal(machine.takeSeat, undefined);
  assert.deepEqual(machine.commands, []);
  assert.match(dialProblem(session({ racing: 2 }), 0)!, /Finish the current call/);

  // Only lines still ringing are hung up when one wins: an answered line being screened runs on to its verdict.
  assert.deepEqual(rivalsToHangUp([
    { id: "c1", legId: "leg-1", state: "answered" },
    { id: "c2", legId: "leg-2", state: "ringing" },
    { id: "c3", legId: "leg-3", state: "answered" },
    { id: "c4", legId: null, state: "dialing" },
  ], "c1"), ["leg-2"]);
});

test("recording off: the person is connected with no notice and no recording", () => {
  const off = reduceContactEvent(event("call.answered", "leg-1"), call({ state: "ringing", record: false }), "c1", solo, 1_000);
  assert.deepEqual(off.commands.map((c) => c.op), ["bridge"]);
});

test("calling hours: +1 numbers only from 8 AM to 9 PM in every zone they may be in; Hawaii by area code; other countries unheld", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.match(callingHoursProblem("+14155550142", at("2026-10-12T14:00:00Z"))!, /7:00 AM/, "10 AM Eastern is 7 AM Pacific");
  assert.equal(callingHoursProblem("+14155550142", at("2026-10-12T19:00:00Z")), null);
  assert.match(callingHoursProblem("+12125550142", at("2026-10-13T01:30:00Z"))!, /9:30 PM/);
  assert.equal(callingHoursProblem("+18085550142", at("2026-10-13T00:00:00Z")), null, "2 PM in Honolulu");
  assert.match(callingHoursProblem("+18085550142", at("2026-10-12T16:00:00Z"))!, /6:00 AM/, "6 AM in Honolulu");
  assert.equal(callingHoursProblem("+442079460958", at("2026-10-13T03:00:00Z")), null);
});
