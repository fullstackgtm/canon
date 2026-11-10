/**
 * Conversation intake, CI3b (docs/conversation-intake.md): an email thread or LinkedIn conversation is read for what
 * it changed once it has been quiet for 10 minutes (`extractDueAt`, set by intake). A cron claims what is due
 * (`startDue`); convex/conversationExtractActions.ts reads it as its owner, on their ChatGPT plan, and proposes
 * through the facts ledger; `finish` records the pass. A pass reads only messages stored since the last one, with
 * a few before them for context (lib/conversations/extract.ts).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { accessFor } from "./permissions";
import { candidateDeals } from "./granola";
import { pickDeal } from "./lib/calls/granola";
import { modelSettings } from "./lib/recipes";
import type { CallsModel } from "../recipes/models.ts";
import { messagesToRead, THREAD_READ_MAX } from "./lib/conversations/extract";
import { ownerThread } from "./lib/conversations/store";
import { matchLate } from "./conversations";

/** Conversations one cron tick starts. The rest wait for the next tick. */
const BATCH = 25;
/** A claimed pass that has not finished by then (the action died) is claimed again. */
const LEASE_MS = 15 * 60_000;
/** One tick's passes start spread over this long, so a burst does not hit one ChatGPT plan at once. */
const SPREAD_MS = 60_000;

/** Claim the conversations whose quiet period is over and start a pass for each. */
export const startDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    if (!integrationEnabled("chatgpt")) return 0;
    const now = Date.now();
    const due = await ctx.db.query("conversations").withIndex("by_extractDueAt", (q) => q.gt("extractDueAt", 0).lte("extractDueAt", now)).take(BATCH);
    for (const [i, c] of due.entries()) {
      const lease = now + LEASE_MS;
      await ctx.db.patch(c._id, { extractDueAt: lease });
      await ctx.scheduler.runAfter(Math.floor((i * SPREAD_MS) / BATCH), internal.conversationExtractActions.extract, { conversationId: c._id, lease });
    }
    return due.length;
  },
});

/** Why a conversation's account no longer lets it be read, or null when intake is on. */
async function intakeClosed(ctx: QueryCtx, c: Doc<"conversations">): Promise<string | null> {
  const linkedin = ctx.db.normalizeId("linkedinAccounts", c.accountRef);
  const email = ctx.db.normalizeId("emailAccounts", c.accountRef);
  const row = linkedin ? await ctx.db.get(linkedin) : email ? await ctx.db.get(email) : null;
  if (!row || row.orgId !== c.orgId || row.status === "disconnected") return "account is gone";
  // emailAccounts gains `ingest` with CI2; until then an email account never reads.
  return (row as { ingest?: boolean }).ingest ? null : "intake is off";
}

export type ExtractContext =
  | { skip: string }
  | {
    orgId: Id<"organizations">; ownerUserId: Id<"users">; channel: "email" | "linkedin";
    owner: { name: string; email: string | null }; access: Awaited<ReturnType<typeof accessFor>>;
    counterpart: Doc<"conversations">["counterpart"]; contactIds: string[];
    title: string; day: string; messages: ReturnType<typeof messagesToRead>; readAt: number;
    /** No earlier pass: `messages` is the whole thread, not a window of it. */
    firstPass: boolean;
    deal: { id: Id<"deals">; name: string; stage: string | null; nextStep: string | null; closeDate: string | null } | null;
    define: CallsModel["define"];
  };

type OpenDeal = Extract<ExtractContext, { deal: unknown }>["deal"];

/** The open deal these contacts or companies are on that `access` sees, picked as a meeting's is. */
async function openDeal(ctx: QueryCtx, orgId: Id<"organizations">, access: Awaited<ReturnType<typeof accessFor>>, contactIds: string[], companies: Array<{ id: string; domain?: string }> = []): Promise<{ deal: OpenDeal; customer: boolean }> {
  const candidates = await candidateDeals(ctx, orgId, access, contactIds, companies);
  const picked = pickDeal(candidates);
  const deal = picked ? await ctx.db.get(picked.dealId as Id<"deals">) : null;
  // A company the workspace has won a deal with is a customer: its conversations are not new business by default.
  let customer = false;
  for (const c of candidates.filter((x) => x.isClosed)) {
    if ((await ctx.db.get(c.dealId as Id<"deals">))?.forecastCategory === "closed_won") customer = true;
  }
  return { deal: deal ? { id: deal._id, name: deal.name, stage: deal.stage ?? null, nextStep: deal.nextStep ?? null, closeDate: deal.closeDate || null } : null, customer };
}

/**
 * What a pass reads, as the conversation's owner: the new messages and their context (labelled with who sent them),
 * the open deal the counterpart is on that the owner sees (picked as a meeting's is), and the workspace's calls model.
 */
export const context = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<ExtractContext> => {
    const c = await ctx.db.get(args.conversationId);
    if (!c) return { skip: "conversation is gone" };
    const closed = await intakeClosed(ctx, c);
    if (closed) return { skip: closed };
    const user = await ctx.db.get(c.ownerUserId);
    if (!user || user.orgId !== c.orgId || !user.isActive) return { skip: "owner is no longer a member" };
    const readAt = Date.now();
    const messages = messagesToRead(await ownerThread(ctx, c, user._id, THREAD_READ_MAX), c.extractedAt);
    if (!messages.length) return { skip: "nothing new to read" };
    const access = await accessFor(ctx, user);
    const them = c.counterpart.name || c.counterpart.email || (c.channel === "linkedin" ? "LinkedIn contact" : "Contact");
    return {
      orgId: c.orgId, ownerUserId: user._id, channel: c.channel, owner: { name: user.name, email: user.email || null }, access,
      counterpart: c.counterpart, contactIds: c.contactIds,
      title: them, day: new Date(messages[messages.length - 1]!.at).toISOString().slice(0, 10),
      // Stored senders are provider ids; the prompt reads names.
      messages: messages.map((m) => ({ ...m, from: m.direction === "us" ? user.name : them })),
      readAt, firstPass: c.extractedAt === undefined,
      deal: (await openDeal(ctx, c.orgId, access, c.contactIds)).deal,
      define: (await modelSettings(ctx, c.orgId, "calls.model")).define,
    };
  },
});

/**
 * The open deal the conversation's people or their companies are on, as its owner sees it, and whether the
 * workspace has won a deal with those companies: a conversation joins its company's open deal rather than
 * suggesting another.
 */
export const dealOf = internalQuery({
  args: { conversationId: v.id("conversations"), contactIds: v.array(v.string()), companies: v.optional(v.array(v.object({ id: v.string(), domain: v.optional(v.string()) }))) },
  handler: async (ctx, args): Promise<{ deal: OpenDeal; customer: boolean }> => {
    const c = await ctx.db.get(args.conversationId);
    const user = c ? await ctx.db.get(c.ownerUserId) : null;
    if (!c || !user || user.orgId !== c.orgId) return { deal: null, customer: false };
    return openDeal(ctx, c.orgId, await accessFor(ctx, user), args.contactIds, args.companies ?? []);
  },
});

/**
 * Record a pass. A pass that read (`readAt`) moves the conversation's read mark; a skipped one keeps it, so the next
 * pass reads what this one could not. The due time is cleared unless a new message set a later one meanwhile. A
 * counterpart the pass found (`contactId`) matches the conversation from now on.
 */
export const finish = internalMutation({
  args: {
    conversationId: v.id("conversations"), lease: v.number(),
    readAt: v.optional(v.number()), patchPlanId: v.optional(v.id("patchPlans")), skipped: v.optional(v.string()),
    contactId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.conversationId);
    if (!c) return;
    if (args.contactId) await matchLate(ctx, c, args.contactId, Date.now());
    if (args.readAt !== undefined) {
      const user = await ctx.db.get(c.ownerUserId);
      if (user?.isActive && user.orgId === c.orgId) {
        const contacts = [...new Set([...c.contactIds, ...(args.contactId ? [args.contactId] : [])])];
        for (const deal of await candidateDeals(ctx, c.orgId, await accessFor(ctx, user), contacts, [])) {
          if (!deal.isClosed) await ctx.scheduler.runAfter(0, internal.dealState.onDeal, { dealId: deal.dealId as Id<"deals"> });
        }
      }
    }
    await ctx.db.patch(c._id, {
      ...(c.extractDueAt === args.lease ? { extractDueAt: undefined } : {}),
      ...(args.readAt !== undefined ? { extractedAt: args.readAt } : {}),
      ...(args.patchPlanId ? { patchPlanId: args.patchPlanId } : {}),
      extractSkipped: args.skipped,
      updatedAt: Date.now(),
    });
  },
});
