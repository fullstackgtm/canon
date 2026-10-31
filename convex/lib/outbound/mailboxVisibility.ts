import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { getCurrentUser } from "../../lib";
import { accessFor, roleIn } from "../../permissions";
import { installedModule, isEnabled } from "../modules/packages";
import { senderReader } from "../modules/senders";
import { personScope } from "../modules/scope";
import { normalizeSuppression } from "../suppressions/domain";
import { ownerEmailFrozenValid } from "./ownerEmailPreparation";
import { boundMailboxRefusal, boundMailboxRow, isMailboxRow } from "./mailboxBinding";
import { canonicalMailboxRecipientReader, type RecipientMergeField } from "./recipients";

export async function visibleMailboxRows(ctx: QueryCtx, rows: Doc<"outboundMessages">[]): Promise<Doc<"outboundMessages">[]> {
  if (!rows.some(isMailboxRow)) return rows;
  const user = await getCurrentUser(ctx);
  const role = user ? await roleIn(ctx, user, user.orgId) : null;
  if (!user || !user.isActive || user.isHidden || role === null) return rows.filter((r) => !isMailboxRow(r));
  const access = await accessFor(ctx, { ...user, role }), principal = ctx.db.normalizeId("users", access.userId);
  if (!principal) return rows.filter((r) => !isMailboxRow(r));
  const modules = new Map<string, Promise<boolean>>(), scopes = new Map<string, ReturnType<typeof personScope>>();
  const sources = new Map<string, Promise<boolean>>(), recipients = new Map<string, ReturnType<ReturnType<typeof canonicalMailboxRecipientReader>>>();
  const readRecipient = canonicalMailboxRecipientReader(ctx), senders = senderReader(ctx, user.orgId, access);
  const senderRows = new Map<string, ReturnType<typeof senders.byId>>();
  const sourceVisible = (moduleId: string, collection: string, key: string) => {
    const identity = JSON.stringify([moduleId, collection, key]);
    if (!sources.has(identity)) sources.set(identity, (async () => {
      if (!scopes.has(moduleId)) scopes.set(moduleId, personScope(ctx, user.orgId, principal, moduleId));
      const scope = await scopes.get(moduleId)!;
      return !!(scope && await scope.peek(collection, key));
    })());
    return sources.get(identity)!;
  };
  const visible: Doc<"outboundMessages">[] = [];
  for (const row of rows) {
    if (!isMailboxRow(row)) { visible.push(row); continue; }
    if (row.orgId !== user.orgId || !row.module) continue;
    if (!modules.has(row.module)) modules.set(row.module, (async () => !!(await installedModule(ctx, row.orgId, row.module!)) && await isEnabled(ctx, row.orgId, row.module!))());
    if (!(await modules.get(row.module)!)) continue;
    const mailbox = boundMailboxRow(row), refusal = boundMailboxRefusal(row), identity = mailbox?.prepared ?? refusal;
    if (!identity) continue;

    const mergeFields: readonly RecipientMergeField[] = mailbox ? (mailbox.kind === "owner.exact-email.v1" ? mailbox.prepared.recipientMergeFields : mailbox.recipientMergeFields) ?? ["name", "firstName", "email"] : [];
    const recipientKey = JSON.stringify([identity.recipient.contactId, mergeFields]);
    if (!recipients.has(recipientKey)) recipients.set(recipientKey, readRecipient({ orgId: row.orgId, contactId: identity.recipient.contactId, principalIds: [principal], mergeFields }));
    const recipient = await recipients.get(recipientKey)!;
    if (!recipient.allowed || recipient.binding.streamId !== identity.recipient.streamId || recipient.binding.address !== identity.recipient.address) continue;
    if (!senderRows.has(identity.sender.id)) senderRows.set(identity.sender.id, senders.byId(identity.sender.id));
    const sender = await senderRows.get(identity.sender.id)!;
    if (!sender || sender.ownerId !== identity.sender.ownerId || normalizeSuppression("email", sender.address) !== identity.sender.address) continue;
    const source = mailbox?.kind === "manifest.automated-email.v1" ? mailbox.moduleSource : refusal?.kind === "manifest.refusal.v1" ? refusal.moduleSource : null;
    if (source && !(await sourceVisible(row.module, source.collection, source.key))) continue;
    if (mailbox?.kind === "owner.exact-email.v1" && (!(await ownerEmailFrozenValid(mailbox.prepared))
      || !(await sourceVisible(row.module, mailbox.prepared.source.collection, mailbox.prepared.source.key)))) continue;
    if (refusal?.kind === "owner.refusal.v1" && !(await sourceVisible(row.module, refusal.source.collection, refusal.source.key))) continue;
    visible.push(row);
  }
  return visible;
}
