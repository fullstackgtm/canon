/**
 * Queueing a message in the outbox (docs/modules.md, "Outbound"), in the transaction that asks for it: the
 * idempotency key, the send gate (gate.ts) over Convex reads, one row per recipient, and a wake for the dispatcher
 * (convex/outboundDispatch.ts) once the transaction commits. Module sends reach it from convex/lib/modules/scope.ts;
 * Canon's own workspace email (a deal room's code) from `queueWorkspaceEmail`.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { EmailSender, OutboundChannel, OutboundDecl, OutboxState, Rendered, SendKind } from "../../../modules/kernel/outbound";
import { suppressionFor } from "../suppressions/store";
import { roleIn } from "../../permissions";
import { providerReady } from "./adapters";
import { judge, type Draft, type GateReads } from "./gate";
import { isMailboxRow } from "./mailboxBinding";

export type OutboxRow = Doc<"outboundMessages">;
export type OutboxTo = OutboxRow["to"];

export type Enqueue = {
  orgId: Id<"organizations">;
  module: Draft["module"];
  /** What asked for it and which of its effects: the key's first parts. */
  cause: string;
  index: number;
  channel: OutboundChannel;
  kind: SendKind;
  from: EmailSender;
  to: OutboxTo;
  target: string;
  name?: string;
  rendered: Draft["rendered"];
  template?: string;
  about?: string;
  fromUserId?: Id<"users">;
  approval?: "person";
  /** A notification's daily group and deadline, used when the member chooses digest delivery. */
  digest?: { key: string; at: number };
};

/** sha256(org, module, cause, effect index, recipient): a rerun, a retried mutation or a re-applied proposal finds its row. */
export async function outboxKey(q: Pick<Enqueue, "orgId" | "module" | "cause" | "index" | "target">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([q.orgId, q.module?.id ?? "", q.cause, q.index, q.target]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The gate's reads over Convex, for one workspace. */
export function gateReads(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): GateReads {
  return {
    suppression: async (draft) => {
      if (draft.channel !== "email") return null;
      const member = draft.member ? ctx.db.normalizeId("users", draft.member) : null;
      const email = member ? (await ctx.db.get(member))?.email : draft.target.startsWith("address:") ? draft.target.slice(8) : undefined;
      const purpose = draft.kind === "notice" ? "system_notice" : draft.kind === "personal" ? "manual_action" : "automated_outreach";
      return (await suppressionFor(ctx, orgId, { email }, purpose)).email.text;
    },
    memberAddress: async (member) => {
      const id = ctx.db.normalizeId("users", member);
      const user = id ? await ctx.db.get(id) : null;
      return user && !user.isHidden && await roleIn(ctx, user, orgId) ? user.email || null : null;
    },
    noticeMode: async (member, moduleId) => {
      const id = ctx.db.normalizeId("users", member);
      return id ? noticeMode(ctx, orgId, id, moduleId) : "off";
    },
    channelOn: async (moduleId, channel) => Boolean(await ctx.db.query("outboundChannels").withIndex("by_orgId_and_moduleId_and_channel", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("channel", channel)).first()),
    mapped: async (channel, target) => {
      const name = target.slice(target.indexOf(":") + 1);
      if (channel === "slack") return Boolean(await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", orgId).eq("channel", "slack").eq("name", name)).first());
      const id = ctx.db.normalizeId("outboundTargets", name);
      return Boolean(id && (await ctx.db.get(id))?.orgId === orgId);
    },
    claimedSince: async (by, since, max) => {
      const rows = "target" in by
        ? await ctx.db.query("outboundMessages").withIndex("by_orgId_and_target_and_claimedAt", (q) => q.eq("orgId", orgId).eq("target", by.target).gte("claimedAt", since)).order("desc").take(max)
        : await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_claimedAt", (q) => q.eq("orgId", orgId).eq("module", by.module).gte("claimedAt", since)).order("desc").take(max);
      return rows.flatMap((r) => (r.claimedAt === undefined ? [] : [r.claimedAt]));
    },
    providerReady,
  };
}

/** Wake the dispatcher once per transaction, after it commits; a lost wake costs the minute until the cron. */
const woken = new WeakSet<object>();
export async function wake(ctx: MutationCtx, delayMs = 0) {
  if (delayMs === 0 && woken.has(ctx)) return;
  if (delayMs === 0) woken.add(ctx);
  await ctx.scheduler.runAfter(delayMs, internal.outboundDispatch.dispatch, {});
}

/** The next daily digest: 08:00 UTC, today's if it is still ahead. */
export function digestAt(now: number): number {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8);
  return at > now ? at : at + 24 * 60 * 60_000;
}

/** Queue one message: the row its key already names, or a new row as the gate decides it. */
export async function enqueue(ctx: MutationCtx, q: Enqueue): Promise<{ id: Id<"outboundMessages">; state: OutboxState; created: boolean }> {
  if (q.cause.startsWith("canon:sq1.email.v1:")) throw new Error("Canonical SQ1 email causes require the trusted mailbox enqueue path");
  const idempotencyKey = await outboxKey(q);
  const hit = await ctx.db.query("outboundMessages").withIndex("by_idempotencyKey", (x) => x.eq("idempotencyKey", idempotencyKey)).first();
  if (hit && isMailboxRow(hit)) throw new Error("Mailbox effects require the trusted mailbox enqueue path");
  if (hit) return { id: hit._id, state: hit.state, created: false };
  const now = Date.now();
  const verdict = await judge({ module: q.module, channel: q.channel, kind: q.kind, from: q.from, target: q.target, name: q.name, rendered: q.rendered, approval: q.approval, member: "member" in q.to ? q.to.member : undefined, digestAt: q.digest?.at }, gateReads(ctx, q.orgId), now);
  const rendered: Rendered = q.rendered.ok ? q.rendered.rendered : { text: "" };
  const id = await ctx.db.insert("outboundMessages", {
    orgId: q.orgId, ...(q.module ? { module: q.module.id } : {}), cause: q.cause, ...(q.about ? { about: q.about } : {}), ...(q.template ? { template: q.template } : {}),
    channel: q.channel, kind: q.kind, ...(q.fromUserId ? { fromUserId: q.fromUserId } : {}), to: q.to, target: q.target, rendered,
    state: verdict.state, ...("reason" in verdict ? { reason: verdict.reason } : {}), notBefore: verdict.state === "held" ? verdict.notBefore : now,
    ...(q.approval ? { approval: q.approval } : {}),
    idempotencyKey, ...(q.digest ? { digest: q.digest.key } : {}), at: now,
  });
  if (verdict.state === "queued") await wake(ctx);
  return { id, state: verdict.state, created: true };
}

/** How a member wants a module's emailed notices; no choice made means each one as it happens. */
export async function noticeMode(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, userId: Id<"users">, moduleId: string): Promise<"instant" | "digest" | "off"> {
  const row = await ctx.db.query("notificationEmail").withIndex("by_orgId_and_userId_and_moduleId", (q) => q.eq("orgId", orgId).eq("userId", userId).eq("moduleId", moduleId)).first();
  return row?.mode ?? "instant";
}

/**
 * Canon's own workspace email, not a module's (a deal room's verification code): one notice to a member or an
 * address, from Canon's transactional sender, through the outbox and its gate. `cause` names it for idempotency: the
 * same cause and recipient queue once. Call it in the mutation that decides to send.
 */
export async function queueWorkspaceEmail(ctx: MutationCtx, a: { orgId: Id<"organizations">; to: { member: Id<"users"> } | { address: string }; subject: string; body: string; cause: string }) {
  const target = "member" in a.to ? `member:${a.to.member}` : `address:${a.to.address.trim().toLowerCase()}`;
  const to = "member" in a.to ? a.to : { address: a.to.address.trim().toLowerCase() };
  return enqueue(ctx, {
    orgId: a.orgId, module: null, cause: a.cause, index: 0, channel: "email", kind: "notice", from: "workspace", to, target,
    rendered: { ok: true, rendered: { subject: a.subject.replace(/\s+/g, " ").trim().slice(0, 200), text: a.body } },
  });
}
