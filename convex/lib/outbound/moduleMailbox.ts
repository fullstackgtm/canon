import type { Id } from "../../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../../_generated/server";
import { principalAccess } from "../../permissions";
import { senderReader } from "../modules/senders";
import { mailboxPeople } from "../../../modules/kernel/outbound";
import { readManifestMailboxGrant } from "./mailboxGrants";
import { enqueueManifestEmail, enqueueOwnerAutomatedEmail, enqueueOwnerPersonalEmail, mailboxEffectNotBefore, type ManifestEffect, type OwnerEmailEnqueueResult } from "./mailboxQueue";
import { prepareManifestEmail } from "./manifestPreparation";
import { prepareOwnerAutomatedEmail, prepareOwnerPersonalEmail, readOwnerEmailSource, type OwnerEmailInput } from "./ownerEmailPreparation";

export { mailboxPeople };
const refusal = () => ({ state: "refused" as const, code: "outbound.module_mailbox.refused", text: "A visible current source, recipient and explicit mailbox sender are required." });

async function authority(ctx: QueryCtx, input: OwnerEmailInput, kind: "personal" | "automated") {
  if (!ctx.db.normalizeId("emailAccounts", input.senderId)) return refusal();
  const account = await ctx.db.get(input.senderId);
  if (!account || account.orgId !== input.orgId) return refusal();
  const access = await principalAccess(ctx, input.orgId, [input.preparedBy, account.userId]);
  if (!access || !(await senderReader(ctx, input.orgId, access[0]).byId(account._id))) return refusal();
  for (const principal of [input.preparedBy, account.userId]) {
    if (!(await readOwnerEmailSource(ctx, input.orgId, input.moduleId, principal, input.source))) return refusal();
  }
  if (kind === "personal") return { state: "owner" as const };
  const rows = await ctx.db.query("mailboxSendGrants").withIndex("by_orgId_and_ownerId_and_moduleId", (q) => q.eq("orgId", input.orgId).eq("ownerId", account.userId).eq("moduleId", input.moduleId)).take(101);
  if (rows.length === 101) return { ...refusal(), text: "Manifest mailbox grants cannot be proven within the lookup bound." };
  let match: Id<"mailboxSendGrants"> | null = null;
  for (const row of rows) {
    if (row.senderId !== input.senderId || row.template.kind !== "manifest" || row.template.name !== input.template) continue;
    const current = await readManifestMailboxGrant(ctx, { orgId: input.orgId, moduleId: input.moduleId, senderId: input.senderId, grantId: row._id });
    if (!current) continue;
    if (match) return { ...refusal(), text: "More than one current manifest grant matches this sender and template." };
    match = row._id;
  }
  return match ? { state: "grant" as const, grantId: match } : { state: "owner" as const };
}

export async function enqueueModuleMailboxEmail(ctx: MutationCtx, input: OwnerEmailInput, kind: "personal" | "automated", effect: ManifestEffect): Promise<OwnerEmailEnqueueResult> {
  if (!["personal", "automated"].includes(kind) || effect.cause.startsWith("canon:sq1.email.v1:")) return refusal();
  input = { ...input, requestedNotBefore: await mailboxEffectNotBefore(ctx, input, effect) ?? input.requestedNotBefore };
  const selected = await authority(ctx, input, kind);
  if (selected.state === "refused") return selected;
  if (kind === "personal") return enqueueOwnerPersonalEmail(ctx, input, effect);
  if (selected.state === "grant") return enqueueManifestEmail(ctx, { orgId: input.orgId, moduleId: input.moduleId, preparedBy: input.preparedBy,
    contactId: input.contactId, senderId: input.senderId, grantId: selected.grantId, requestedNotBefore: input.requestedNotBefore }, { ...effect, source: input.source });
  return enqueueOwnerAutomatedEmail(ctx, input, effect);
}

export async function previewModuleMailboxEmail(ctx: QueryCtx, input: OwnerEmailInput, kind: "personal" | "automated") {
  const selected = await authority(ctx, input, kind);
  if (selected.state === "refused") return selected;
  const result = kind === "personal" ? await prepareOwnerPersonalEmail(ctx, input) : selected.state === "grant"
    ? await prepareManifestEmail(ctx, { orgId: input.orgId, moduleId: input.moduleId, preparedBy: input.preparedBy, contactId: input.contactId,
      senderId: input.senderId, grantId: selected.grantId, requestedNotBefore: input.requestedNotBefore })
    : await prepareOwnerAutomatedEmail(ctx, input);
  if (result.state === "refused") return result;
  return { state: "preview" as const, to: result.prepared.recipient.address, sender: `${result.prepared.sender.name} <${result.prepared.sender.address}>`,
    subject: result.prepared.delivery.subject, text: result.prepared.delivery.text, approval: kind === "personal" || selected.state !== "grant" };
}
