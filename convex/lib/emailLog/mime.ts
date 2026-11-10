/**
 * An RFC 822 / MIME message read for email logging (convex/emailLog.ts): its headers, addresses, plain text and
 * the names and sizes of its attachments. HTML is never kept or rendered: an HTML-only message is turned into text.
 * Attached messages (`message/rfc822`, a forward sent as an attachment) are read too.
 *
 * Pure: no database access, no Node-only imports.
 */

export type MailAddress = { email: string; name?: string };
export type Attachment = { name: string; size: number; type: string };

export type ParsedMail = {
  messageId: string | null;
  inReplyTo: string | null;
  /** Oldest first, as the header lists them. */
  references: string[];
  subject: string;
  /** The Date header, or null when it has none or it can't be read. */
  date: number | null;
  /** The Date header's offset from UTC in minutes (-480 for -0800): forward headers without a zone are read in it. */
  dateOffset: number | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  /** Headers by lowercased name, first value only, decoded. */
  headers: ReadonlyMap<string, string>;
  text: string;
  /** The text came from an HTML part (the message had no plain one). */
  fromHtml: boolean;
  attachments: Attachment[];
  attached: ParsedMail[];
};

const DEPTH_MAX = 5;
const PARTS_MAX = 100;
export const ATTACHMENTS_MAX = 20;
export const HEADER_VALUE_MAX = 2_000;

/** Bytes as a string of char codes 0-255, so a part is decoded with its own charset later. */
export function binaryOf(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

const bytesOf = (binary: string) => Uint8Array.from(binary, (c) => c.charCodeAt(0) & 0xff);

const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039,
  0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122,
  0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178,
};

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  if (/^(iso-?8859-1|latin-?1|us-ascii|ascii)$/.test(cs)) return binaryOf(bytes);
  if (/^(windows-1252|cp1252)$/.test(cs)) return Array.from(bytes, (b) => String.fromCharCode(CP1252[b] ?? b)).join("");
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function base64Binary(s: string): string {
  try {
    return atob(s.replace(/[^A-Za-z0-9+/]/g, "").replace(/^(.*?)(={0,2})$/, (_m, b: string) => b + "=".repeat((4 - (b.length % 4)) % 4)));
  } catch {
    return "";
  }
}

const quotedPrintableBinary = (s: string) =>
  s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/** RFC 2047 encoded words (`=?utf-8?B?...?=`); whitespace between two of them is dropped. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const binary = enc.toUpperCase() === "B" ? base64Binary(text) : quotedPrintableBinary(text.replace(/_/g, " "));
      return decodeBytes(bytesOf(binary), charset);
    });
}

/** A header block's fields, unfolded, by lowercased name (first value kept). */
function headersOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = decodeBytes(bytesOf(block), "utf-8");
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), m[2].trim().slice(0, HEADER_VALUE_MAX));
  }
  return out;
}

/** `type/subtype; a=b; c="d"` as the lowercased type and its parameters (names lowercased). */
function paramsOf(value: string | undefined): { value: string; params: Record<string, string> } {
  const [head, ...rest] = (value ?? "").split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(p);
    if (!m) continue;
    const name = m[1].toLowerCase();
    let v = m[2].replace(/^"(.*)"$/, "$1");
    // RFC 2231: name*=utf-8''encoded
    if (name.endsWith("*")) {
      const enc = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (enc) v = decodeBytes(bytesOf(enc[2].replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))), enc[1] || "utf-8");
      params[name.slice(0, -1)] ??= v;
    } else params[name] = decodeWords(v);
  }
  return { value: head.trim().toLowerCase(), params };
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** One header's addresses: `"Name" <a@b>`, `Name <a@b>`, `a@b (Name)`, and groups. Anything without an address is dropped. */
export function addressesOf(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const pieces: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of value) {
    if (ch === '"' && depth === 0) quoted = !quoted;
    else if (!quoted && (ch === "<" || ch === "(")) depth++;
    else if (!quoted && (ch === ">" || ch === ")")) depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && (ch === "," || ch === ";")) {
      pieces.push(cur);
      cur = "";
    } else cur += ch;
  }
  pieces.push(cur);
  const out: MailAddress[] = [];
  for (const raw of pieces) {
    // A group's name ("Team: a@b, c@d;") goes; so does Outlook's `[mailto:a@b]`.
    const piece = raw.replace(/^[^"<@]*:(?!\/\/)/, "").replace(/\[mailto:([^\]]+)\]/i, "<$1>").trim();
    const angle = /<([^<>]+)>/.exec(piece);
    const email = (angle ? angle[1] : piece.replace(/\([^)]*\)/g, "")).trim().replace(/^mailto:/i, "").toLowerCase();
    if (!EMAIL.test(email)) continue;
    const comment = /\(([^)]*)\)/.exec(piece)?.[1];
    const name = decodeWords((angle ? piece.slice(0, angle.index) : comment ?? "").replace(/^\s*"|"\s*$/g, "").replace(/\\(.)/g, "$1").replace(/\*/g, "")).trim();
    out.push(name && name.toLowerCase() !== email ? { email, name: name.slice(0, 200) } : { email });
  }
  return out;
}

const ids = (value: string | undefined) => [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].slice(0, 300));

/** RFC 2822 date with its offset. */
function dateOf(value: string | undefined): { at: number | null; offset: number | null } {
  const v = (value ?? "").replace(/\([^)]*\)/g, "").trim();
  const at = v ? Date.parse(v) : NaN;
  const zone = /([+-])(\d{2}):?(\d{2})\s*$/.exec(v);
  return { at: Number.isFinite(at) ? at : null, offset: zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : /\b(GMT|UTC|UT|Z)\s*$/i.test(v) ? 0 : null };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };

/** HTML as plain text: scripts, styles and comments go, blocks become lines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|table|h[1-6]|blockquote|ul|ol|pre|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      const code = e[0] === "#" ? (e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : null;
      if (code !== null) return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Walk = { text: string | null; html: string | null; attachments: Attachment[]; attached: ParsedMail[]; parts: number };

function splitParts(body: string, boundary: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (t === `--${boundary}--`) {
      if (cur) out.push(cur.join("\r\n"));
      return out;
    }
    if (t === `--${boundary}`) {
      if (cur) out.push(cur.join("\r\n"));
      cur = [];
    } else cur?.push(line);
  }
  if (cur) out.push(cur.join("\r\n"));
  return out;
}

function splitHead(binary: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(binary);
  return m ? { head: binary.slice(0, m.index), body: binary.slice(m.index + m[0].length) } : { head: binary, body: "" };
}

function walk(headers: Map<string, string>, body: string, depth: number, w: Walk): void {
  if (++w.parts > PARTS_MAX) return;
  const type = paramsOf(headers.get("content-type") ?? "text/plain");
  const disposition = paramsOf(headers.get("content-disposition"));
  const cte = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (type.value.startsWith("multipart/") && type.params.boundary && depth < DEPTH_MAX) {
    for (const part of splitParts(body, type.params.boundary)) {
      const { head, body: b } = splitHead(part);
      walk(headersOf(head), b, depth + 1, w);
    }
    return;
  }
  const binary = cte === "base64" ? base64Binary(body) : cte === "quoted-printable" ? quotedPrintableBinary(body) : body;
  const name = disposition.params.filename ?? type.params.name;
  if (type.value === "message/rfc822" && depth < DEPTH_MAX) {
    const inner = parseBinary(binary, depth + 1);
    w.attached.push(inner);
    if (w.attachments.length < ATTACHMENTS_MAX) w.attachments.push({ name: name ?? (`${inner.subject || "message"}.eml`), size: binary.length, type: type.value });
    return;
  }
  const isText = type.value === "text/plain" || type.value === "text/html" || type.value === "";
  if (isText && disposition.value !== "attachment" && !name) {
    const text = decodeBytes(bytesOf(binary), type.params.charset);
    if (type.value === "text/html") w.html ??= text;
    else w.text ??= text;
    return;
  }
  if (w.attachments.length < ATTACHMENTS_MAX) w.attachments.push({ name: (name ?? "attachment").slice(0, 200), size: binary.length, type: type.value || "application/octet-stream" });
}

function parseBinary(binary: string, depth: number): ParsedMail {
  const { head, body } = splitHead(binary);
  const headers = headersOf(head);
  const w: Walk = { text: null, html: null, attachments: [], attached: [], parts: 0 };
  walk(headers, body, depth, w);
  const decoded = new Map([...headers].map(([k, val]) => [k, decodeWords(val)]));
  const { at, offset } = dateOf(headers.get("date"));
  const text = w.text ?? (w.html !== null ? htmlToText(w.html) : "");
  return {
    messageId: ids(headers.get("message-id"))[0] ?? null,
    inReplyTo: ids(headers.get("in-reply-to"))[0] ?? null,
    references: ids(headers.get("references")).slice(-50),
    subject: (decoded.get("subject") ?? "").slice(0, 300),
    date: at,
    dateOffset: offset,
    from: addressesOf(headers.get("from"))[0] ?? null,
    to: addressesOf(headers.get("to")),
    cc: addressesOf(headers.get("cc")),
    headers: decoded,
    text: text.replace(/\r\n?/g, "\n"),
    fromHtml: w.text === null && w.html !== null,
    attachments: w.attachments,
    attached: w.attached,
  };
}

/** A raw RFC 822 message. */
export function parseMime(raw: Uint8Array | string): ParsedMail {
  return parseBinary(typeof raw === "string" ? binaryOf(new TextEncoder().encode(raw)) : binaryOf(raw), 0);
}
