/**
 * Canon tools for conversation intake (docs/conversation-intake.md, CI5): the
 * email and LinkedIn conversations Canon reads for a person who turned it on.
 *
 * Same Convex functions (convex/conversationsApi.ts), run as the caller, so a
 * connection sees what its user sees in the app and no more. Turning intake
 * on, and deleting what was read, are the person's consent and stay in the app.
 */
import { api } from "../../../convex/_generated/api.js";
import type { CanonTool } from "./_canonTools.ts";
import { a, groupTool, m, q } from "./_canonJobTools.ts";

const SUMMARY = "{ conversationId, channel: linkedin | email, ownerUserId, mine, counterpart: { name?, providerId?, publicIdentifier?, profileUrl?, email? }, contactIds (the people it is matched to), lastMessageAt, lastMessage, extraction: { status: waiting (dueAt) | read (readAt, patchPlanId: the proposals it made, in canon_patch_plans) | skipped (reason) | not_read } }";
const MESSAGE = "{ id, at, direction: in | out, from, text } or, where the caller may not read it, { id, at, direction, from, hidden: true, ownerUserId }";

export const canonConversationTools: CanonTool[] = [
  groupTool(
    "canon_conversations",
    "The LinkedIn and email conversations Canon reads for people who turned on \"Read my messages\" for a linked account. You see your own conversations, and a teammate's only through a person your role sees; a message's text shows to its owner and to roles that read the owner's activity, otherwise only who sent it and when. For a company or a deal, list its people first (canon_associations related, canon_deal_roles for_deal) and pass their ids. Canon reads each thread once it goes quiet and proposes the record changes it finds (extraction). Turning reading on, and deleting what was read, are for the account's owner in the app.",
    {
      list: a(api.conversationsApi.list, `{ contactIds?: string[] (at most 50; omit for your own conversations), limit? (at most 50) } -> { conversations: [${SUMMARY}] } newest first; lastMessage is ${MESSAGE}`),
      thread: a(api.conversationsApi.thread, `{ conversationId, limit? (latest messages, default 50, at most 200) } -> { ...summary, messages: [${MESSAGE}] oldest first, more (older messages exist) }`),
      intake_status: q(api.conversationsApi.intakeStatus, "{} -> { accounts: [{ accountId, channel, label, status, on, consentAt, backfilledAt, syncedAt, hasRead }] } (your linked LinkedIn and Gmail accounts and whether Canon reads each one's messages)"),
      stop_intake: m(api.conversationsApi.stopIntake, "{ accountId (yours, from intake_status) } -> { on: false } (stops reading that account's messages; what was read stays until you delete it in the app)"),
    },
  ),
];
