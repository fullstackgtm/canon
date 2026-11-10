/**
 * Calendar events as meetings (docs/calendar-meetings.md). A transport hands a member's events to `ingest`, which
 * matches the people on each as the member sees them, decides whether it is a meeting (lib/calendar/events.ts), and
 * writes it through `logEvent` the way Granola writes its notes (convex/granola.ts logMeeting): a `meeting` activity
 * about the people, their companies and their open deal, under the member's visibility. An event with no one from
 * outside the team who is in Canon is never stored; the unknown people with business domains on a logged one are
 * suggested (lib/calls/suggestions.ts planSuggestions), and nothing is created from them.
 *
 * No transport is wired yet: devSeed.seedCalendarEvents feeds fixture events through `ingest` on a local stack.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { saveAsCaller } from "./objects";
import { attachTargets } from "./activityTargets";
import { accessFor } from "./permissions";
import { candidateDeals } from "./granola";
import { contactsByEmail } from "./conversationActions";
import { principalClient } from "./records";
import { pickDeal, domainOfEmail } from "./lib/calls/granola";
import { planSuggestions, teamOf } from "./lib/calls/suggestions";
import { decideEvent, meetingValuesOf, type CalendarEvent, type EventDecision } from "./lib/calendar/events";
import { granolaMeetingFor } from "./lib/calendar/links";
import { FREE_EMAIL_DOMAINS } from "../engine/src/freeEmailDomains";

const EVENTS_MAX = 200;

const attendeeV = v.object({
  email: v.string(), name: v.optional(v.string()),
  response: v.union(v.literal("accepted"), v.literal("declined"), v.literal("tentative"), v.literal("pending")),
});
export const calendarEventV = v.object({
  icalUid: v.string(), instanceStart: v.number(), title: v.string(), startAt: v.number(), endAt: v.union(v.number(), v.null()),
  allDay: v.boolean(), cancelled: v.boolean(),
  visibility: v.union(v.literal("default"), v.literal("public"), v.literal("private"), v.literal("confidential")),
  eventType: v.string(), attendees: v.array(attendeeV), location: v.optional(v.string()),
});

/**
 * Write one event the member's calendar logs as a meeting. The same event again (its UID and first scheduled start)
 * updates its meeting: a moved start moves it, a cancellation sets it `canceled`. A first sighting of a meeting a
 * Granola note already logged links to that meeting instead of adding a second. A cancellation of an event Canon
 * never logged stores nothing.
 */
export const logEvent = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), event: calendarEventV,
    contactIds: v.array(v.string()), companies: v.array(v.object({ id: v.string(), domain: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<{ status: "logged" | "updated" | "linked" | "skipped"; meetingStreamId: string | null }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId || !user.isActive) return { status: "skipped", meetingStreamId: null };
    const { event } = args;
    const link = await ctx.db.query("calendarEventLinks")
      .withIndex("by_ownerUserId_and_icalUid_and_instanceStart", (q) => q.eq("ownerUserId", user._id).eq("icalUid", event.icalUid).eq("instanceStart", event.instanceStart))
      .first();
    const now = Date.now();
    const accountIds = args.companies.map((c) => c.id);
    if (link) {
      const moved = link.startAt !== event.startAt;
      if (!moved && !event.cancelled) return { status: "skipped", meetingStreamId: link.meetingStreamId };
      const values = event.cancelled ? { outcome: "canceled" } : { startAt: event.startAt, ...(event.endAt !== null && event.endAt > event.startAt ? { endAt: event.endAt } : {}) };
      const result = await saveAsCaller(ctx, user, "meeting", { op: "update", streamId: link.meetingStreamId, values });
      if (result.status === "invalid" || result.status === "conflict") return { status: "skipped", meetingStreamId: link.meetingStreamId };
      await ctx.db.patch(link._id, { startAt: event.startAt, updatedAt: now });
      return { status: "updated", meetingStreamId: link.meetingStreamId };
    }
    if (event.cancelled) return { status: "skipped", meetingStreamId: null };
    const access = await accessFor(ctx, user);
    const deal = pickDeal(await candidateDeals(ctx, args.orgId, access, args.contactIds, args.companies));
    const targets = [...args.contactIds, ...accountIds, ...(deal ? [deal.streamId] : [])];
    const granola = await granolaMeetingFor(ctx, args.orgId, user._id, event.startAt, args.contactIds);
    let streamId = granola;
    if (!streamId) {
      const result = await saveAsCaller(ctx, user, "meeting", {
        op: "create",
        values: {
          ...meetingValuesOf(event), ownerId: user._id,
          ...(args.contactIds[0] ? { contactId: args.contactIds[0] } : {}), ...(accountIds[0] ? { accountId: accountIds[0] } : {}), ...(deal ? { dealId: deal.streamId } : {}),
        },
      });
      if (result.status === "invalid" || result.status === "conflict") return { status: "skipped", meetingStreamId: null };
      streamId = result.streamId;
    }
    await attachTargets(ctx, user, streamId, targets);
    await ctx.db.insert("calendarEventLinks", {
      orgId: args.orgId, ownerUserId: user._id, icalUid: event.icalUid, instanceStart: event.instanceStart,
      meetingStreamId: streamId, startAt: event.startAt, contactIds: args.contactIds, updatedAt: now,
    });
    return { status: granola ? "linked" : "logged", meetingStreamId: streamId };
  },
});

/**
 * Log a member's calendar events (a transport's page of them, recurring ones expanded): match each one's people as
 * the member sees them, keep the meetings, and suggest the unknown people with business domains on them. Returns
 * what each event came to, in order.
 */
export const ingest = internalAction({
  args: { orgId: v.id("organizations"), userId: v.id("users"), memberEmail: v.string(), events: v.array(calendarEventV) },
  handler: async (ctx, args): Promise<string[]> => {
    const events = args.events.slice(0, EVENTS_MAX);
    const who = { orgId: args.orgId, userId: args.userId };
    const { memberEmails, ourTeam } = await ctx.runQuery(internal.conversations.emailTeam, { orgId: args.orgId });
    const team = teamOf(memberEmails, ourTeam);
    const emails = [...new Set(events.flatMap((e) => e.attendees.map((a) => a.email.toLowerCase())))];
    const contacts = await contactsByEmail(ctx, who, emails);
    const accounts = await accountsByDomain(ctx, who, [...new Set(emails.map(domainOfEmail).filter((d) => !FREE_EMAIL_DOMAINS.has(d)))]);
    const out: string[] = [];
    for (const event of events) {
      const decision: EventDecision = decideEvent(event as CalendarEvent, { member: args.memberEmail, team, contacts, accounts, now: Date.now() });
      if (!decision.log) {
        out.push(decision.reason);
        continue;
      }
      const companies = decision.accountIds.map((id) => ({ id, domain: [...accounts].find(([, a]) => a === id)![0] }));
      const logged = await ctx.runMutation(internal.calendarEvents.logEvent, { ...who, event, contactIds: decision.contactIds, companies });
      out.push(logged.status);
      if (logged.status === "logged" && logged.meetingStreamId && decision.unknown.length) {
        await suggestUnknown(ctx, who, logged.meetingStreamId, decision, contacts, accounts);
      }
    }
    return out;
  },
});

/** Canon companies by business domain, as the member sees them: a domain with one company. */
async function accountsByDomain(ctx: ActionCtx, who: { orgId: Id<"organizations">; userId: Id<"users"> }, domains: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!domains.length) return out;
  const owner = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: who.orgId, userId: who.userId });
  if (!owner) return out;
  const { rows } = await principalClient(ctx, who.orgId, [owner.access]).listRegister(who.orgId, "account", { filter: [{ field: "domain", op: "in", value: domains.slice(0, 50) }], limit: 100 });
  const hits = new Map<string, string[]>();
  for (const r of rows) {
    const domain = typeof r.values.domain === "string" ? r.values.domain.trim().toLowerCase() : null;
    if (domain) hits.set(domain, [...(hits.get(domain) ?? []), r.id]);
  }
  for (const [domain, ids] of hits) if (ids.length === 1) out.set(domain, ids[0]);
  return out;
}

/** The unknown people on a logged meeting, and their companies, as suggestions for the member (emailLog.ts suggestUnknown's rule). */
async function suggestUnknown(ctx: ActionCtx, who: { orgId: Id<"organizations">; userId: Id<"users"> }, meetingStreamId: string, decision: Extract<EventDecision, { log: true }>, contacts: ReadonlyMap<string, string>, accounts: ReadonlyMap<string, string>) {
  const domains = [...new Set(decision.outside.map((a) => domainOfEmail(a.email)).filter((d) => !FREE_EMAIL_DOMAINS.has(d)))];
  const planned = planSuggestions({
    callKey: meetingStreamId, attendees: decision.outside.map((a) => ({ email: a.email.toLowerCase(), name: a.name ?? null })),
    knownEmails: new Set(contacts.keys()), knownDomains: new Set(accounts.keys()), meetingDomains: domains, hasDeal: true, recent: true,
    read: { companyNames: {}, titles: {}, opportunity: null },
  });
  if (planned.length) await ctx.runMutation(internal.callSuggestions.record, { ...who, meetingStreamId, suggestions: planned, reason: "suggested" });
}
