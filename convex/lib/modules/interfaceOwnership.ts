import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { ICPS_V1_FIELDS, ICP_NODES_V1_FIELDS } from "../../../modules/kernel/icpsInterface.ts";
import { manifestOf, packageRow } from "./packages";

type Db = Pick<QueryCtx, "db">;
export const ICPS_MODULE = "@canon/icps";
export const ICPS_CUTOVER = "icps.legacy.v1";

export function interfaceOwner(ctx: Db, orgId: Id<"organizations">, moduleId = ICPS_MODULE) {
  return ctx.db.query("moduleInterfaceOwners").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).unique();
}

export async function assertLegacyIcpsWritable(ctx: Db, orgId: Id<"organizations">) {
  if (await interfaceOwner(ctx, orgId)) throw new ConvexError("ICPs are owned by the ICPs module. Open its page to edit them.");
}

export function assertIcpProvider(pkg: Pick<Doc<"modulePackages">, "moduleId" | "source">, m: ModuleManifest) {
  if (pkg.moduleId !== ICPS_MODULE || pkg.source.kind !== "canon" || pkg.source.id !== "icps") throw new ConvexError("ICP ownership requires the genuine From Canon ICPs package.");
  for (const [name, collection, fields, max] of [["icps.v1", "icps", ICPS_V1_FIELDS, 25], ["icpNodes.v1", "nodes", ICP_NODES_V1_FIELDS, 75]] as const) {
    const p = m.provides?.[name], v = p && m.views[p.view], c = m.collections[collection];
    if (!p || !v || v.kind !== "list" || v.collection !== collection || v.where || v.parent || v.index || v.eq || v.range || (v.limit !== undefined && v.limit < max) || v.args && Object.keys(v.args).length || !c || c.setOf || c.max !== max || JSON.stringify(p.fields) !== JSON.stringify(fields) || ["manager", "rep", "other"].some((r) => c.access[r as "manager"] !== "all")) throw new ConvexError("The owning package must preserve the complete ICP interfaces and member reads.");
  }
}

export async function assertOwnedPackageChange(ctx: Db, orgId: Id<"organizations">, moduleId: string, next?: { source: Doc<"modulePackages">["source"]; manifest: ModuleManifest }) {
  const owner = await interfaceOwner(ctx, orgId, moduleId);
  if (!owner) return;
  if (!next) throw new ConvexError("A module that owns a Canon interface cannot be switched off or uninstalled.");
  const pkg = await packageRow(ctx, orgId, moduleId);
  if (!pkg || pkg._id !== owner.packageId) throw new ConvexError("The interface owner package is unavailable.");
  assertIcpProvider({ moduleId, source: next.source }, next.manifest);
  // Migrations could delete or reinterpret authoritative definitions before publication.
  if (next.manifest.migrations?.icps || next.manifest.migrations?.nodes) throw new ConvexError("Owned ICP definition migrations require a separate authority migration.");
}

export async function assertModuleDefinitionWrite(ctx: Db, row: { orgId: Id<"organizations">; moduleId: string; collection: string }) {
  if (row.moduleId !== ICPS_MODULE || !["icps", "nodes", "challenges"].includes(row.collection)) return;
  const owner = await interfaceOwner(ctx, row.orgId);
  const pkg = await packageRow(ctx, row.orgId, row.moduleId);
  if (!owner || !pkg || owner.packageId !== pkg._id) throw new ConvexError("ICPs remain Canon-owned in this workspace. Module definitions are read-only until the explicit cutover.");
  assertIcpProvider(pkg, manifestOf(pkg));
}
