/**
 * A deal's missing company and people (lib/deals/gaps.ts plans them; convex/dealGapActions.ts finds them). Each
 * proposal is a callSuggestions row with the deal's stream in `dealId`, for the deal's owner, shown on the deal page
 * and in "From your conversations". Accepting one (callSuggestions.create) creates the record when the CRM has none
 * and links it to the deal: the company as the deal's company, a person on the deal as Involved.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, dealVisible } from "./permissions";
import { dealOfStream, mayEdit } from "./dealCommittee";
import { edgeStore } from "./associations";
import { applyEdgeCommand, EDGES_PER_RECORD_MAX } from "./lib/objects/associations";
import { saveDealEdit } from "./deals";
import { isRestricted, refuseLockedWrite } from "./lib/access";
import type { GapSource } from "./lib/deals/gaps";

/** Each inbox's and LinkedIn account's conversations read for a deal, most recent first. */
const CONVERSATIONS_PER_ACCOUNT = 200;
/** The workspace's meetings read for a deal, most recent first. */
const MEETINGS_MAX = 300;
/** Proposals one deal shows. */
const SHOWN_MAX = 30;
const via = v.union(v.literal("crm"), v.literal("email"), v.literal("linkedin"), v.literal("call"), v.literal("search"));
const proposal = v.object({
  kind: v.union(v.literal("account"), v.literal("contact")), key: v.string(),
  values: v.object({
    name: v.optional(v.string()), domain: v.optional(v.string()), email: v.optional(v.string()), title: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()), companyName: v.optional(v.string()),
  }),
  matchId: v.optional(v.string()), evidence: v.string(), via,
  source: v.optional(v.object({ kind: v.union(v.literal("email"), v.literal("linkedin"), v.literal("call")), id: v.string() })),
});

/** A deal as its gap check needs it: owner, name, company, whether people are on it. Null for a closed or archived deal. */
export const dealOf = internalQuery({
  args: { orgId: v.id("organizations"), streamId: v.string() },
  handler: async (ctx, args) => {
    const deal = await dealOfStream(ctx, args.orgId, args.streamId);
    const owner = deal?.primaryRepId ? await ctx.db.get(deal.primaryRepId) : null;
    if (!deal || deal.archivedAt !== undefined || deal.isClosed || !owner || owner.orgId !== args.orgId) return null;
    // Proposals are read as the owner sees the CRM (CP14): what their role hides is never proposed to them.
    return { dealId: deal._id, name: deal.name, ownerId: owner._id, ownerAccess: await accessFor(ctx, owner), companyId: deal.companyId ?? null };
  },
});

/** The open deals of `userId` with no company or no people, oldest changes first, for the backfill. */
export const gapDealsOf = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const deals = await ctx.db.query("deals").withIndex("by_orgId_and_primaryRepId", (q) => q.eq("orgId", args.orgId).eq("primaryRepId", args.userId)).take(500);
    const out: string[] = [];
    for (const d of deals) {
      if (d.isClosed || d.archivedAt !== undefined) continue;
      const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", d._id)).first();
      if (!stream) continue;
      const person = await ctx.db.query("associations")
        .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "deal_contact").eq("fromId", stream._id))
        .filter((q) => q.eq(q.field("active"), true)).first();
      if (!d.companyId || !person) out.push(stream._id);
    }
    return out;
  },
});

/** The owner's conversations and the workspace's meetings they were on (or that are on the deal), with the other side's people. */
export async function sourceInventoryOf(ctx: QueryCtx, args: { orgId: Id<"organizations">; userId: Id<"users">; dealId: Id<"deals"> }) {
  const out: GapSource[] = [];
  let limited = false;
  const email = await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", args.userId)).take(11);
  const linkedin = await ctx.db.query("linkedinAccounts").withIndex("by_userId", (q) => q.eq("userId", args.userId)).take(11);
  const accounts = [...email.slice(0, 10), ...linkedin.slice(0, 10)].filter((a) => a.orgId === args.orgId);
  limited ||= email.length > 10 || linkedin.length > 10;
  for (const a of accounts) {
    const rows = await ctx.db.query("conversations").withIndex("by_accountRef_and_lastMessageAt", (q) => q.eq("accountRef", a._id)).order("desc").take(CONVERSATIONS_PER_ACCOUNT + 1);
    limited ||= rows.length > CONVERSATIONS_PER_ACCOUNT;
    for (const c of rows.slice(0, CONVERSATIONS_PER_ACCOUNT)) {
      const people = c.channel === "email"
        ? (c.participants?.length ? c.participants : c.counterpart.email ? [{ email: c.counterpart.email, name: c.counterpart.name }] : [])
        : [{ ...(c.counterpart.name ? { name: c.counterpart.name } : {}), ...(c.counterpart.profileUrl ? { linkedinUrl: c.counterpart.profileUrl } : {}) }];
      out.push({ kind: c.channel, id: c._id, title: c.subject ?? c.counterpart.name ?? c.counterpart.email ?? "Conversation", at: c.lastMessageAt, revision: c.updatedAt, contactIds: c.contactIds, people });
    }
  }
  const onDeal = await ctx.db.query("callRecordings").withIndex("by_dealId", (q) => q.eq("dealId", args.dealId)).order("desc").take(51);
  const recent = await ctx.db.query("callRecordings").withIndex("by_orgId_callDate", (q) => q.eq("orgId", args.orgId)).order("desc").take(MEETINGS_MAX + 1);
  limited ||= onDeal.length > 50 || recent.length > MEETINGS_MAX;
  const seen = new Set<string>();
  for (const call of [...onDeal.slice(0, 50), ...recent.slice(0, MEETINGS_MAX).filter((c) => c.ownerId === args.userId)]) {
    if (seen.has(call._id)) continue;
    seen.add(call._id);
    const participants = (Array.isArray(call.participants) ? call.participants : []) as Array<Record<string, unknown>>;
    const people = participants.filter((p) => p.role !== "owner" && typeof p.email === "string")
      .map((p) => ({ email: (p.email as string).toLowerCase(), ...(typeof p.name === "string" && p.name ? { name: p.name } : {}) }));
    const m = (call.sourceMetadata ?? {}) as Record<string, unknown>;
    const contactIds = Array.isArray(m.contactIds) ? (m.contactIds as string[]) : [];
    // A meeting logged on the deal is about it however it reads (lib/deals/gaps.ts sourceMatches).
    out.push({ kind: "call", id: call._id, title: call.title, at: call.callDate ? Date.parse(call.callDate) : call.createdAt, revision: call.updatedAt, contactIds, people, ...(call.dealId === args.dealId ? { onDeal: true } : {}) });
  }
  return { sources: out.sort((a, b) => b.at - a.at), limited };
}

const sourceArgs = { orgId: v.id("organizations"), userId: v.id("users"), dealId: v.id("deals") };
export const sourceInventory = internalQuery({ args: sourceArgs, handler: sourceInventoryOf });
export const sourcesOf = internalQuery({ args: sourceArgs, handler: async (ctx, args): Promise<GapSource[]> => (await sourceInventoryOf(ctx, args)).sources });

/** Record a deal's proposals for its owner. A key proposed for the deal before (pending, accepted or dismissed) is not proposed again. */
export const record = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), proposals: v.array(proposal) },
  handler: async (ctx, args): Promise<number> => {
    let added = 0;
    const now = Date.now();
    for (const p of args.proposals) {
      const key = `deal:${args.streamId}:${p.key}`;
      const seen = await ctx.db.query("callSuggestions").withIndex("by_orgId_and_kind_and_key", (q) => q.eq("orgId", args.orgId).eq("kind", p.kind).eq("key", key)).first();
      if (seen) continue;
      const from = p.source?.kind === "call" ? { callId: ctx.db.normalizeId("callRecordings", p.source.id) ?? undefined }
        : p.source ? { conversationId: ctx.db.normalizeId("conversations", p.source.id) ?? undefined } : {};
      await ctx.db.insert("callSuggestions", {
        orgId: args.orgId, userId: args.userId, dealId: args.streamId, kind: p.kind, key, values: p.values, evidence: p.evidence, via: p.via,
        ...(p.matchId ? { matchId: p.matchId } : {}), ...from, status: "pending", createdAt: now,
      });
      added++;
    }
    return added;
  },
});

/**
 * Link what accepting a deal's proposals made or matched: the company becomes the deal's company when it still has
 * none, and the people go on the deal as Involved. Whoever accepts must be able to edit the deal.
 */
export async function linkToDeal(ctx: MutationCtx, user: Doc<"users">, streamId: string, link: { companyId?: string; contactIds: readonly string[] }) {
  const deal = await dealOfStream(ctx, user.orgId, streamId);
  if (!deal) throw new Error("Deal not found");
  if (!mayEdit(user, deal)) throw new Error("Only admins, managers and the deal's owner can change this deal");
  // The company is a deal field: held to the role's field rules as every deal edit is (CP14b).
  if (link.companyId && !deal.companyId) refuseLockedWrite(await accessFor(ctx, user), "deal", ["companyId"]);
  if (link.companyId && !deal.companyId) await saveDealEdit(ctx, deal, { kind: "user", userId: user._id }, { companyId: link.companyId });
  const edgeCtx = { orgId: user.orgId, source: { kind: "user" as const, ref: `user:${user._id}` }, actor: { kind: "user" as const, id: user._id }, now: Date.now() };
  for (const contactId of link.contactIds) {
    const r = await applyEdgeCommand(edgeStore(ctx), edgeCtx, { op: "setRole", dealId: streamId, contactId, role: "involved" });
    if (r.status === "invalid") throw new Error(r.message);
  }
}

/** The deal page's "Missing company" and "Missing people" cards: what the deal lacks and the pending proposals for it. */
export const forDeal = query({
  args: { streamId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const deal = await dealOfStream(ctx, user.orgId, args.streamId);
    const access = await accessFor(ctx, user);
    if (!deal || !dealVisible(access, deal)) return null;
    const edges = await ctx.db.query("associations")
      .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", user.orgId).eq("association", "deal_contact").eq("fromId", args.streamId))
      .take(EDGES_PER_RECORD_MAX);
    const legacy = edges.length ? null : await ctx.db.query("dealContacts").withIndex("by_dealId", (q) => q.eq("dealId", deal._id)).first();
    const hasPeople = edges.some((e) => e.active) || Boolean(legacy);
    // Proposals were read as the owner sees the CRM: shown to them, and to roles that see every record.
    const shows = deal.primaryRepId === user._id || !isRestricted(access);
    const rows = shows ? await ctx.db.query("callSuggestions").withIndex("by_orgId_and_dealId_and_status", (q) => q.eq("orgId", user.orgId).eq("dealId", args.streamId).eq("status", "pending")).take(SHOWN_MAX) : [];
    const suggestions = await Promise.all(rows.filter((s) => s.kind === "contact" || !deal.companyId).map(async (s) => ({
      id: s._id, kind: s.kind as "account" | "contact", values: s.values, evidence: s.evidence ?? null, via: s.via ?? null, existing: Boolean(s.matchId),
      ...(await evidenceLink(ctx, s)),
    })));
    return { name: deal.name, hasCompany: Boolean(deal.companyId), hasPeople, canEdit: mayEdit(user, deal), suggestions };
  },
});

/** The thread or meeting a proposal came from, to open: a conversation's page, a meeting's notetaker link, or a search's source. */
export async function evidenceLink(ctx: QueryCtx, s: Doc<"callSuggestions">): Promise<{ href: string | null; external: boolean }> {
  if (s.conversationId) return { href: `/dashboard/conversations/${s.conversationId}`, external: false };
  if (s.callId) {
    const call = await ctx.db.get(s.callId);
    return { href: call?.recordingUrl && /^https:\/\//.test(call.recordingUrl) ? call.recordingUrl : null, external: true };
  }
  if (s.matchId) return { href: s.kind === "account" ? `/dashboard/accounts/${encodeURIComponent(s.matchId)}` : `/dashboard/records/contact/${encodeURIComponent(s.matchId)}`, external: false };
  if (s.values.linkedinUrl) return { href: s.values.linkedinUrl, external: true };
  if (s.values.domain) return { href: `https://${s.values.domain}`, external: true };
  return { href: null, external: false };
}

/** The website of the company proposed for a deal, for a people search before the company is accepted. */
export const companyDomainOf = internalQuery({
  args: { orgId: v.id("organizations"), streamId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const rows = await ctx.db.query("callSuggestions").withIndex("by_orgId_and_dealId_and_status", (q) => q.eq("orgId", args.orgId).eq("dealId", args.streamId).eq("status", "pending")).take(SHOWN_MAX);
    return rows.find((s) => s.kind === "account" && s.values.domain)?.values.domain ?? null;
  },
});
