import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor, requireWriteAccess } from "./permissions";
import { can } from "./lib/capabilities";
import { fieldLevel, may, refuseLockedWrite, withoutHidden, type Access } from "./lib/access";
import { saveDealLinesAsCaller, saveDealAsCaller } from "./objects";
import { lineTotal, MAX_DEAL_LINES } from "./lib/objects/lineItems";
import { currentLines, parentDeal } from "./lib/objects/lineItemRecords";
import type { SaveCommand } from "./lib/objects/write";

const EDIT_FIELDS = ["name", "dealId", "productId", "quantity", "unitPrice", "totalPrice", "position", "source"];
const lineVersion = v.object({ id: v.id("canonEntities"), version: v.number() });
function requireCurrent(rows: Array<{ streamId: string; version: number }>, expected: Array<{ id: string; version: number }>) {
  const stamp = (list: Array<{ id: string; version: number }>) => JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.version]));
  if (stamp(rows.map((r) => ({ id: r.streamId, version: r.version }))) !== stamp(expected)) throw new ConvexError("The line items changed. Reload them before saving");
}
function editable(user: Doc<"users">, access: Access) {
  return can(user, "deals.write") && may(access, "deal", "edit") && may(access, "lineItem", "create") && may(access, "lineItem", "edit") && may(access, "lineItem", "delete")
    && EDIT_FIELDS.every((f) => fieldLevel(access, "lineItem", f) === "editable");
}

export const forDeal = query({
  args: { deal: v.id("canonEntities") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const access = await accessFor(ctx, user);
    if (!(await parentDeal(ctx, user.orgId, access, args.deal))) return null;
    if (!may(access, "lineItem", "read")) return null;
    const rows = await currentLines(ctx, user.orgId, args.deal);
    const lines: Array<{ id: Id<"canonEntities">; version: number } & Record<string, unknown>> = rows.map((r) => ({ id: r.streamId, version: r.version, ...withoutHidden(access, "lineItem", r.values) }));
    const total = fieldLevel(access, "lineItem", "totalPrice") === "hidden" ? null : lineTotal(rows.map((r) => ({ totalPrice: Number(r.values.totalPrice) })));
    return { lines, total, editable: editable(user, access) };
  },
});

const inputLine = v.object({
  id: v.optional(v.id("canonEntities")), version: v.optional(v.number()),
  productId: v.id("canonEntities"), quantity: v.number(), unitPrice: v.union(v.number(), v.null()), totalPrice: v.number(),
});

export const replace = mutation({
  args: { deal: v.id("canonEntities"), expected: v.array(lineVersion), lines: v.array(inputLine) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const access = await requireWriteAccess(ctx, user);
    if (!(await parentDeal(ctx, user.orgId, access, args.deal))) throw new ConvexError("Deal not found");
    if (!editable(user, access)) throw new ConvexError("Your role cannot change this deal's line items");
    refuseLockedWrite(access, "lineItem", EDIT_FIELDS);
    if (args.lines.length > MAX_DEAL_LINES) throw new ConvexError(`Add at most ${MAX_DEAL_LINES} lines`);
    const current = await currentLines(ctx, user.orgId, args.deal);
    requireCurrent(current, args.expected);
    const byId = new Map(current.map((r) => [r.streamId, r]));
    const kept = new Set<string>();
    const commands: SaveCommand[] = [];
    for (const [position, line] of args.lines.entries()) {
      if (line.id && (kept.has(line.id) || byId.get(line.id)?.version !== line.version)) throw new ConvexError("Line item not found or changed");
      if (line.id) kept.add(line.id);
      const values = { dealId: args.deal, productId: line.productId, quantity: line.quantity, unitPrice: line.unitPrice, totalPrice: line.totalPrice, position };
      commands.push(line.id ? { op: "update", streamId: line.id, values, expectedVersion: line.version } : { op: "create", values });
    }
    for (const row of current) if (!kept.has(row.streamId)) commands.push({ op: "delete", streamId: row.streamId, expectedVersion: row.version });
    const results = await saveDealLinesAsCaller(ctx, user, args.deal, commands);
    if (results.some((r) => r.status !== "applied" && r.status !== "unchanged")) throw new ConvexError("Could not save the line items");
    return null;
  },
});

export const useAsAmount = mutation({
  args: { deal: v.id("canonEntities"), expectedVersion: v.number(), expected: v.array(lineVersion) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const access = await requireWriteAccess(ctx, user);
    if (!(await parentDeal(ctx, user.orgId, access, args.deal))) throw new ConvexError("Deal not found");
    if (!can(user, "deals.write") || !may(access, "deal", "edit") || !may(access, "lineItem", "read") || fieldLevel(access, "lineItem", "totalPrice") === "hidden") throw new ConvexError("Your role cannot use the line items total");
    refuseLockedWrite(access, "deal", ["amount"]);
    const rows = await currentLines(ctx, user.orgId, args.deal);
    requireCurrent(rows, args.expected);
    if (!rows.length) throw new ConvexError("Add line items first");
    return saveDealAsCaller(ctx, user, args.deal, { amount: lineTotal(rows.map((r) => ({ totalPrice: Number(r.values.totalPrice) }))) }, args.expectedVersion);
  },
});
