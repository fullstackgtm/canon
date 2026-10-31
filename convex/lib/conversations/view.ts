/**
 * A record's Conversations section (docs/conversation-intake.md CI4): its email and LinkedIn threads and its calls
 * and meetings in one list, newest first. Pure: the record page and convex/conversationView.ts share it.
 */
import type { Activity } from "../activities.ts";

/** An email or LinkedIn thread as a record's list shows it: who and when, never the text. */
export type ConversationSummary = {
  id: string;
  channel: "email" | "linkedin";
  lastMessageAt: number;
  contactId: string;
  /** Who the rep talked to, as intake named them. */
  counterpart: string;
  /** An email thread's subject. */
  subject?: string;
  ownerUserId: string;
  /** Proposals the last extraction made, and suggestions the conversation made, at most `COUNT_MAX` each. */
  proposals: number;
  suggestions: number;
};

export type ConversationRow =
  | ({ kind: "conversation"; at: number } & ConversationSummary)
  | { kind: "call" | "meeting"; id: string; at: number; title: string; ownerId: string | null };

/** Threads, then calls and meetings, merged newest first; at most `limit`. A thread read twice (two contacts' lists) shows once. */
export function conversationRows(conversations: readonly ConversationSummary[], activities: readonly Activity[], limit: number): ConversationRow[] {
  const rows = new Map<string, ConversationRow>();
  for (const c of conversations) rows.set(`c:${c.id}`, { kind: "conversation", at: c.lastMessageAt, ...c });
  for (const a of activities) {
    if (a.kind === "call") rows.set(`a:${a.id}`, { kind: "call", id: a.id, at: a.at, title: a.subject ?? "Call", ownerId: a.ownerId });
    else if (a.kind === "meeting") rows.set(`a:${a.id}`, { kind: "meeting", id: a.id, at: a.at, title: a.title, ownerId: a.ownerId });
  }
  return [...rows.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, limit);
}
