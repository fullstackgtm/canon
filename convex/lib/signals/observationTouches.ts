/**
 * A person's observations as touches a module reads (`observations.forPeople`, docs/modules.md): which channel, what
 * happened and which way, never what was said. Pure. The deal plays' own reading of a log is lib/plays/model.ts.
 */

export const OBSERVATION_CHANNELS = ["email", "linkedin", "room", "hot_lead"] as const;
export type ObservationChannel = (typeof OBSERVATION_CHANNELS)[number];
export type ObservationTouch = { channel: ObservationChannel; event: string; direction: "in" | "out" };

/** The parts of an observation's body a touch reads: no subject, body or reply text crosses here. */
export type TouchBody = { type: string; event?: string | { kind: string; direction?: string; class?: string }; provider?: string };

/** The touch an observation is, or null when it is none (a signal, a bounce, an auto-reply, a Gmail hot lead). */
export function observationTouch(b: TouchBody): ObservationTouch | null {
  const ev = typeof b.event === "object" ? b.event : null;
  if (b.type === "room" && (b.event === "opened" || b.event === "acted")) return { channel: "room", event: b.event, direction: "in" };
  if (b.type === "linkedin" && ev) {
    if (ev.kind === "invite_sent" || ev.kind === "message_sent") return { channel: "linkedin", event: ev.kind, direction: "out" };
    if (ev.kind === "invite_accepted" || ev.kind === "reply_received") return { channel: "linkedin", event: ev.kind, direction: "in" };
    if (ev.kind === "message") return { channel: "linkedin", event: "message", direction: ev.direction === "out" ? "out" : "in" };
    return null;
  }
  if (b.type === "email" && ev) {
    if (ev.kind === "received") return ev.class === "bounce" || ev.class === "auto_reply" ? null : { channel: "email", event: "received", direction: "in" };
    if (ev.kind === "sent") return { channel: "email", event: "sent", direction: "out" };
    if (ev.kind === "logged") return { channel: "email", event: "logged", direction: ev.direction === "inbound" ? "in" : "out" };
    if (ev.kind === "message") return { channel: "email", event: "message", direction: ev.direction === "in" ? "in" : "out" };
    return null;
  }
  // A Gmail hot lead is also its received email, counted above.
  if (b.type === "hot_lead" && b.provider !== "gmail") return { channel: "hot_lead", event: "reply", direction: "in" };
  return null;
}

/** An observation body cut to what a touch reads, in the query, so message text never reaches the module's action. */
export function touchBodyOf(body: Record<string, unknown>): TouchBody {
  const ev = body.event;
  const event = typeof ev === "string" ? ev
    : ev && typeof ev === "object" ? { kind: String((ev as { kind?: unknown }).kind ?? ""), ...pickText(ev as Record<string, unknown>, ["direction", "class"]) }
      : undefined;
  return { type: String(body.type ?? ""), ...(event === undefined ? {} : { event }), ...pickText(body, ["provider"]) };
}

const pickText = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap((k) => (typeof o[k] === "string" ? [[k, o[k] as string]] : [])));
