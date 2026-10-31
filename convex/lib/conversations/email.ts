/**
 * Email conversation intake (docs/conversation-intake.md, CI2): one Unipile email (a webhook's, the mail list's,
 * or one read by id) as intake keeps it, and whether it is a conversation with someone outside the team at all.
 * Skipped: drafts, trash and spam; mail where everyone else is on the team (Granola's rules, lib/calls/suggestions.ts
 * teamOf); newsletters and automated senders (List-Unsubscribe, List-Id, Precedence, Auto-Submitted, no-reply
 * addresses); and bulk sends (more than `BULK_RECIPIENTS` people outside the team).
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "../calls/granola.ts";
import { isOurSide, type Team } from "../calls/suggestions.ts";
import { stripQuoted } from "../email/replies.ts";
import { plainOf } from "../linkedin/inbound.ts";
import { timeOf } from "../linkedin/unipile.ts";

export type MailPerson = { email: string; name?: string };

export type IntakeMail = {
  /** Unipile's id, to read the email again. */
  emailId: string;
  /** The RFC Message-ID (Unipile's id when there is none): the stored message's id and its timeline key. */
  messageId: string;
  /** Unipile's thread id; null when Unipile sent none (the thread is then found through `inReplyTo`). */
  threadId: string | null;
  inReplyTo: string | null;
  direction: "in" | "out";
  at: number;
  from: MailPerson;
  /** To and Cc. */
  recipients: MailPerson[];
  subject: string;
  /** The text above the quoted history. */
  text: string;
  /** Sent through Canon's Unipile key (a send from Canon, already on the timeline). */
  viaCanon: boolean;
  /** A newsletter or an automated sender, by its headers or address. */
  automated: boolean;
};

/** More people outside the team than this on one email make it a bulk send. */
export const BULK_RECIPIENTS = 10;
/** Participants kept on a conversation, at most. */
export const PARTICIPANTS_MAX = 20;

const SKIPPED_ROLES = new Set(["drafts", "trash", "spam"]);
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|newsletters?|bounces?)([+._-]|$)/i;

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

function personOf(raw: unknown): MailPerson | null {
  const r = rec(raw);
  const email = str(r.identifier)?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = str(r.display_name);
  return name && name.toLowerCase() !== email ? { email, name: name.slice(0, 200) } : { email };
}

/** Whether headers or the sender's address say a machine or a mailing list sent it. */
export function isAutomated(headers: ReadonlyMap<string, string>, from: string): boolean {
  if (headers.has("list-unsubscribe") || headers.has("list-id")) return true;
  if (/^(bulk|list|junk)$/i.test(headers.get("precedence") ?? "")) return true;
  const auto = headers.get("auto-submitted");
  if (auto && !/^no$/i.test(auto)) return true;
  return AUTOMATED_LOCAL.test(from.slice(0, from.lastIndexOf("@")));
}

/** One Unipile email as intake reads it, seen from the inbox `inbox`; null for a draft, trash, spam or one without an id or sender. */
export function intakeMailOf(raw: unknown, inbox: string): IntakeMail | null {
  const r = rec(raw);
  const emailId = str(r.id) ?? str(r.email_id);
  const from = personOf(r.from_attendee);
  const at = timeOf(r.date);
  const role = str(r.role)?.toLowerCase() ?? "";
  const folders = Array.isArray(r.folders) ? r.folders.map((f) => String(f).toUpperCase()) : [];
  if (!emailId || !from || !at || SKIPPED_ROLES.has(role) || folders.some((f) => /DRAFT|TRASH|SPAM/.test(f))) return null;
  const headers = new Map<string, string>();
  for (const h of Array.isArray(r.headers) ? r.headers : []) {
    const name = str(rec(h).name)?.toLowerCase();
    const value = str(rec(h).value);
    if (name && value && !headers.has(name)) headers.set(name, value);
  }
  const recipients = new Map<string, MailPerson>();
  for (const p of [...(Array.isArray(r.to_attendees) ? r.to_attendees : []), ...(Array.isArray(r.cc_attendees) ? r.cc_attendees : [])].map(personOf)) {
    if (p && !recipients.has(p.email)) recipients.set(p.email, p);
  }
  const me = inbox.toLowerCase();
  const out = from.email === me || role === "sent" || folders.some((f) => f.includes("SENT"));
  return {
    emailId: emailId.slice(0, 300),
    messageId: (str(r.message_id) ?? emailId).slice(0, 300),
    threadId: str(r.thread_id)?.slice(0, 300) ?? null,
    inReplyTo: str(rec(r.in_reply_to).message_id)?.slice(0, 300) ?? null,
    direction: out ? "out" : "in",
    at,
    from,
    recipients: [...recipients.values()],
    subject: (str(r.subject) ?? "").slice(0, 300),
    text: stripQuoted(str(r.body_plain) ?? plainOf(str(r.body) ?? "")),
    viaCanon: str(r.origin) === "unipile",
    automated: isAutomated(headers, from.email),
  };
}

export type MailVerdict =
  | { keep: false; reason: "team" | "automated" | "bulk" }
  | { keep: true; counterpart: MailPerson & { domain?: string }; participants: MailPerson[] };

/**
 * Whether intake keeps an email, and who it was with: everyone on it outside the inbox and the team, the one the
 * conversation is with first (the sender of a received email, the first outside recipient of a sent one).
 */
export function mailVerdict(mail: IntakeMail, inbox: string, team: Team): MailVerdict {
  const me = inbox.toLowerCase();
  const outside = (p: MailPerson) => p.email !== me && !isOurSide(team, p.email);
  const people = [mail.from, ...mail.recipients].filter(outside);
  if (!people.length) return { keep: false, reason: "team" };
  if (mail.direction === "in" && mail.automated) return { keep: false, reason: "automated" };
  if (people.length > BULK_RECIPIENTS) return { keep: false, reason: "bulk" };
  const first = people[0];
  const domain = domainOfEmail(first.email);
  return {
    keep: true,
    counterpart: { ...first, ...(FREE_EMAIL_DOMAINS.has(domain) ? {} : { domain }) },
    participants: people.slice(0, PARTICIPANTS_MAX),
  };
}

/** A webhook mail event intake reads (`mail_received` or `mail_sent`): the account and Unipile's id of the email. */
export function mailEventOf(body: unknown): { accountId: string; emailId: string } | null {
  const b = rec(body);
  if (b.event !== "mail_received" && b.event !== "mail_sent") return null;
  const accountId = str(b.account_id);
  const emailId = str(b.email_id) ?? str(b.id);
  return accountId && emailId ? { accountId, emailId } : null;
}
