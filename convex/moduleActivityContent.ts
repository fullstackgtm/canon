/**
 * What was said on a deal, for a module's read plan (docs/modules.md, "Server code": activity content, shared gap P11):
 * the recorded calls and meetings filed on deals (`callRecordings`: Granola, the dialer, imported Gong and others), each
 * with the activity it belongs to when Canon logged one, and its transcript as speaker-labelled lines. The call's action
 * (lib/modules/recordReads.ts) asks only for the deals the caller sees, as the plan's query checked them.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { accessFor, dealVisible } from "./permissions";
import { permissionOf } from "./lib/access";
import { membersOf } from "./dealCommittee";
import { sourceInventoryOf } from "./dealGaps";
import { sourceMatches } from "./lib/deals/gaps";
import { mayReadText } from "./lib/conversations/intake";
import { readableThread } from "./lib/conversations/store";
import { isOurSide, teamOf } from "./lib/calls/suggestions";

export const dealConversations = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), dealIds: v.array(v.string()), domains: v.record(v.string(), v.string()), fields: v.array(v.string()), limit: v.number() },
  handler: async (ctx, a): Promise<Array<Record<string, unknown>>> => {
    const user = await ctx.db.get(a.userId);
    if (!user?.isActive || user.orgId !== a.orgId) return [];
    const access = await accessFor(ctx, user);
    if (!permissionOf(access, "deal").read) return [];
    const members = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", a.orgId)).take(500);
    const integration = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", a.orgId).eq("provider", "granola")).first();
    const extra: unknown = integration?.syncConfig?.granolaOurTeam;
    const team = teamOf(members.map((m) => m.email), Array.isArray(extra) ? extra.filter((x): x is string => typeof x === "string") : []);
    const out: Array<{ at: number; row: Record<string, unknown> }> = [];
    let chars = 0;
    for (const raw of a.dealIds) {
      const id = ctx.db.normalizeId("deals", raw);
      const deal = id ? await ctx.db.get(id) : null;
      if (!deal || deal.orgId !== a.orgId || deal.archivedAt !== undefined || !dealVisible(access, deal)) continue;
      const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", a.orgId).eq("projectionId", deal._id)).first();
      const people = stream ? await membersOf(ctx, a.orgId, deal, stream._id) : [];
      const inventory = await sourceInventoryOf(ctx, { orgId: a.orgId, userId: deal.primaryRepId ?? a.userId, dealId: deal._id });
      const matched = inventory.sources.filter((s) => s.kind !== "call" && sourceMatches({ name: deal.name, contactIds: people.map((p) => p.contactId), companyDomain: a.domains[raw] ?? null }, s));
      if (out.length + matched.length > a.limit) throw new ConvexError("Too many deal conversations; read fewer deals or raise the limit.");
      for (const s of matched) {
        const threadId = ctx.db.normalizeId("conversations", s.id);
        const thread = threadId ? await ctx.db.get(threadId) : null;
        if (!thread || thread.orgId !== a.orgId) continue;
        const read = await readableThread(ctx, access, thread, 100);
        const value = {
          dealId: raw, channel: thread.channel, at: thread.lastMessageAt, ownerUserId: thread.ownerUserId,
          counterpart: thread.counterpart, subject: mayReadText(access, thread.ownerUserId) ? thread.subject ?? null : null,
          messages: read.messages.map((m) => ({ ...m, buyer: m.direction === "in" && (thread.channel === "linkedin" || !isOurSide(team, m.from)) })),
          more: read.more, inventoryLimited: inventory.limited,
        };
        const row = { id: `${raw}:${thread._id}`, createdAt: thread.createdAt, ...Object.fromEntries(a.fields.filter((f) => Object.hasOwn(value, f)).map((f) => [f, value[f as keyof typeof value]])) };
        chars += JSON.stringify(row).length;
        if (chars > 3_000_000) throw new ConvexError("Conversation evidence exceeds this read's character limit; read fewer deals.");
        out.push({ at: thread.lastMessageAt, row });
      }
    }
    return out.sort((x, y) => y.at - x.at).map(({ row }) => row);
  },
});

/** Recordings one deal holds, and insights one recording holds, that a read takes; past either it refuses. */
const RECORDINGS_MAX = 500;
/** Transcript lines one recording reads; a longer one falls back to its stored text. */
const SEGMENTS_MAX = 4000;
const INSIGHTS_MAX = 200;

/** The activity a recording belongs to: a Granola meeting's stream, or the dialer call's activity. */
async function activityOf(ctx: QueryCtx, r: Doc<"callRecordings">): Promise<string | null> {
  const meta = (r.sourceMetadata ?? {}) as Record<string, unknown>;
  if (typeof meta.meetingStreamId === "string") return meta.meetingStreamId;
  if (typeof meta.dialerCallId === "string") {
    const id = ctx.db.normalizeId("dialerCalls", meta.dialerCallId);
    const call = id ? await ctx.db.get(id) : null;
    return call?.orgId === r.orgId ? call.activityStreamId ?? null : null;
  }
  return null;
}

export type RecordingMeta = { id: string; activityId: string | null; dealId: string; title: string; at: number | null; ownerId: string | null; provider: string };

/** The recordings filed on `dealIds` (deals the caller sees), since `since` (ms) when given. */
export const recordingsOf = internalQuery({
  args: { orgId: v.id("organizations"), dealIds: v.array(v.string()), since: v.union(v.number(), v.null()) },
  handler: async (ctx, a): Promise<RecordingMeta[] | { over: true }> => {
    const out: RecordingMeta[] = [];
    for (const raw of a.dealIds) {
      const dealId = ctx.db.normalizeId("deals", raw);
      if (!dealId) continue;
      const recordings = await ctx.db.query("callRecordings").withIndex("by_dealId", (q) => q.eq("dealId", dealId)).take(RECORDINGS_MAX + 1);
      // Past the cap, before any date filter: a read never returns part of a deal's recordings as all of them.
      if (recordings.length > RECORDINGS_MAX) return { over: true };
      for (const r of recordings) {
        if (r.orgId !== a.orgId) continue;
        const at = r.callDate ? Date.parse(r.callDate) : r._creationTime;
        if (a.since !== null && Number.isFinite(at) && at < a.since) continue;
        out.push({ id: r._id, activityId: await activityOf(ctx, r), dealId: raw, title: r.title, at: Number.isFinite(at) ? at : null, ownerId: r.ownerId ?? null, provider: r.provider });
        if (out.length > RECORDINGS_MAX) return { over: true };
      }
    }
    return out;
  },
});

const SIDE = { rep: "Rep", customer: "Customer", unknown: "Speaker" } as const;

/** One recording's transcript, a line per turn ("Customer (Sam Lee): ..."), and its insights. */
export const recordingContent = internalQuery({
  args: { orgId: v.id("organizations"), id: v.string() },
  handler: async (ctx, a): Promise<{ transcript: string | null; insights: Array<{ type: string; text: string; evidence: string }> } | { over: true } | null> => {
    const id = ctx.db.normalizeId("callRecordings", a.id);
    const r = id ? await ctx.db.get(id) : null;
    if (!r || r.orgId !== a.orgId) return null;
    const segments = await ctx.db.query("callTranscriptSegments").withIndex("by_callId_segmentIndex", (q) => q.eq("callId", r._id as Id<"callRecordings">)).take(SEGMENTS_MAX + 1);
    const transcript = segments.length && segments.length <= SEGMENTS_MAX
      ? segments.map((s) => `${SIDE[s.speakerRole]}${s.speaker ? ` (${s.speaker})` : ""}: ${s.text}`).join("\n")
      : r.transcriptText ?? null;
    const rows = await ctx.db.query("callInsights").withIndex("by_callId", (q) => q.eq("callId", r._id)).take(INSIGHTS_MAX + 1);
    if (rows.length > INSIGHTS_MAX) return { over: true };
    return { transcript, insights: rows.map((i) => ({ type: i.type, text: i.text, evidence: i.evidence })) };
  },
});
