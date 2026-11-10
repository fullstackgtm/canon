/**
 * Message-IDs as every email source compares them (a linked inbox read through Unipile, mail logged by BCC or
 * forward, a reply webhook), and the key of the thread an email belongs to. Pure: no imports.
 */

/**
 * A Message-ID as every source stores and compares it, without angle brackets: logged mail's parser drops them
 * (lib/emailLog/mime.ts), and Unipile's `message_id` is not documented either way.
 */
export const bareMessageId = (id: string) => id.trim().replace(/^<([^<>]+)>$/, "$1");
/** The forms one Message-ID may be stored under: bare, and with the brackets rows stored before bareMessageId kept. */
export const messageIdForms = (id: string): string[] => {
  const bare = bareMessageId(id);
  return [bare, `<${bare}>`];
};

/** The ids an RFC 5322 header lists (References, In-Reply-To), in order, without brackets. */
export const headerIds = (value: string | null | undefined) => [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].slice(0, 300));

/**
 * An email thread's key, the same from every source (a linked inbox, a BCC, a forward): `msg:` and its root
 * Message-ID, the first References entry, else the message it replies to, else its own.
 */
export const emailThreadKey = (m: { messageId: string; inReplyTo?: string | null; references?: readonly string[] }) =>
  `msg:${m.references?.[0] ?? m.inReplyTo ?? m.messageId}`;
