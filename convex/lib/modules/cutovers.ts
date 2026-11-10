import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { specToQuery } from "../../../modules/kernel/icpQuery";
import { icpTreeRequest } from "./icpTrees";
import { modelSettings } from "../recipes";
import type { ImportDoc } from "./imports";
import type { ReadDoc } from "../../../modules/kernel/calls.ts";
import { ICPS_CUTOVER, ICPS_MODULE } from "./interfaceOwnership";

/** Explicit trusted ownership changes. Installation never starts these. */
export const MODULE_CUTOVERS = {
  [ICPS_CUTOVER]: {
    module: ICPS_MODULE,
    interfaces: ["icps.v1", "icpNodes.v1"],
    async read(ctx: QueryCtx, orgId: Id<"organizations">): Promise<ImportDoc[]> {
      const icps = await ctx.db.query("icps").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(26);
      const nodes = await ctx.db.query("icpNodes").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(76);
      if (icps.length > 25 || nodes.length > 75) throw new ConvexError("Cutover refuses existing data above 25 ICPs or 75 segments and personas.");
      const docs: ImportDoc[] = [
        ...icps.map(({ _id, _creationTime: _time, orgId: _org, updatedAt, createdBy: _by, ...data }) => ({ collection: "icps", key: _id, createdAt: data.createdAt, data: { ...data, query: specToQuery(data.spec), updatedAt } })),
        ...nodes.map(({ _id, _creationTime: _time, orgId: _org, icpId, parentId, createdBy: _by, ...data }) => ({ collection: "nodes", key: _id, createdAt: data.createdAt, data: { ...data, icp: icpId, ...(parentId ? { parent: parentId } : {}) } })),
      ];
      const reads = (collection: string): ReadDoc[] => docs.filter((d) => d.collection === collection).map((d) => ({ key: d.key, version: 1, data: d.data, createdAt: Number(d.data.createdAt), updatedAt: Number(d.data.updatedAt), owner: null, parentKey: null }));
      icpTreeRequest({ icps: "definitions", nodes: "nodes" }, { definitions: reads("icps"), nodes: reads("nodes") }, await modelSettings(ctx, orgId, "scoring.fit"));
      return docs;
    },
  },
} as const;
