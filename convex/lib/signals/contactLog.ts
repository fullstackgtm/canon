/**
 * A contact's observations (docs/signal-ledger.md, SL3): LinkedIn events the worker saw, keyed by the
 * register contact id. convex/observations.ts stores them; tests use a Map.
 * Pure and free of Node imports.
 */
import type { Id } from "../../_generated/dataModel";
import type { Event, SendRow } from "../linkedin/perform.ts";
import type { LinkedinEvent, Observation, PlannedObservation } from "./observations.ts";

/** What claim rendered for one enrollment: the cadence step it sends and the exact text ("" for an invite without a note). */
export type Rendered = { enrollmentId: Id<"linkedinEnrollments">; cadenceId: Id<"linkedinCadences">; step: number; text: string };

export type ContactLog = {
  has(contactId: string, key: string): Promise<boolean>;
  append(contactId: string, entry: PlannedObservation): Promise<void>;
  /** Up to `limit` of the contact's observations not yet erased. */
  unerased(contactId: string, limit: number): Promise<Array<{ id: string; body: Observation }>>;
  replace(id: string, body: Observation): Promise<void>;
};

type Enrollment = { _id: Id<"linkedinEnrollments">; cadenceId: Id<"linkedinCadences">; contactId: string };

/**
 * What a worker event says happened between the sender and the contact, or null when nothing did.
 * The key names the enrollment, the kind and the step, so a retried event finds its first observation.
 * An invite counts only when this run sent it (one found pending on lookup went out earlier), and an
 * acceptance only when a sync saw it (not a contact who was already connected).
 */
export function linkedinEventOf(ev: Event, e: Enrollment, sends: readonly SendRow[], rendered: Rendered | undefined): { key: string; event: LinkedinEvent } | null {
  const mine = rendered?.enrollmentId === e._id ? rendered : undefined;
  const key = (kind: LinkedinEvent["kind"], step?: number) => `linkedin:${e._id}:${kind}${step === undefined ? "" : `:${step}`}`;
  switch (ev.event) {
    case "invited": {
      const sent = sends.some((s) => s.kind === "invite" && s.ok && s.enrollmentId === e._id);
      if (!sent || !mine) return null;
      return { key: key("invite_sent", mine.step), event: { kind: "invite_sent", cadenceId: mine.cadenceId, step: mine.step, ...(mine.text ? { note: mine.text } : {}) } };
    }
    case "connected":
      return ev.accepted ? { key: key("invite_accepted"), event: { kind: "invite_accepted", cadenceId: e.cadenceId } } : null;
    case "sent":
      return mine ? { key: key("message_sent", mine.step), event: { kind: "message_sent", cadenceId: mine.cadenceId, step: mine.step, body: mine.text, ...(ev.messageId ? { messageId: ev.messageId } : {}) } } : null;
    case "replied":
      return { key: key("reply_received"), event: { kind: "reply_received", cadenceId: e.cadenceId } };
    case "withdrawn":
    case "retry":
    case "fail":
    case "activity":
    case "dormant":
      return null;
  }
}

/** Append the event's observation to the contact's log, unless an earlier delivery of it is already there. */
export async function logLinkedinEvent(log: ContactLog, ev: Event, e: Enrollment, sends: readonly SendRow[], rendered: Rendered | undefined, now: number): Promise<void> {
  const found = linkedinEventOf(ev, e, sends, rendered);
  if (!found || (await log.has(e.contactId, found.key))) return;
  await log.append(e.contactId, { body: { type: "linkedin", ...found }, observedAt: now });
}

/** Erase up to `limit` of a contact's observations: each keeps its key and place, and loses everything else. Returns how many. */
export async function eraseContactLog(log: ContactLog, contactId: string, now: number, limit: number): Promise<number> {
  const rows = await log.unerased(contactId, limit);
  for (const row of rows) await log.replace(row.id, { type: "erased", key: row.body.key, erasedAt: now });
  return rows.length;
}
