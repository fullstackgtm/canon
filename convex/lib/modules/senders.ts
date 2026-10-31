import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { roleBasesOf, roleIn } from "../../permissions";
import type { Access } from "../access";
import { baseRole } from "../roles";

export type Sender = {
  id: Id<"emailAccounts">; createdAt: number; ownerId: Id<"users">;
  name: string; address: string; status: Doc<"emailAccounts">["status"];
};
const SCAN_MAX = 2000;
export const senderFields = (sender: Sender, fields: readonly string[]) => Object.fromEntries(
  fields.filter((f) => ["ownerId", "name", "address", "status"].includes(f)).map((f) => [f, sender[f as keyof Sender]]),
);
const usableSender = (row: Doc<"emailAccounts">) => row.status === "ok" && row.unipileAccountId.trim().length > 0;

export function senderReader(ctx: QueryCtx, orgId: Id<"organizations">, access: Access | null) {
  const members = new Map<string, Promise<boolean>>();
  const member = (raw: string) => {
    if (!members.has(raw)) members.set(raw, (async () => {
      const id = ctx.db.normalizeId("users", raw);
      const user = id ? await ctx.db.get(id) : null;
      return !!user && !user.isHidden && (await roleIn(ctx, user, orgId)) !== null;
    })());
    return members.get(raw)!;
  };
  let role: Promise<string> | undefined;
  const ownerVisible = async (id: string) => {
    if (!access || access.userId === "system" || !(await member(access.userId))) return false;
    role ??= roleBasesOf(ctx, orgId).then((bases) => baseRole(access.role, bases));
    const base = await role;
    return (base === "admin" || (base === "manager" && (id === access.userId || access.teamOwners.includes(id))) || (base === "rep" && id === access.userId)) && await member(id);
  };
  const descriptor = (row: Doc<"emailAccounts">): Sender => ({
    id: row._id, createdAt: row._creationTime, ownerId: row.userId,
    name: row.displayName?.trim() || row.address, address: row.address, status: row.status,
  });
  const row = async (raw: string) => {
    const id = ctx.db.normalizeId("emailAccounts", raw);
    const found = id ? await ctx.db.get(id) : null;
    return found && found.orgId === orgId && await ownerVisible(found.userId) ? found : null;
  };
  return {
    async byId(id: string): Promise<Sender | null> { const found = await row(id); return found ? descriptor(found) : null; },
    async forMembers(ids: readonly string[], limit: number): Promise<Sender[]> {
      const out: Sender[] = [];
      let scanned = 0;
      for (const raw of new Set(ids)) {
        const id = ctx.db.normalizeId("users", raw);
        if (!id || !(await ownerVisible(id))) continue;
        for await (const found of ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", id))) {
          if (++scanned > SCAN_MAX) throw new ConvexError("Too many mailboxes to read. Narrow the members.");
          if (found.orgId !== orgId) continue;
          if (out.length >= limit) throw new ConvexError("Too many senders for this read.");
          out.push(descriptor(found));
        }
      }
      return out;
    },
    async pick(search: string, max: number, addressGranted: boolean) {
      const out: Array<{ id: string; label: string }> = [];
      const needle = search.trim().toLowerCase();
      let scanned = 0;
      for await (const found of ctx.db.query("emailAccounts").withIndex("by_orgId", (q) => q.eq("orgId", orgId))) {
        if (++scanned > SCAN_MAX) throw new ConvexError("Too many mailboxes to pick from.");
        if (!usableSender(found) || !(await ownerVisible(found.userId))) continue;
        const sender = descriptor(found);
        if (!needle || sender.name.toLowerCase().includes(needle) || (addressGranted && sender.address.toLowerCase().includes(needle))) out.push({ id: sender.id, label: sender.name });
        if (out.length >= max) break;
      }
      return out;
    },
  };
}
