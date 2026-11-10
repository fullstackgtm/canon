/**
 * A deal's play (docs/deal-plays.md): the brief, the account map, the outreach
 * plan and the keeper that watches them. Roles stay on the deal's
 * `deal_contact` edges (lib/committee.ts). This file holds what a play adds on
 * top: the touches read from the observation log and activities, each person's
 * thread, and the shapes a recipe's rules read and return (docs/recipes.md).
 * The rules themselves are methodology and live in recipes/.
 * Pure and free of Node imports: the schema, Convex functions and UI share it.
 */
import type { DealRole } from "../objects/registry.ts";

export const PLAY_CHANNELS = ["linkedin", "email", "call", "meeting", "task", "other"] as const;
export type Channel = (typeof PLAY_CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { linkedin: "LinkedIn", email: "Email", call: "Call", meeting: "Meeting", task: "Task", other: "Other" };

/** Brief evidence: dated events and signals that explain "why now", and the lists a seller keeps open. */
export const ITEM_KINDS = ["timeline", "signal", "competitor", "risk", "gap", "discovery"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_LABEL: Record<ItemKind, string> = {
  timeline: "Timeline", signal: "Signal", competitor: "Competitor", risk: "Risk", gap: "Open gap", discovery: "Discovery question",
};

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const STEP_STATES = ["planned", "done", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];

/** Who wrote a value: a person (in the app or over /mcp, as themselves) or Canon's research run. */
export const ORIGINS = ["user", "research"] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * How an item's quote stands. `verified`: Canon read the quote word for word in the cited page. `unverified`: a
 * source was given but the quote wasn't found there (or the page couldn't be read). `none`: no source.
 */
export type Evidence = "verified" | "unverified" | "none";

const DAY = 86_400_000;

// ───────────────────────────── Touches ─────────────────────────────

/** One touch with a person (or the deal, `contactId` null). `in` is the buyer's side reaching back; `both` a meeting. */
export type Touch = { contactId: string | null; channel: Channel; direction: "out" | "in" | "both"; at: number; summary: string };

/** The parts of an observation a touch reads (lib/signals/observations.ts). */
export type ObservationLike = { observedAt: number; occurredAt?: number; body: { type: string; event?: string | { kind: string; subject?: string; direction?: string }; dealStreamId?: string; accountId?: string; reply?: string; provider?: string } };

export function touchesFromLog(contactId: string | null, log: readonly ObservationLike[], roomDealStreamId?: string): Touch[] {
  const out: Touch[] = [];
  for (const o of log) {
    const at = o.occurredAt ?? o.observedAt;
    const b = o.body;
    if (b.type === "room" && roomDealStreamId && b.dealStreamId === roomDealStreamId && (b.event === "opened" || b.event === "acted")) {
      out.push({ contactId, channel: "other", direction: "in", at, summary: b.event === "opened" ? "Viewed the customer room" : "Updated the customer room" });
    } else if (b.type === "linkedin" && b.event && typeof b.event === "object") {
      const k = b.event.kind;
      if (k === "invite_sent") out.push({ contactId, channel: "linkedin", direction: "out", at, summary: "LinkedIn invite sent" });
      else if (k === "message_sent") out.push({ contactId, channel: "linkedin", direction: "out", at, summary: "LinkedIn message sent" });
      else if (k === "invite_accepted") out.push({ contactId, channel: "linkedin", direction: "in", at, summary: "Accepted the LinkedIn invite" });
      else if (k === "reply_received") out.push({ contactId, channel: "linkedin", direction: "in", at, summary: "Replied on LinkedIn" });
      else if (k === "message") {
        const sent = b.event.direction === "out";
        out.push({ contactId, channel: "linkedin", direction: sent ? "out" : "in", at, summary: sent ? "LinkedIn message sent" : "Messaged on LinkedIn" });
      }
    } else if (b.type === "email" && b.event && typeof b.event === "object") {
      const inbound = b.event.kind === "received" || (b.event.kind === "logged" && b.event.direction === "inbound") || (b.event.kind === "message" && b.event.direction === "in");
      out.push({ contactId, channel: "email", direction: inbound ? "in" : "out", at, summary: `${inbound ? "Email from them" : "Email sent"}${b.event.subject ? `: ${b.event.subject}` : ""}` });
    } else if (b.type === "hot_lead" && b.provider !== "gmail") {
      // A Gmail hot lead is also its received email, counted above.
      out.push({ contactId, channel: "email", direction: "in", at, summary: "Replied to cold email" });
    }
  }
  return out;
}

/** The parts of an activity a touch reads (lib/activities.ts). */
export type ActivityLike = { kind: string; at: number; subject?: string | null; title?: string; outcome?: string | null; targets?: ReadonlyArray<{ object: string; id: string }> };

/**
 * Touches from the deal's calls and meetings up to `now`, one per committee member they name, or one for the deal
 * when they name none. Notes and tasks are not touches.
 */
export function touchesFromActivities(activities: readonly ActivityLike[], memberIds: ReadonlySet<string>, now: number): Touch[] {
  const out: Touch[] = [];
  for (const a of activities) {
    // A meeting scheduled ahead hasn't happened yet.
    if ((a.kind !== "call" && a.kind !== "meeting") || a.at > now) continue;
    const who = (a.targets ?? []).filter((t) => t.object === "contact" && memberIds.has(t.id)).map((t) => t.id);
    const summary = a.kind === "call" ? `Call${a.subject ? `: ${a.subject}` : ""}${a.outcome ? ` (${a.outcome})` : ""}` : `Meeting${a.title ? `: ${a.title}` : ""}`;
    const touch = { channel: a.kind as Channel, direction: (a.kind === "meeting" ? "both" : "out") as Touch["direction"], at: a.at, summary };
    if (who.length) for (const contactId of who) out.push({ ...touch, contactId });
    else out.push({ ...touch, contactId: null });
  }
  return out;
}

// ───────────────────────────── Thread state ─────────────────────────────

/**
 * Where a person's thread stands. `untouched`: no touch yet. `waiting`: we reached out lately and they haven't
 * answered. `replied`: they answered after our last touch, so the next move is ours. `engaged`: two-way and recent.
 * `quiet`: our last touch is old and unanswered, or they went silent.
 */
export type ThreadState = "untouched" | "waiting" | "replied" | "engaged" | "quiet";
export const THREAD_LABEL: Record<ThreadState, string> = { untouched: "Not contacted", waiting: "Waiting", replied: "Replied, our move", engaged: "Engaged", quiet: "Gone quiet" };

export type Thread = { state: ThreadState; lastOut: number | null; lastIn: number | null; lastChannel: Channel | null; touches: number };

/** `quietDays`: no touch either way in this long reads as quiet (the recipe's setting). */
export function threadOf(touches: readonly Touch[], now: number, quietDays: number): Thread {
  let lastOut: number | null = null;
  let lastIn: number | null = null;
  let last: Touch | null = null;
  for (const t of touches) {
    if (t.direction !== "in" && (lastOut === null || t.at > lastOut)) lastOut = t.at;
    if (t.direction !== "out" && (lastIn === null || t.at > lastIn)) lastIn = t.at;
    if (!last || t.at > last.at) last = t;
  }
  const base = { lastOut, lastIn, lastChannel: last?.channel ?? null, touches: touches.length };
  if (!last) return { ...base, state: "untouched" };
  const quiet = now - last.at > quietDays * DAY;
  // A meeting is both ways at once: nothing is owed after it.
  if (lastIn !== null && (lastOut === null || lastIn > lastOut)) return { ...base, state: quiet ? "quiet" : "replied" };
  if (lastIn !== null) return { ...base, state: quiet ? "quiet" : "engaged" };
  return { ...base, state: quiet ? "quiet" : "waiting" };
}

// ───────────────────────────── Plan ─────────────────────────────

export type StepLike = { id: string; title: string; channel: Channel; contactId?: string | null; role?: DealRole | null; dueOn?: string | null; state: StepState; createdAt: number };

/** The person a step is for: its contact, or whoever holds its role now. */
export function stepTarget(step: Pick<StepLike, "contactId" | "role">, holders: ReadonlyMap<DealRole, string>): string | null {
  return step.contactId ?? (step.role ? holders.get(step.role) ?? null : null);
}

/**
 * The touch that completes a planned step: one to its person on its channel since the step was made. A task or
 * "other" step, or one with no person, is completed only by hand.
 */
export function touchDoing(step: StepLike, target: string | null, touches: readonly Touch[]): Touch | null {
  if (step.state !== "planned" || !target || step.channel === "task" || step.channel === "other") return null;
  let found: Touch | null = null;
  for (const t of touches) {
    if (t.contactId === target && t.channel === step.channel && t.direction !== "in" && t.at >= step.createdAt && (!found || t.at < found.at)) found = t;
  }
  return found;
}

// ───────────────────────────── Keeper ─────────────────────────────

export type Severity = "high" | "medium" | "low";
/** A step the keeper proposes for a flag; adding it is one click. */
export type Proposal = { title: string; channel: Channel; contactId?: string; role?: DealRole };
export type Flag = { key: string; severity: Severity; text: string; contactId?: string; stepId?: string; propose?: Proposal };
export type Health = "on_track" | "needs_attention" | "at_risk";
export const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", needs_attention: "Needs attention", at_risk: "At risk" };

export type KeeperInput = {
  now: number;
  hasCompany: boolean;
  /** The decision window (an RFP, a budget cycle), as an ISO date. */
  windowClosesOn: string | null;
  windowLabel: string | null;
  members: ReadonlyArray<{ contactId: string; name: string; role: DealRole; thread: Thread }>;
  steps: ReadonlyArray<StepLike & { doneByTouch: boolean }>;
  researchedAt: number | null;
  hasBrief: boolean;
};

/** The keeper's read of a play: what is off track and the step that would fix each, most urgent first. */
export type KeeperReport = { health: Health; flags: Flag[]; windowDays: number | null };

/** Days from `now` to an ISO date (negative once passed). */
export function daysUntil(isoDate: string, now: number): number {
  const at = Date.parse(`${isoDate}T23:59:59Z`);
  return Number.isNaN(at) ? Number.NaN : Math.ceil((at - now) / DAY);
}

// ───────────────────────────── Prep ─────────────────────────────

/** The prep panel's view model: a verdict, what's missing before the deal can move, why it's slow, and research questions. */
export type PrepCheckKey = "exec" | "second" | "next" | "signer";
export type PrepCheck = { key: PrepCheckKey; label: string; ok: boolean; evidence: string };
/** Jen Abel's three reasons a deal goes slow (docs/deal-prep-loop.md). */
export type StallKind = "selling_up" | "polite" | "unframed";
export type Stall = { kind: StallKind; text: string };
export type Prep = { verdict: string; checks: PrepCheck[]; stall: Stall | null; questions: string[] };

export type PrepInput = {
  now: number;
  company: string | null;
  dealName: string;
  members: ReadonlyArray<{ name: string; role: DealRole; thread: Thread }>;
  steps: ReadonlyArray<{ channel: Channel; dueOn: string | null; state: StepState; doneByTouch: boolean }>;
  windowLabel: string | null;
  windowDays: number | null;
  hasWhyNow: boolean;
};

// ───────────────────────────── Stage ─────────────────────────────

/** Where a deal is, which decides the deal page's job. A recipe names the stages and decides which one a deal is in. */
export const DEAL_STAGES = ["in", "case", "close"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Someone the deal could reach first: on the deal, at the company in Canon, or named by research and not in Canon. */
export type Prospect = {
  key: string; contactId: string | null; itemId: string | null; name: string; title: string | null;
  source: "deal" | "company" | "research"; role: DealRole | null; buyer: boolean; researched: boolean;
  why: string | null; reached: string | null; suggested: boolean;
  /** People research's reading of them (lib/plays/peopleResearch.ts): Jev's remit call and the capability hypothesis. */
  center: "innovation" | "stability" | null; capability: string | null;
};

// ───────────────────────────── Overview ─────────────────────────────

/** A play's counts for the plays list, saved with each keeper check. */
export type PlaySummary = { people: number; engaged: number; repliesOwed: number; coreFilled: number; openSteps: number; nextDue?: string };

/** `coreRoles`: the roles the recipe counts as the committee's core. */
export function summaryOf(members: ReadonlyArray<{ role: DealRole; thread: Thread }>, steps: ReadonlyArray<{ state: StepState; dueOn: string | null; doneByTouch: boolean }>, coreRoles: readonly DealRole[]): PlaySummary {
  const open = steps.filter((s) => s.state === "planned" && !s.doneByTouch);
  const due = open.map((s) => s.dueOn).filter((d): d is string => Boolean(d)).sort()[0];
  return {
    people: members.length,
    engaged: members.filter((m) => m.thread.state === "engaged" || m.thread.state === "replied").length,
    repliesOwed: members.filter((m) => m.thread.state === "replied").length,
    coreFilled: coreRoles.filter((r) => members.some((m) => m.role === r)).length,
    openSteps: open.length,
    ...(due ? { nextDue: due } : {}),
  };
}

export type OrgNode<T> = { person: T; reports: Array<OrgNode<T>> };

/**
 * The account map as a tree from each person's `reportsTo`. A person whose manager isn't on the deal, or who sits in
 * a reporting loop, is a root, so everyone appears exactly once.
 */
export function orgTree<T extends { contactId: string; reportsTo: string | null }>(people: readonly T[]): Array<OrgNode<T>> {
  const byId = new Map(people.map((p) => [p.contactId, p]));
  const managerOf = (p: T): string | null => {
    // Walk up; a loop back to `p` makes it a root.
    const seen = new Set([p.contactId]);
    const m = p.reportsTo && byId.has(p.reportsTo) ? p.reportsTo : null;
    for (let cur = m; cur; ) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const next = byId.get(cur)!.reportsTo;
      cur = next && byId.has(next) ? next : null;
    }
    return m;
  };
  const nodes = new Map(people.map((p) => [p.contactId, { person: p, reports: [] as Array<OrgNode<T>> }]));
  const roots: Array<OrgNode<T>> = [];
  for (const p of people) {
    const m = managerOf(p);
    if (m) nodes.get(m)!.reports.push(nodes.get(p.contactId)!);
    else roots.push(nodes.get(p.contactId)!);
  }
  return roots;
}
