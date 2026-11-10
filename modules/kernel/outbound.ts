/**
 * Outbound effects (docs/modules.md, "Outbound"): what a module may send, the templates it sends, and how a template
 * renders. A send leaves Canon only through the outbox (convex/lib/outbound). Pure, with no Node-only imports: the
 * manifest checker, Convex and the browser's send preview all use it.
 */
import { renderText, type Doc, type TextScope } from "./text.ts";

export const OUTBOUND_CHANNELS = ["email", "slack", "webhook"] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];
/** `notice`: to a member, from Canon. `personal`: written or approved by its sender. `automated`: a play or job wrote it. */
export const SEND_KINDS = ["notice", "personal", "automated"] as const;
export type SendKind = (typeof SEND_KINDS)[number];
/** `workspace`: Canon's transactional sender, for notices. `member_mailbox`: a member's linked Gmail (not yet). */
export const EMAIL_SENDERS = ["workspace", "member_mailbox"] as const;
export type EmailSender = (typeof EMAIL_SENDERS)[number];

/**
 * An outbox row's state. A row is decided as it queues: `queued` to send, `held` until `notBefore` (a rate limit, a
 * digest), `awaiting_approval` for a person, `refused` by the gate. The dispatcher moves a due row to `sending`, then
 * `sent`, `failed` or `unknown` (it may have gone: never sent again). A canonical suppression keeps it `suppressed`.
 */
export const OUTBOX_STATES = ["awaiting_approval", "queued", "held", "sending", "sent", "failed", "unknown", "suppressed", "refused", "cancelled"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];
/** What a person may do to a row, by its state. */
export const OUTBOX_ACTIONS = { approve: ["awaiting_approval"], cancel: ["awaiting_approval", "queued", "held"], sendNow: ["held"] } as const satisfies Record<string, readonly OutboxState[]>;
export type OutboxAction = keyof typeof OUTBOX_ACTIONS;

/** The channels a module declares (the install screen lists them; an admin turns each on). */
export type OutboundDecl = {
  email?: { from: readonly EmailSender[]; kinds: readonly SendKind[] };
  /** Names an admin maps to Slack channels in Settings > Outbound: the module never sees a URL. */
  slack?: { channels: readonly string[] };
  /** Events an admin points webhook endpoints at. */
  webhook?: { events: readonly string[] };
};

/** A message a module sends, its `{$...}` filled from the doc (`doc`), a call's `vars`, or a member recipient (`to`). */
export type TemplateDecl =
  | { channel: "email"; subject: string; body: string }
  | { channel: "slack"; text: string }
  /** A webhook's `data`: each value a text, sent as JSON. */
  | { channel: "webhook"; data: Record<string, string> };

/** The binds a template may name. */
export const TEMPLATE_BINDS = ["doc", "vars", "to"] as const;

/** A rendered message as the outbox keeps it: an email's subject and body, a Slack post's text, a webhook's JSON. */
export type Rendered = { subject?: string; text: string };

const PLACEHOLDER = /\{\$([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)?)(?:\|([a-zA-Z]+))?\}/g;

/** Each `{$bind.field}` a text names, with its format. */
export const placeholders = (text: string): Array<{ bind: string; field: string; format?: string }> =>
  [...text.matchAll(PLACEHOLDER)].map(([, bind, field, format]) => ({ bind, field, ...(format ? { format } : {}) }));

/**
 * A template rendered, or the placeholders it can't fill: a missing `{$...}` value refuses the whole message, so
 * nothing sends half-filled. A webhook's values render as a CSV holds them (plain).
 */
export function renderTemplate(t: TemplateDecl, scope: TextScope): { ok: true; rendered: Rendered } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const fill = (text: string, s: TextScope) => {
    for (const p of text.match(PLACEHOLDER) ?? []) if (renderText(p, s).trim() === "") missing.push(p);
    return renderText(text, s);
  };
  let rendered: Rendered;
  if (t.channel === "email") rendered = { subject: fill(t.subject, scope).replace(/\s+/g, " ").trim(), text: fill(t.body, scope) };
  else if (t.channel === "slack") rendered = { text: fill(t.text, scope) };
  else {
    const plain = { ...scope, plain: true };
    rendered = { text: JSON.stringify(Object.fromEntries(Object.entries(t.data).map(([k, v]) => [k, fill(v, plain)]))) };
  }
  return missing.length ? { ok: false, missing: [...new Set(missing)] } : { ok: true, rendered };
}

/** A doc as a template's `{$doc...}`, `{$vars...}` or `{$to...}` reads it. */
export const asDoc = (data: Record<string, unknown>, key = "", owner: string | null = null): Doc => ({ key, version: 0, data, owner });

export function mailboxPeople(values: readonly unknown[]): string[] | null {
  const pending: unknown[] = [...values].reverse(), ids = new Set<string>();
  let scanned = 0;
  while (pending.length) {
    if (++scanned > 8192) return null;
    const value = pending.pop();
    if (Array.isArray(value)) { if (pending.length + value.length > 8192) return null; for (let i = value.length - 1; i >= 0; i--) pending.push(value[i]); continue; }
    if (typeof value !== "string" || !/^con_[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
    ids.add(value);
    if (ids.size > 20) return null;
  }
  return ids.size ? [...ids] : null;
}
