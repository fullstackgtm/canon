/**
 * Email logging (convex/emailLog.ts): the logging address, and what one delivered message logs. The token in the
 * address names the member; the message itself authorizes nothing. Its From must be one of that member's own
 * addresses (and so must the envelope sender, when the adapter passes one), or it is held, never logged as theirs.
 * Mail the member sent with the address on BCC logs as sent by them. Mail they forwarded to it logs as the
 * original, from its sender and at its date, when the forward's header block or attachment says who that was.
 *
 * Pure: no database access, no Node-only imports.
 */
import { stripQuoted, BODY_MAX } from "../email/replies.ts";
import { isOurSide, type Team } from "../calls/suggestions.ts";
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "../calls/granola.ts";
import { BULK_RECIPIENTS, PARTICIPANTS_MAX } from "../conversations/email.ts";
import { MESSAGE_TEXT_MAX } from "../linkedin/inbound.ts";
import { forwardedOf } from "./forward.ts";
import type { Attachment, MailAddress, ParsedMail } from "./mime.ts";

/** `log+<token>@<domain>`: 24 characters of a-z and 2-7 (120 bits), lowercase so no mail system changes it. */
export const TOKEN_LENGTH = 24;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newToken(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(random(TOKEN_LENGTH), (b) => TOKEN_ALPHABET[b & 31]).join("");
}

export const addressOf = (token: string, domain: string) => `log+${token}@${domain.trim().toLowerCase()}`;

/** The token of the first recipient that is a logging address on `domain`, or null. */
export function tokenOf(recipients: readonly string[], domain: string): string | null {
  const want = domain.trim().toLowerCase();
  for (const r of recipients) {
    const m = /^log\+([a-z2-7]+)@(.+)$/.exec(r.trim().toLowerCase().replace(/^.*<|>.*$/g, ""));
    if (m && m[2] === want && m[1].length === TOKEN_LENGTH) return m[1];
  }
  return null;
}

/** An address without its `+tag`: Gmail's auto-forwarding sends as `ada+caf_=...@`. */
const untagged = (email: string) => email.toLowerCase().replace(/\+[^@]*@/, "@");

export type LoggedEmail = {
  kind: "bcc" | "forward";
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  direction: "in" | "out";
  at: number;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** Above the quoted chain, capped, with a line naming any attachments (keptText). */
  text: string;
  /** The same email logged twice, by BCC and by a forward, has the same fingerprint (fingerprintOf). */
  fingerprint: string;
  /** `messageId` is the email's own (not the forward's): only an email without one is matched by fingerprint. */
  ownId: boolean;
};

export type HoldReason = "not_member" | "unreadable_forward";
export type Attributed = { log: LoggedEmail } | { hold: HoldReason };

const normalSubject = (s: string) => s.replace(/^\s*((re|fwd?|fw|aw|wg|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Sender, minute and subject: a forward's header block gives the minute at best. */
export const fingerprintOf = (from: string, at: number, subject: string) => `${from.toLowerCase()}|${Math.floor(at / 60_000)}|${normalSubject(subject).slice(0, 200)}`;

/**
 * The text kept: above the quoted reply chain when that can be cut (lib/email/replies.ts stripQuoted), else whole,
 * and at most MESSAGE_TEXT_MAX characters, ending with a line that says how much was left out.
 */
export function keptText(text: string, attachments: readonly Attachment[] = [], note = ""): string {
  const whole = text.replace(/\r\n?/g, "\n").trim();
  const above = stripQuoted(whole);
  let body = (above && above.length < BODY_MAX ? above : whole) + (note ? `\n\n[Note added when forwarding]\n${note}` : "");
  const files = attachments.length ? `\n\n[Attachments, not kept: ${attachments.map((a) => `${a.name} (${sizeOf(a.size)})`).join(", ")}]` : "";
  const room = MESSAGE_TEXT_MAX - files.length;
  if (body.length > room) {
    const keep = room - 100;
    body = `${body.slice(0, keep)}\n\n[Truncated: the last ${(body.length - keep).toLocaleString("en-US")} characters were not kept]`;
  }
  return body + files;
}

const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

const outsiders = (people: readonly MailAddress[], team: Team, domain: string) =>
  people.filter((p) => !isOurSide(team, p.email) && !p.email.endsWith(`@${domain}`));

/**
 * What a delivered message logs for the member it was addressed to. `addresses` are the member's own (their sign-in
 * address and the Gmail inboxes they linked); `team` decides which side a forwarded email came from; `now` dates mail
 * with no readable date.
 */
export function attributed(mail: ParsedMail, member: { addresses: ReadonlySet<string>; envelopeFrom?: string | null }, team: Team, domain: string, now: number): Attributed {
  const own = new Set([...member.addresses].map((a) => a.toLowerCase()));
  const sender = mail.from?.email;
  if (!sender || !own.has(sender) || (member.envelopeFrom && !own.has(untagged(member.envelopeFrom)))) return { hold: "not_member" };
  const at = mail.date ?? now;
  const messageId = mail.messageId ?? `logged.${fingerprintOf(sender, at, mail.subject).replace(/[^a-z0-9.@-]+/g, ".")}`;
  const sentToOutsiders = outsiders([...mail.to, ...mail.cc], team, domain).length > 0;
  const forwarded = sentToOutsiders ? null : forwardedOf(mail);
  if (!forwarded) {
    if (!sentToOutsiders && /^\s*(fwd?|fw)\s*:/i.test(mail.subject)) return { hold: "unreadable_forward" };
    return {
      log: {
        kind: "bcc", messageId, inReplyTo: mail.inReplyTo, references: mail.references, direction: "out", at, from: mail.from!, to: mail.to, cc: mail.cc,
        subject: mail.subject, text: keptText(mail.text, mail.attachments), fingerprint: fingerprintOf(sender, at, mail.subject), ownId: true,
      },
    };
  }
  const origAt = forwarded.at ?? at;
  return {
    log: {
      kind: "forward", messageId: forwarded.messageId ?? messageId, inReplyTo: forwarded.inReplyTo, references: forwarded.references,
      direction: isOurSide(team, forwarded.from.email) || own.has(forwarded.from.email) ? "out" : "in",
      at: origAt, from: forwarded.from, to: forwarded.to, cc: forwarded.cc, subject: forwarded.subject || mail.subject.replace(/^\s*(fwd?|fw)\s*:\s*/i, ""),
      text: keptText(forwarded.text, mail.attachments.filter((a) => a.type !== "message/rfc822" || !forwarded.messageId), forwarded.note),
      fingerprint: fingerprintOf(forwarded.from.email, origAt, forwarded.subject || mail.subject), ownId: forwarded.messageId !== null,
    },
  };
}

export type Participants =
  | { keep: false; reason: "team" | "bulk" }
  | { keep: true; counterpart: MailAddress & { domain?: string }; participants: MailAddress[] };

/**
 * Who a logged email was with, as email intake counts them (lib/conversations/email.ts mailVerdict): everyone on it
 * outside the team and the logging domain, the sender of a received email first. None, or a bulk send, logs nothing.
 */
export function participantsOf(log: LoggedEmail, team: Team, domain: string): Participants {
  const people = [...new Map(outsiders([log.from, ...log.to, ...log.cc], team, domain).map((p) => [p.email, p])).values()];
  if (!people.length) return { keep: false, reason: "team" };
  if (people.length > BULK_RECIPIENTS) return { keep: false, reason: "bulk" };
  const first = people[0];
  const d = domainOfEmail(first.email);
  return { keep: true, counterpart: { ...first, ...(FREE_EMAIL_DOMAINS.has(d) ? {} : { domain: d }) }, participants: people.slice(0, PARTICIPANTS_MAX) };
}
