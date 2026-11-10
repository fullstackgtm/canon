import { ConvexError, v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { moduleActivityOf, type ModuleActivitySearchHit, type ModuleActivitySearchResult } from "../modules/kernel/activities.ts";
import { enabledModules } from "./lib/modules/packages";
import { accessScope, moduleScope, personScope, systemScope } from "./lib/modules/scope";
import type { ModuleActivityRef, ModuleActivityRow } from "./lib/activities";
import type { ModuleActivityPrincipal, ModuleActivityRequest } from "./lib/modules/activities";
import { moduleDealTarget } from "./lib/modules/dealTarget";
import type { Access } from "./lib/access";
import type { ModuleActivityReportSource, ModuleDocScope } from "./lib/objects/moduleReport";
import { projectionOf } from "./lib/modules/projection";
import { reportsBehind } from "./lib/modules/jobs";
import { canonicalJson } from "../modules/kernel/integrity.ts";

export type ActivityReportContext = { sources: ModuleActivityReportSource[]; fence: string; ready: boolean };

/** Server-built sources. The same query fences lifecycle, scope and readiness around the service snapshot. */
export const reportContext = internalQuery({
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()) },
  handler: async (ctx, { orgId, accesses: given }): Promise<ActivityReportContext> => {
    const accesses = given as Access[];
    if (!accesses.length || accesses.length > 100) throw new ConvexError("An activity report needs between one and 100 principals.");
    const sources: ModuleActivityReportSource[] = [];
    const states = [];
    let ready = true, collections = 0;
    for (const { pkg, manifest } of (await enabledModules(ctx, orgId, true)).sort((a, b) => a.pkg.moduleId.localeCompare(b.pkg.moduleId))) {
      const activities = Object.entries(manifest.collections).filter(([, c]) => c.activity).sort(([a], [b]) => a.localeCompare(b));
      if (!activities.length) continue;
      if (pkg.pending?.phase === "cutover") throw new ConvexError("An activity module is finishing its upgrade. Try again shortly.");
      const principals = await Promise.all(accesses.map((access) => accessScope(ctx, orgId, access, pkg.moduleId)));
      if (principals.some((scope) => !scope)) throw new ConvexError("An activity report principal or module is unavailable.");
      const projection = projectionOf(pkg, manifest);
      const completed = [...(pkg.projection?.completed ?? [])].sort();
      const dirty = await reportsBehind(ctx.db, orgId, pkg.moduleId);
      const migrating = principals.some((scope) => !!scope!.migrating);
      const plans = [];
      for (const [collection, c] of activities) {
        const scopes = principals.map((scope) => scope!.activityPlan(collection));
        plans.push({ collection, declaration: c.activity!, scopes });
        if (scopes.includes("none")) continue;
        if (++collections > 100) throw new ConvexError("Activity reports support at most 100 collection sources.");
        if (!projection || migrating || dirty || !projection.collections.every((name) => completed.includes(name))) ready = false;
        if (projection) sources.push({ module: pkg.moduleId, collection, kind: c.activity!.kind, owner: c.activity!.owner ?? null, scopes: scopes as ModuleDocScope[], projection });
      }
      states.push({ module: pkg.moduleId, packageId: pkg._id, manifestHash: pkg.manifestHash, epoch: pkg.epoch ?? 1, projection, completed, dirty, migrating, plans });
    }
    return { sources, ready, fence: canonicalJson({ states, sources, ready }) };
  },
});

const MODULE_ACTIVITY_SCAN_MAX = 1000;
const targetKey = (ref: { object: string; id: string }) => `${ref.object}/${ref.id}`;

export const search = query({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { q, limit = 30 }): Promise<ModuleActivitySearchResult> => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new ConvexError("Activity search limit must be between 1 and 30.");
    const needle = q.trim().toLowerCase();
    if (!needle || q.length > 200) return { kind: "ready", hits: [] };
    const user = await getCurrentUser(ctx);
    if (!user) return { kind: "ready", hits: [] };
    const candidates: Array<{ hit: ModuleActivitySearchHit; updatedAt: number }> = [];
    let remaining = MODULE_ACTIVITY_SCAN_MAX;
    try {
      for (const { pkg, manifest } of await enabledModules(ctx, user.orgId, true)) {
        const collections = Object.entries(manifest.collections).filter(([, c]) => c.activity);
        if (!collections.length || pkg.pending?.phase === "cutover") continue;
        const scope = await moduleScope(ctx, pkg.moduleId);
        if (!scope) continue;
        for (const [collection, c] of collections) {
          const declaration = c.activity!;
          const { docs, scanned } = await scope.activityDocs(collection, remaining);
          remaining -= scanned;
          const page = manifest.pages.find((p) => p.path === declaration.path);
          if (page?.roles && !page.roles.includes(scope.role)) continue;
          for (const doc of docs) {
            const { activity } = moduleActivityOf(pkg.moduleId, pkg.slug, collection, declaration, doc);
            candidates.push({ hit: { id: activity.id, title: activity.subject, activityKind: activity.activityKind, moduleTitle: manifest.title, source: activity.source }, updatedAt: doc.updatedAt });
          }
        }
      }
    } catch (error) {
      if (!(error instanceof ConvexError) || typeof error.data !== "object" || error.data === null || !("kind" in error.data) || error.data.kind !== "module_activity_limit") throw error;
      return { kind: "unavailable", message: "Activity search is unavailable for this workspace. Open the activity module to find its records." };
    }
    return { kind: "ready", hits: candidates.filter(({ hit }) => hit.title.toLowerCase().includes(needle)).sort((a, b) =>
      Number(b.hit.title.toLowerCase().startsWith(needle)) - Number(a.hit.title.toLowerCase().startsWith(needle)) ||
      b.updatedAt - a.updatedAt || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
    ).slice(0, limit).map(({ hit }) => hit) };
  },
});

/** Only internal callers can name a background person or Canon. A session always uses moduleScope. */
async function scopedModuleActivities(ctx: QueryCtx, request: ModuleActivityRequest, principal?: ModuleActivityPrincipal): Promise<ModuleActivityRow[]> {
  const orgId = principal?.orgId ?? (await getCurrentUser(ctx))?.orgId;
  if (!orgId || !request.targets.some((target) => target.object !== "lead")) return [];
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.targets.length > MODULE_ACTIVITY_SCAN_MAX) throw new ConvexError("Module activities exceed the live read request limit.");
  const out: ModuleActivityRow[] = [];
  const wanted = new Set(request.targets.map(targetKey));
  let remaining = MODULE_ACTIVITY_SCAN_MAX;
  const dealStreams = new Map<string, string | null>();
  const streamOf = async (raw: string): Promise<string | null> => {
    if (dealStreams.has(raw)) return dealStreams.get(raw)!;
    const stream = (await moduleDealTarget(ctx, orgId, raw))?.entity._id ?? null;
    dealStreams.set(raw, stream);
    return stream;
  };
  for (const { pkg, manifest } of await enabledModules(ctx, orgId, true)) {
    const collections = Object.entries(manifest.collections).filter(([, c]) => c.activity);
    if (!collections.length || pkg.pending?.phase === "cutover") continue;
    const scope = principal ? "system" in principal ? await systemScope(ctx, orgId, pkg.moduleId) : await personScope(ctx, orgId, principal.userId, pkg.moduleId) : await moduleScope(ctx, pkg.moduleId);
    if (!scope) continue;
    for (const [collection, c] of collections) {
      if (!c.activity) continue;
      const declaration = c.activity;
      const page = manifest.pages.find((p) => p.path === declaration.path);
      if (!scope.system && page?.roles && !page.roles.includes(scope.role)) continue;
      const { docs, scanned } = await scope.activityDocs(collection, remaining);
      remaining -= scanned;
      for (const doc of docs) {
        if (request.since !== null && doc.createdAt < request.since) continue;
        const row = moduleActivityOf(pkg.moduleId, pkg.slug, collection, c.activity, doc);
        const refs: ModuleActivityRef[] = [];
        for (const ref of row.refs) {
          if (ref.object === "deal") {
            const stream = await streamOf(ref.id);
            if (stream) refs.push({ object: "deal", id: stream, dealId: ref.id });
          } else refs.push(ref);
        }
        if (refs.some((ref) => wanted.has(targetKey(ref)))) out.push({ ...row, refs });
      }
    }
  }
  if (out.length > request.limit) throw new ConvexError({ kind: "module_activity_limit", message: `Module activity read exceeds its ${request.limit} row limit.` });
  return out.sort((a, b) => b.activity.at - a.activity.at || a.activity.id.localeCompare(b.activity.id));
}

export const read = internalQuery({
  args: {
    targets: v.array(v.object({ object: v.union(v.literal("account"), v.literal("contact"), v.literal("deal"), v.literal("lead")), id: v.string() })),
    since: v.union(v.number(), v.null()), limit: v.number(),
    principal: v.optional(v.union(
      v.object({ orgId: v.id("organizations"), userId: v.id("users") }),
      v.object({ orgId: v.id("organizations"), system: v.literal(true) }),
    )),
  },
  handler: (ctx, { principal, ...request }): Promise<ModuleActivityRow[]> => scopedModuleActivities(ctx, request, principal),
});
