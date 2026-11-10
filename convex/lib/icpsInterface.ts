import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { ModuleDoc } from "./modules/scope";
import { specToQuery } from "../../modules/kernel/icpQuery";
import { MAX_ICPS } from "./icps";
import type { IcpSpec } from "../../modules/kernel/icpSpec";

export const ICPS_MODULE = "@canon/icps";
export { ICPS_V1_FIELDS, ICP_NODES_V1_FIELDS } from "../../modules/kernel/icpsInterface.ts";
import { ICPS_V1_FIELDS, ICP_NODES_V1_FIELDS } from "../../modules/kernel/icpsInterface.ts";
import { ConvexError } from "convex/values";
import { systemScope } from "./modules/scope";
import { interfaceOwner, assertIcpProvider } from "./modules/interfaceOwnership";
import { installedModule, isEnabled, manifestOf } from "./modules/packages";
const NODES_MAX = 75;

export type IcpRow = {
  key: string; name: string; description: string | null; spec: IcpSpec; query: string; active: boolean; isDefault: boolean;
  sourceDomain?: string; gapCheck?: Doc<"icps">["gapCheck"]; source: Doc<"icps">["source"]; pointOfView: string | null; offer: string | null; createdAt: number; updatedAt: number;
};
export type IcpNodeRow = {
  key: string; icp: string; parent: string | null; kind: "segment" | "persona"; name: string; query: string;
  role: string | null; pointOfView: string | null; offer: string | null; createdAt: number; updatedAt: number;
};

const icpRow = (i: Doc<"icps">): IcpRow => ({
  key: i._id, name: i.name, description: i.description ?? null, spec: i.spec, query: specToQuery(i.spec), active: i.active,
  isDefault: i.isDefault, ...(i.sourceDomain ? { sourceDomain: i.sourceDomain } : {}), ...(i.gapCheck ? { gapCheck: i.gapCheck } : {}), source: i.source, pointOfView: i.pointOfView ?? null, offer: i.offer ?? null, createdAt: i.createdAt, updatedAt: i.updatedAt,
});
const nodeRow = (n: Doc<"icpNodes">): IcpNodeRow => ({
  key: n._id, icp: n.icpId, parent: n.parentId ?? null, kind: n.kind, name: n.name, query: n.query, role: n.role ?? null,
  pointOfView: n.pointOfView ?? null, offer: n.offer ?? null, createdAt: n.createdAt, updatedAt: n.updatedAt,
});

async function ownedDefinitions(ctx: QueryCtx, orgId: Id<"organizations">, collection: "icps" | "nodes", max: number): Promise<ModuleDoc[] | null> {
  const owner = await interfaceOwner(ctx, orgId);
  if (!owner) return null;
  const pkg = await installedModule(ctx, orgId, ICPS_MODULE);
  if (!pkg || pkg._id !== owner.packageId || pkg.pending || !(await isEnabled(ctx, orgId, ICPS_MODULE))) throw new ConvexError("The owning ICP provider is unavailable or upgrading. Fit remains stale until it is ready.");
  const manifest = manifestOf(pkg);
  assertIcpProvider(pkg, manifest);
  const scope = await systemScope(ctx, orgId, ICPS_MODULE);
  if (!scope) throw new ConvexError("The owning ICP provider is unavailable.");
  const provide = manifest.provides![collection === "icps" ? "icps.v1" : "icpNodes.v1"];
  // Scope validates full enumeration; the own view retains metadata outside the frozen public fields.
  await scope.provide(collection === "icps" ? "icps.v1" : "icpNodes.v1", {}, max);
  return await scope.view(provide.view, {}) as ModuleDoc[];
}

export async function readIcps(ctx: QueryCtx, orgId: Id<"organizations">): Promise<IcpRow[]> {
  const owned = await ownedDefinitions(ctx, orgId, "icps", MAX_ICPS);
  const rows = owned === null ? await ctx.db.query("icps").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_ICPS + 1) : null;
  if (rows && rows.length > MAX_ICPS) throw new ConvexError("This workspace exceeds the 25 ICP limit. Resolve the existing definitions before continuing.");
  return (rows ? rows.map(icpRow) : owned!.map((d): IcpRow => ({
    key: d.key, name: String(d.data.name), description: d.data.description as string ?? null, spec: d.data.spec as IcpSpec, query: String(d.data.query),
    active: d.data.active === true, isDefault: d.data.isDefault === true, source: d.data.source as IcpRow["source"],
    pointOfView: d.data.pointOfView as string ?? null, offer: d.data.offer as string ?? null,
    createdAt: Number(d.data.createdAt ?? d.createdAt), updatedAt: d.updatedAt,
    ...(typeof d.data.sourceDomain === "string" ? { sourceDomain: d.data.sourceDomain } : {}),
    ...(d.data.gapCheck ? { gapCheck: d.data.gapCheck as IcpRow["gapCheck"] } : {}),
  }))).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export async function readIcpNodes(ctx: QueryCtx, orgId: Id<"organizations">): Promise<IcpNodeRow[]> {
  const owned = await ownedDefinitions(ctx, orgId, "nodes", NODES_MAX);
  if (owned !== null) return owned.map((d) => ({ key: d.key, icp: String(d.data.icp), parent: d.data.parent as string ?? null, kind: d.data.kind as "segment" | "persona", name: String(d.data.name), query: String(d.data.query), role: d.data.role as string ?? null, pointOfView: d.data.pointOfView as string ?? null, offer: d.data.offer as string ?? null, createdAt: Number(d.data.createdAt ?? d.createdAt), updatedAt: d.updatedAt }));
  const rows = await ctx.db.query("icpNodes").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(NODES_MAX + 1);
  if (rows.length > NODES_MAX) throw new ConvexError("This workspace exceeds the 75 segments and personas limit.");
  return rows.map(nodeRow);
}

function asDocs<R extends { key: string; createdAt: number; updatedAt: number }>(rows: readonly R[], fields: readonly (keyof R & string)[]): ModuleDoc[] {
  return rows.map((r) => ({
    key: r.key, version: r.updatedAt, owner: null, parentKey: null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    data: Object.fromEntries(fields.filter((f) => r[f] !== null).map((f) => [f, r[f]])),
  }));
}

/** `@canon/icps`'s interfaces as Canon serves them while ICPs are Canon's, or null for any other name. */
export async function bridgedIcpsRead(ctx: QueryCtx, orgId: Id<"organizations">, provide: string): Promise<ModuleDoc[] | null> {
  if (await interfaceOwner(ctx, orgId)) return null;
  if (provide === "icps.v1") return asDocs(await readIcps(ctx, orgId), ICPS_V1_FIELDS);
  if (provide === "icpNodes.v1") return asDocs(await readIcpNodes(ctx, orgId), ICP_NODES_V1_FIELDS);
  return null;
}
