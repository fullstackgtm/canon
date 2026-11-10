/**
 * What a call changed in the CRM (convex/callFactActions.ts reads the call):
 * the call's context for the prompt, and the proposals it made, submitted
 * through the agent write gate as `sourceKind: "call"` for the person whose
 * meeting it was. An email thread or LinkedIn conversation read the same way
 * (lib/conversations/facts.ts) submits through `submitConversation` with its
 * own kind. The org's ownership and auto-accept rules decide what applies at
 * once; the rest waits in the review queue.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { accessFor, dealVisible } from "./permissions";
import { submitProposalBatch } from "./canonGate";
import { candidateDeals } from "./granola";
import { declaredLabel } from "./lib/agents/attribution";
import { CALL_FACTS_MAX_AGE_MS } from "./lib/calls/granola";
import { isOurSide, teamAddresses, teamOf } from "./lib/calls/suggestions";
import { modelSettings } from "./lib/recipes";
import type { ConversationKind } from "./lib/conversations/facts";

/** Workspace members a call's people are checked against. */
const MEMBERS_MAX = 500;

/** The label the gate's review queue shows for these proposals, by what was read. */
const SOURCE_LABEL: Record<ConversationKind, string> = { call: "granola", email: "gmail", linkedin: "linkedin" };
/** How the review queue names what was read. */
const SOURCE_NOUN: Record<ConversationKind, { batch: string; it: string; quotes: string }> = {
  call: { batch: "Call", it: "the meeting", quotes: "the call" },
  email: { batch: "Email", it: "the email thread", quotes: "the thread" },
  linkedin: { batch: "LinkedIn", it: "the LinkedIn conversation", quotes: "the conversation" },
};

/** A call's transcript, summary and deal as `userId` sees them, and the people it was matched to. */
export const context = internalQuery({
  args: { orgId: v.id("organizations"), callId: v.id("callRecordings"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    const user = await ctx.db.get(args.userId);
    if (!call || call.orgId !== args.orgId || !user || user.orgId !== args.orgId || !user.isActive || !call.transcriptText) return null;
    const metadata = (call.sourceMetadata ?? {}) as Record<string, unknown>;
    const deal = call.dealId ? await ctx.db.get(call.dealId) : null;
    const seen = deal && deal.orgId === args.orgId && dealVisible(await accessFor(ctx, user), deal) ? deal : null;
    const participants = Array.isArray(call.participants) ? (call.participants as Array<Record<string, unknown>>) : [];
    const memberRows = (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(MEMBERS_MAX)).filter((m) => m.isActive);
    const members = memberRows.map((m) => m.email.toLowerCase());
    const emails = participants.flatMap((p) => (typeof p.email === "string" ? [p.email.toLowerCase()] : []));
    const startAt = call.callDate ? Date.parse(call.callDate) : call.createdAt;
    const integration = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).first();
    const ourTeam = Array.isArray(integration?.syncConfig?.granolaOurTeam) ? (integration.syncConfig.granolaOurTeam as string[]) : [];
    const team = teamOf(members, ourTeam);
    const contactIds = Array.isArray(metadata.contactIds) ? (metadata.contactIds as string[]) : [];
    const accountIds = Array.isArray(metadata.accountIds) ? (metadata.accountIds as string[]) : [];
    // A meeting with a company the workspace has won a deal with is a customer's: not new business by default.
    let customer = false;
    for (const d of (await candidateDeals(ctx, args.orgId, await accessFor(ctx, user), contactIds, accountIds.map((id) => ({ id })))).filter((x) => x.isClosed)) {
      if ((await ctx.db.get(d.dealId as Id<"deals">))?.forecastCategory === "closed_won") customer = true;
    }
    return {
      customer,
      teamAddresses: teamAddresses(team),
      // Our side's people by name: never suggested as the other company's.
      memberNames: memberRows.map((m) => m.name),
      ownerEmail: participants.find((p) => p.role === "owner" && typeof p.email === "string")?.email as string | undefined,
      ownerName: (participants.find((p) => p.role === "owner")?.name as string | undefined) || "Me",
      webUrl: typeof metadata.webUrl === "string" ? metadata.webUrl : null,
      // Our side: the note's owner or someone on the call is a member, at a member's company, or on the team list an admin keeps.
      memberAttended: emails.some((e) => isOurSide(team, e)),
      membersOnly: integration?.syncConfig?.granolaSuggestMembersOnly !== false,
      recent: startAt >= Date.now() - CALL_FACTS_MAX_AGE_MS,
      accountIds,
      title: call.title,
      meetingDay: (call.callDate ?? new Date(call.createdAt).toISOString()).slice(0, 10),
      summary: typeof metadata.summary === "string" ? metadata.summary : null,
      transcript: call.transcriptText,
      deal: seen ? { id: seen._id, name: seen.name, stage: seen.stage ?? null, nextStep: seen.nextStep ?? null, closeDate: seen.closeDate || null } : null,
      contactIds,
      attendees: participants.flatMap((p) => (p.role === "attendee" && typeof p.email === "string" ? [{ email: p.email, name: typeof p.name === "string" ? p.name : null }] : [])),
      define: (await modelSettings(ctx, args.orgId, "calls.model")).define,
    };
  },
});

const fact = v.union(
  v.object({ entityType: v.literal("opportunity"), attribute: v.union(v.literal("nextStep"), v.literal("closeDate")), value: v.string(), evidence: v.string() }),
  v.object({ entityType: v.literal("contact"), contactId: v.string(), attribute: v.literal("title"), value: v.string(), evidence: v.string() }),
);

type Fact = typeof fact.type;

/**
 * Propose what one conversation established, as `userId`, with the conversation's kind as the source. The contact
 * facts' ids must come from that person's scoped client (CP14): they are admitted without another check.
 */
async function proposeConversationFacts(ctx: MutationCtx, a: {
  orgId: Id<"organizations">; userId: Id<"users">; kind: ConversationKind; title: string; dealId?: Id<"deals">; facts: Fact[]; model: string;
}) {
  const noun = SOURCE_NOUN[a.kind];
  return await submitProposalBatch(ctx, {
    attribution: { kind: "user", orgId: a.orgId, userId: a.userId, label: declaredLabel(SOURCE_LABEL[a.kind]) },
    sourceKind: a.kind,
    title: `${noun.batch}: ${a.title}`,
    reason: `Read from ${noun.it} "${a.title}" by ${a.model}; each value quotes ${noun.quotes}.`,
    facts: a.facts.map((f) => f.entityType === "opportunity"
      ? { entityType: "opportunity" as const, dealId: a.dealId, attribute: f.attribute, value: f.value, evidence: f.evidence, confidence: 0.7 }
      : { entityType: "contact" as const, recordId: f.contactId, attribute: f.attribute, value: f.value, evidence: f.evidence, confidence: 0.7 }),
    admitted: a.facts.flatMap((f) => (f.entityType === "contact" ? [f.contactId] : [])),
  });
}

/** Propose what the call established, as the person whose meeting it was; record the batch on the call. */
export const submit = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), callId: v.id("callRecordings"), dealId: v.optional(v.id("deals")), facts: v.array(fact), model: v.string() },
  handler: async (ctx, args): Promise<{ proposed: number; rejected: number } | null> => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) return null;
    // The contacts were matched through this person's scoped client when the meeting was logged.
    const result = await proposeConversationFacts(ctx, { ...args, kind: "call", title: call.title });
    const metadata = (call.sourceMetadata ?? {}) as Record<string, unknown>;
    await ctx.db.patch(call._id, {
      sourceMetadata: { ...metadata, callFacts: { patchPlanId: result.patchPlanId, proposed: result.proposed, rejected: result.rejected.length } },
      updatedAt: Date.now(),
    });
    return { proposed: result.proposed, rejected: result.rejected.length };
  },
});

/**
 * Propose what an email thread or LinkedIn conversation established (lib/conversations/facts.ts grounds the facts),
 * as the inbox's owner. The gate keys the batch by its attribution, not by the conversation, so the caller keeps the
 * returned batch on its conversation. Contact ids must come from the owner's scoped client.
 */
export const submitConversation = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"),
    kind: v.union(v.literal("email"), v.literal("linkedin")),
    title: v.string(), dealId: v.optional(v.id("deals")), facts: v.array(fact), model: v.string(),
  },
  handler: async (ctx, args): Promise<{ patchPlanId: Id<"patchPlans"> | null; proposed: number; rejected: number } | null> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId || !user.isActive) return null;
    const result = await proposeConversationFacts(ctx, args);
    return { patchPlanId: result.patchPlanId, proposed: result.proposed, rejected: result.rejected.length };
  },
});
