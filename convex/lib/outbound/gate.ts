/**
 * The send gate (docs/modules.md, "Outbound"): whether one outbox row may go now. It runs when the effect queues the
 * row, in the transaction that asks for it, and again when the dispatcher claims the row. It is an ordered list of
 * checks, each pure apart from the reads it is handed, and the first that has a verdict decides. A later check (a
 * sender's grant, suppression, quiet hours, recipient caps) is a new entry in GATE, not a change to the others.
 * Free of database and Node-only imports: lib/outbound/queue.ts gives it reads over Convex, tests over memory.
 */
import type { EmailSender, OutboundChannel, OutboundDecl, Rendered, SendKind } from "../../../modules/kernel/outbound";

export type Draft = {
  /** The module sending it and what it declares; null for Canon's own workspace email. */
  module: { id: string; title: string; outbound: OutboundDecl | undefined } | null;
  channel: OutboundChannel;
  kind: SendKind;
  from: EmailSender;
  /** The recipient as rate limits count it: `slack:<name>`, `webhook:<endpoint>`, `member:<id>`, `address:<email>`. */
  target: string;
  member?: string;
  /** Notification delivery choices apply only to rows with a digest schedule. */
  digestAt?: number;
  sendNow?: boolean;
  /** The Slack channel name or webhook event the module named. */
  name?: string;
  rendered: { ok: true; rendered: Rendered } | { ok: false; missing: string[] };
  approval?: "person";
  /** A person approved it (the row left awaiting_approval). */
  approved?: boolean;
};

export type Verdict =
  | { state: "queued" }
  | { state: "held"; notBefore: number; reason: string }
  | { state: "awaiting_approval"; reason: string }
  | { state: "refused"; reason: string }
  | { state: "suppressed"; reason: string };

export type GateReads = {
  suppression(draft: Draft): Promise<string | null>;
  /** An address only while the recipient is an active member of this workspace. */
  memberAddress(member: string): Promise<string | null>;
  noticeMode(member: string, moduleId: string): Promise<"instant" | "digest" | "off">;
  /** Whether an admin turned the channel on for the module. */
  channelOn(moduleId: string, channel: OutboundChannel): Promise<boolean>;
  /** Whether the target leads somewhere: a Slack name an admin mapped, a webhook endpoint that exists. */
  mapped(channel: "slack" | "webhook", target: string): Promise<boolean>;
  /** When the most recent sends (at most `max`) to a target or from a module since `since` were claimed. */
  claimedSince(by: { target: string } | { module: string }, since: number, max: number): Promise<number[]>;
  /** Whether the channel can deliver on this deployment: a sink always can; email needs Postmark's key. */
  providerReady(channel: OutboundChannel): boolean;
};

type Check = { name: string; check: (d: Draft, r: GateReads, now: number) => Verdict | null | Promise<Verdict | null> };

const DAY = 24 * 60 * 60_000;
const CHANNEL_WORDS: Record<OutboundChannel, string> = { email: "Email", slack: "Slack", webhook: "Webhooks" };

/** The rate limits P4a enforces: over one, a row is held until it would fit, never dropped. */
export const LIMITS: ReadonlyArray<{ channel?: OutboundChannel; by: "target" | "module"; max: number; windowMs: number; what: string }> = [
  { channel: "slack", by: "target", max: 1, windowMs: 1000, what: "one post a second to a Slack channel" },
  { channel: "webhook", by: "target", max: 10, windowMs: 1000, what: "10 posts a second to a webhook endpoint" },
  { by: "module", max: 500, windowMs: DAY, what: "500 sends a day from one module" },
];

const refused = (reason: string): Verdict => ({ state: "refused", reason });

export const GATE: readonly Check[] = [
  {
    name: "declared",
    check: (d) => {
      if (!d.module) return null;
      const o = d.module.outbound;
      if (!o?.[d.channel]) return refused(`${d.module.title} doesn't declare ${CHANNEL_WORDS[d.channel].toLowerCase()}.`);
      if (d.channel === "slack" && !o.slack!.channels.includes(d.name ?? "")) return refused(`${d.module.title} doesn't declare the Slack channel ${d.name}.`);
      if (d.channel === "webhook" && !o.webhook!.events.includes(d.name ?? "")) return refused(`${d.module.title} doesn't declare the webhook event ${d.name}.`);
      if (d.channel === "email" && !(o.email!.from.includes(d.from) && o.email!.kinds.includes(d.kind))) return refused(`${d.module.title} doesn't declare ${d.kind} email from ${d.from === "workspace" ? "the workspace" : "a member's mailbox"}.`);
      return null;
    },
  },
  {
    name: "channelOn",
    check: async (d, r) => (!d.module || (await r.channelOn(d.module.id, d.channel)) ? null
      : refused(`${CHANNEL_WORDS[d.channel]} is off for ${d.module.title}. An admin turns it on in Settings > Outbound.`)),
  },
  {
    name: "renders",
    check: (d) => (d.rendered.ok ? null : refused(`The message leaves ${d.rendered.missing.join(", ")} empty, and nothing sends half-filled.`)),
  },
  {
    name: "notYet",
    check: (d) => (d.channel === "email" && (d.kind !== "notice" || d.from !== "workspace")
      ? refused("Canon doesn't send personal or automated email, or email from a member's mailbox, yet: only notices from the workspace.") : null),
  },
  {
    name: "noticeToMember",
    check: (d) => (d.module && d.channel === "email" && !d.member ? refused("A module's notice goes only to a member of the workspace.") : null),
  },
  {
    name: "recipient",
    check: async (d, r) => (d.channel === "email" && d.member && !(await r.memberAddress(d.member))
      ? refused("The recipient is no longer an active member with an email address in this workspace.") : null),
  },
  {
    name: "suppression",
    check: async (d, r) => {
      const reason = await r.suppression(d);
      return reason ? { state: "suppressed", reason } : null;
    },
  },
  {
    name: "provider",
    check: (d, r) => (r.providerReady(d.channel) ? null : refused(`${CHANNEL_WORDS[d.channel]} isn't set up on this deployment.`)),
  },
  {
    name: "mapped",
    check: async (d, r) => {
      if (d.channel === "email" || (await r.mapped(d.channel, d.target))) return null;
      return refused(d.channel === "slack" ? `No Slack channel is mapped to ${d.name}. An admin maps it in Settings > Outbound.` : `No webhook endpoint receives ${d.name}. An admin adds one in Settings > Outbound.`);
    },
  },
  {
    name: "approval",
    check: (d) => (d.approval === "person" && !d.approved ? { state: "awaiting_approval", reason: "It waits for a person to approve it." } : null),
  },
  {
    name: "notificationChoice",
    check: async (d, r, now) => {
      if (d.digestAt === undefined || !d.member || !d.module) return null;
      const mode = await r.noticeMode(d.member, d.module.id);
      if (mode === "off") return refused("The member turned off emailed notifications for this module.");
      return mode === "digest" && !d.sendNow && d.digestAt > now
        ? { state: "held", notBefore: d.digestAt, reason: "Waits for the daily digest." } : null;
    },
  },
  {
    name: "rateLimits",
    check: async (d, r, now) => {
      let until = 0, what = "";
      for (const l of LIMITS) {
        if (l.channel !== undefined && l.channel !== d.channel) continue;
        if (l.by === "module" && !d.module) continue;
        const times = (await r.claimedSince(l.by === "target" ? { target: d.target } : { module: d.module!.id }, now - l.windowMs, l.max)).sort((a, b) => a - b);
        if (times.length < l.max) continue;
        // It fits once the oldest send that keeps the window full leaves it.
        const fits = times[times.length - l.max] + l.windowMs;
        if (fits > until) { until = fits; what = l.what; }
      }
      return until > now ? { state: "held", notBefore: until, reason: `Held to keep to ${what}.` } : null;
    },
  },
];

/** The gate's verdict: the first check that has one, else the row may go now. */
export async function judge(d: Draft, reads: GateReads, now: number): Promise<Verdict> {
  for (const c of GATE) {
    const v = await c.check(d, reads, now);
    if (v) return v;
  }
  return { state: "queued" };
}
