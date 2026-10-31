/**
 * The duplicates view (CP15b, lib/objects/duplicates.ts): candidate groups of companies or people that
 * look like the same record, strongest first, each with why. Candidates are computed in the record service,
 * where the register lives (a TAM is tens of thousands of rows); this action only hides what someone
 * dismissed and adds the names a card shows. Merging a group is recordMerges.merge; dismissing it stores
 * its pairs here. Anyone can view; only admins and managers dismiss (as only they merge).
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { callerClient, requireCaller } from "./records";
import { visibleIds } from "./lib/scopedRecordClient";
import { accountNamesByList } from "./lib/recordClient";
import { GROUP_IDS_MAX, pairKeys, type MatchReason } from "./lib/objects/duplicates";

const object = v.union(v.literal("account"), v.literal("contact"));
/** Most groups one view reads from the service, before the dismissed ones are dropped. */
const GROUPS_MAX = 2000;
const GROUPS_PAGE = 200;
/** Most dismissed pairs one view honours; beyond it a dismissed group may reappear. */
const DISMISSED_MAX = 20000;

export type DuplicateCard = {
  /** The group's record ids, sorted: the merge dialog's `ids` and what a dismissal names. */
  ids: string[];
  /** Records in the group; more than `members` when it was cut to what a merge takes. */
  size: number;
  members: Array<{ id: string; title: string; subtitle: string }>;
  matches: Array<{ reason: MatchReason; value: string }>;
};
/** `count` is every group worth reviewing (a floor when `exact` is false); `canAct`: the caller may merge and dismiss. */
export type DuplicatesView = { cards: DuplicateCard[]; count: number; exact: boolean; canAct: boolean };

export const dismissedPairs = internalQuery({
  args: { orgId: v.id("organizations"), object },
  handler: async (ctx, a): Promise<string[]> => {
    const rows = await ctx.db.query("duplicateDismissals").withIndex("by_orgId_object_pair", (q) => q.eq("orgId", a.orgId).eq("object", a.object)).take(DISMISSED_MAX);
    return rows.map((r) => `${r.a}|${r.b}`);
  },
});

/** The groups worth reviewing: those with at least one pair nobody dismissed. */
export const list = action({
  args: { object },
  handler: async (ctx, a): Promise<DuplicatesView> => {
    const caller = await requireCaller(ctx, { read: true });
    // Groups among the records the caller sees only (CP14), so a card never names a hidden one.
    const client = callerClient(ctx, caller);
    const dismissed = new Set(await ctx.runQuery(internal.duplicates.dismissedPairs, { orgId: caller.orgId as Id<"organizations">, object: a.object }));
    const { groups, total } = await client.listDuplicates(caller.orgId, a.object, Math.min(GROUPS_MAX, GROUPS_PAGE + dismissed.size));
    const live = groups.filter((g) => pairKeys(g.members.map((m) => m.id)).some((k) => !dismissed.has(k)));
    const companies = a.object === "contact"
      ? await accountNamesByList(client, caller.orgId, live.flatMap((g) => g.members.flatMap((m) => (m.accountId ? [m.accountId] : []))))
      : {};
    const cards = live.map((g): DuplicateCard => ({
      ids: g.members.map((m) => m.id),
      size: g.size,
      members: g.members.map((m) => ({
        id: m.id,
        title: m.name || m.id,
        subtitle: (a.object === "account"
          ? [m.domain, m.detail]
          : [m.email, m.detail, m.accountId ? companies[m.accountId] : null]
        ).filter(Boolean).join(" · "),
      })),
      matches: g.matches,
    }));
    const exact = groups.length === total;
    // Past what one read takes, the count is a floor: the groups left are not checked against dismissals.
    return { cards, count: exact ? cards.length : cards.length + (total - groups.length), exact, canAct: mayAct(caller) };
  },
});

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds cleanup.run. */
const mayAct = (who: { role: string; capabilities?: readonly string[] }) => can(who, "cleanup.run");

/** Store the pairs of a dismissed group. */
export const record = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), object, ids: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    for (const key of pairKeys(a.ids)) {
      const [x, y] = key.split("|");
      const seen = await ctx.db.query("duplicateDismissals").withIndex("by_orgId_object_pair", (q) => q.eq("orgId", a.orgId).eq("object", a.object).eq("a", x).eq("b", y)).unique();
      if (!seen) await ctx.db.insert("duplicateDismissals", { orgId: a.orgId, object: a.object, a: x, b: y, dismissedBy: a.userId, dismissedAt: Date.now() });
    }
    return null;
  },
});

/**
 * Mark a group "not duplicates": every pair in it, so none of them is offered again, even in a bigger group.
 * An action like recordMerges.merge, which it sits beside in the view; API, CLI and MCP parity for both is CP16's.
 */
export const dismiss = action({
  args: { object, ids: v.array(v.string()) },
  handler: async (ctx, a): Promise<null> => {
    const caller = await requireCaller(ctx);
    if (!mayAct(caller)) throw new ConvexError("Only admins and managers can dismiss duplicates");
    if (a.ids.length < 2 || a.ids.length > GROUP_IDS_MAX || new Set(a.ids).size !== a.ids.length) throw new ConvexError(`Name 2 to ${GROUP_IDS_MAX} different records`);
    // Only records the caller sees: a hidden one reads as missing (CP14).
    const seen = await visibleIds(callerClient(ctx, caller), caller.orgId, a.object, a.ids);
    if (a.ids.some((id) => !seen.has(id))) throw new ConvexError("Record not found");
    await ctx.runMutation(internal.duplicates.record, { orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, object: a.object, ids: a.ids });
    return null;
  },
});
