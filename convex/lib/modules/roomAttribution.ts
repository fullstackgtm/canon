import { ConvexError } from "convex/values";
import type { RecordClient } from "../recordClient.ts";
import type { RoomAttribution, RoomSource } from "../../../modules/kernel/room.ts";

export type RoomTarget = { source: RoomSource; deal: { id: string; streamId: string; companyId: string } | null };

export async function resolveRoomAttribution(sellerClient: RecordClient, orgId: string, target: RoomTarget | null, to: { email?: string; contactId?: string }): Promise<RoomAttribution | null> {
  if (!target || !target.source.deal && !target.source.company) return null;
  const refuse = (): never => { throw new ConvexError("The linked account, deal or recipient is not readable or no longer matches. Refresh and issue again."); };
  let accountId = target.source.company;
  if (target.source.deal) {
    if (!target.deal) return refuse();
    const row = (await sellerClient.listObjects(orgId, "deal", { filter: [{ field: "id", op: "eq", value: target.deal.streamId }], limit: 1 })).rows[0];
    if (!row || row.id !== target.deal.streamId || row.values.companyId !== target.deal.companyId) return refuse();
    accountId = target.deal.companyId;
  }
  if (!accountId) return refuse();
  const account = (await sellerClient.listRegister(orgId, "account", { filter: [{ field: "id", op: "eq", value: accountId }], limit: 1 })).rows[0];
  const domain = account?.values.domain;
  if (!account || account.id !== accountId || typeof domain !== "string" || !domain.trim()) return refuse();
  const attribution: RoomAttribution = { accountId, domain: domain.trim().toLowerCase(), source: target.source, ...(target.deal ? { deal: target.deal } : {}) };
  const email = to.email?.trim().toLowerCase(), id = to.contactId?.trim();
  if (email || id) {
    const rows = (await sellerClient.listRegister(orgId, "contact", { filter: [
      ...(id ? [{ field: "id", op: "eq" as const, value: id }] : [{ field: "email", op: "eq" as const, value: email! }]),
    ], limit: 2 })).rows;
    const contact = rows.length === 1 ? rows[0] : null, canonical = contact?.values.email;
    if (contact && contact.accountId === accountId && typeof canonical === "string" && canonical.trim() && (!email || canonical.trim().toLowerCase() === email)) {
      attribution.contact = { id: contact.id, email: canonical.trim().toLowerCase() };
    } else if (id) return refuse();
  }
  return attribution;
}
