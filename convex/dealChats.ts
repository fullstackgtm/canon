import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { accessFor, dealVisible, principalAccess } from "./permissions";
import { isRestricted } from "./lib/access";
import { dealOfStream } from "./dealCommittee";
import { MAX_ANSWER_CHARS, MAX_QUESTION_CHARS } from "./lib/ask/askLoop";

const CHATS_MAX = 100;
const MESSAGES_MAX = 100;
const sources = v.array(v.object({ object: v.string(), id: v.string(), title: v.string(), href: v.string() }));

/** Retained answers cannot be field-redacted. Every history surface uses this live admission gate. */
async function admission(ctx: QueryCtx, streamId: string) {
  const user = await requireUser(ctx, { allowPreview: true });
  const access = await accessFor(ctx, user);
  const deal = await dealOfStream(ctx, user.orgId, streamId);
  return { user, allowed: Boolean(!access.preview && !isRestricted(access) && deal && deal.archivedAt === undefined && dealVisible(access, deal)) };
}

async function chatFor(ctx: QueryCtx, chatId: Id<"dealChats">, ownerOnly = false): Promise<Doc<"dealChats"> | null> {
  const chat = await ctx.db.get(chatId);
  if (!chat) return null;
  const { user, allowed } = await admission(ctx, chat.streamId);
  if (!allowed || chat.orgId !== user.orgId) return null;
  return chat.ownerId === user._id || (!ownerOnly && chat.sharedWith.includes(user._id)) ? chat : null;
}

const messagesOf = (ctx: QueryCtx, chatId: Id<"dealChats">) => ctx.db.query("dealChatMessages").withIndex("by_chatId", (q) => q.eq("chatId", chatId)).take(MESSAGES_MAX);
const chatsOf = (ctx: QueryCtx, orgId: Id<"organizations">, streamId: string) => ctx.db.query("dealChats").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", streamId)).take(CHATS_MAX);

export const list = query({
  args: { streamId: v.string() },
  handler: async (ctx, { streamId }) => {
    const { user, allowed } = await admission(ctx, streamId);
    if (!allowed) return { available: false, mine: [], shared: [] };
    const chats = (await chatsOf(ctx, user.orgId, streamId)).sort((a, b) => b.updatedAt - a.updatedAt);
    const summary = (c: Doc<"dealChats">) => ({ _id: c._id, title: c.title, updatedAt: c.updatedAt });
    return { available: true, mine: chats.filter((c) => c.ownerId === user._id).map(summary), shared: chats.filter((c) => c.ownerId !== user._id && c.sharedWith.includes(user._id)).map(summary) };
  },
});

export const get = query({
  args: { chatId: v.id("dealChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await chatFor(ctx, chatId);
    if (!chat) return null;
    const user = await requireUser(ctx);
    return { title: chat.title, owned: chat.ownerId === user._id, sharedWith: chat.sharedWith, messages: await messagesOf(ctx, chatId) };
  },
});

export const create = mutation({
  args: { streamId: v.string(), title: v.string() },
  handler: async (ctx, { streamId, title }) => {
    await requireUser(ctx);
    const { user, allowed } = await admission(ctx, streamId);
    if (!allowed) throw new ConvexError("Saved deal chats require unrestricted read access to this deal.");
    if ((await chatsOf(ctx, user.orgId, streamId)).length >= CHATS_MAX) throw new ConvexError("This deal has 100 chats. Delete an old chat first.");
    const now = Date.now();
    return ctx.db.insert("dealChats", { orgId: user.orgId, streamId, ownerId: user._id, title: title.trim().slice(0, 120) || "Deal chat", sharedWith: [], createdAt: now, updatedAt: now });
  },
});

export const share = mutation({
  args: { chatId: v.id("dealChats"), userIds: v.array(v.id("users")) },
  handler: async (ctx, { chatId, userIds }) => {
    await requireUser(ctx);
    const chat = await chatFor(ctx, chatId, true);
    if (!chat) throw new ConvexError("Chat unavailable.");
    const ids = [...new Set(userIds)].filter((id) => id !== chat.ownerId);
    if (ids.length > 50) throw new ConvexError("Share with at most 50 members.");
    const deal = await dealOfStream(ctx, chat.orgId, chat.streamId);
    const accesses = ids.length ? await principalAccess(ctx, chat.orgId, ids) : [];
    if (!deal || !accesses || accesses.some((a) => isRestricted(a) || !dealVisible(a, deal))) throw new ConvexError("Recipients need unrestricted read access to this deal.");
    await ctx.db.patch(chatId, { sharedWith: ids, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { chatId: v.id("dealChats") },
  handler: async (ctx, { chatId }) => {
    const user = await requireUser(ctx);
    const chat = await ctx.db.get(chatId);
    // Owners can erase their retained text even after losing access to its deal.
    if (!chat || chat.orgId !== user.orgId || chat.ownerId !== user._id) throw new ConvexError("Chat unavailable.");
    for (const message of await messagesOf(ctx, chatId)) await ctx.db.delete(message._id);
    await ctx.db.delete(chatId);
    return null;
  },
});

export const begin = internalMutation({
  args: { chatId: v.id("dealChats"), turnId: v.string() },
  handler: async (ctx, { chatId, turnId }) => {
    await requireUser(ctx);
    const chat = await chatFor(ctx, chatId, true);
    if (!chat) throw new ConvexError("Chat unavailable.");
    if (chat.pending && Date.now() - (chat.pendingAt ?? 0) < 130_000) throw new ConvexError("A reply is already in progress.");
    const messages = await messagesOf(ctx, chatId);
    if (messages.length + 2 > MESSAGES_MAX) throw new ConvexError("This chat is full. Start a new chat.");
    await ctx.db.patch(chatId, { pending: turnId, pendingAt: Date.now() });
    return { streamId: chat.streamId, history: messages.slice(-8).map(({ role, content }) => ({ role, content })) };
  },
});

export const finish = internalMutation({
  args: { chatId: v.id("dealChats"), turnId: v.string(), reply: v.optional(v.object({ question: v.string(), answer: v.string(), sources })) },
  handler: async (ctx, { chatId, turnId, reply }) => {
    await requireUser(ctx);
    const chat = await chatFor(ctx, chatId, true);
    if (!chat || chat.pending !== turnId) throw new ConvexError("Chat changed or is unavailable.");
    const now = Date.now();
    if (reply) {
      await ctx.db.insert("dealChatMessages", { chatId, role: "user", content: reply.question.slice(0, MAX_QUESTION_CHARS), sources: [], createdAt: now });
      await ctx.db.insert("dealChatMessages", { chatId, role: "assistant", content: reply.answer.slice(0, MAX_ANSWER_CHARS), sources: reply.sources.slice(0, 20), createdAt: now });
    }
    await ctx.db.patch(chatId, { pending: undefined, pendingAt: undefined, updatedAt: now });
    return null;
  },
});
