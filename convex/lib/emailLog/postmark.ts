/**
 * Postmark's inbound webhook (its JSON for one received email) as the message email logging reads, the same as the
 * raw RFC 822 adapter reads it. With "Include raw email content" on, Postmark's `RawEmail` is read as the raw message.
 * Only translation happens here: the route authenticates the request and convex/emailLog.ts logInbound decides
 * everything else. Postmark sends no envelope sender, so only the From is checked against the member.
 *
 * Pure: no database access, no Node-only imports.
 */
import { addressesOf, ATTACHMENTS_MAX, HEADER_VALUE_MAX, htmlToText, parseMime, type MailAddress, type ParsedMail } from "./mime.ts";

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const str = (x: unknown) => (typeof x === "string" ? x : "");
const ids = (value: string) => [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].slice(0, 300));

function people(full: unknown, plain: unknown): MailAddress[] {
  if (Array.isArray(full)) {
    return full.flatMap((p) => addressesOf(`${str(rec(p).Name) ? `"${str(rec(p).Name).replace(/"/g, "")}" ` : ""}<${str(rec(p).Email)}>`));
  }
  if (full && typeof full === "object") return people([full], null);
  return addressesOf(str(plain));
}

export type PostmarkDelivery = { mail: ParsedMail; recipients: string[] };

/** One Postmark inbound delivery, or null when the body is not one. */
export function postmarkDelivery(body: unknown): PostmarkDelivery | null {
  const b = rec(body);
  if (!b.From && !b.FromFull && !b.RawEmail) return null;
  const recipients = [str(b.OriginalRecipient), ...people(b.ToFull, b.To), ...people(b.CcFull, b.Cc), ...people(b.BccFull, b.Bcc)].map((p) => (typeof p === "string" ? p : p.email)).filter(Boolean);
  if (typeof b.RawEmail === "string" && b.RawEmail) return { mail: parseMime(b.RawEmail), recipients };
  const headers = new Map<string, string>();
  for (const h of Array.isArray(b.Headers) ? b.Headers : []) {
    const name = str(rec(h).Name).toLowerCase();
    if (name && !headers.has(name)) headers.set(name, str(rec(h).Value).trim().slice(0, HEADER_VALUE_MAX));
  }
  const dateText = str(b.Date) || headers.get("date") || "";
  const at = Date.parse(dateText.replace(/\([^)]*\)/g, ""));
  const zone = /([+-])(\d{2}):?(\d{2})\s*$/.exec(dateText.replace(/\([^)]*\)/g, "").trim());
  const attachments = (Array.isArray(b.Attachments) ? b.Attachments : []).slice(0, ATTACHMENTS_MAX).map(rec);
  const attached = attachments.filter((a) => str(a.ContentType).toLowerCase() === "message/rfc822" && str(a.Content)).map((a) => {
    try {
      return parseMime(Uint8Array.from(atob(str(a.Content)), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }).filter((m): m is ParsedMail => m !== null);
  const text = str(b.TextBody);
  return {
    recipients,
    mail: {
      messageId: ids(headers.get("message-id") ?? "")[0] ?? null,
      inReplyTo: ids(headers.get("in-reply-to") ?? "")[0] ?? null,
      references: ids(headers.get("references") ?? "").slice(-50),
      subject: str(b.Subject).slice(0, 300),
      date: Number.isFinite(at) ? at : null,
      dateOffset: zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : null,
      from: people(b.FromFull, b.From)[0] ?? null,
      to: people(b.ToFull, b.To),
      cc: people(b.CcFull, b.Cc),
      headers,
      text: (text || htmlToText(str(b.HtmlBody))).replace(/\r\n?/g, "\n"),
      fromHtml: !text && Boolean(str(b.HtmlBody)),
      attachments: attachments.map((a) => ({
        name: (str(a.Name) || "attachment").slice(0, 200),
        size: typeof a.ContentLength === "number" ? a.ContentLength : Math.floor((str(a.Content).length * 3) / 4),
        type: str(a.ContentType).toLowerCase().slice(0, 100) || "application/octet-stream",
      })),
      attached,
    },
  };
}
