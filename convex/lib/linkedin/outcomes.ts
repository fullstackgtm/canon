/**
 * What a LinkedIn refusal means for the sender and for the contact
 * (docs/linkedin-cadences.md, "Health"). The worker applies these; the
 * mapping is pure so it is tested on its own.
 *
 * Error types are Unipile's (`errors/<name>`), from its API reference. What
 * each means in practice is not documented, so anything unknown retries a few
 * times and then fails the contact without touching the account.
 */
const HOUR = 3_600_000;

export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = HOUR;
export const RATE_LIMIT_HOLD_MS = 6 * HOUR;
export const INVITE_LIMIT_HOLD_MS = 24 * HOUR;

export type Refusal = { status: number; type: string | null };
const named = (r: Refusal) => (r.type ?? "").replace(/^errors\//, "");

export type AccountEffect = {
  /** Stop every action until now + holdMs. */
  holdMs?: number;
  /** Stop invites (messages still go) until now + inviteHoldMs. */
  inviteHoldMs?: number;
  /** Take the account out of sending until its owner acts. */
  status?: "credentials" | "paused";
  reason: string;
};

export function accountEffectOf(r: Refusal, action: "invite" | "message" | "lookup" | "sync" | "withdraw"): AccountEffect | null {
  const t = named(r);
  if (r.status === 401 || t === "disconnected_account") return { status: "credentials", reason: "LinkedIn needs you to log in again." };
  if (t === "account_restricted") return { status: "paused", reason: "LinkedIn restricted this account. Canon stopped sending; check LinkedIn before resuming." };
  if (r.status === 429 || t === "too_many_requests") return { holdMs: RATE_LIMIT_HOLD_MS, reason: "LinkedIn is rate limiting this account. Sending resumes in 6 hours." };
  if (action === "invite" && ["limit_exceeded", "connection_limit_reached", "cannot_resend_yet"].includes(t)) {
    return { inviteHoldMs: INVITE_LIMIT_HOLD_MS, reason: "LinkedIn says this account hit its invite limit. Invites resume tomorrow." };
  }
  return null;
}

export type ContactOutcome =
  | { kind: "connected" }
  | { kind: "invited" }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; reason: string };

export function inviteRefusal(r: Refusal): ContactOutcome {
  const t = named(r);
  if (t === "already_connected") return { kind: "connected" };
  if (t === "already_invited_recently" || t === "action_already_performed") return { kind: "invited" };
  if (t === "cannot_invite_attendee") return { kind: "fail", reason: "LinkedIn doesn't allow inviting this person" };
  if (t === "cannot_resend_within_24hrs") return { kind: "retry", reason: "LinkedIn won't take another invite to this person today" };
  return { kind: "retry", reason: `Invite refused (${t || `HTTP ${r.status}`})` };
}

export function messageRefusal(r: Refusal): ContactOutcome {
  const t = named(r);
  if (t === "no_connection_with_recipient") return { kind: "fail", reason: "No longer connected on LinkedIn" };
  return { kind: "retry", reason: `Message refused (${t || `HTTP ${r.status}`})` };
}

/** A retry, or a failure once the contact has used its attempts. */
export function settleRetry(attempts: number, reason: string, now: number, holdUntil?: number): { state: "retry"; attempts: number; nextAt: number; reason: string } | { state: "failed"; reason: string } {
  const next = attempts + 1;
  if (next >= MAX_ATTEMPTS) return { state: "failed", reason };
  return { state: "retry", attempts: next, nextAt: Math.max(now + RETRY_AFTER_MS, holdUntil ?? 0), reason };
}
