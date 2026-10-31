/**
 * Replies arriving through Unipile's webhooks (docs/deal-plays.md, DP4): a
 * LinkedIn message someone sent one of Canon's senders, and an email that
 * landed in a linked Gmail inbox. Before this a reply was noticed only when
 * the replier's next cadence message came due. Pure parsers: they read only
 * the fields Canon needs and return null for anything else.
 *
 * A cadence reply (`linkedinReplyOf`) carries ids only, never text, and our own
 * messages are not replies. Conversation intake (docs/conversation-intake.md)
 * reads more, for accounts whose owner turned it on: `linkedinMessageOf` keeps the
 * text of every 1:1 message, the ones the account sent included. The webhook
 * route asks whether the account opted in before it keeps anything.
 */

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null);
const when = (x: unknown) => {
  const t = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : Number.NaN;
  return Number.isFinite(t) && t > 0 ? t : null;
};

export type LinkedinReply = { accountId: string; chatId: string; messageId: string; senderProviderId: string; at: number | null };

/** A LinkedIn message someone else sent (Unipile `messaging` source, `message_received`). */
export function linkedinReplyOf(body: unknown): LinkedinReply | null {
  const b = obj(body);
  if (!b || b.event !== "message_received") return null;
  const type = str(b.account_type);
  if (type && type.toUpperCase() !== "LINKEDIN") return null;
  const sender = obj(b.sender);
  const accountId = str(b.account_id);
  const chatId = str(b.chat_id);
  const messageId = str(b.message_id);
  const senderProviderId = str(sender?.attendee_provider_id);
  if (!accountId || !chatId || !messageId || !senderProviderId) return null;
  // A message the account itself sent (from LinkedIn directly, or our own send echoing back) is not a reply.
  const self = str(obj(b.account_info)?.user_id);
  if (b.is_sender === true || (self && self === senderProviderId)) return null;
  return { accountId, chatId, messageId, senderProviderId, at: when(b.timestamp) };
}

/** Who the account is talking to in a 1:1 chat: LinkedIn's provider id, and the name and profile link when given. */
export type Counterpart = { providerId: string; name: string | null; profileUrl: string | null };

export type LinkedinMessage = {
  accountId: string; chatId: string; messageId: string; direction: "in" | "out"; at: number | null;
  /** The sender's provider id. */
  from: string; text: string; counterpart: Counterpart;
};

/** At most this much of a message's text is kept. */
export const MESSAGE_TEXT_MAX = 50_000;

const attendeeOf = (x: unknown): Counterpart | null => {
  const a = obj(x);
  const providerId = str(a?.attendee_provider_id);
  return providerId ? { providerId, name: str(a?.attendee_name), profileUrl: str(a?.attendee_profile_url) } : null;
};

/**
 * Any message in a 1:1 LinkedIn chat, either way (Unipile `message_received`), for conversation intake. Null for
 * group chats, spam, sponsored messages and events (reactions, read receipts), and when the other person is unknown.
 */
export function linkedinMessageOf(body: unknown): LinkedinMessage | null {
  const b = obj(body);
  if (!b || b.event !== "message_received") return null;
  const type = str(b.account_type);
  if (type && type.toUpperCase() !== "LINKEDIN") return null;
  const accountId = str(b.account_id);
  const chatId = str(b.chat_id);
  const messageId = str(b.message_id);
  const sender = attendeeOf(b.sender);
  if (!accountId || !chatId || !messageId || !sender || b.is_event === true || b.is_event === 1) return null;
  const folders = Array.isArray(b.folder) ? b.folder.map((f) => String(f).toUpperCase()) : [];
  if (folders.some((f) => f.includes("SPAM")) || /sponsored/i.test(str(b.chat_content_type) ?? "")) return null;
  const self = str(obj(b.account_info)?.user_id);
  const out = b.is_sender === true || b.is_sender === 1 || (self !== null && self === sender.providerId);
  const others = (Array.isArray(b.attendees) ? b.attendees : []).flatMap((a) => attendeeOf(a) ?? [])
    .filter((a) => a.providerId !== self && !(out && a.providerId === sender.providerId));
  const distinct = new Map([...others, ...(out ? [] : [sender])].map((a) => [a.providerId, a]));
  if (b.is_group === true || distinct.size !== 1) return null;
  const counterpart = [...distinct.values()][0];
  return {
    accountId, chatId, messageId, direction: out ? "out" : "in", at: when(b.timestamp), from: sender.providerId,
    text: (typeof b.message === "string" ? b.message : "").slice(0, MESSAGE_TEXT_MAX), counterpart,
  };
}

export type EmailReply = { accountId: string; from: string; subject: string; body: string; inReplyTo: string | null; messageId: string; at: number | null };

/** HTML as plain text: tags out, breaks and paragraphs as new lines, the common entities decoded. */
export const plainOf = (html: string) => html.replace(/<(br|\/p|\/div)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** An email received in a linked inbox (Unipile `email` source, `mail_received`). Sent mail is ignored. */
export function emailReplyOf(body: unknown): EmailReply | null {
  const b = obj(body);
  if (!b || b.event !== "mail_received") return null;
  const folders = Array.isArray(b.folders) ? b.folders.map((f) => String(f).toUpperCase()) : [];
  if (folders.some((f) => f.includes("SENT") || f.includes("DRAFT")) || str(b.role)?.toLowerCase() === "sent") return null;
  const accountId = str(b.account_id);
  const from = str(obj(b.from_attendee)?.identifier)?.toLowerCase() ?? null;
  const messageId = str(b.message_id) ?? str(b.email_id);
  if (!accountId || !from || !from.includes("@") || !messageId) return null;
  const text = (str(b.body_plain) ?? plainOf(str(b.body) ?? "")).slice(0, 50_000);
  const inReplyTo = str(obj(b.in_reply_to)?.message_id)?.slice(0, 300) ?? null;
  return { accountId, from, subject: (str(b.subject) ?? "").slice(0, 300), body: text, inReplyTo, messageId: messageId.slice(0, 300), at: when(b.date) };
}
