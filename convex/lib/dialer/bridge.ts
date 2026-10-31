/**
 * The dialer's call flow, as one pure reducer (docs/dialer.md). A rep's
 * dialing session is one call to the rep's own phone (the agent leg). Each
 * contact is dialled as a second leg; when it answers, Canon bridges the
 * agent leg to it with `park_after_unbridge` on the agent leg, so the rep's
 * call is parked again when the contact hangs up and one phone call carries a
 * whole session of calls.
 *
 * Every webhook names its leg through the `client_state` Canon set when it
 * placed the call, so an event finds its row without guessing. The reducer
 * takes the event and the rows it names and returns the patches and the
 * Telnyx commands to run; convex/dialer.ts applies them in one transaction.
 *
 * Pure: no database access, no Node-only imports.
 */
import { decodeLegState, type LegState } from "./telnyx.ts";

/** A session holds its number this long at most; an abandoned one frees it then. */
export const SESSION_TTL_MS = 2 * 60 * 60_000;

export type SessionStatus = "calling_agent" | "ready" | "ended" | "failed";
export type CallState = "dialing" | "ringing" | "answered" | "ended" | "failed";
export type TranscriptStatus = "none" | "pending" | "ready" | "failed";
export type Outcome = "connected" | "no_answer" | "left_voicemail" | "busy" | "wrong_number";

export const OUTCOMES: readonly Outcome[] = ["connected", "no_answer", "left_voicemail", "busy", "wrong_number"];

export type SessionView = { status: SessionStatus; agentLegId: string | null; currentCallId: string | null; expiresAt: number; racing: number };

/**
 * The legs to hang up when a call takes the rep: racing lines still ringing.
 * A line already answered keeps going, so a person there gets the
 * abandoned-call notice (and a machine its voicemail), never a silent hangup.
 */
export function rivalsToHangUp(race: readonly { id: string; legId: string | null; state: CallState }[], winnerId: string): string[] {
  return race.filter((c) => c.id !== winnerId && c.legId && (c.state === "dialing" || c.state === "ringing")).map((c) => c.legId!);
}

/** Lines a rep may dial at once from a queue (docs/dialer.md, parallel lines). */
export const MAX_LINES = 3;

/**
 * Where a contact call stands with the rep. `solo`: the rep's one call (or the
 * race winner). `open`: one of several lines racing for the rep, nobody
 * reached yet. `taken`: another line already has the rep.
 */
export type Seat = {
  agentLegId: string | null;
  race: "solo" | "open" | "taken";
  /** The race's other live legs: hung up when this one takes the rep. */
  rivals: string[];
  /** What a person who answers after the rep was taken hears before the hangup (an abandoned call). */
  abandonNotice: string;
};
export type CallView = {
  state: CallState;
  legId: string | null;
  answeredAt: number | null;
  transcriptStatus: TranscriptStatus;
  /** Set once the recording webhook arrived; tracked apart from the transcript, which can arrive first. */
  recordingId: string | null;
  /** Answering machine detection's verdict on this leg, when it ran. */
  machine: boolean | null;
  /** Detection runs on this leg: the bridge waits for its verdict (docs/dialer.md, D4). */
  detectMachine: boolean;
  /** The rep's voicemail, spoken after the beep when a machine answers; null hangs up instead. */
  voicemail: string | null;
  /** The voicemail began playing: a retried greeting webhook doesn't start it twice. */
  voicemailStarted: boolean;
  voicemailLeft: boolean;
  /** A person answered after another line had the rep: they heard the notice and were hung up. */
  abandoned: boolean;
  /** The workspace records calls: a person is told so as they're connected (docs/dialer.md, compliance). */
  record: boolean;
  /** Recording began, after the person heard the notice. Recording webhooks count only then. */
  recordingStarted: boolean;
};

/** What a person hears as they're connected to the rep on a recorded call. */
export const RECORDING_NOTICE = "This call is recorded.";

export type DialerEvent = {
  type: string;
  legId: string;
  state: LegState | null;
  hangupCause: string | null;
  recordingId: string | null;
  transcript: string | null;
  /** `call.machine.detection.ended`: "human", "machine" or "not_sure". */
  machineResult: string | null;
};

export type Command =
  | { op: "speak"; legId: string; text: string; state: LegState; commandId?: string }
  | { op: "hangup"; legId: string }
  | { op: "bridge"; agentLegId: string; contactLegId: string }
  | { op: "record"; legId: string; state: LegState; commandId: string }
  /** Copy the recording into Canon's storage (Telnyx's links expire in minutes). */
  | { op: "saveRecording"; recordingId: string }
  /** Hand the transcript to call intelligence and log it on the call. */
  | { op: "importTranscript"; text: string }
  /** Log the finished call as a `call` activity on the contact. */
  | { op: "logActivity"; outcome: Outcome; durationSeconds: number };

export type Effects = {
  session?: Partial<Pick<SessionView, "status" | "agentLegId" | "currentCallId">> & { error?: string | null; endedAt?: number };
  call?: Partial<Pick<CallView, "state" | "legId" | "answeredAt" | "transcriptStatus" | "machine" | "voicemailStarted" | "voicemailLeft" | "abandoned" | "recordingStarted">> & {
    endedAt?: number;
    durationSeconds?: number;
    hangupCause?: string | null;
    outcome?: Outcome;
    recordingId?: string;
  };
  releaseNumber?: boolean;
  /** This call reached a person first: it takes the rep, and the race ends. */
  takeSeat?: boolean;
  commands: Command[];
};

export const CONNECTED_PROMPT = "You're connected to Canon. Dial your first contact from the screen.";

const LIVE_CALL: readonly CallState[] = ["dialing", "ringing", "answered"];
export const isLiveCall = (state: CallState) => LIVE_CALL.includes(state);

export function isLiveSession(s: Pick<SessionView, "status" | "expiresAt">, now: number): boolean {
  return (s.status === "calling_agent" || s.status === "ready") && s.expiresAt > now;
}

/** Why a session can't dial a contact right now, or null when it can. */
export function dialProblem(s: SessionView, now: number): string | null {
  if (!isLiveSession(s, now)) return "This dialing session has ended. Start a new one.";
  if (s.status !== "ready" || !s.agentLegId) return "Answer the call to your phone first.";
  if (s.currentCallId || s.racing > 0) return "Finish the current call first.";
  return null;
}

/** The outcome a finished leg logs before the rep picks one. A machine is a voicemail left, or no answer. */
export function outcomeOf(answered: boolean, hangupCause: string | null, machine: boolean | null, voicemailLeft = false): Outcome {
  if (machine) return voicemailLeft ? "left_voicemail" : "no_answer";
  if (answered) return "connected";
  const cause = (hangupCause ?? "").toLowerCase();
  if (cause === "user_busy") return "busy";
  if (cause === "unallocated_number" || cause === "invalid_number_format" || cause === "number_changed") return "wrong_number";
  return "no_answer";
}

const none = (): Effects => ({ commands: [] });

/** What a detection verdict on an answered leg does: reach the person, wait for a machine's beep, or hang up on it. */
function afterVerdict(machine: boolean, voicemail: string | null, legId: string, seat: Seat, state: LegState, callId: string, record: boolean): Effects {
  if (!machine) return personReached(legId, seat, state, callId, record);
  return { commands: voicemail ? [] : [{ op: "hangup", legId }] };
}

/**
 * A person is on this leg. Alone, they're connected to the rep. In a race,
 * the first person takes the rep and the other lines are hung up; one who
 * answers after that hears who called and is hung up: an abandoned call,
 * which the telemarketing rules cap, so it's flagged and counted.
 */
function personReached(legId: string, seat: Seat, state: LegState, callId: string, record: boolean): Effects {
  if (seat.race === "taken") {
    return { call: { abandoned: true }, commands: [{ op: "speak", legId, text: seat.abandonNotice, state, commandId: `ab-${callId}` }] };
  }
  const commands = connect(seat.agentLegId, legId, state, callId, record);
  if (seat.race === "solo") return { commands };
  return { takeSeat: true, commands: [...commands, ...seat.rivals.map((rival) => ({ op: "hangup" as const, legId: rival }))] };
}

/**
 * A person answered: bridge the rep's leg to them (parked again when they hang
 * up). When the workspace records, tell them first; the recording starts only
 * once the notice has played (`call.speak.ended`), so nothing is recorded
 * before they know, and nothing at all if the notice fails.
 */
function connect(agentLegId: string | null, legId: string, state: LegState, callId: string, record: boolean): Command[] {
  return [
    ...(agentLegId ? [{ op: "bridge" as const, agentLegId, contactLegId: legId }] : []),
    ...(record ? [{ op: "speak" as const, legId, text: RECORDING_NOTICE, state, commandId: `notice-${callId}` }] : []),
  ];
}

/** The agent leg: the rep's own phone. */
export function reduceAgentEvent(e: DialerEvent, session: SessionView, liveLegs: readonly string[], sessionId: string): Effects {
  if (session.agentLegId && session.agentLegId !== e.legId) return none();
  if (e.type === "call.answered" && session.status === "calling_agent") {
    return {
      session: { status: "ready", agentLegId: e.legId, error: null },
      commands: [{ op: "speak", legId: e.legId, text: CONNECTED_PROMPT, state: { k: "agent", s: sessionId } }],
    };
  }
  if (e.type === "call.hangup" && (session.status === "calling_agent" || session.status === "ready")) {
    const unanswered = session.status === "calling_agent";
    // The rep hung up: contacts still on the line (or ringing) are dropped, not left talking to no one.
    const commands: Command[] = liveLegs.map((legId) => ({ op: "hangup", legId }));
    return {
      session: {
        status: unanswered ? "failed" : "ended",
        error: unanswered ? `Your phone didn't answer (${e.hangupCause ?? "no answer"}).` : null,
        agentLegId: session.agentLegId ?? e.legId,
      },
      releaseNumber: true,
      commands,
    };
  }
  return none();
}

/** The contact's leg, and its recording. */
export function reduceContactEvent(e: DialerEvent, call: CallView, callId: string, seat: Seat, now: number): Effects {
  if (call.legId && call.legId !== e.legId) return none();
  const state: LegState = { k: "contact", c: callId };
  const answeredPatch = { state: "answered" as const, legId: e.legId, answeredAt: now };
  switch (e.type) {
    case "call.initiated":
      return call.state === "dialing" ? { call: { state: "ringing", legId: e.legId }, commands: [] } : none();
    case "call.answered": {
      if (call.state !== "dialing" && call.state !== "ringing") return none();
      // With detection on, the rep hears nothing until Telnyx says who answered; a verdict that came first applies now.
      if (call.detectMachine && call.machine === null) return { call: answeredPatch, commands: [] };
      const reached = call.detectMachine ? afterVerdict(call.machine === true, call.voicemail, e.legId, seat, state, callId, call.record) : personReached(e.legId, seat, state, callId, call.record);
      return { ...reached, call: { ...answeredPatch, ...reached.call } };
    }
    case "call.machine.detection.ended": {
      if (!isLiveCall(call.state) || call.machine !== null) return none();
      // "not_sure" goes to the rep: a person kept waiting is worse than a rep hearing a greeting.
      const machine = e.machineResult === "machine";
      // Before the answer webhook (Telnyx doesn't promise their order): keep the verdict for the answer to apply.
      if (call.state !== "answered" || !call.detectMachine) return { call: { machine }, commands: [] };
      const reached = afterVerdict(machine, call.voicemail, e.legId, seat, state, callId, call.record);
      return { ...reached, call: { machine, ...reached.call } };
    }
    case "call.machine.greeting.ended":
      if (call.state !== "answered" || call.machine !== true || !call.voicemail || call.voicemailStarted) return none();
      return { call: { voicemailStarted: true }, commands: [{ op: "speak", legId: e.legId, text: call.voicemail, state, commandId: `vm-${callId}` }] };
    case "call.speak.ended":
      if (call.state !== "answered") return none();
      // The abandoned-call notice finished: hang up.
      if (call.abandoned) return { commands: [{ op: "hangup", legId: e.legId }] };
      // The recording notice finished on a person's call: now record.
      if (call.machine !== true) {
        if (!call.record || call.recordingStarted) return none();
        return { call: { recordingStarted: true }, commands: [{ op: "record", legId: e.legId, state, commandId: `rec-${callId}` }] };
      }
      if (!call.voicemailStarted || call.voicemailLeft) return none();
      return { call: { voicemailLeft: true }, commands: [{ op: "hangup", legId: e.legId }] };
    case "call.hangup": {
      if (!isLiveCall(call.state)) return none();
      const answered = call.answeredAt !== null;
      const durationSeconds = answered ? Math.max(0, Math.round((now - (call.answeredAt ?? now)) / 1000)) : 0;
      // An abandoned call reached a person but never the rep: no answer, flagged `abandoned` for the rate.
      const outcome = call.abandoned ? "no_answer" : outcomeOf(answered, e.hangupCause, call.machine, call.voicemailLeft);
      return {
        call: { state: "ended", legId: e.legId, endedAt: now, durationSeconds, hangupCause: e.hangupCause, outcome },
        session: { currentCallId: null },
        commands: [{ op: "logActivity", outcome, durationSeconds }],
      };
    }
    case "call.recording.saved":
      // Only a recording Canon started counts: not one nobody answered, nor a voicemail box, nor a workspace that doesn't record.
      if (call.recordingId || !e.recordingId || !call.recordingStarted) return none();
      return {
        call: { recordingId: e.recordingId, ...(call.transcriptStatus === "none" ? { transcriptStatus: "pending" as const } : {}) },
        commands: [{ op: "saveRecording", recordingId: e.recordingId }],
      };
    case "call.recording.transcription.saved": {
      if (call.transcriptStatus === "ready" || call.transcriptStatus === "failed" || !call.recordingStarted) return none();
      const text = (e.transcript ?? "").trim();
      if (!text) return { call: { transcriptStatus: "failed" }, commands: [] };
      return { call: { transcriptStatus: "ready" }, commands: [{ op: "importTranscript", text }] };
    }
    case "call.recording.error":
      return call.transcriptStatus === "ready" ? none() : { call: { transcriptStatus: "failed" }, commands: [] };
    default:
      return none();
  }
}

/** The fields Canon reads from a Telnyx webhook body (`{ data: { event_type, payload } }`). */
export function parseEvent(body: unknown): DialerEvent | null {
  const data = (body as { data?: { event_type?: unknown; payload?: Record<string, unknown> } } | null)?.data;
  const p = data?.payload;
  const type = data?.event_type;
  const legId = p?.call_control_id;
  if (typeof type !== "string" || !p || typeof legId !== "string" || !legId) return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  const transcription = p.transcription_text ?? p.transcript ?? (p.transcription as { text?: unknown } | undefined)?.text;
  return {
    type,
    legId,
    state: decodeLegState(p.client_state),
    hangupCause: str(p.hangup_cause),
    recordingId: str(p.recording_id),
    transcript: str(transcription),
    machineResult: str(p.result),
  };
}
