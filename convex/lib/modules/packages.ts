import { capturePendingActivityDescriptor } from "./activityCapture";
/**
 * The modules a workspace has installed (modulePackages) and turned on (recipeEnablements at point "module"), read
 * in one place. A module's manifest was checked on install, so it is only parsed here, once per stored version.
 * Caller data reads and semantic writes go through ./scope.ts. Activity publication reads retained physical state.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { ConvexError } from "convex/values";

type Db = Pick<QueryCtx, "db">;
/** An installed module's server bundle in file storage. */
export type ModuleBundle = { hash: string; storageId: Id<"_storage"> };

/** The point a module's enablement row sits at, and its one contribution: the nav entry and its pages. */
export const MODULE_POINT = "module";
export const MODULE_CONTRIBUTION = "nav";
const ENABLED_READ = 100;

const PARSED_KEPT = 64;
const parsed = new Map<string, ModuleManifest>();

function parsedOnce(key: string, text: string): ModuleManifest {
  let m = parsed.get(key);
  if (!m) {
    m = JSON.parse(text) as ModuleManifest;
    parsed.set(key, m);
    if (parsed.size > PARSED_KEPT) parsed.delete(parsed.keys().next().value!);
  }
  return m;
}

/** The manifest of the version that serves. */
export function manifestOf(pkg: Pick<Doc<"modulePackages">, "_id" | "manifestHash" | "manifest">): ModuleManifest {
  return parsedOnce(`${pkg._id}:${pkg.manifestHash}`, pkg.manifest);
}

/**
 * The text of a newer version's manifest while it installs (its backfill running), or null: in its own document
 * (moduleManifests), or inline on a row an earlier Canon stored.
 */
export async function pendingManifestText(ctx: Db, pkg: Pick<Doc<"modulePackages">, "_id" | "pending">): Promise<string | null> {
  const p = pkg.pending;
  if (!p) return null;
  if (p.manifest !== undefined) return p.manifest;
  const rows = await ctx.db.query("moduleManifests").withIndex("by_packageId", (q) => q.eq("packageId", pkg._id)).take(10);
  return rows.find((r) => r.manifestHash === p.manifestHash)?.manifest ?? null;
}

/** The manifest of a newer version still installing, or null. */
export async function pendingManifestOf(ctx: Db, pkg: Pick<Doc<"modulePackages">, "_id" | "pending">): Promise<ModuleManifest | null> {
  const text = await pendingManifestText(ctx, pkg);
  return text === null ? null : parsedOnce(`${pkg._id}:pending:${pkg.pending!.manifestHash}`, text);
}

/** Keep an upgrade's next manifest (or none) in its own document: the package's earlier ones go. */
export async function storePendingManifest(ctx: MutationCtx, pkg: Pick<Doc<"modulePackages">, "_id" | "orgId">, next: { manifest: string; manifestHash: string } | null) {
  return capturePendingActivityDescriptor(ctx, pkg, async () => {
    for (const row of await ctx.db.query("moduleManifests").withIndex("by_packageId", (q) => q.eq("packageId", pkg._id)).take(10)) await ctx.db.delete(row._id);
    if (next) await ctx.db.insert("moduleManifests", { orgId: pkg.orgId, packageId: pkg._id, ...next });
  });
}

export const packageRow = (ctx: Db, orgId: Id<"organizations">, moduleId: string) =>
  ctx.db.query("modulePackages").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).unique();

/** The installed module a slug or id names in this workspace, or null. */
export async function installedModule(ctx: Db, orgId: Id<"organizations">, module: string): Promise<Doc<"modulePackages"> | null> {
  const row = module.startsWith("@")
    ? await packageRow(ctx, orgId, module)
    : await ctx.db.query("modulePackages").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", module)).unique();
  return row?.status === "installed" ? row : null;
}

export const enablementRow = (ctx: Db, orgId: Id<"organizations">, moduleId: string) =>
  ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_recipeId_and_contributionKey", (q) =>
    q.eq("orgId", orgId).eq("point", MODULE_POINT).eq("recipeId", moduleId).eq("contributionKey", MODULE_CONTRIBUTION)).unique();

export async function isEnabled(ctx: Db, orgId: Id<"organizations">, moduleId: string): Promise<boolean> {
  return (await enablementRow(ctx, orgId, moduleId))?.enabled === true;
}

/** The workspace's modules that are installed and on. */
export async function enabledModules(ctx: Db, orgId: Id<"organizations">, exact = false): Promise<Array<{ pkg: Doc<"modulePackages">; manifest: ModuleManifest }>> {
  const rows = await ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_enabled", (q) => q.eq("orgId", orgId).eq("point", MODULE_POINT).eq("enabled", true)).take(ENABLED_READ + (exact ? 1 : 0));
  if (exact && rows.length > ENABLED_READ) throw new ConvexError({ kind: "module_activity_limit", message: `Module activities support at most ${ENABLED_READ} enabled module entries per workspace.` });
  const packages = await Promise.all(rows.filter((row) => row.contributionKey === MODULE_CONTRIBUTION).map((row) => installedModule(ctx, orgId, row.recipeId)));
  return packages.flatMap((pkg) => pkg ? [{ pkg, manifest: manifestOf(pkg) }] : []);
}
