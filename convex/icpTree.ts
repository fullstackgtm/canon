/**
 * ICPs as trees (docs/icp-tree.md): each saved ICP (icps.ts) with the segments that narrow its accounts and the
 * personas to reach inside them, every node stored as one query line (modules/kernel/icpQuery.ts). Anyone in the workspace
 * reads them; admins and managers edit them. Segments and personas are counted, not scored: an ICP's gate, fit and
 * icpIds stay its own, so adding one never rescores the workspace.
 */
import { assertLegacyIcpsWritable, interfaceOwner } from "./lib/modules/interfaceOwnership";
import { readIcps, readIcpNodes } from "./lib/icpsInterface";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";
import { cleanPointOfView } from "./icps";
import { modelSettings } from "./lib/recipes";
import { fieldSlugs, formatQuery, parseQuery, type IcpQuery } from "../modules/kernel/icpQuery";
import { treeRequest, type TreeRows } from "./lib/icpTree";
import { treeMoveError } from "../modules/kernel/icpTreeMove";
import { callerClient, requireCaller } from "./records";
import { atLeastVersion } from "./lib/recordClient";
import type { IcpTreeCounts } from "./lib/recordContract";

/** Segments and personas a workspace keeps: with its ICPs, one counts request (contract.ts, at most 100 nodes). */
export const MAX_NODES = 75;
/** Segments inside segments, at most this deep below the ICP. */
const MAX_DEPTH = 4;
/** The record service contract that counts trees (contract.ts icp-tree/counts). */
const TREE_CONTRACT = "1.31.0";

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds strategy.edit. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "strategy.edit");

/** A node's query, checked: it parses for its kind and names only the workspace's account AI fields. Returns its canonical spelling. */
export async function checkQuery(ctx: QueryCtx, orgId: Id<"organizations">, text: string, kind: "icp" | "segment" | "persona"): Promise<{ text: string; query: IcpQuery }> {
  const { query: parsed, errors } = parseQuery(text.slice(0, 4000), kind);
  if (errors.length) throw new ConvexError(errors.join("; "));
  for (const slug of fieldSlugs(parsed)) {
    const field = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
    if (!field || field.entityType !== "account") throw new ConvexError(`field.${slug} is not one of this workspace's account AI fields`);
  }
  return { text: formatQuery(parsed), query: parsed };
}

function cleanName(name: string, kind: string): string {
  const n = name.trim().slice(0, 80);
  if (!n) throw new ConvexError(`Name the ${kind}.`);
  return n;
}

const nodesOf = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("icpNodes").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_NODES + 1);

async function ownedNode(ctx: MutationCtx, nodeId: Id<"icpNodes">, orgId: Id<"organizations">): Promise<Doc<"icpNodes">> {
  await assertLegacyIcpsWritable(ctx, orgId);
  const node = await ctx.db.get(nodeId);
  if (!node || node.orgId !== orgId) throw new ConvexError("Segment or persona not found.");
  return node;
}

/** Every ICP with its query line, and every segment and persona, for the ICPs page and agents. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const moduleOwned = !!(await interfaceOwner(ctx, user.orgId));
    const icps = await readIcps(ctx, user.orgId), nodes = await readIcpNodes(ctx, user.orgId);
    return {
      canEdit: !moduleOwned && isManager(user), canViewQuery: user.role === "admin", moduleOwned,
      icps: icps.map((i) => ({ ...i, description: i.description ?? undefined, pointOfView: i.pointOfView ?? undefined, offer: i.offer ?? undefined, _id: i.key as Id<"icps">, _creationTime: i.createdAt, orgId: user.orgId })),
      nodes: nodes.map((n) => ({ ...n, role: n.role ?? undefined, pointOfView: n.pointOfView ?? undefined, offer: n.offer ?? undefined, _id: n.key as Id<"icpNodes">, _creationTime: n.createdAt, orgId: user.orgId, icpId: n.icp as Id<"icps">, parentId: n.parent as Id<"icpNodes"> | undefined })),
    };
  },
});

export const createNode = mutation({
  args: {
    icpId: v.id("icps"),
    parentId: v.optional(v.id("icpNodes")),
    kind: v.union(v.literal("segment"), v.literal("persona")),
    name: v.string(),
    query: v.string(),
    role: v.optional(v.string()),
    pointOfView: v.optional(v.string()),
    offer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await assertLegacyIcpsWritable(ctx, user.orgId);
    const icp = await ctx.db.get(args.icpId);
    if (!icp || icp.orgId !== user.orgId) throw new ConvexError("ICP not found.");
    if ((await nodesOf(ctx, user.orgId)).length >= MAX_NODES) throw new ConvexError(`A workspace keeps at most ${MAX_NODES} segments and personas. Delete one first.`);
    if (args.parentId) {
      const parent = await ownedNode(ctx, args.parentId, user.orgId);
      if (parent.icpId !== icp._id) throw new ConvexError("That segment belongs to another ICP.");
      if (parent.kind === "persona") throw new ConvexError("A persona has no segments or personas under it.");
      let depth = 1;
      for (let p: Doc<"icpNodes"> | null = parent; p?.parentId; p = await ctx.db.get(p.parentId)) depth++;
      if (depth >= MAX_DEPTH) throw new ConvexError(`Segments go at most ${MAX_DEPTH} deep.`);
    }
    const { text } = await checkQuery(ctx, user.orgId, args.query, args.kind);
    const now = Date.now();
    return ctx.db.insert("icpNodes", {
      orgId: user.orgId, icpId: icp._id, ...(args.parentId ? { parentId: args.parentId } : {}), kind: args.kind,
      name: cleanName(args.name, args.kind), query: text, role: args.role?.trim().slice(0, 40) || undefined,
      pointOfView: cleanPointOfView(args.pointOfView), offer: cleanPointOfView(args.offer), createdBy: user._id, createdAt: now, updatedAt: now,
    });
  },
});

export const updateNode = mutation({
  args: {
    nodeId: v.id("icpNodes"),
    parentId: v.optional(v.union(v.id("icpNodes"), v.null())),
    name: v.optional(v.string()),
    query: v.optional(v.string()),
    role: v.optional(v.string()),
    pointOfView: v.optional(v.string()),
    offer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const node = await ownedNode(ctx, args.nodeId, user.orgId);
    const patch: Partial<Doc<"icpNodes">> = { updatedAt: Date.now() };
    if (args.parentId !== undefined) {
      const nodes = await ctx.db.query("icpNodes").withIndex("by_icpId", (q) => q.eq("icpId", node.icpId)).take(MAX_NODES + 1);
      const error = treeMoveError([
        { id: node.icpId, parent: null, kind: "icp" },
        ...nodes.filter((n) => n.orgId === user.orgId).map((n) => ({ id: n._id, parent: n.parentId ?? n.icpId, kind: n.kind })),
      ], node._id, args.parentId ?? node.icpId);
      if (error) throw new ConvexError(error);
      patch.parentId = args.parentId ?? undefined;
    }
    if (args.name !== undefined) patch.name = cleanName(args.name, node.kind);
    if (args.query !== undefined) patch.query = (await checkQuery(ctx, user.orgId, args.query, node.kind)).text;
    if (args.role !== undefined) patch.role = args.role.trim().slice(0, 40) || undefined;
    if (args.pointOfView !== undefined) patch.pointOfView = cleanPointOfView(args.pointOfView);
    if (args.offer !== undefined) patch.offer = cleanPointOfView(args.offer);
    await ctx.db.patch(node._id, patch);
    return null;
  },
});

/** Delete the nodes under an ICP or a segment (`parentId` undefined: the ICP's whole tree), deepest first. */
export async function removeSubtree(ctx: MutationCtx, icpId: Id<"icps">, parentId?: Id<"icpNodes">) {
  const icp = await ctx.db.get(icpId);
  if (icp) await assertLegacyIcpsWritable(ctx, icp.orgId);
  const nodes = await ctx.db.query("icpNodes").withIndex("by_icpId", (q) => q.eq("icpId", icpId)).take(MAX_NODES + 1);
  const doomed = new Set<Id<"icpNodes">>(parentId ? [parentId] : nodes.map((n) => n._id));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of nodes) if (n.parentId && doomed.has(n.parentId) && !doomed.has(n._id)) (doomed.add(n._id), (grew = true));
  }
  for (const id of doomed) await ctx.db.delete(id);
}

export const removeNode = mutation({
  args: { nodeId: v.id("icpNodes") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const node = await ownedNode(ctx, args.nodeId, user.orgId);
    await removeSubtree(ctx, node.icpId, node._id);
    return null;
  },
});

// ───────────────────────────── Counts ─────────────────────────────

export const treeForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => ({
    fit: await modelSettings(ctx, args.orgId, "scoring.fit"),
    icps: (await readIcps(ctx, args.orgId)).map((i) => ({ id: i.key, spec: i.spec })),
    nodes: (await readIcpNodes(ctx, args.orgId)).map((n) => ({ id: n.key, icpId: n.icp, parentId: n.parent ?? undefined, kind: n.kind, query: n.query })),
  }),
});

/**
 * Every ICP, segment and persona's accounts (and a persona's people), and the accounts each pair of siblings shares,
 * counted over the records the caller sees. Null when the record service can't count trees yet.
 */
export const counts = action({
  args: {},
  handler: async (ctx): Promise<IcpTreeCounts | null> => {
    const { orgId } = await ctx.runQuery(internal.icps.viewer, {});
    const client = callerClient(ctx, await requireCaller(ctx, { read: true }));
    if (client.mode === "http" && !atLeastVersion(await client.contractVersion(), TREE_CONTRACT)) return null;
    const rows: TreeRows = await ctx.runQuery(internal.icpTree.treeForOrg, { orgId });
    const nodes = treeRequest(rows);
    return nodes.length ? client.icpTreeCounts(orgId, { nodes }) : { nodes: [], overlaps: [] };
  },
});
