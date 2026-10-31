/**
 * One sender action against Unipile (docs/linkedin-cadences.md, "Work"): an
 * invite, a message, or a sync of accepted and overdue invites. Each returns
 * the calls made (for the caps), what happened to each contact, and any
 * pushback for the account. convex/linkedinWorker.ts claims the job and
 * records the result; this file only talks to Unipile, so tests run it
 * against a fake client.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { Id } from "../../_generated/dataModel";
import { commentTimes, dormantReason, isDormant, latestOf, postTimes } from "./activity.ts";
import { accountEffectOf, inviteRefusal, messageRefusal, type AccountEffect, type ContactOutcome } from "./outcomes.ts";
import { UnipileError, type UnipileClient } from "./unipile.ts";

const RELATION_PAGES = 3;

export type EnrollmentRef = { id: Id<"linkedinEnrollments">; providerId: string | null; publicIdentifier: string; invitationId: string | null };
export type Job =
  /** `activeWithinDays`: check their recent posts and comments first, and stop them if quiet that long. Null skips the check. */
  | { kind: "invite"; unipileAccountId: string; enrollment: EnrollmentRef; note: string | null; activeWithinDays: number | null }
  | { kind: "message"; unipileAccountId: string; enrollment: EnrollmentRef & { chatId: string | null; since: number }; text: string }
  | { kind: "sync"; unipileAccountId: string; invited: EnrollmentRef[]; overdue: EnrollmentRef[]; lookups: number }
  | { kind: "skip" };


export type SendRow = { kind: "lookup" | "invite" | "message" | "withdraw" | "sync"; ok: boolean; error?: string; enrollmentId?: Id<"linkedinEnrollments"> };
export type Event =
  | { event: "invited"; id: Id<"linkedinEnrollments">; providerId: string; invitationId?: string }
  | { event: "connected"; id: Id<"linkedinEnrollments">; providerId?: string; accepted: boolean; acceptedAt?: number }
  | { event: "sent"; id: Id<"linkedinEnrollments">; chatId?: string; messageId?: string }
  | { event: "replied"; id: Id<"linkedinEnrollments"> }
  | { event: "withdrawn"; id: Id<"linkedinEnrollments"> }
  | { event: "retry"; id: Id<"linkedinEnrollments">; reason: string }
  | { event: "fail"; id: Id<"linkedinEnrollments">; reason: string }
  | { event: "activity"; id: Id<"linkedinEnrollments">; providerId: string; lastActiveAt: number | null }
  | { event: "dormant"; id: Id<"linkedinEnrollments">; reason: string };
export type Result = { sends: SendRow[]; events: Event[]; effect: AccountEffect | null };

const refusalOf = (cause: unknown) => (cause instanceof UnipileError ? { status: cause.status, type: cause.type } : null);
const errorText = (cause: unknown) => (cause instanceof UnipileError ? cause.type ?? `HTTP ${cause.status}` : "unexpected error");

function contactEvent(id: Id<"linkedinEnrollments">, outcome: ContactOutcome, providerId?: string): Event {
  switch (outcome.kind) {
    case "connected": return { event: "connected", id, providerId, accepted: false };
    case "invited": return { event: "invited", id, providerId: providerId ?? "" };
    case "retry": return { event: "retry", id, reason: outcome.reason };
    case "fail": return { event: "fail", id, reason: outcome.reason };
  }
}

export async function performInvite(client: UnipileClient, job: Extract<Job, { kind: "invite" }>, now = Date.now()): Promise<Result> {
  const { enrollment: e, unipileAccountId: account } = job;
  const sends: SendRow[] = [];
  let providerId = e.providerId;
  let stage: "lookup" | "invite" = "lookup";
  // Kept on every path, so a check that finished is stored even when the invite after it fails.
  const events: Event[] = [];
  try {
    if (!providerId) {
      const profile = await client.getProfile(account, e.publicIdentifier);
      sends.push({ kind: "lookup", ok: Boolean(profile), enrollmentId: e.id });
      if (!profile) return { sends, events: [{ event: "fail", id: e.id, reason: "LinkedIn profile not found" }], effect: null };
      providerId = profile.providerId;
      if (profile.connected) return { sends, events: [{ event: "connected", id: e.id, providerId, accepted: false }], effect: null };
      if (profile.invitePending) return { sends, events: [{ event: "invited", id: e.id, providerId }], effect: null };
    }
    if (job.activeWithinDays !== null) {
      const posts = await client.recentPosts(account, providerId);
      sends.push({ kind: "lookup", ok: true, enrollmentId: e.id });
      const comments = await client.recentComments(account, providerId);
      sends.push({ kind: "lookup", ok: true, enrollmentId: e.id });
      const last = Math.max(latestOf(posts, postTimes, now) ?? 0, latestOf(comments, commentTimes, now) ?? 0) || null;
      events.push({ event: "activity", id: e.id, providerId, lastActiveAt: last });
      if (isDormant(last, now, job.activeWithinDays)) return { sends, events: [...events, { event: "dormant", id: e.id, reason: dormantReason(last, job.activeWithinDays) }], effect: null };
    }
    stage = "invite";
    const { invitationId } = await client.invite(account, providerId, job.note ?? undefined);
    sends.push({ kind: "invite", ok: true, enrollmentId: e.id });
    return { sends, events: [...events, { event: "invited", id: e.id, providerId, ...(invitationId ? { invitationId } : {}) }], effect: null };
  } catch (cause) {
    sends.push({ kind: stage, ok: false, error: errorText(cause), enrollmentId: e.id });
    const refusal = refusalOf(cause);
    if (!refusal) return { sends, events: [...events, { event: "retry", id: e.id, reason: "Unexpected error" }], effect: null };
    const outcome = stage === "invite" ? inviteRefusal(refusal) : { kind: "retry" as const, reason: `Profile lookup refused (${errorText(cause)})` };
    return { sends, events: [...events, contactEvent(e.id, outcome, providerId ?? undefined)], effect: accountEffectOf(refusal, stage) };
  }
}

export async function performMessage(client: UnipileClient, job: Extract<Job, { kind: "message" }>): Promise<Result> {
  const { enrollment: e, unipileAccountId: account } = job;
  const sends: SendRow[] = [];
  try {
    if (!e.providerId) return { sends, events: [{ event: "fail", id: e.id, reason: "No LinkedIn id for this contact" }], effect: null };
    // Stop before sending if they wrote to us since the invite: a reply ends the cadence.
    const chats = e.chatId ? [e.chatId] : (await client.chatsWith(account, e.providerId)).slice(0, 2);
    for (const chat of chats) {
      if (await client.repliedSince(chat, e.since)) return { sends, events: [{ event: "replied", id: e.id }], effect: null };
    }
    const chatId = chats[0] ?? null;
    if (chatId) {
      const messageId = (await client.sendMessage(account, chatId, job.text))?.messageId;
      sends.push({ kind: "message", ok: true, enrollmentId: e.id });
      return { sends, events: [{ event: "sent", id: e.id, chatId, ...(messageId ? { messageId } : {}) }], effect: null };
    }
    const started = await client.startChat(account, e.providerId, job.text);
    sends.push({ kind: "message", ok: true, enrollmentId: e.id });
    return { sends, events: [{ event: "sent", id: e.id, ...(started.chatId ? { chatId: started.chatId } : {}), ...(started.messageId ? { messageId: started.messageId } : {}) }], effect: null };
  } catch (cause) {
    const refusal = refusalOf(cause);
    sends.push({ kind: "message", ok: false, error: errorText(cause), enrollmentId: e.id });
    if (!refusal) return { sends, events: [{ event: "retry", id: e.id, reason: "Unexpected error" }], effect: null };
    return { sends, events: [contactEvent(e.id, messageRefusal(refusal))], effect: accountEffectOf(refusal, "message") };
  }
}

export async function performSync(client: UnipileClient, job: Extract<Job, { kind: "sync" }>): Promise<Result> {
  const account = job.unipileAccountId;
  const sends: SendRow[] = [];
  const events: Event[] = [];
  try {
    // Each relation's connection time (or null), by member id and by profile slug.
    const members = new Map<string, number | null>();
    const slugs = new Map<string, number | null>();
    let cursor: string | undefined;
    for (let page = 0; page < RELATION_PAGES; page++) {
      const out = await client.relations(account, cursor);
      for (const r of out.items) {
        if (r.memberId) members.set(r.memberId, r.connectedAt);
        if (r.publicIdentifier) slugs.set(r.publicIdentifier.toLowerCase(), r.connectedAt);
      }
      if (!out.cursor) break;
      cursor = out.cursor;
    }
    sends.push({ kind: "sync", ok: true });
    const accepted = new Set<string>();
    for (const e of job.invited) {
      const slug = e.publicIdentifier.toLowerCase();
      if ((e.providerId && members.has(e.providerId)) || slugs.has(slug)) {
        accepted.add(e.id);
        const at = (e.providerId ? members.get(e.providerId) : null) ?? slugs.get(slug) ?? null;
        events.push({ event: "connected", id: e.id, accepted: true, ...(at ? { acceptedAt: at } : {}) });
      }
    }
    const overdue = job.overdue.filter((e) => !accepted.has(e.id));
    let lookups = job.lookups;
    let sent: Map<string, string> | null = null;
    for (const e of overdue) {
      // An acceptance older than the relations we read still counts: check before withdrawing.
      if (lookups > 0) {
        lookups--;
        const profile = await client.getProfile(account, e.providerId ?? e.publicIdentifier);
        sends.push({ kind: "lookup", ok: Boolean(profile), enrollmentId: e.id });
        if (profile?.connected) { events.push({ event: "connected", id: e.id, providerId: profile.providerId, accepted: true }); continue; }
        if (profile && !profile.invitePending) { events.push({ event: "withdrawn", id: e.id }); continue; }
      }
      let invitationId = e.invitationId;
      if (!invitationId) {
        sent ??= await client.sentInvites(account);
        invitationId = (e.providerId && sent.get(e.providerId)) || sent.get(e.publicIdentifier.toLowerCase()) || null;
      }
      if (invitationId) {
        await client.cancelInvite(account, invitationId);
        sends.push({ kind: "withdraw", ok: true, enrollmentId: e.id });
      }
      events.push({ event: "withdrawn", id: e.id });
    }
    return { sends, events, effect: null };
  } catch (cause) {
    sends.push({ kind: "sync", ok: false, error: errorText(cause) });
    const refusal = refusalOf(cause);
    return { sends, events, effect: refusal ? accountEffectOf(refusal, "sync") : null };
  }
}

