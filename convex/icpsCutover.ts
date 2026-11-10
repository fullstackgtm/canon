import { ConvexError, v } from "convex/values";
import { isDevAuthBypassEnabled } from "./lib";
import { internalMutation } from "./_generated/server";
import { sealOf } from "../modules/kernel/integrity.ts";
import { MODULE_CUTOVERS } from "./lib/modules/cutovers";
import { ICPS_CUTOVER, ICPS_MODULE, assertIcpProvider, interfaceOwner } from "./lib/modules/interfaceOwnership";
import { installedModule, isEnabled, manifestOf } from "./lib/modules/packages";
import { hasDocs, systemScope } from "./lib/modules/scope";
import { invalidateFit } from "./lib/fitInvalidation";

/** One transaction. Invoked explicitly on the parent's local stack for I5 proof only. */
export const cutOver = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("This explicit I5 cutover is available only on an anonymous local stack.");
    const registry = MODULE_CUTOVERS[ICPS_CUTOVER];
    const docs = await registry.read(ctx, orgId);
    const fingerprint = await sealOf({ field: "hash", fields: ["docs"] }, { docs }, {});
    const pkg = await installedModule(ctx, orgId, ICPS_MODULE);
    if (!pkg || pkg.pending || !(await isEnabled(ctx, orgId, ICPS_MODULE))) throw new ConvexError("Install and enable the Canon ICPs package with no pending upgrade before cutover.");
    assertIcpProvider(pkg, manifestOf(pkg));
    const prior = await interfaceOwner(ctx, orgId);
    if (prior) {
      if (prior.packageId !== pkg._id || prior.cutover !== ICPS_CUTOVER || prior.fingerprint !== fingerprint) throw new ConvexError("This workspace has a different completed ownership change.");
      return { completed: true, repeated: true, icps: prior.icps, nodes: prior.nodes, at: prior.at };
    }
    for (const collection of ["icps", "nodes"]) if (await hasDocs(ctx, orgId, ICPS_MODULE, collection)) throw new ConvexError("Cutover needs empty target definition collections. Preserve and explicitly remove synthetic preview docs first.");
    const at = Date.now(), icps = docs.filter((d) => d.collection === "icps").length, nodes = docs.length - icps;
    await ctx.db.insert("moduleInterfaceOwners", { orgId, moduleId: ICPS_MODULE, packageId: pkg._id, interfaces: [...registry.interfaces], cutover: ICPS_CUTOVER, fingerprint, icps, nodes, at });
    const scope = await systemScope(ctx, orgId, ICPS_MODULE);
    if (!scope) throw new ConvexError("The owning provider is unavailable.");
    await scope.copyCutover(ICPS_CUTOVER, docs);
    await invalidateFit(ctx, orgId);
    return { completed: true, repeated: false, icps, nodes, at };
  },
});
