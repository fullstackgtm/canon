import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { dealOfStream, mayEdit } from "./dealCommittee";
import { ensurePlay, playOf } from "./dealPlays";
import { accessFor, dealVisible } from "./permissions";
import { fieldLevel, isRestricted, may } from "./lib/access";
import { mayReadText, EXTRACT_QUIET_MS } from "./lib/conversations/intake";
import { readableThread } from "./lib/conversations/store";
import { isOurSide, teamOf } from "./lib/calls/suggestions";
import { stateValidator, summarizeState, mergeConcerns, buyerCallTexts, type StateSource } from "./lib/plays/state";
import { sourceMatches } from "./lib/deals/gaps";
import { asEntry, loadDef } from "./objects";
import { stageVisits } from "./lib/objects/stageHistory";
import { orgRecipe } from "./lib/recipes";
import { RESEARCH_STALL_MS } from "./lib/plays/runs";

const principal = { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string() };

export const inputs = internalQuery({
  args: { ...principal, contactIds: v.array(v.string()), companyDomain: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ sources: StateSource[]; inventoryLimited: boolean; inventory: Array<{ id: string; at: number; revision: number }> }> => {
    const user = await ctx.db.get(args.userId);
    const deal = user?.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user?.isActive || !deal) throw new ConvexError("Deal not found");
    const access = await accessFor(ctx, user);
    if (!dealVisible(access, deal)) throw new ConvexError("Deal not found");
    const inventory = await ctx.runQuery(internal.dealGaps.sourceInventory, { orgId: args.orgId, userId: deal.primaryRepId ?? args.userId, dealId: deal._id });
    const matched = inventory.sources.filter((s) => sourceMatches({ name: deal.name, contactIds: args.contactIds, companyDomain: args.companyDomain }, s));
    const fingerprint = matched.map((s) => ({ id: s.id, at: s.at, revision: s.revision ?? s.at }));
    const sources: StateSource[] = [];
    const members = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(500);
    const integration = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).first();
    const extra: unknown = integration?.syncConfig?.granolaOurTeam;
    const team = teamOf(members.map((m) => m.email), Array.isArray(extra) ? extra.filter((x): x is string => typeof x === "string") : []);
    let left = 60_000;
    for (const s of matched) {
      const source: StateSource = { kind: s.kind, id: s.id, at: s.at, text: "", buyerTexts: [], activity: true };
      sources.push(source);
      if (left <= 0) continue;
      if (s.kind === "call") {
        const id = ctx.db.normalizeId("callRecordings", s.id);
        const call = id ? await ctx.db.get(id) : null;
        if (!call || call.orgId !== args.orgId) continue;
        const summary: unknown = call.sourceMetadata?.summary;
        const full = [typeof summary === "string" ? summary : "", call.transcriptText ?? ""].filter(Boolean).join("\n\n");
        source.text = full.slice(0, left);
        source.partial = source.text.length < full.length;
        if (call.transcriptText) {
          const segments = await ctx.db.query("callTranscriptSegments").withIndex("by_callId_segmentIndex", (q) => q.eq("callId", call._id)).take(1001);
          source.partial ||= segments.length > 1000;
          source.buyerTexts = buyerCallTexts(source.text, segments.slice(0, 1000), participantsOf(call.participants), team);
        }
      } else {
        const id = ctx.db.normalizeId("conversations", s.id);
        const thread = id ? await ctx.db.get(id) : null;
        // Check before reading any message text, including the store's alternate-inbox fallback.
        if (!thread || thread.orgId !== args.orgId || !mayReadText(access, thread.ownerUserId)) continue;
        source.ownerUserId = thread.ownerUserId;
        const read = await readableThread(ctx, access, thread, 100);
        const texts = read.messages.flatMap((m) => "text" in m ? [{ text: `${m.from}: ${m.text}`, buyer: m.direction === "in" && (thread.channel === "linkedin" || !isOurSide(team, m.from)) }] : []);
        const full = texts.map((m) => m.text).join("\n");
        source.text = full.slice(0, left);
        source.buyerTexts = texts.filter((m) => m.buyer && source.text.includes(m.text)).map((m) => m.text);
        source.partial = read.more || source.text.length < full.length;
      }
      left -= source.text.length;
    }
    const entityId = ctx.db.normalizeId("canonEntities", args.streamId);
    if (entityId) {
      const facts = await ctx.db.query("facts").withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", entityId)).take(301);
      for (const f of facts.slice(0, 300)) {
        if (f.orgId !== args.orgId || f.entityType !== "opportunity" || f.status !== "accepted" || fieldLevel(access, "deal", f.attribute) === "hidden") continue;
        sources.push({ kind: "fact", id: f._id, at: f.observedAt, text: `${f.attribute}: ${JSON.stringify(f.value)}\n${f.evidence ?? ""}`, buyerTexts: [], activity: false });
      }
      if (fieldLevel(access, "deal", "stage") !== "hidden") {
        const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entityId)).take(1001);
        const visits = stageVisits(await loadDef(ctx, args.orgId, "deal"), entries.slice(0, 1000).map(asEntry));
        sources.unshift({ kind: "deal", id: `${args.streamId}:stages`, at: 0, text: JSON.stringify(visits), buyerTexts: [], activity: false, partial: entries.length > 1000 });
      }
      return { sources, inventory: fingerprint, inventoryLimited: inventory.limited || facts.length > 300 };
    }
    return { sources, inventory: fingerprint, inventoryLimited: inventory.limited };
  },
});

function participantsOf(value: unknown): Array<{ name?: string; email?: string }> {
  return Array.isArray(value) ? value.flatMap((p: unknown) => p && typeof p === "object" ? [{
    ...("name" in p && typeof p.name === "string" ? { name: p.name } : {}),
    ...("email" in p && typeof p.email === "string" ? { email: p.email } : {}),
  }] : []) : [];
}

export const claim = internalMutation({
  args: { ...principal, inputHash: v.string(), force: v.boolean() },
  handler: async (ctx, args): Promise<number | null> => {
    const user = await ctx.db.get(args.userId);
    const deal = user?.orgId === args.orgId ? await dealOfStream(ctx, args.orgId, args.streamId) : null;
    if (!user?.isActive || !deal || !mayEdit(user, deal) || !may(await accessFor(ctx, user), "deal", "edit")) throw new ConvexError("Only deal editors can regenerate its state");
    // A role that narrows anything doesn't generate: the state is shown to every full-access reader of the deal.
    if (isRestricted(await accessFor(ctx, user))) throw new ConvexError("Your role sees only part of this deal, so it can't generate its state");
    const play = await ensurePlay(ctx, args.orgId, user, deal, args.streamId);
    const now = Math.max(Date.now(), (play.stateRun?.startedAt ?? 0) + 1);
    if (play.stateRun?.status === "running" && now - play.stateRun.startedAt < RESEARCH_STALL_MS) return null;
    if (!args.force && (play.stateInputHash === args.inputHash || (play.stateDueAt ?? 0) > now)) return null;
    await ctx.db.patch(play._id, { stateRun: { status: "running", startedAt: now, startedBy: user._id } });
    return now;
  },
});

export const finish = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), startedAt: v.number(), inputHash: v.string(), state: v.optional(stateValidator), error: v.optional(v.string()),
    // The sources the run read with text (`sourceKey`): a saved concern is resolved only when its sources were read again.
    readKeys: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    if (!play?.stateRun || play.stateRun.status !== "running" || play.stateRun.startedAt !== args.startedAt) return null;
    const run = { ...play.stateRun, finishedAt: Date.now() };
    if (args.state) {
      const concerns = mergeConcerns(play.state?.concerns ?? [], args.state.concerns, args.state.generatedAt, new Set(args.readKeys ?? []));
      if (concerns.length > 60) throw new ConvexError("This deal has reached the saved concern limit");
      const state = { ...args.state, concerns };
      if (new TextEncoder().encode(JSON.stringify(state)).length > 700_000) throw new ConvexError("Deal state exceeds the stored evidence budget");
      await ctx.db.patch(play._id, { state, stateSummary: summarizeState(state), stateInputHash: args.inputHash, stateRun: { ...run, status: "done" } });
    } else await ctx.db.patch(play._id, { stateRun: { ...run, status: "failed", error: (args.error ?? "State generation failed").slice(0, 500) } });
    return null;
  },
});

export async function queueDealState(ctx: MutationCtx, deal: Doc<"deals">) {
  const user = deal.primaryRepId ? await ctx.db.get(deal.primaryRepId) : null;
  if (!user?.isActive || user.orgId !== deal.orgId || deal.archivedAt !== undefined) return;
  const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id)).first();
  if (!stream) return;
  if (!(await orgRecipe(ctx, deal.orgId)).plays) return;
  const play = await ensurePlay(ctx, deal.orgId, user, deal, stream._id);
  const dueAt = Date.now() + EXTRACT_QUIET_MS;
  await ctx.db.patch(play._id, { stateDueAt: dueAt });
  await ctx.scheduler.runAfter(EXTRACT_QUIET_MS, internal.dealState.runDue, { orgId: deal.orgId, streamId: stream._id, dueAt });
}

export const runDue = internalMutation({
  args: { orgId: v.id("organizations"), streamId: v.string(), dueAt: v.number() },
  handler: async (ctx, args) => {
    const play = await playOf(ctx, args.orgId, args.streamId);
    const deal = play ? await ctx.db.get(play.dealId) : null;
    if (!play || play.stateDueAt !== args.dueAt || !deal?.primaryRepId || deal.archivedAt !== undefined) return null;
    if (play.stateRun?.status === "running" && Date.now() - play.stateRun.startedAt < RESEARCH_STALL_MS) {
      await ctx.scheduler.runAfter(60_000, internal.dealState.runDue, args);
      return null;
    }
    await ctx.db.patch(play._id, { stateDueAt: undefined });
    await ctx.scheduler.runAfter(0, internal.dealStateActions.generate, { orgId: args.orgId, userId: deal.primaryRepId, streamId: args.streamId });
    return null;
  },
});

export const onCall = internalMutation({
  args: { callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    const deal = call?.dealId ? await ctx.db.get(call.dealId) : null;
    if (deal && deal.orgId === call?.orgId) await queueDealState(ctx, deal);
    return null;
  },
});

export const onDeal = internalMutation({
  args: { dealId: v.id("deals") },
  handler: async (ctx, args) => {
    const deal = await ctx.db.get(args.dealId);
    if (deal) await queueDealState(ctx, deal);
    return null;
  },
});
