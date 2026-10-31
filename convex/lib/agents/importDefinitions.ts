import type { ModuleImport } from "../modules/imports";
import { legacyDefinition } from "./definitionModel";

export const eventDefinitionsImport: ModuleImport = {
  module: "@canon/agents",
  label: "Existing event agents",
  async batch(ctx, orgId, cursor) {
    const page = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
      .paginate({ numItems: 100, cursor });
    const docs = page.page.flatMap((agent) => {
      const data = agent.archivedAt === undefined ? legacyDefinition(agent) : null;
      return data ? [{ collection: "agents", key: agent._id, data }] : [];
    });
    return { docs, cursor: page.isDone ? null : page.continueCursor };
  },
};
