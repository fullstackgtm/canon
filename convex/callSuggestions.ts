/**
 * Companies, people and deals a meeting suggests adding (lib/calls/suggestions.ts plans them;
 * convex/callFactActions.ts records them). Nothing is created until the person whose meeting it
 * was picks what to add. Creating matches the register again first (a company by domain, a
 * person by email), so a record someone added since is reused, never doubled. A person joins
 * their company, the deal puts them on it, and the meeting is logged on all of them. Only admins
 * and managers create the deal part, as for every deal.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { callerClient, clientFor, requireCaller } from "./records";
import { may, refuseLockedWrite } from "./lib/access";
import { accessFor } from "./permissions";
import { edgeStore } from "./associations";
import { createDealAsUser, saveDealEdit } from "./deals";
import { orgPipelines } from "./pipelines";
import { applyEdgeCommand } from "./lib/objects/associations";
import { dealOfStream, mayEdit } from "./dealCommittee";
import { evidenceLink, linkToDeal } from "./dealGaps";
import { nameFromDomain } from "./lib/calls/suggestions";
import { companyDomainOf } from "./lib/calls/whoIs";
import { modelSettings } from "./lib/recipes";
import { defaultModel } from "../recipes/index.ts";

type SuggestionLink = { href: string | null; external: boolean };
type ListedSuggestion = {
  id: Id<"callSuggestions">; kind: Doc<"callSuggestions">["kind"]; values: Doc<"callSuggestions">["values"]; evidence: string | null;
  research: Doc<"callSuggestions">["research"] | null; via: Doc<"callSuggestions">["via"] | null; existing: boolean; link: SuggestionLink | null;
};
type ListedGroup = {
  key: string; callId: Id<"callRecordings"> | null; conversationId: Id<"conversations"> | null; dealStreamId: string | null; meetingUrl: string | null;
  source: "call" | "email" | "linkedin" | "deal" | null; title: string; at: number; suggestions: ListedSuggestion[];
};

/** Pending suggestions one person's list shows: a busy inbox leaves a few hundred. */
const PENDING_MAX = 500;
/** Suggestions one create takes. */
const CREATE_MAX = 25;
/** Suggestions one dismiss takes: a reviewer's "Dismiss selected" over a filtered list. */
const DISMISS_MAX = 250;

/** The meeting, conversation or deal (its missing company and people) a suggestion is for: listed and created one at a time. */
const sourceOf = (s: Doc<"callSuggestions">) => (s.dealId ? `deal:${s.dealId}` : s.callId ?? `conversation:${s.conversationId}`);

const kind = v.union(v.literal("account"), v.literal("contact"), v.literal("deal"));
const values = v.object({
  name: v.optional(v.string()), domain: v.optional(v.string()), email: v.optional(v.string()), title: v.optional(v.string()),
  amount: v.optional(v.number()), closeDate: v.optional(v.string()), nextStep: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()), companyName: v.optional(v.string()),
});
const research = v.object({
  status: v.union(v.literal("found"), v.literal("not_found")), at: v.number(),
  quote: v.optional(v.string()), sourceUrl: v.optional(v.string()),
});
const identity = v.object({
  fullName: v.string(), title: v.optional(v.string()), companyName: v.string(), companyDomain: v.string(),
  linkedinUrl: v.optional(v.string()), quote: v.string(), sourceUrl: v.string(),
});

/**
 * Record a meeting's or a conversation's suggestions for `userId`: pass `callId` or `conversationId`. A key
 * already suggested in the workspace (pending, created or dismissed) is not suggested again: one open
 * suggestion per company or person, and a dismissal sticks. A meeting also keeps why it suggested what it
 * did; a conversation keeps that on its own row.
 */
export const record = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"),
    callId: v.optional(v.id("callRecordings")), conversationId: v.optional(v.id("conversations")),
    suggestions: v.array(v.object({ kind, key: v.string(), values, evidence: v.optional(v.string()), research: v.optional(research) })),
    reason: v.union(v.literal("suggested"), v.literal("not_our_meeting"), v.literal("no_one_else"), v.literal("all_known")),
  },
  handler: async (ctx, args): Promise<number> => {
    if (Boolean(args.callId) === Boolean(args.conversationId)) throw new ConvexError("Suggestions come from one meeting or one conversation");
    const from = args.callId ? { callId: args.callId } : { conversationId: args.conversationId! };
    if (args.callId) {
      const call = await ctx.db.get(args.callId);
      // The meeting was deleted (Granola disconnected) while it was being read: suggest nothing from it.
      if (!call || call.orgId !== args.orgId) return 0;
      const metadata = (call.sourceMetadata ?? {}) as Record<string, unknown>;
      await ctx.db.patch(call._id, { sourceMetadata: { ...metadata, suggestionCheck: { reason: args.reason, count: args.suggestions.length, at: Date.now() } } });
    }
    let added = 0;
    for (const s of args.suggestions) {
      const seen = await ctx.db.query("callSuggestions").withIndex("by_orgId_and_kind_and_key", (q) => q.eq("orgId", args.orgId).eq("kind", s.kind).eq("key", s.key)).first();
      if (seen) continue;
      await ctx.db.insert("callSuggestions", { orgId: args.orgId, ...from, userId: args.userId, ...s, status: "pending", createdAt: Date.now() });
      added++;
    }
    return added;
  },
});

/** The signed-in person's pending suggestions, by meeting or conversation, newest first. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { canCreateDeals: false, groups: [] };
    const rows = await ctx.db.query("callSuggestions")
      .withIndex("by_orgId_and_userId_and_status", (q) => q.eq("orgId", user.orgId).eq("userId", user._id).eq("status", "pending"))
      .take(PENDING_MAX);
    const bySource = new Map<string, Doc<"callSuggestions">[]>();
    for (const r of rows) bySource.set(sourceOf(r), [...(bySource.get(sourceOf(r)) ?? []), r]);
    const groups = (await Promise.all([...bySource].map(async ([key, items]): Promise<ListedGroup | null> => {
      const dealStream = items[0]!.dealId;
      if (dealStream) {
        // A deal's missing company and people: gone once the deal closes or has its company.
        const deal = await dealOfStream(ctx, user.orgId, dealStream);
        const open = deal && !deal.isClosed && deal.archivedAt === undefined ? items.filter((s) => s.kind === "contact" || !deal.companyId) : [];
        if (!deal || !open.length) return null;
        return {
          key, callId: null, conversationId: null, dealStreamId: dealStream, meetingUrl: null, source: "deal" as const,
          title: deal.name, at: Math.max(...open.map((s) => s.createdAt)),
          suggestions: await Promise.all(open.sort((a, b) => Number(a.kind === "contact") - Number(b.kind === "contact")).map(async (s) => ({
            id: s._id, kind: s.kind, values: s.values, evidence: s.evidence ?? null, research: s.research ?? null,
            via: s.via ?? null, existing: Boolean(s.matchId), link: await evidenceLink(ctx, s),
          }))),
        };
      }
      const callId = items[0]!.callId;
      const conversationId = items[0]!.conversationId;
      const call = callId ? await ctx.db.get(callId) : null;
      // A conversation erased since ("Delete what was read") leaves its suggestions without a source.
      const conversation = conversationId ? await ctx.db.get(conversationId) : null;
      const order = { account: 0, contact: 1, deal: 2 } as const;
      return {
        key, callId: callId ?? null, conversationId: conversation ? conversation._id : null, dealStreamId: null,
        // The meeting in its notetaker (Granola's web link): Canon has no meeting page of its own.
        meetingUrl: call?.recordingUrl && /^https:\/\//.test(call.recordingUrl) ? call.recordingUrl : null,
        source: callId ? "call" as const : conversation?.channel ?? null,
        title: call?.title ?? conversation?.counterpart.name ?? conversation?.counterpart.email ?? (callId ? "Meeting" : "Conversation"),
        at: call?.callDate ? Date.parse(call.callDate) : (call?.createdAt ?? conversation?.lastMessageAt ?? Math.min(...items.map((s) => s.createdAt))),
        suggestions: items.sort((a, b) => order[a.kind] - order[b.kind]).map((s) => ({ id: s._id, kind: s.kind, values: s.values, evidence: s.evidence ?? null, research: s.research ?? null, via: null, existing: false, link: null })),
      };
    }))).filter((g): g is ListedGroup => g !== null);
    const access = await accessFor(ctx, user);
    return { canCreateDeals: can(user, "deals.write") && may(access, "deal", "create"), groups: groups.sort((a, b) => b.at - a.at) };
  },
});

/** A pending person suggestion of the caller's, with what researching it needs: who, and their meeting. */
export const forIdentify = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), id: v.id("callSuggestions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.id);
    if (!s || s.orgId !== args.orgId || s.userId !== args.userId || s.status !== "pending" || s.kind !== "contact" || !s.values.email) return null;
    const call = s.callId ? await ctx.db.get(s.callId) : null;
    const metadata = (call?.sourceMetadata ?? {}) as Record<string, unknown>;
    const participants = Array.isArray(call?.participants) ? (call.participants as Array<Record<string, unknown>>) : [];
    const owner = participants.find((p) => p.role === "owner");
    return {
      person: { email: s.values.email, name: s.values.name ?? null },
      meeting: {
        title: call?.title ?? "Meeting",
        summary: typeof metadata.summary === "string" ? metadata.summary : null,
        transcript: call?.transcriptText ?? null,
        // Granola labels the owner's lines with their name (lib/calls/granola.ts meetingOf).
        ownerLabel: typeof owner?.name === "string" && owner.name ? owner.name : "Me",
        oneOnOne: participants.filter((p) => p.role === "attendee").length === 1,
        webUrl: typeof metadata.webUrl === "string" ? metadata.webUrl : null,
      },
    };
  },
});

/** What researching a person found: their employer becomes their company (added with them), or a "not found". */
export const setIdentity = internalMutation({
  args: { orgId: v.id("organizations"), id: v.id("callSuggestions"), identity: v.union(v.null(), identity) },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.id);
    if (!s || s.orgId !== args.orgId || s.status !== "pending") return;
    const at = Date.now();
    const i = args.identity;
    if (!i) {
      await ctx.db.patch(s._id, { research: { status: "not_found", at } });
      return;
    }
    await ctx.db.patch(s._id, {
      values: {
        ...s.values,
        name: s.values.name && s.values.name.includes(" ") ? s.values.name : i.fullName,
        domain: i.companyDomain, companyName: i.companyName,
        ...(i.title && !s.values.title ? { title: i.title } : {}),
        ...(i.linkedinUrl ? { linkedinUrl: i.linkedinUrl } : {}),
      },
      research: { status: "found", at, quote: i.quote, sourceUrl: i.sourceUrl },
    });
  },
});

/** Not these: dismissed suggestions are not made again. */
export const dismiss = mutation({
  args: { ids: v.array(v.id("callSuggestions")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    for (const id of args.ids.slice(0, DISMISS_MAX)) {
      const s = await ctx.db.get(id);
      if (!s || s.orgId !== user.orgId || s.status !== "pending") continue;
      // A deal's proposal is the deal's: whoever may edit the deal dismisses it, as they accept it.
      const deal = s.userId !== user._id && s.dealId ? await dealOfStream(ctx, user.orgId, s.dealId) : null;
      if (s.userId !== user._id && !(deal && mayEdit(user, deal))) continue;
      await ctx.db.patch(id, { status: "dismissed", decidedAt: Date.now() });
    }
  },
});

/** The caller's pending suggestions among `ids` (others read as missing). */
export const pendingOf = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), ids: v.array(v.id("callSuggestions")) },
  handler: async (ctx, args) => {
    const out: Doc<"callSuggestions">[] = [];
    for (const id of args.ids.slice(0, CREATE_MAX)) {
      const s = await ctx.db.get(id);
      // A deal's proposal is the deal's: whoever may edit the deal accepts it (dealGaps.linkToDeal checks).
      if (s && s.orgId === args.orgId && (s.userId === args.userId || s.dealId) && s.status === "pending") out.push(s);
    }
    // A deal needs its company and people: accepting a deal alone brings its conversation's pending ones along.
    const dealSources = new Set(out.filter((s) => s.kind === "deal").map(sourceOf));
    if (dealSources.size) {
      const have = new Set(out.map((s) => s._id));
      const pending = await ctx.db
        .query("callSuggestions")
        .withIndex("by_orgId_and_userId_and_status", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId).eq("status", "pending"))
        .take(1000);
      for (const s of pending) if (s.kind !== "deal" && !have.has(s._id) && dealSources.has(sourceOf(s)) && out.length < CREATE_MAX) out.push(s);
    }
    return out;
  },
});

/**
 * The deal part of a create, in one transaction: the deal in the default pipeline's first open
 * stage, the meeting's people on it, and the suggestions marked done.
 */
export const finish = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"),
    created: v.array(v.object({ id: v.id("callSuggestions"), recordId: v.string() })),
    deal: v.optional(v.object({ id: v.id("callSuggestions"), name: v.string(), amount: v.optional(v.number()), closeDate: v.string(), nextStep: v.optional(v.string()), companyId: v.optional(v.string()), contactIds: v.array(v.string()) })),
    /** A deal's missing company and people, accepted: linked to it in the same transaction. */
    link: v.optional(v.object({ streamId: v.string(), companyId: v.optional(v.string()), contactIds: v.array(v.string()) })),
  },
  handler: async (ctx, args): Promise<{ dealStreamId: string | null }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Not authenticated");
    const now = Date.now();
    let dealStreamId: string | null = null;
    if (args.link) {
      try {
        await linkToDeal(ctx, user, args.link.streamId, args.link);
      } catch (cause) {
        throw new ConvexError(cause instanceof Error ? cause.message : "The deal could not be changed");
      }
    }
    if (args.deal) {
      const pipelines = await orgPipelines(ctx, args.orgId);
      const pipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
      const stage = pipeline?.stages.find((s) => s.active && s.forecastCategory !== "closed_won" && s.forecastCategory !== "closed_lost");
      if (!stage) throw new ConvexError("The default pipeline has no open stage to start a deal in");
      const created = await createDealAsUser(ctx, user, {
        name: args.deal.name, closeDate: args.deal.closeDate, stage: stage.value,
        ...(args.deal.amount !== undefined ? { amount: args.deal.amount } : {}),
        ...(pipeline?.id ? { pipelineId: pipeline.id } : {}),
        ...(args.deal.companyId ? { companyId: args.deal.companyId } : {}),
      });
      dealStreamId = created.streamId;
      // createDealAsUser holds its own fields to the role's rules; the next step is set here, so it is checked here.
      if (args.deal.nextStep) refuseLockedWrite(await accessFor(ctx, user), "deal", ["nextStep"]);
      const row = args.deal.nextStep ? await ctx.db.get(created.dealId) : null;
      if (row && args.deal.nextStep) await saveDealEdit(ctx, row, { kind: "user", userId: user._id }, { nextStep: args.deal.nextStep });
      const edgeCtx = { orgId: args.orgId, source: { kind: "user" as const, ref: `user:${user._id}` }, actor: { kind: "user" as const, id: user._id }, now };
      for (const contactId of args.deal.contactIds) {
        const role = await applyEdgeCommand(edgeStore(ctx), edgeCtx, { op: "setRole", dealId: dealStreamId, contactId, role: "involved" });
        if (role.status === "invalid") throw new ConvexError(role.message);
      }
    }
    for (const c of [...args.created, ...(args.deal && dealStreamId ? [{ id: args.deal.id, recordId: dealStreamId }] : [])]) {
      const s = await ctx.db.get(c.id);
      if (s && s.status === "pending") await ctx.db.patch(c.id, { status: "created", recordId: c.recordId, decidedAt: now });
    }
    return { dealStreamId };
  },
});

/** `skipped`: people on personal email with no company on their meeting to add them to; their suggestions stay. */
type Created = { companies: number; people: number; deal: string | null; reused: number; skipped: string[] };

/** The register's company with this domain and person with this email, as anyone sees them, and whether the caller does. */
async function existing(ctx: ActionCtx, caller: { orgId: string; access: Parameters<typeof callerClient>[1]["access"] }, object: "account" | "contact", field: "domain" | "email", value: string) {
  const row = (await clientFor(ctx).listRegister(caller.orgId, object, { filter: [{ field, op: "eq", value }], limit: 1 })).rows[0];
  if (!row) return null;
  const seen = object === "account" ? await callerClient(ctx, caller).get(caller.orgId, row.id) : await callerClient(ctx, caller).getContact(caller.orgId, row.id);
  // Someone else's record the caller's role hides (CP14): not theirs to add to, and not shown.
  if (!seen) throw new ConvexError(`${object === "account" ? "A company with this domain" : "This person"} is already in the workspace, owned by someone your role cannot see`);
  return row.id;
}

/**
 * Create what the caller picked. `deal` overrides the suggested deal's name, amount (cents) and
 * close date. A person's company is created with them when the register has none.
 */
export const create = action({
  args: {
    ids: v.array(v.id("callSuggestions")),
    deal: v.optional(v.object({ name: v.optional(v.string()), amount: v.optional(v.number()), closeDate: v.optional(v.string()) })),
    /** Websites the reviewer gave for companies the meeting named but research could not identify, and for people with no company. */
    websites: v.optional(v.array(v.object({ id: v.id("callSuggestions"), domain: v.string() }))),
  },
  handler: async (ctx, args): Promise<Created> => {
    const caller = await requireCaller(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const picked: Doc<"callSuggestions">[] = await ctx.runQuery(internal.callSuggestions.pendingOf, { orgId, userId, ids: args.ids });
    if (!picked.length) throw new ConvexError("Nothing to create: these suggestions are gone or already handled");
    if (new Set(picked.map(sourceOf)).size > 1) throw new ConvexError("Create one meeting's suggestions at a time");
    // A deal's proposals carry the thread they came from as evidence only: nothing is logged on it from here.
    const gap = picked[0]!.dealId;
    const callId = gap ? undefined : picked[0]!.callId;
    const kinds = new Set(picked.map((s) => s.kind));
    const needs: Array<["account" | "contact" | "deal", "create"]> = [
      ...(kinds.has("account") || kinds.has("contact") ? [["account", "create"] as ["account", "create"]] : []),
      ...(kinds.has("contact") ? [["contact", "create"] as ["contact", "create"]] : []),
      ...(kinds.has("deal") ? [["deal", "create"] as ["deal", "create"]] : []),
    ];
    const refused = needs.find(([object, op]) => !may(caller.access, object, op));
    if (refused) throw new ConvexError(`Your role cannot ${refused[1]} ${refused[0]} records`);
    if (kinds.has("deal") && !can(caller, "deals.write")) throw new ConvexError("Only admins and managers can create deals; leave the deal unticked");
    if (gap && !may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
    const gapDeal = gap ? await ctx.runQuery(internal.dealGaps.dealOf, { orgId, streamId: gap }) : null;
    if (gap && !gapDeal) throw new ConvexError("This deal is closed or gone");
    // The fields each record gets, held to the role's field rules as records.upsert holds them (CP14b): a hidden or
    // read-only field is not written through a suggestion either. accountId and accountDomain are links, not fields.
    if (kinds.has("account") || kinds.has("contact")) refuseLockedWrite(caller.access, "account", ["domain", "name", "ownerId"]);
    for (const s of picked.filter((x) => x.kind === "contact")) refuseLockedWrite(caller.access, "contact", ["fullName", ...(s.values.email ? ["email"] : []), ...(s.values.title ? ["title"] : []), ...(s.values.linkedinUrl ? ["linkedinUrl"] : [])]);

    const client = clientFor(ctx);
    const created: Array<{ id: Id<"callSuggestions">; recordId: string }> = [];
    const companyByDomain = new Map<string, string>();
    const skipped: string[] = [];
    const corrected = new Map<string, string>();
    /** The companies the reviewer picked (not those added only as a person's employer): the first is a deal's company. */
    const picks = new Set<string>();
    let reused = 0;
    let companies = 0;
    let people = 0;

    const companyFor = async (domain: string, name: string, suggestionId: string): Promise<string> => {
      const known = companyByDomain.get(domain) ?? (await existing(ctx, caller, "account", "domain", domain));
      if (known) {
        companyByDomain.set(domain, known);
        return known;
      }
      const up = await client.upsertAccounts(caller.orgId, { source: "api", idempotencyKey: `callsuggestion:${suggestionId}`, fill: "missing", records: [{ domain, name, ownerId: userId }] });
      if (!up.ids[0]) throw new ConvexError(`${name} could not be created: ${up.rejected?.[0]?.reason ?? "refused"}`);
      companies++;
      companyByDomain.set(domain, up.ids[0]);
      return up.ids[0];
    };

    for (const s of picked.filter((x) => x.kind === "account")) {
      // A company the CRM has already: linked as it is, once the caller is shown to see it (CP14).
      if (s.matchId) {
        if (!(await callerClient(ctx, caller).get(caller.orgId, s.matchId))) throw new ConvexError(`${s.values.name ?? "This company"} is not in the workspace, or your role cannot see it`);
        if (s.values.domain) companyByDomain.set(s.values.domain, s.matchId);
        picks.add(s.matchId);
        reused++;
        created.push({ id: s._id, recordId: s.matchId });
        continue;
      }
      const given = args.websites?.find((w) => w.id === s._id)?.domain;
      // A website the reviewer typed wins over research's guess.
      const domain = companyDomainOf(given ?? null) ?? s.values.domain;
      if (!domain) {
        if (given) throw new ConvexError(`"${given}" is not a website domain, such as acme.com`);
        skipped.push(`${s.values.name ?? "a company"} (add its website)`);
        continue;
      }
      // The reviewer corrected research's guess: the company's people follow it, not the guess.
      if (s.values.domain && s.values.domain !== domain) corrected.set(s.values.domain, domain);
      const before = companies;
      const id = await companyFor(domain, s.values.name ?? domain, s._id);
      picks.add(id);
      if (companies === before) reused++;
      created.push({ id: s._id, recordId: id });
    }
    const contactIds: string[] = [];
    const accountNames = new Map(picked.filter((x) => x.kind === "account" && x.values.domain).map((x) => [x.values.domain!, x.values.name ?? nameFromDomain(x.values.domain!)]));
    // The company a person on personal email joins: the one candidate, decided once before anyone is added so the
    // order of people cannot change it. Candidates are the companies added or matched just above and the meeting's
    // (or conversation's) companies the caller can still see (CP14); with none, or more than one, there is none to guess.
    const conversationId = gap ? undefined : picked[0]!.conversationId;
    const origin = callId ? await ctx.runQuery(internal.callSuggestions.callContext, { orgId, callId })
      : conversationId ? await conversationOrigin(ctx, caller, conversationId) : null;
    const meetingAccounts = origin?.accountIds ?? [];
    const visibleMeeting = (await Promise.all(meetingAccounts.map(async (id) => ((await callerClient(ctx, caller).get(caller.orgId, id)) ? id : null)))).filter((id): id is string => id !== null);
    const candidates = new Set([...picks, ...companyByDomain.values(), ...visibleMeeting]);
    // A deal's person with no company of their own joins the deal's company, or the one accepted with them.
    if (gapDeal?.companyId) candidates.add(gapDeal.companyId);
    const fallback = candidates.size === 1 ? [...candidates][0] : undefined;
    for (const s of picked.filter((x) => x.kind === "contact")) {
      // Someone the meeting named has no address: matched by nothing, created under their company.
      const email = s.values.email;
      if (s.matchId && !(await callerClient(ctx, caller).getContact(caller.orgId, s.matchId))) throw new ConvexError(`${s.values.name ?? "This person"} is not in the workspace, or your role cannot see them`);
      const known = s.matchId ?? (email ? await existing(ctx, caller, "contact", "email", email) : null);
      if (known) {
        reused++;
        contactIds.push(known);
        created.push({ id: s._id, recordId: known });
        continue;
      }
      // Every person belongs to a company: their own, the website the reviewer gave for it (a LinkedIn conversation
      // names no company), else the one company being added or matched on this meeting.
      const given = args.websites?.find((w) => w.id === s._id)?.domain;
      const typed = s.values.domain ? null : companyDomainOf(given ?? null);
      if (given && !s.values.domain && !typed) throw new ConvexError(`"${given}" is not a website domain, such as acme.com`);
      const domain = s.values.domain ? corrected.get(s.values.domain) ?? s.values.domain : typed ?? undefined;
      const accountId = domain ? await companyFor(domain, accountNames.get(domain) ?? s.values.companyName ?? nameFromDomain(domain), `${s._id}:company`) : fallback;
      if (!accountId) {
        skipped.push(s.values.name ?? email ?? "someone");
        continue;
      }
      const up = await client.upsertContacts(caller.orgId, {
        source: "api", idempotencyKey: `callsuggestion:${s._id}`, fill: "missing",
        records: [{
          fullName: s.values.name ?? email ?? "Unknown", ...(email ? { email } : {}), ...(accountId ? { accountId } : {}),
          ...(s.values.title ? { title: s.values.title } : {}), ...(s.values.linkedinUrl ? { linkedinUrl: s.values.linkedinUrl } : {}),
        }],
      });
      const id = up.ids[0];
      if (!id) throw new ConvexError(`${s.values.name ?? email} could not be created: ${up.rejected?.[0]?.reason ?? "refused"}`);
      people++;
      if (accountId) {
        const linked = await ctx.runMutation(internal.associations.apply, { orgId, userId, command: { op: "link", fromId: id, toId: accountId, primary: true }, seed: accountId });
        if (linked.status === "invalid") throw new ConvexError(linked.message);
      }
      contactIds.push(id);
      created.push({ id: s._id, recordId: id });
    }

    // The deal's company: the one created or matched here, else the existing company of the meeting's or the
    // conversation's people; they are on the deal with the people added here.
    const dealSuggestion = picked.find((x) => x.kind === "deal");
    let deal: { id: Id<"callSuggestions">; name: string; amount?: number; closeDate: string; nextStep?: string; companyId?: string; contactIds: string[] } | undefined;
    if (dealSuggestion) {
      const companyId = [...companyByDomain.values()][0] ?? origin?.accountIds[0];
      const meetingDay = origin?.day ?? new Date().toISOString().slice(0, 10);
      const closeDays = origin?.defaultCloseDays ?? defaultModel("calls.model").defaultCloseDays;
      const closeDate = args.deal?.closeDate ?? dealSuggestion.values.closeDate ?? new Date(Date.parse(meetingDay) + closeDays * 86_400_000).toISOString().slice(0, 10);
      const amount = args.deal?.amount ?? dealSuggestion.values.amount;
      deal = {
        id: dealSuggestion._id, name: (args.deal?.name ?? dealSuggestion.values.name ?? "New deal").trim(), closeDate,
        ...(amount !== undefined ? { amount } : {}),
        ...(dealSuggestion.values.nextStep ? { nextStep: dealSuggestion.values.nextStep } : {}),
        ...(companyId ? { companyId } : {}),
        contactIds: [...new Set([...contactIds, ...(origin?.contactIds ?? [])])],
      };
    }
    const link = gap ? { streamId: gap, contactIds, ...(gapDeal?.companyId ? {} : picks.size || companyByDomain.size ? { companyId: [...picks, ...companyByDomain.values()][0]! } : {}) } : undefined;
    const done = await ctx.runMutation(internal.callSuggestions.finish, { orgId, userId, created, ...(deal ? { deal } : {}), ...(link ? { link } : {}) });

    // The meeting is logged on everything it is now about (granola.logMeeting picks the open deal, the new one included).
    const call = callId ? await ctx.runQuery(internal.callSuggestions.callContext, { orgId, callId }) : null;
    if (callId && call) {
      const companies = [...new Set([...call.accountIds, ...companyByDomain.values()])].map((id) => ({ id }));
      await ctx.runMutation(internal.granola.logMeeting, {
        orgId, userId, callId, title: call.title, startAt: call.startAt, notes: call.notes,
        contactIds: [...new Set([...call.contactIds, ...contactIds])], companies,
      });
    }
    if (client.mode === "http") {
      const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId });
      await client.nudgeProjector(caller.orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
    }
    return { companies, people, deal: done.dealStreamId, reused, skipped };
  },
});

/**
 * The records a conversation is already about, as the caller sees them (CP14): its matched people and their
 * companies; and the day it was last active and when a deal it suggests closes. Null once it was erased.
 */
async function conversationOrigin(ctx: ActionCtx, caller: Parameters<typeof callerClient>[1], conversationId: Id<"conversations">) {
  const c = await ctx.runQuery(internal.callSuggestions.conversationContext, { orgId: caller.orgId as Id<"organizations">, conversationId });
  if (!c) return null;
  const client = callerClient(ctx, caller);
  const people = (await Promise.all(c.contactIds.map((id) => client.getContact(caller.orgId, id)))).flatMap((x) => (x ? [x] : []));
  const companies = [...new Set(people.map((x) => x.accountId).filter(Boolean))];
  const accountIds = (await Promise.all(companies.map(async (id) => ((await client.get(caller.orgId, id)) ? id : null)))).filter((id): id is string => id !== null);
  return { day: c.day, defaultCloseDays: c.defaultCloseDays, contactIds: people.map((x) => x.id), accountIds };
}

/** A conversation's matched people, the day it was last active, and when a deal it suggests closes. */
export const conversationContext = internalQuery({
  args: { orgId: v.id("organizations"), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.conversationId);
    if (!c || c.orgId !== args.orgId) return null;
    return {
      contactIds: c.contactIds, day: new Date(c.lastMessageAt).toISOString().slice(0, 10),
      defaultCloseDays: (await modelSettings(ctx, args.orgId, "calls.model")).defaultCloseDays,
    };
  },
});

/** What re-logging a meeting needs: its records so far, its time and its notes; and when a deal it suggests closes. */
export const callContext = internalQuery({
  args: { orgId: v.id("organizations"), callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) return null;
    const m = (call.sourceMetadata ?? {}) as Record<string, unknown>;
    const startAt = call.callDate ? Date.parse(call.callDate) : call.createdAt;
    const summary = typeof m.summary === "string" ? m.summary : null;
    const webUrl = typeof m.webUrl === "string" ? m.webUrl : null;
    return {
      title: call.title, startAt, day: new Date(startAt).toISOString().slice(0, 10),
      notes: [summary, webUrl ? `Granola note: ${webUrl}` : null].filter(Boolean).join("\n\n").slice(0, 20_000),
      contactIds: Array.isArray(m.contactIds) ? (m.contactIds as string[]) : [],
      accountIds: Array.isArray(m.accountIds) ? (m.accountIds as string[]) : [],
      defaultCloseDays: (await modelSettings(ctx, args.orgId, "calls.model")).defaultCloseDays,
    };
  },
});
