/**
 * Conversation intake (docs/conversation-intake.md): who may read the text Canon keeps, and how a
 * counterpart is matched to a contact. The consent text is in consent.ts.
 * Pure: no database access, no Node-only imports.
 */
import { canSeeRecord, hasOwnerField, type Access } from "../access.ts";
import { ACTIVITY_TYPES } from "../objects/reportSpec.ts";
import { publicIdentifierOf } from "../linkedin/cadence.ts";

export const BACKFILL_DAYS = 90;
/** Extraction (CI3) waits until a thread has been quiet this long. */
export const EXTRACT_QUIET_MS = 10 * 60_000;

/** The timeline observation key of a message intake read. */
export const messageKey = (externalMessageId: string) => `linkedin:msg:${externalMessageId}`;
/** The key a cadence reply is logged under (linkedinWorker.inboundReply): the same message, already on the timeline. */
export const replyKey = (externalMessageId: string) => `linkedin:reply:${externalMessageId}`;

/** An email intake read (CI2), sent or received, keyed by its Message-ID. */
export const emailMessageKey = (messageId: string) => `email:msg:${messageId}`;
/** The key a received email is logged under (emailAccounts.logReceived): the same message, already on the timeline. */
export const emailReceivedKey = (messageId: string) => `email:received:${messageId}`;

/** The message id behind a timeline key whose text intake may hold (a LinkedIn message or an email), or null for any other key. */
export function messageIdOfKey(key: string): string | null {
  const m = /^(?:linkedin:(?:msg|reply)|email:(?:msg|received)):(.+)$/.exec(key);
  return m ? m[1] : null;
}

/**
 * Whether `access` may read the text of a conversation `ownerUserId` had: its owner, or a role that reads that
 * owner's activities (every activity type, so a role narrowed on any one of them reads metadata only).
 */
export function mayReadText(access: Access, ownerUserId: string): boolean {
  if (access.userId === ownerUserId) return true;
  return ACTIVITY_TYPES.every((t) => canSeeRecord(access, t, hasOwnerField(t), ownerUserId));
}

/** A profile's vanity slug: Unipile's public identifier, else the one in its profile link. */
export function slugOf(publicIdentifier: string | null | undefined, profileUrl: string | null | undefined): string | null {
  return publicIdentifier?.trim() || publicIdentifierOf(profileUrl);
}

/** The one contact whose LinkedIn URL names `slug` (in any case), or null when none or several do. */
export function contactBySlug(slug: string, rows: ReadonlyArray<{ id: string; values: Record<string, unknown> }>): string | null {
  const want = slug.toLowerCase();
  const hits = rows.filter((r) => typeof r.values.linkedinUrl === "string" && publicIdentifierOf(r.values.linkedinUrl)?.toLowerCase() === want);
  return hits.length === 1 ? hits[0].id : null;
}
