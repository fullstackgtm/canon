/**
 * An automation rule's outbound steps (convex/automations.ts `perform`): post to Slack, email a member, call a record
 * webhook. Each queues in the step's own transaction, so a step queues once whatever retries: Slack and email as rows
 * of the outbox (lib/outbound/queue.ts: its send gate, a Slack channel an admin mapped, an active member's address,
 * and its sink, which never sends from a local stack), a webhook call as a record-webhook delivery (signed and retried
 * by convex/recordWebhooks.ts deliver). What leaves is the record as the rule's member sees it (`row`, its hidden
 * fields already empty), never more.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { enqueue, queueWorkspaceEmail } from "./outbound/queue";
import { renderMessage } from "./automations";
import type { ListRow } from "./objects/listSpec";
import type { ResolvedObjectDef } from "./objects/registry";
import type { LeafAction } from "../../modules/kernel/automation";

type Outbound = Extract<LeafAction, { kind: "notify_slack" | "notify_email" | "call_webhook" }>;
type Ctx = { rule: Doc<"automationRules">; run: Doc<"automationRuns">; ref: string; actsAs: Id<"users">; def: ResolvedObjectDef; row: ListRow };

/** The outbox key's cause for one step of one run: the same step queues once. */
const causeOf = (c: Ctx) => `automation:${c.run._id}:${c.ref}`;

/** What became of an outbox row, as the run log says it; a refused row fails the step with the outbox's reason. */
function outcome(out: { state: string; created: boolean }, where: string, reason?: string): string {
  if (out.state === "refused" || out.state === "suppressed") throw new ConvexError(reason ?? `Not sent to ${where}`);
  return out.state === "held" ? `Held for ${where}` : `Queued for ${where}`;
}

const reasonOf = async (ctx: MutationCtx, id: Id<"outboundMessages">) => (await ctx.db.get(id))?.reason;

/** Queue one outbound step. `to` is the email's recipient, already resolved and checked to see the record. */
export async function sendStep(ctx: MutationCtx, c: Ctx, a: Outbound, to: Id<"users"> | null): Promise<{ detail: string }> {
  if (a.kind === "notify_slack") {
    const name = a.channel.replace(/^#/, "").toLowerCase();
    const out = await enqueue(ctx, {
      orgId: c.rule.orgId, module: null, cause: causeOf(c), index: 0, channel: "slack", kind: "notice", from: "workspace", to: { slack: name }, target: `slack:${name}`, name,
      rendered: { ok: true, rendered: { text: renderMessage(a.message, c.def, c.row) } }, fromUserId: c.actsAs,
    });
    return { detail: outcome(out, `#${name}`, await reasonOf(ctx, out.id)) };
  }
  if (a.kind === "notify_email") {
    if (!to) throw new ConvexError("Nobody to email");
    const out = await queueWorkspaceEmail(ctx, { orgId: c.rule.orgId, to: { member: to }, subject: renderMessage(a.subject, c.def, c.row), body: renderMessage(a.message, c.def, c.row), cause: causeOf(c) });
    return { detail: outcome(out, (await ctx.db.get(to))?.name ?? "a member", await reasonOf(ctx, out.id)) };
  }
  const endpoint = a.endpointId ? await ctx.db.get(a.endpointId) : null;
  if (!a.endpointId) throw new ConvexError("Pick the webhook again: webhooks don't move with an imported workspace");
  if (!endpoint || endpoint.orgId !== c.rule.orgId) throw new ConvexError("The webhook was deleted");
  if (!endpoint.enabled) throw new ConvexError("The webhook is turned off");
  const now = Date.now();
  const deliveryKey = causeOf(c);
  const payload = JSON.stringify({
    event: "automation.rule", eventId: deliveryKey, at: new Date(now).toISOString(), rule: { id: c.rule._id, name: c.rule.name },
    object: c.run.object, id: c.row.id, title: c.row.title, values: Object.fromEntries(c.def.fields.map((f) => [f.apiName, c.row.values[f.fieldId] ?? null])),
  });
  const deliveryId = await ctx.db.insert("recordWebhookDeliveries", {
    orgId: c.rule.orgId, endpointId: endpoint._id, shard: c.run.shard, seq: c.run.seq, event: "automation.rule", object: c.run.object, payload,
    status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, deliveryKey, actsAs: c.actsAs,
  });
  await ctx.scheduler.runAfter(0, internal.recordWebhooks.deliver, { deliveryId });
  return { detail: `Queued for ${hostOf(endpoint.url)}` };
}

/** Where a webhook sends, as the run log and the sentence name it. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "the webhook";
  }
};
