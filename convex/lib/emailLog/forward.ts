/**
 * The original email inside a forward (convex/emailLog.ts): who sent it, to whom, when, and its text, read from
 * the header block Gmail, Outlook and Apple Mail put above a forwarded message, or from a message forwarded as an
 * attachment. Anything less certain is not read: the forward is then logged as the member's own.
 *
 * Pure: no database access, no Node-only imports.
 */
import { addressesOf, type MailAddress, type ParsedMail } from "./mime.ts";

export type Forwarded = {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** Null when the block's date can't be read reliably. */
  at: number | null;
  text: string;
  /** What the member wrote above the forwarded message. */
  note: string;
  /** Only a message forwarded as an attachment carries its own ids. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
};

/** The separators the three clients (and Thunderbird) write above a forwarded message. */
const MARKERS = [
  /^-{5,}\s*Forwarded message\s*-{5,}\s*$/im,
  /^-{3,}\s*Original Message\s*-{3,}\s*$/im,
  /^Begin forwarded message:\s*$/im,
  /^_{10,}\s*$/m,
];
const FIELD = /^(from|sent|date|to|cc|subject|reply-to)\s*:\s*(.*)$/i;
const FORWARD_SUBJECT = /^\s*(fwd?|fw)\s*:/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONES: Record<string, number> = {
  utc: 0, gmt: 0, ut: 0, z: 0, pst: -480, pdt: -420, mst: -420, mdt: -360, cst: -360, cdt: -300, est: -300, edt: -240, bst: 60, cet: 60, cest: 120,
};

/**
 * A forward block's date: "Mon, Nov 2, 2026 at 10:15 AM" (Gmail), "Monday, November 2, 2026 10:15 AM" (Outlook),
 * "November 2, 2026 at 10:15:42 AM PST" (Apple Mail), or "2 Nov 2026 10:15". Without a zone of its own it is read in
 * `fallbackOffset` (the forward's own Date offset: the client wrote it in the member's time zone). Null when there
 * is no month name, so a day and a month can't be confused.
 */
export function looseDate(value: string, fallbackOffset: number | null): number | null {
  const v = value.replace(/\([^)]*\)/g, " ").replace(/\bat\b/gi, " ").replace(/,/g, " ");
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}[a-z]*\\.?(?![a-z])`, "i").test(v));
  const year = /\b(\d{4})\b/.exec(v)?.[1];
  const time = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?(?![a-z])/i.exec(v);
  if (month < 0 || !year || !time) return null;
  const rest = v.replace(time[0], " ").replace(year, " ");
  const day = /\b(\d{1,2})\b/.exec(rest)?.[1];
  if (!day || Number(day) > 31) return null;
  let hour = Number(time[1]);
  const ap = time[4]?.toLowerCase();
  if (ap === "p" && hour < 12) hour += 12;
  if (ap === "a" && hour === 12) hour = 0;
  const numeric = /(?:gmt|utc)?\s*([+-])(\d{1,2}):?(\d{2})?\b/i.exec(rest.replace(/\b\d{1,2}\b(?![:\d])/, " "));
  const named = /\b([a-z]{1,4})\s*$/i.exec(rest.trim())?.[1]?.toLowerCase();
  const offset = numeric ? (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3] ?? 0)) : named && named in ZONES ? ZONES[named] : fallbackOffset;
  if (offset === null) return null;
  const at = Date.UTC(Number(year), month, Number(day), hour, Number(time[2]), Number(time[3] ?? 0)) - offset * 60_000;
  return Number.isFinite(at) ? at : null;
}

/** The forwarded message's header block and what follows it, from the first marker (or a bare Outlook block at the top). */
function inlineOf(text: string, fallbackOffset: number | null): Forwarded | null {
  const lines = text.split("\n");
  let start = -1;
  for (const marker of MARKERS) {
    const m = marker.exec(text);
    if (m && (start < 0 || m.index < start)) start = m.index;
  }
  let i: number;
  let note: string;
  if (start >= 0) {
    const markerLine = text.slice(0, start).split("\n").length - 1;
    note = lines.slice(0, markerLine).join("\n").trim();
    i = markerLine + 1;
  } else {
    // New Outlook writes no separator: the block starts at the first "From:" line, after the member's note.
    i = lines.findIndex((l) => /^from\s*:\s*\S/i.test(l.trim()));
    if (i < 0 || !lines.slice(i, i + 6).some((l) => /^(sent|date)\s*:/i.test(l.trim()))) return null;
    note = lines.slice(0, i).join("\n").trim();
  }
  while (i < lines.length && !lines[i].trim()) i++;
  const fields = new Map<string, string>();
  let last: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^\*+|\*+$/g, "");
    if (!line) {
      if (fields.has("from")) break;
      continue;
    }
    const m = FIELD.exec(line);
    if (m) {
      last = m[1].toLowerCase();
      if (!fields.has(last)) fields.set(last, m[2].replace(/\*/g, "").trim());
    } else if (last === "to" || last === "cc") fields.set(last, `${fields.get(last)} ${line}`);
    else if (fields.has("from")) break;
    else return null;
  }
  const from = addressesOf(fields.get("from"))[0];
  if (!from) return null;
  const when = fields.get("date") ?? fields.get("sent");
  return {
    from, to: addressesOf(fields.get("to")), cc: addressesOf(fields.get("cc")), subject: (fields.get("subject") ?? "").slice(0, 300),
    at: when ? looseDate(when, fallbackOffset) : null,
    text: lines.slice(i).join("\n").trim(), note, messageId: null, inReplyTo: null, references: [],
  };
}

/** The original of a forward: an attached message when the forward carries one, else the inline block; null for none. */
export function forwardedOf(mail: ParsedMail): Forwarded | null {
  const attached = mail.attached.find((m) => m.from);
  if (attached && (FORWARD_SUBJECT.test(mail.subject) || !mail.text.trim())) {
    return {
      from: attached.from!, to: attached.to, cc: attached.cc, subject: attached.subject, at: attached.date, text: attached.text,
      note: mail.text.trim(), messageId: attached.messageId, inReplyTo: attached.inReplyTo, references: attached.references,
    };
  }
  return inlineOf(mail.text, mail.dateOffset);
}
