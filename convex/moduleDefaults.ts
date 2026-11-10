import { capturePackageState, moduleSource, withModulePublication } from "./lib/modules/activityCapture";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MODULE_EXAMPLES } from "../modules/examples/_examples.generated.ts";
import { moduleSlug, type ModuleManifest } from "../modules/kernel/manifest.ts";
import { compareVersions, defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import { applyModule, checkModule, setModuleEnabled } from "./modules";
import { enablementRow, manifestOf, packageRow, MODULE_CONTRIBUTION, MODULE_POINT } from "./lib/modules/packages";
import { hasDocs } from "./lib/modules/scope";
import { ensureCursors } from "./lib/modules/jobs";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";

const SWEEP_BATCH = 50;

const canonExamples = () => Object.entries(MODULE_EXAMPLES).map(([slug, ex]) => ({
  slug, sha: ex.sha, text: ex.manifest, manifest: JSON.parse(ex.manifest) as ModuleManifest, bundle: ex.bundle,
}));

type Example = ReturnType<typeof canonExamples>[number];

/** The default modules Canon ships, by slug. */
export const defaultExamples = (): Example[] => canonExamples().filter((ex) => ex.manifest.default);

/** Initial selection also gates delayed installs and pending navigation. */
export async function examplesForOrg(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">): Promise<Example[]> {
  const org = await ctx.db.get(orgId);
  const plan = org?.startingPlan;
  if (!plan) return defaultExamples();
  const ids = new Set(plan.modules.map((m) => m.id));
  return canonExamples().filter((ex) => ids.has(ex.manifest.id));
}

export async function applyStartingPlan(ctx: MutationCtx, user: Doc<"users">): Promise<void> {
  const org = await ctx.db.get(user.orgId);
  if (!org?.startingPlan) return;
  const selected = await examplesForOrg(ctx, user.orgId);
  if (selected.length !== new Set(org.startingPlan.modules.map((m) => m.id)).size) throw new ConvexError("The starting plan names a module Canon no longer ships.");
  const ids = new Set(selected.map((ex) => ex.manifest.id));
  // Clerk seeds before claim. Retain their data, and leave every explicit member choice alone.
  for (const ex of defaultExamples()) {
    if (ids.has(ex.manifest.id)) continue;
    const pkg = await packageRow(ctx, user.orgId, ex.manifest.id);
    const on = await enablementRow(ctx, user.orgId, ex.manifest.id);
    if (pkg?.status === "installed" && pkg.source.kind === "canon" && pkg.source.id === ex.slug && !pkg.installedBy && on?.enabled && !on.by) {
      await setModuleEnabled(ctx, user, { moduleId: ex.manifest.id, enabled: false });
    }
  }
  await seedDefaultModules(ctx, user.orgId);
}

type Candidate = Pick<Example, "slug" | "sha">;

/** Whether the workspace has never had the module: no package row and no on or off row. */
export async function neverHad(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, moduleId: string): Promise<boolean> {
  return !(await packageRow(ctx, orgId, moduleId)) && !(await enablementRow(ctx, orgId, moduleId));
}

async function eligible(ctx: QueryCtx, orgId: Id<"organizations">, ex: Example): Promise<boolean> {
  const row = await packageRow(ctx, orgId, ex.manifest.id);
  if (!row) {
    if (!(await neverHad(ctx, orgId, ex.manifest.id))) return false;
    return !(await ctx.db.query("modulePackages").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", moduleSlug(ex.manifest.id))).first());
  }
  if (row.status !== "installed" || row.source.kind !== "canon" || row.source.id !== ex.slug || row.source.sha === ex.sha || (row.pending && !row.pending.error) || compareVersions(ex.manifest.version, row.version) < 0) return false;
  const from = manifestOf(row);
  const plan = planUpgrade(from, row.slots ?? defaultSlots(from), ex.manifest, row.version);
  if (plan.problems.length) return false;
  for (const collection of plan.dropped) if (await hasDocs(ctx, orgId, row.moduleId, collection)) return false;
  return true;
}

async function applyDefault(ctx: MutationCtx, orgId: Id<"organizations">, ex: Example, bundle?: { bundleHash: string; bundleStorageId: Id<"_storage"> }): Promise<boolean> {
  return withModulePublication(ctx, async () => {
    if (!(await eligible(ctx, orgId, ex))) return false;
    const fresh = await neverHad(ctx, orgId, ex.manifest.id);
    const previous = await packageRow(ctx, orgId, ex.manifest.id);
    const from = previous && manifestOf(previous);
    const newReads = previous && from ? planUpgrade(from, previous.slots ?? defaultSlots(from), ex.manifest, previous.version).newReads : [];
    const checked = await checkModule(ex.text);
    await applyModule(ctx, orgId, {
      moduleId: ex.manifest.id, source: { kind: "canon", id: ex.slug, ref: ex.manifest.version, sha: ex.sha },
      version: ex.manifest.version, manifest: checked.text, manifestHash: checked.hash, approveReads: true, ...bundle,
    });
    if (previous) await ctx.db.patch(previous._id, { autoUpgrade: { version: ex.manifest.version, newReads, at: Date.now() } });
    if (fresh) {
      await ensureCursors(ctx, orgId, ex.manifest.id, ex.manifest, from ?? null);
      const installed = (await packageRow(ctx, orgId, ex.manifest.id))!;
      await capturePackageState(ctx, moduleSource(installed), () => ctx.db.insert("recipeEnablements", { orgId, point: MODULE_POINT, recipeId: ex.manifest.id, contributionKey: MODULE_CONTRIBUTION, enabled: true, at: Date.now() }));
    }
    return true;
  });
}

/** Workspace creation keeps server-less seeds inline; file storage needs the scheduled action. */
export async function seedDefaultModules(ctx: MutationCtx, orgId: Id<"organizations">): Promise<number> {
  let seeded = 0, needsAction = false;
  for (const ex of await examplesForOrg(ctx, orgId)) {
    if (!(await eligible(ctx, orgId, ex))) continue;
    if (ex.manifest.server) needsAction = true;
    else if (await applyDefault(ctx, orgId, ex)) seeded++;
  }
  if (needsAction) await ctx.scheduler.runAfter(0, internal.moduleDefaults.reconcile, { orgId });
  return seeded;
}

export const candidates = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }): Promise<Candidate[]> => {
    const out: Candidate[] = [];
    for (const ex of await examplesForOrg(ctx, orgId)) if (await eligible(ctx, orgId, ex)) out.push({ slug: ex.slug, sha: ex.sha });
    return out;
  },
});

export const storeDefault = internalMutation({
  args: { orgId: v.id("organizations"), slug: v.string(), sha: v.string(), bundleHash: v.optional(v.string()), bundleStorageId: v.optional(v.id("_storage")) },
  handler: async (ctx, a): Promise<boolean> => {
    const ex = (await examplesForOrg(ctx, a.orgId)).find((ex) => ex.slug === a.slug && ex.sha === a.sha);
    if (!ex || (ex.manifest.server && (!a.bundleHash || !a.bundleStorageId))) return false;
    return applyDefault(ctx, a.orgId, ex, a.bundleHash && a.bundleStorageId ? { bundleHash: a.bundleHash, bundleStorageId: a.bundleStorageId } : undefined);
  },
});

export const reconcile = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }): Promise<void> => {
    const candidates: Candidate[] = await ctx.runQuery(internal.moduleDefaults.candidates, { orgId });
    const examples = canonExamples();
    for (const candidate of candidates) {
      const ex = examples.find((ex) => ex.slug === candidate.slug && ex.sha === candidate.sha);
      if (!ex) continue;
      const code = ex.manifest.server ? ex.bundle : null;
      if (ex.manifest.server && code === null) throw new Error(`${ex.slug} declares server code that Canon didn't build.`);
      const bundleStorageId = code === null ? undefined : await ctx.storage.store(new Blob([code], { type: "text/javascript" }));
      let used = false;
      try {
        used = await ctx.runMutation(internal.moduleDefaults.storeDefault, {
          orgId, slug: ex.slug, sha: ex.sha, ...(bundleStorageId ? { bundleStorageId, bundleHash: await bundleHash(code!) } : {}),
        });
      } finally {
        if (bundleStorageId && !used) await ctx.storage.delete(bundleStorageId);
      }
    }
  },
});

export const sweep = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    if (!canonExamples().length) return null;
    const page = await ctx.db.query("organizations").paginate({ cursor: args.cursor ?? null, numItems: SWEEP_BATCH });
    for (const org of page.page) await seedDefaultModules(ctx, org._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.moduleDefaults.sweep, { cursor: page.continueCursor });
    return null;
  },
});
