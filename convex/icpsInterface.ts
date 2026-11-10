import { interfaceOwner } from "./lib/modules/interfaceOwnership";
import { query } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { can } from "./lib/capabilities";
import { readIcps } from "./lib/icpsInterface";
import { modelSettings } from "./lib/recipes";

/** The workspace's ICPs (default first) and the buyer levels an ICP that names none means (scoring.fit). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const { buyerLevels } = await modelSettings(ctx, user.orgId, "scoring.fit");
    const moduleOwned = !!(await interfaceOwner(ctx, user.orgId));
    return { icps: await readIcps(ctx, user.orgId), buyerLevels, moduleOwned, canEdit: !moduleOwned && can(user, "strategy.edit") };
  },
});
