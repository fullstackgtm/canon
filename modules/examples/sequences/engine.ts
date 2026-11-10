/**
 * Sequences' pure computations (docs/module-plans/sequences.md §6): who an enroll skips and why, what an outcome does
 * to an enrollment, how a day's sends fit each sender's budget, and the funnel. When a step runs and which A/B arm a
 * contact gets are Canon's rules, in the module kit (modules/kernel/sequences.ts). server.ts calls them;
 * tests/sequencesEngine.test.ts checks them against the plan's Northwind goldens (§12). No reads, no clock: everything
 * comes in as arguments.
 *
 * Sending is Canon's (decision 2026-10-18): email only from the rep's linked Gmail, LinkedIn through Canon's worker,
 * calls as tasks. The budget here is the sequence's own pacing on top of Canon's caps.
 */

import { addDays, DAY_MS, localDate, type Step, type StepKind } from "../../kernel/sequences.ts";

export type FinishReason = "completed" | "replied" | "bounced" | "unsubscribed" | "meeting" | "opportunity" | "manual" | "failed";
export type OutcomeKind = "reply" | "auto_reply" | "bounce" | "unsubscribe" | "accepted" | "meeting" | "opportunity" | "call_logged";

/** An out-of-office reply with no return date holds this long (plan §2). */
export const OOO_HOLD_DAYS = 7;

// ── Enrolling ──

export type SkipReason = "suppressed" | "active_elsewhere" | "no_email" | "no_linkedin" | "enrolled_before" | "contacted_recently" | "unresolved_field";
export type Candidate = { id: string; email?: string | null; linkedinUrl?: string | null; fields: Record<string, string | number | null | undefined> };
export type EnrollContext = {
  /** Contacts on Canon's suppression list for a channel this sequence uses, with why. */
  suppressed: ReadonlyMap<string, string>;
  /** Active in another sequence or a LinkedIn cadence (one active outreach per contact, plan §2). */
  activeElsewhere: ReadonlySet<string>;
  /** In this sequence before (finished), for the add policy. */
  enrolledBefore: ReadonlySet<string>;
  addPolicy: "once" | "if_not_active" | "any";
  /** When each contact was last contacted by any sequence, and the days that must have passed since. */
  lastContactedAt: ReadonlyMap<string, number>;
  contactLatencyDays: number;
  steps: readonly Step[];
  now: number;
  /** The merge fields the module can check (the person's own); others, as `company` or `custom.*`, Canon checks at send. All when absent. */
  checkable?: readonly string[];
};

const MERGE = /\{\{\s*([a-zA-Z][\w.]*)\s*(?:\|\s*default\s+"([^"]*)")?\s*\}\}/g;
/** The merge fields a template names that the contact has no value for and no default covers. */
export function unresolvedFields(template: string, fields: Candidate["fields"]): string[] {
  const out: string[] = [];
  for (const [, name, fallback] of template.matchAll(MERGE)) {
    const v = fields[name];
    if ((v === undefined || v === null || v === "") && fallback === undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Who an enroll takes and who it skips, with one reason each, checked in this order: suppressed, active elsewhere,
 * no email or LinkedIn URL for the channels the steps use, enrolled before (by the add policy), contacted recently,
 * and a merge field the contact can't fill.
 */
export function skipReasons(contacts: readonly Candidate[], c: EnrollContext): { enroll: string[]; skipped: Array<{ id: string; reason: SkipReason }> } {
  const usesEmail = c.steps.some((s) => s.kind === "auto_email" || s.kind === "manual_email");
  const usesLinkedin = c.steps.some((s) => s.kind === "linkedin_invite" || s.kind === "linkedin_message");
  const templates = c.steps.flatMap((s) => (s.variants ?? []).flatMap((v) => [v.subject ?? "", v.body]));
  const enroll: string[] = [];
  const skipped: Array<{ id: string; reason: SkipReason }> = [];
  for (const p of contacts) {
    const last = c.lastContactedAt.get(p.id);
    const reason: SkipReason | null =
      c.suppressed.has(p.id) ? "suppressed"
      : c.activeElsewhere.has(p.id) ? "active_elsewhere"
      : usesEmail && !p.email ? "no_email"
      : usesLinkedin && !p.linkedinUrl ? "no_linkedin"
      : c.enrolledBefore.has(p.id) && c.addPolicy === "once" ? "enrolled_before"
      : last !== undefined && c.now - last < c.contactLatencyDays * DAY_MS ? "contacted_recently"
      : templates.some((t) => unresolvedFields(t, p.fields).some((f) => !c.checkable || c.checkable.includes(f))) ? "unresolved_field"
      : null;
    if (reason) skipped.push({ id: p.id, reason }); else enroll.push(p.id);
  }
  return { enroll, skipped };
}

// ── Outcomes ──

export type Outcome = { kind: OutcomeKind; hard?: boolean; returnOn?: string | null; at: number };
export type Effect =
  | { transition: "finish"; finishReason: FinishReason }
  | { transition: "hold"; holdUntil: string }
  | { transition: "complete_task" }
  | { transition: "none" };

/**
 * What an outcome does to an active (or held) enrollment: a reply, hard bounce, unsubscribe, booked meeting or new
 * opportunity finishes it; an out-of-office reply holds it until the day they're back (7 days when none), at the same
 * step, and is not a reply; a logged call completes the call task; an accepted invite and a soft bounce change nothing.
 */
export function onOutcome(o: Outcome, timeZone: string): Effect {
  switch (o.kind) {
    case "reply": return { transition: "finish", finishReason: "replied" };
    case "bounce": return o.hard === false ? { transition: "none" } : { transition: "finish", finishReason: "bounced" };
    case "unsubscribe": return { transition: "finish", finishReason: "unsubscribed" };
    case "meeting": return { transition: "finish", finishReason: "meeting" };
    case "opportunity": return { transition: "finish", finishReason: "opportunity" };
    case "auto_reply": return { transition: "hold", holdUntil: o.returnOn ?? addDays(localDate(o.at, timeZone), OOO_HOLD_DAYS) };
    case "call_logged": return { transition: "complete_task" };
    case "accepted": return { transition: "none" };
  }
}

// ── A day's sends ──

/** A send due today: `first` is a sequence's first email to the contact (it takes a new-thread slot); else a follow-up. */
export type Due = { key: string; channel: "email" | "linkedin"; first?: boolean; sender?: string; dueDay: string };
/** A sender's room today: new threads and follow-ups for email (the sequence's per-sender pacing), sends for LinkedIn. */
export type Room = { id: string; channel: "email" | "linkedin"; newLeft: number; followLeft: number };

/**
 * One day's sends, oldest due first: a first email goes to the pool's sender with the most new-thread room left (ties
 * to the earlier one), which then keeps the thread; a follow-up goes to its thread's sender; a LinkedIn send to its
 * account. What doesn't fit rolls to the next schedule day.
 */
export function placeDay(due: readonly Due[], rooms: readonly Room[]): { sent: Array<{ key: string; sender: string }>; rolled: string[] } {
  const left = new Map(rooms.map((r) => [r.id, { ...r }]));
  const sent: Array<{ key: string; sender: string }> = [];
  const rolled: string[] = [];
  const order = [...due].sort((a, b) => a.dueDay.localeCompare(b.dueDay));
  for (const d of order) {
    let room = d.sender ? left.get(d.sender) : undefined;
    if (!room && d.first) room = [...left.values()].filter((r) => r.channel === d.channel && r.newLeft > 0).sort((a, b) => b.newLeft - a.newLeft)[0];
    if (!room && d.channel === "linkedin") room = [...left.values()].find((r) => r.channel === "linkedin" && r.followLeft > 0);
    const slot = d.first ? "newLeft" : "followLeft";
    if (!room || room[slot] <= 0) { rolled.push(d.key); continue; }
    room[slot] -= 1;
    sent.push({ key: d.key, sender: room.id });
  }
  return { sent, rolled };
}

// ── Reports ──

export type Touch = { enrollment: string; stepIndex: number; kind: StepKind; variant?: string | null; state: "planned" | "requested" | "sent" | "failed" | "skipped" };
export type Funnel = {
  enrolled: number; firstSent: number; bounced: number; delivered: number; replies: number; replyRate: number;
  ooo: number; unsubscribed: number; meetings: number; finished: number; activeOrHeld: number;
};

/**
 * A sequence's funnel. Reply rate is replies over first emails delivered (sent less hard bounces), as a percentage to
 * one decimal; an out-of-office reply is not a reply (Outreach's rule). Meetings count once per enrollment.
 */
export function funnel(enrollments: ReadonlyArray<{ key: string; state: string; finishReason?: string | null }>, touches: readonly Touch[], outcomes: ReadonlyArray<{ enrollment: string; kind: OutcomeKind; hard?: boolean }>): Funnel {
  const firstEmail = Math.min(...touches.filter((t) => t.kind === "auto_email" || t.kind === "manual_email").map((t) => t.stepIndex), Infinity);
  const firstSent = new Set(touches.filter((t) => t.stepIndex === firstEmail && t.state === "sent").map((t) => t.enrollment)).size;
  const once = (kind: OutcomeKind, pred: (o: { hard?: boolean }) => boolean = () => true) => new Set(outcomes.filter((o) => o.kind === kind && pred(o)).map((o) => o.enrollment)).size;
  const bounced = once("bounce", (o) => o.hard !== false);
  const replies = once("reply");
  const delivered = firstSent - bounced;
  return {
    enrolled: enrollments.length, firstSent, bounced, delivered, replies,
    replyRate: delivered > 0 ? Math.round((replies / delivered) * 1000) / 10 : 0,
    ooo: once("auto_reply"), unsubscribed: once("unsubscribe"), meetings: once("meeting"),
    finished: enrollments.filter((e) => e.state === "finished").length,
    activeOrHeld: enrollments.filter((e) => e.state === "active" || e.state === "held").length,
  };
}

/** Two variants' reply rates compared (two-proportion z-test): the z score, and whether it may name a winner (100 sends each). */
export function abTest(a: { sent: number; replies: number }, b: { sent: number; replies: number }): { z: number; enough: boolean } {
  const enough = a.sent >= 100 && b.sent >= 100;
  if (!a.sent || !b.sent) return { z: 0, enough };
  const p = (a.replies + b.replies) / (a.sent + b.sent);
  const se = Math.sqrt(p * (1 - p) * (1 / a.sent + 1 / b.sent));
  return { z: se === 0 ? 0 : Math.round(((a.replies / a.sent - b.replies / b.sent) / se) * 100) / 100, enough };
}
