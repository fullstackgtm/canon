/**
 * What an email that landed in a linked Gmail inbox is (docs/gmail-sending.md, G2): a bounce notice, an
 * auto-reply, or a person's reply, and for a reply what it says (interested, not now, not interested,
 * unsubscribe). Headers and keywords decide first; only a reply they can't place, with a body of at least
 * `MODEL_MIN_CHARS`, goes to the inbox owner's model (convex/emailReplyActions.ts).
 *
 * Pure: no database access, no Node-only imports.
 */

export type ReplyClass = "interested" | "not_now" | "not_interested" | "unsubscribe";
export const REPLY_CLASSES: readonly ReplyClass[] = ["interested", "not_now", "not_interested", "unsubscribe"];
/** A body shorter than this ("Thanks!") is never sent to a model. */
export const MODEL_MIN_CHARS = 12;
/** The most of a reply's text Canon keeps. */
export const BODY_MAX = 10_000;
/** An out-of-office reply with no return date holds this long. */
export const OOO_DEFAULT_DAYS = 7;

export type Bounce = { hard: boolean; status: string | null; recipient: string | null };
export type AutoReply = { returnOn: string };

/** The reply above the quoted thread: cut at "On … wrote:", an "Original Message" or "From:" block, or quoted lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on\b.{0,200}\bwrote:?$/i.test(t) || /^-{2,}\s*original message\s*-{2,}$/i.test(t) || /^from:\s.+/i.test(t) && out.length > 0 || t.startsWith(">")) break;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, BODY_MAX);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * A delivery failure notice: from a mail daemon or with a failure subject. A `5.x.x` status (or none, from a daemon
 * whose subject says it failed) is hard; `4.x.x` is a delay. The recipient is the report's `Final-Recipient` or
 * `Original-Recipient`, else the first address in the text that isn't the inbox's own.
 */
export function bounceOf(from: string, subject: string, body: string, inbox: string): Bounce | null {
  const daemon = /^(mailer-daemon|postmaster|mail-daemon)@/i.test(from);
  const failed = /(undeliver|delivery status notification|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|failure notice|could not be delivered)/i.test(subject);
  if (!daemon && !failed) return null;
  const status = body.match(/\b([245])\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? null;
  const reported = body.match(/(?:final|original)-recipient:\s*(?:rfc822;\s*)?<?([^\s<>;]+@[^\s<>;]+)>?/i)?.[1] ?? null;
  const own = inbox.toLowerCase();
  const fallback = [...body.matchAll(new RegExp(EMAIL, "g"))].map((m) => m[0].toLowerCase()).find((a) => a !== own && !/^(mailer-daemon|postmaster|mail-daemon)@/.test(a)) ?? null;
  return { hard: status === null ? failed || daemon : status.startsWith("5"), status, recipient: (reported ?? fallback)?.toLowerCase() ?? null };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A date written in an auto-reply, on or after `now`'s day: "November 9", "9 Nov", "11/9", "2026-11-09". */
export function returnDateIn(text: string, now: number): string | null {
  const today = new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  const year = today.getUTCFullYear();
  const at = (y: number, m: number, d: number): string | null => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    let date = new Date(Date.UTC(y, m, d));
    if (date.getUTCDate() !== d) return null;
    // A date with no year that has passed means next year's.
    if (date < today) date = new Date(Date.UTC(y + 1, m, d));
    return iso(date);
  };
  const t = text.toLowerCase();
  const isoMatch = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (isoMatch) return iso(new Date(Date.UTC(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3])));
  const monthName = `(${MONTHS.join("|")})[a-z]*\\.?`;
  const md = t.match(new RegExp(`\\b${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (md) return at(year, MONTHS.indexOf(md[1]), +md[2]);
  const dm = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthName}`));
  if (dm) return at(year, MONTHS.indexOf(dm[2]), +dm[1]);
  const us = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (us) return us[3] ? iso(new Date(Date.UTC(us[3].length === 2 ? 2000 + +us[3] : +us[3], +us[1] - 1, +us[2]))) : at(year, +us[1] - 1, +us[2]);
  return null;
}

/** An automatic reply (out of office, on leave): its return date, read after "back", "return" or "until", else 7 days on. */
export function autoReplyOf(subject: string, body: string, now: number): AutoReply | null {
  const auto = /(automatic reply|auto-?reply|autoreply|out of (the )?office|\booo\b|away from (the )?office|on (annual |parental |maternity |paternity )?leave)/i;
  const said = /(i am|i'm|i will be) (currently )?(out of (the )?office|away|on leave|travell?ing|on vacation|on holiday)|limited access to (my )?email/i;
  if (!auto.test(subject) && !said.test(body)) return null;
  const after = body.match(/(back|return(ing)?|until|through|till)\b[^.\n]{0,60}/i)?.[0] ?? "";
  const fallback = iso(new Date(new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z").getTime() + OOO_DEFAULT_DAYS * 86_400_000));
  return { returnOn: (after && returnDateIn(after, now)) || fallback };
}

const RULES: ReadonlyArray<[ReplyClass, RegExp]> = [
  ["unsubscribe", /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email) me|don'?t (contact|email) me|opt(ed)? out)\b/i],
  ["not_interested", /\b(not interested|no thanks|no thank you|we'?re (all )?set|not a (good )?fit|no need|already have a (solution|vendor|provider)|please don'?t follow up)\b/i],
  ["not_now", /\b(not (right )?now|not a priority|maybe later|circle back|reach out (again )?(in|next)|next (quarter|year)|timing (isn'?t|is not) right|check back|revisit (this )?(in|next|later)|in a few months)\b/i],
  ["interested", /\b(i'?m interested|we'?re interested|sounds (good|great|interesting)|let'?s (talk|chat|connect|set up|find a time)|set up a (call|meeting|time)|book a (call|time|meeting)|happy to (chat|talk|connect)|send (me )?(more|over)|what times?|my calendar|calendly|tell me more)\b/i],
];

/** A reply's class by its words alone, strongest first (an opt-out beats a polite "sounds good"); null when none says. */
export function classifyByRules(body: string): ReplyClass | null {
  for (const [cls, re] of RULES) if (re.test(body)) return cls;
  return null;
}

/** What the model is asked when the rules can't place a reply: one class, from the reply's own words. */
export function classifyPrompt(subject: string, body: string): string {
  return [
    "A prospect replied to a sales email. Classify the reply by what the prospect means.",
    "interested: wants to talk, learn more or meet. not_now: open to it later. not_interested: declines.",
    "unsubscribe: asks not to be contacted again.",
    `Subject: ${subject.slice(0, 300)}`,
    `Reply:\n${body.slice(0, 4000)}`,
  ].join("\n");
}
export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: { class: { type: "string", enum: [...REPLY_CLASSES] } },
  required: ["class"],
  additionalProperties: false,
} as const;

export type Received =
  | { kind: "bounce"; bounce: Bounce }
  | { kind: "auto_reply"; auto: AutoReply; body: string }
  | { kind: "reply"; body: string; class: ReplyClass | null; askModel: boolean };

/** What one received email is, before any model: a bounce, an auto-reply, or a reply with its class if words say. */
export function readReceived(m: { from: string; subject: string; body: string; inbox: string; now: number }): Received {
  const bounce = bounceOf(m.from, m.subject, m.body, m.inbox);
  if (bounce) return { kind: "bounce", bounce };
  const body = stripQuoted(m.body);
  const auto = autoReplyOf(m.subject, body, m.now);
  if (auto) return { kind: "auto_reply", auto, body };
  const cls = classifyByRules(body);
  return { kind: "reply", body, class: cls, askModel: cls === null && body.length >= MODEL_MIN_CHARS };
}
