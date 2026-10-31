import { agentClientOf } from "../../lib";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { RecipientUnsubscribeProof } from "../outbound/unsubscribe";
import { normalizeSuppression, suppressionKeys, suppressionVerdict, type ChannelSuppressions, type SuppressionCause, type SuppressionIdentifiers, type SuppressionKind, type SuppressionPurpose, type SuppressionSource } from "./domain";

type ReadCtx = QueryCtx | MutationCtx;
/** Existing interactive sends are manual; service-JWT callers are agents, even when a person typed the CLI command. */
export async function callerOutreachPurpose(ctx: ReadCtx): Promise<SuppressionPurpose> {
  return await agentClientOf(ctx) ? "automated_outreach" : "manual_action";
}

export const suppressionRow = (ctx: ReadCtx, orgId: Id<"organizations">, kind: SuppressionKind, value: string, source: SuppressionSource) =>
  ctx.db.query("suppressions").withIndex("by_orgId_and_kind_and_value_and_source", (q) => q.eq("orgId", orgId).eq("kind", kind).eq("value", value).eq("source", source)).unique();

/** Bounded exact index reads. Canonical DNC tombstones win throughout and after migration. */
export async function suppressionFor(ctx: ReadCtx, orgId: Id<"organizations">, identifiers: SuppressionIdentifiers, purpose: SuppressionPurpose): Promise<ChannelSuppressions> {
  const causes: SuppressionCause[] = [];
  for (const { kind, value } of suppressionKeys(identifiers)) {
    const rows = await ctx.db.query("suppressions").withIndex("by_orgId_and_kind_and_value_and_source", (q) => q.eq("orgId", orgId).eq("kind", kind).eq("value", value)).take(6);
    if (rows.length > 5) throw new ConvexError("Suppression rules need repair before sending.");
    causes.push(...rows);
    if (kind === "phone" && !rows.some((r) => r.source === "dnc")) {
      // Keep this compatibility read for the rollout release. Retirement requires human-confirmed migration and a later release.
      const legacy = await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", orgId).eq("number", value)).first();
      if (legacy) causes.push({ kind: "phone", source: "dnc", state: "active" });
    }
  }
  return suppressionVerdict(causes, purpose);
}

type SuppressionChange = {
  orgId: Id<"organizations">; kind: SuppressionKind; value: string; source: SuppressionSource;
  state: "active" | "lifted"; actor: Id<"users">; reason?: string; contactId?: string;
} | {
  orgId: Id<"organizations">; kind: "email"; value: string; source: "unsubscribe"; state: "active";
  actor: { kind: "recipient"; proof: RecipientUnsubscribeProof }; reason?: never; contactId?: never;
};

export async function setSuppression(ctx: MutationCtx, a: SuppressionChange) {
  const actorId = typeof a.actor === "string" ? a.actor : undefined;
  const proof = typeof a.actor === "object" && a.actor?.kind === "recipient" ? a.actor.proof : undefined;
  if (!actorId && (!proof || proof.kind !== "rfc8058" || !/^[a-f0-9]{64}$/.test(proof.tokenDigest)
    || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
    || a.kind !== "email" || a.source !== "unsubscribe" || a.state !== "active" || a.reason !== undefined || a.contactId !== undefined)) {
    throw new ConvexError("Invalid recipient suppression change.");
  }
  const value = normalizeSuppression(a.kind, a.value);
  if (!value) throw new ConvexError(`Enter a valid ${a.kind === "phone" ? "international phone number" : a.kind}.`);
  const existing = await suppressionRow(ctx, a.orgId, a.kind, value, a.source);
  if (existing?.state === a.state) return existing._id;
  const now = Date.now();
  // Retain the original DNC provenance even when an old client lifts before backfill reaches this number.
  const legacy = a.kind === "phone" && a.source === "dnc" && !existing
    ? await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", a.orgId).eq("number", value)).first() : null;
  const id = existing ? existing._id : await ctx.db.insert("suppressions", {
    orgId: a.orgId, kind: a.kind, value, source: a.source, state: a.state,
    ...(legacy?.addedBy || actorId ? { addedBy: legacy?.addedBy ?? actorId } : {}), addedAt: legacy?.addedAt ?? now,
    ...(proof ? { recipientProof: proof } : {}),
    ...(legacy?.contactId || a.contactId ? { contactId: legacy?.contactId ?? a.contactId } : {}),
    ...(legacy?.reason || a.reason ? { reason: (legacy?.reason ?? a.reason)!.slice(0, 200) } : {}),
    ...(legacy ? { legacyId: legacy._id } : {}), updatedAt: now,
    ...(a.state === "lifted" ? { liftedBy: actorId, liftedAt: now } : {}),
  });
  if (existing) await ctx.db.patch(id, { state: a.state, updatedAt: now, ...(proof ? { recipientProof: proof } : {}),
    ...(a.state === "lifted" ? { liftedBy: actorId, liftedAt: now } : { liftedBy: undefined, liftedAt: undefined }) });
  await ctx.db.insert("suppressionEvents", { orgId: a.orgId, suppressionId: id, ...(actorId ? { actor: actorId } : { recipientProof: proof }),
    state: a.state, at: now, ...(a.reason ? { reason: a.reason.slice(0, 200) } : {}) });
  return id;
}

/** Check-then-insert in the migration transaction; never overwrite a newer rule or a lift. */
export async function migrateDncRow(ctx: MutationCtx, legacy: Doc<"dialerDoNotCall">) {
  const value = normalizeSuppression("phone", legacy.number);
  if (!value) throw new ConvexError("Legacy DNC number needs repair before migration can finish.");
  if (await suppressionRow(ctx, legacy.orgId, "phone", value, "dnc")) return;
  await ctx.db.insert("suppressions", {
    orgId: legacy.orgId, kind: "phone", value, source: "dnc", state: "active", addedBy: legacy.addedBy, addedAt: legacy.addedAt,
    ...(legacy.contactId ? { contactId: legacy.contactId } : {}), ...(legacy.reason ? { reason: legacy.reason } : {}), legacyId: legacy._id, updatedAt: Date.now(),
  });
}
