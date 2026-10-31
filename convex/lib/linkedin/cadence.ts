/**
 * LinkedIn cadences (docs/linkedin-cadences.md, slice L2): the steps, the
 * merge variables, and how an enrollment moves from one state to the next.
 *
 * A cadence is one invite followed by 0 to MAX_MESSAGES messages; an
 * invite-only cadence is done once the invite is accepted. Message 1
 * goes `delayDays` after the invite is accepted; each later message goes
 * `delayDays` after the one before. A reply, an invite left pending for
 * WITHDRAW_AFTER_DAYS, or a manual stop ends the enrollment.
 *
 * Pure: no database access, no Node-only imports.
 */
import { v } from "convex/values";
import type { OutboundContact } from "../outbound/audience.ts";
import { splitName } from "../outbound/audience.ts";
import { noteLimit, WITHDRAW_AFTER_DAYS, type Tier } from "./limits.ts";

export type Step = { kind: "invite"; note?: string } | { kind: "message"; body: string; delayDays: number };
export const stepValidator = v.union(
  v.object({ kind: v.literal("invite"), note: v.optional(v.string()) }),
  v.object({ kind: v.literal("message"), body: v.string(), delayDays: v.number() }),
);

export const MAX_MESSAGES = 5;
export const MAX_DELAY_DAYS = 30;
/** LinkedIn allows longer messages; past this a cold message reads as spam. */
export const MAX_MESSAGE_CHARS = 1500;
export const NAME_MAX = 80;
const DAY_MS = 86_400_000;

export type EnrollmentState = "queued" | "invited" | "connected" | "replied" | "done" | "withdrawn" | "stopped" | "failed";
/** States the worker still acts on. A contact is in at most one of these across the org. */
export const ACTIVE_STATES: readonly EnrollmentState[] = ["queued", "invited", "connected"];
export const isActive = (s: EnrollmentState) => ACTIVE_STATES.includes(s);

export function validateSteps(steps: Step[], tier: Tier): string | null {
  const [first, ...rest] = steps;
  if (first?.kind !== "invite") return "A cadence starts with a connection invite.";
  if (rest.length > MAX_MESSAGES) return `A cadence has at most ${MAX_MESSAGES} messages.`;
  if (first.note !== undefined && first.note.trim().length > noteLimit(tier)) return `The invite note is at most ${noteLimit(tier)} characters on this LinkedIn plan.`;
  for (const [i, step] of rest.entries()) {
    if (step.kind !== "message") return "Only the first step is an invite; the rest are messages.";
    if (!step.body.trim()) return `Message ${i + 1} is empty.`;
    if (step.body.length > MAX_MESSAGE_CHARS) return `Message ${i + 1} is over ${MAX_MESSAGE_CHARS} characters.`;
    if (!Number.isInteger(step.delayDays) || step.delayDays < 0 || step.delayDays > MAX_DELAY_DAYS) return `Message ${i + 1} waits 0 to ${MAX_DELAY_DAYS} whole days.`;
  }
  for (const text of [first.note ?? "", ...rest.map((s) => (s.kind === "message" ? s.body : ""))]) {
    const bad = unknownVariables(text);
    if (bad.length) return `Unknown merge field ${bad.map((v) => `{{${v}}}`).join(", ")}. Use ${BASE_VARS.map((v) => `{{${v}}}`).join(", ")} or {{custom.<field>}}.`;
  }
  return null;
}

// ───────────────────────────── Merge variables ─────────────────────────────

export const BASE_VARS = ["firstName", "lastName", "fullName", "company", "title"] as const;
const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;

const variablesIn = (text: string) => [...text.matchAll(VAR)].map((m) => m[1]);
const known = (name: string) => (BASE_VARS as readonly string[]).includes(name) || /^custom\.[\w-]+$/.test(name);
const unknownVariables = (text: string) => [...new Set(variablesIn(text).filter((v) => !known(v)))];

/** The values a contact fills the templates with. Custom fields arrive keyed "custom.<slug>". */
export function variablesOf(contact: Pick<OutboundContact, "fullName" | "company" | "title" | "custom">): Record<string, string> {
  const { first, last } = splitName(contact.fullName);
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v).trim();
    if (s) out[k] = s;
  };
  put("firstName", first);
  put("lastName", last);
  put("fullName", contact.fullName);
  put("company", contact.company);
  put("title", contact.title);
  for (const [k, v] of Object.entries(contact.custom)) {
    const key = k.startsWith("custom.") ? k : `custom.${k}`;
    if (/^custom\.[\w-]+$/.test(key)) put(key, v);
  }
  return out;
}

/** Only the variables the cadence uses are kept on an enrollment. */
export function variablesUsed(steps: Step[]): string[] {
  return [...new Set(steps.flatMap((s) => variablesIn(s.kind === "invite" ? s.note ?? "" : s.body)))];
}

export function render(template: string, vars: Record<string, string>): { text: string } | { missing: string[] } {
  const missing = [...new Set(variablesIn(template).filter((v) => !vars[v]))];
  if (missing.length) return { missing };
  return { text: template.replace(VAR, (_, name: string) => vars[name]).trim() };
}

/** Whether every step renders for this contact, within LinkedIn's limits. Checked when the contact is enrolled. */
export function checkRenders(steps: Step[], vars: Record<string, string>, tier: Tier): string | null {
  for (const step of steps) {
    const out = render(step.kind === "invite" ? step.note ?? "" : step.body, vars);
    if ("missing" in out) return `No value for ${out.missing.map((v) => `{{${v}}}`).join(", ")}`;
    if (step.kind === "invite" && out.text.length > noteLimit(tier)) return `The invite note is over ${noteLimit(tier)} characters for this contact`;
  }
  return null;
}

// ───────────────────────────── Profiles ─────────────────────────────

/** The vanity slug of a linkedin.com/in/<slug> URL, which Unipile resolves to a profile. */
export function publicIdentifierOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;
  const m = /^\/in\/([^/?#]+)\/?/.exec(parsed.pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return slug.length >= 2 && slug.length <= 100 ? slug : null;
}

// ───────────────────────────── Transitions ─────────────────────────────

/** When message `stepIndex` is due, counted from `from` (acceptance for the first message, the last send after that). */
export const dueAt = (steps: Step[], stepIndex: number, from: number) => {
  const step = steps[stepIndex];
  return from + (step?.kind === "message" ? step.delayDays : 0) * DAY_MS;
};

/** An invite older than this is withdrawn: LinkedIn counts long-pending invites against the sender. */
export const withdrawDue = (invitedAt: number, now: number) => now - invitedAt >= WITHDRAW_AFTER_DAYS * DAY_MS;

/** After the invite is accepted (or they were already connected): message 1 and when, or done for an invite-only cadence. */
export function afterConnected(steps: Step[], stepIndex: number, now: number): { state: "connected"; stepIndex: number; nextAt: number } | { state: "done" } {
  const next = Math.max(1, stepIndex);
  return next < steps.length ? { state: "connected", stepIndex: next, nextAt: dueAt(steps, next, now) } : { state: "done" };
}

/** After message `stepIndex` was sent: the next message and when, or done. */
export function afterMessage(steps: Step[], stepIndex: number, now: number): { state: "connected"; stepIndex: number; nextAt: number } | { state: "done" } {
  const next = stepIndex + 1;
  return next < steps.length ? { state: "connected", stepIndex: next, nextAt: dueAt(steps, next, now) } : { state: "done" };
}

// ───────────────────────────── Funnel ─────────────────────────────

/**
 * How far a cadence's people got, counted from what each enrollment kept:
 * `invitedAt` when the invite went out, `connectedAt` once connected,
 * `lastSentAt` after a message. Someone who was already a connection never
 * got an invite, so they count as `alreadyConnected`, not as an acceptance.
 */
export type Funnel = {
  enrolled: number;
  invited: number;
  /** Still waiting on the person to accept. */
  pending: number;
  accepted: number;
  alreadyConnected: number;
  messaged: number;
  replied: number;
};

export type FunnelStage = keyof Funnel;
type FunnelRow = { state: EnrollmentState; invitedAt?: number | null; connectedAt?: number | null; lastSentAt?: number | null };

/** Whether one enrollment counts in a funnel stage. `funnelOf` counts with this, so a stage's list matches its number. */
export function inStage(r: FunnelRow, stage: FunnelStage): boolean {
  const invited = r.invitedAt != null;
  const connected = r.connectedAt != null;
  switch (stage) {
    case "enrolled": return true;
    case "invited": return invited;
    case "pending": return invited && !connected && r.state === "invited";
    case "accepted": return invited && connected;
    case "alreadyConnected": return !invited && connected;
    case "messaged": return r.lastSentAt != null;
    case "replied": return r.state === "replied";
  }
}

export const FUNNEL_STAGES: readonly FunnelStage[] = ["enrolled", "invited", "pending", "accepted", "alreadyConnected", "messaged", "replied"];

export function funnelOf(rows: readonly FunnelRow[]): Funnel {
  const f: Funnel = { enrolled: 0, invited: 0, pending: 0, accepted: 0, alreadyConnected: 0, messaged: 0, replied: 0 };
  for (const r of rows) for (const stage of FUNNEL_STAGES) if (inStage(r, stage)) f[stage]++;
  return f;
}

/** A whole percent, or null when nothing was counted. */
export const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

/** What the sender does next, given what is due and what today's budget allows. Messages go first: they answer someone who accepted. */
export type Work = "message" | "invite" | "sync" | null;
export function chooseWork(a: {
  messageDue: boolean;
  inviteDue: boolean;
  syncDue: boolean;
  budget: { invites: number; messages: number; lookups: number };
}): Work {
  if (a.syncDue) return "sync";
  if (a.messageDue && a.budget.messages > 0) return "message";
  if (a.inviteDue && a.budget.invites > 0 && a.budget.lookups > 0) return "invite";
  return null;
}

// ───────────────────────────── Enrolling ─────────────────────────────

export type EnrollCandidate = {
  contactId: string;
  contactName: string;
  linkedinUrl: string;
  publicIdentifier: string;
  vars: Record<string, string>;
};
export type EnrollSkip = { contactId: string; contactName: string; reason: string };

/**
 * Who from an audience joins a cadence, and why the rest don't: no usable
 * LinkedIn URL, a merge field without a value, already in an active LinkedIn
 * cadence, already enrolled here, or the same profile twice.
 */
export function planEnrollment(
  contacts: Pick<OutboundContact, "id" | "fullName" | "company" | "title" | "custom" | "linkedinUrl">[],
  steps: Step[],
  tier: Tier,
  existing: { active: Set<string>; inCadence: Set<string> },
): { enroll: EnrollCandidate[]; skipped: EnrollSkip[] } {
  const enroll: EnrollCandidate[] = [];
  const skipped: EnrollSkip[] = [];
  const seen = new Set<string>();
  const used = variablesUsed(steps);
  for (const c of contacts) {
    const skip = (reason: string) => skipped.push({ contactId: c.id, contactName: c.fullName, reason });
    const slug = publicIdentifierOf(c.linkedinUrl);
    if (!slug) { skip("No LinkedIn profile URL"); continue; }
    if (existing.inCadence.has(c.id)) { skip("Already enrolled in this cadence"); continue; }
    if (existing.active.has(c.id)) { skip("Already in another active LinkedIn cadence"); continue; }
    const key = slug.toLowerCase();
    if (seen.has(key)) { skip("Same LinkedIn profile as another contact"); continue; }
    const all = variablesOf(c);
    const problem = checkRenders(steps, all, tier);
    if (problem) { skip(problem); continue; }
    seen.add(key);
    enroll.push({
      contactId: c.id,
      contactName: c.fullName,
      linkedinUrl: c.linkedinUrl!,
      publicIdentifier: slug,
      vars: Object.fromEntries(used.map((k) => [k, all[k]])),
    });
  }
  return { enroll, skipped };
}
