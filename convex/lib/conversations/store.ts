/**
 * Reading and erasing what conversation intake stored (docs/conversation-intake.md). `readableTexts` is the one
 * read of conversationMessages text: every surface that shows it goes through here, so the owner's permission
 * check (intake.ts mayReadText) holds everywhere. tests/conversationIntake.test.ts fails on another reader.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Access } from "../access.ts";
import type { StoredMessage } from "./extract.ts";
import { mayReadText, messageIdOfKey } from "./intake.ts";

/** A message's text as one reader may see it: the text, or only whose conversation it was. */
export type MessageText = { text: string } | { hidden: true; ownerUserId: string };

/** Copies of one message kept, at most: one per linked account that read it (an email to several teammates). */
const COPIES_MAX = 20;

/** Every copy of a message in the org, each with its conversation (one in another org is dropped). */
async function copiesOf(ctx: QueryCtx, orgId: Id<"organizations">, externalMessageId: string) {
  const rows = await ctx.db.query("conversationMessages").withIndex("by_orgId_and_externalMessageId", (q) => q.eq("orgId", orgId).eq("externalMessageId", externalMessageId)).take(COPIES_MAX);
  const out: Array<{ message: Doc<"conversationMessages">; conversation: Doc<"conversations"> }> = [];
  for (const message of rows) {
    const conversation = await ctx.db.get(message.conversationId);
    if (conversation?.orgId === orgId) out.push({ message, conversation });
  }
  return out;
}

type Copy = Awaited<ReturnType<typeof copiesOf>>[number];

/** A message's text from the first copy whose owner's text `access` may read, else only whose it was. */
function textOfCopies(access: Access, copies: readonly Copy[], ownerUserId: string): MessageText {
  const readable = copies.find((c) => mayReadText(access, c.conversation.ownerUserId));
  return readable ? { text: readable.message.text } : { hidden: true, ownerUserId };
}

/** The account's own copy of a message, when it has read it (intake's dedupe, and a reply finding its thread). */
export async function accountCopy(ctx: QueryCtx, orgId: Id<"organizations">, accountRef: string, externalMessageId: string) {
  return (await copiesOf(ctx, orgId, externalMessageId)).find((c) => c.conversation.accountRef === accountRef) ?? null;
}

/**
 * The stored text behind each timeline key (`linkedin:msg:<id>`, `linkedin:reply:<id>`, `email:msg:<id>`,
 * `email:received:<id>`) that has some, as `access` may see it: a copy whose owner's text it may read, else only
 * whose it was. Call only after the caller was judged able to see the contact the keys came from.
 */
export async function readableTexts(ctx: QueryCtx, access: Access, orgId: Id<"organizations">, keys: readonly string[]): Promise<Record<string, MessageText>> {
  const out: Record<string, MessageText> = {};
  for (const key of keys) {
    const id = messageIdOfKey(key);
    const copies = id ? await copiesOf(ctx, orgId, id) : [];
    if (copies.length) out[key] = textOfCopies(access, copies, copies[0].conversation.ownerUserId);
  }
  return out;
}

/** One message of a thread as a reader may see it: who wrote it and when, with its text only where they may read it. */
export type ThreadMessage = { id: string; direction: "in" | "out"; at: number; from: string } & MessageText;

/**
 * A conversation's latest `limit` messages, oldest first, as `access` may see them (the record page's thread,
 * convex/conversationView.ts, and /mcp's, convex/conversationsApi.ts). As on the timeline (readableTexts), a message
 * the caller may not read in this conversation shows its text when another inbox's copy is theirs to read. Call only
 * after the caller was judged able to see the conversation.
 */
export async function readableThread(ctx: QueryCtx, access: Access, conversation: Doc<"conversations">, limit: number): Promise<{ messages: ThreadMessage[]; more: boolean }> {
  const rows = await ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", conversation._id)).order("desc").take(limit + 1);
  const reads = mayReadText(access, conversation.ownerUserId);
  const messages: ThreadMessage[] = [];
  for (const m of rows.slice(0, limit).reverse()) {
    const text = reads ? { text: m.text } : textOfCopies(access, await copiesOf(ctx, conversation.orgId, m.externalMessageId), conversation.ownerUserId);
    messages.push({ id: m._id, direction: m.direction, at: m.at, from: m.from, ...text });
  }
  return { messages, more: rows.length > limit };
}

/**
 * A conversation's latest messages, read for its owner only (CI3b extraction, convex/conversationExtract.ts): the
 * owner may always read their own conversation's text (mayReadText). Anyone else gets nothing.
 */
export async function ownerThread(ctx: QueryCtx, conversation: Doc<"conversations">, userId: Id<"users">, limit: number): Promise<StoredMessage[]> {
  if (conversation.ownerUserId !== userId) return [];
  const rows = await ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", conversation._id)).order("desc").take(limit);
  return rows.map((m) => ({ at: m.at, from: m.from, direction: m.direction === "out" ? "us" : "them", text: m.text, stored: m._creationTime }));
}

/** Delete the stored text behind a timeline key, every inbox's copy (a contact's erase). */
export async function eraseMessageOfKey(ctx: MutationCtx, orgId: Id<"organizations">, key: string): Promise<void> {
  const id = messageIdOfKey(key);
  for (const { message } of id ? await copiesOf(ctx, orgId, id) : []) await ctx.db.delete(message._id);
}

/** Contacts one conversation is linked to, at most (conversations.ts keeps at most 10 per conversation). */
const LINKS_MAX = 50;

/** Link a conversation to each of `contactIds` it is not linked to yet: how a record's page finds it (conversationView.ts). */
export async function linkContacts(ctx: MutationCtx, orgId: Id<"organizations">, conversationId: Id<"conversations">, contactIds: Iterable<string>): Promise<void> {
  for (const contactId of contactIds) {
    const linked = await ctx.db.query("conversationContacts").withIndex("by_conversationId_and_contactId", (q) => q.eq("conversationId", conversationId).eq("contactId", contactId)).first();
    if (!linked) await ctx.db.insert("conversationContacts", { orgId, contactId, conversationId });
  }
}

/** Drop a conversation's links to its contacts (it is being erased). Returns how many rows went. */
export async function unlinkContacts(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<number> {
  const rows = await ctx.db.query("conversationContacts").withIndex("by_conversationId_and_contactId", (q) => q.eq("conversationId", conversationId)).take(LINKS_MAX);
  for (const r of rows) await ctx.db.delete(r._id);
  return rows.length;
}
