/**
 * Audiences move from Canon's own tables into the Audiences module (docs/module-plans/audiences.md, "Data migration").
 * While both exist, this copies each workspace's `audiences` rows into the module's docs wherever the module is on,
 * each keyed by the audience's old id, so links and stored references keep naming the same audience. Each copy keeps
 * a fingerprint of every field as it was copied: a field Canon changed since is copied again unless someone changed it
 * in the module, which keeps theirs (a rename or a Make private there survives a legacy export's new lastSentAt).
 * Running it twice changes nothing. An audience whose owner has left the workspace can't be owned in the module and
 * is left out, counted. Deleted with the core Audiences code once every reader has moved.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { systemScope, type ModuleDoc, type ModuleScope } from "./lib/modules/scope";

import { importSetKey } from "./lib/modules/imports";
import { audienceDoc, fingerprints, followUntouchedImports, followUntouchedRun, parentCopied, recentRunDocs, AUDIENCES_IMPORT } from "./lib/modules/audienceImport";
export { audienceDoc, followUntouchedImports as merge } from "./lib/modules/audienceImport";

const MODULE = "audiences";
const ORGS_PAGE = 50;
const AUDIENCES_PAGE = 100;

/** Every workspace, a page at a time; each with the module on gets its audiences copied. */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const page = await ctx.db.query("organizations").paginate({ numItems: ORGS_PAGE, cursor: a.cursor ?? null });
    for (const org of page.page) {
      if (await systemScope(ctx, org._id, MODULE)) await ctx.scheduler.runAfter(0, internal.audienceImport.copyOrg, { orgId: org._id });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.audienceImport.sweep, { cursor: page.continueCursor });
  },
});

/** One page of a workspace's audiences copied into the module, then the next. */
export const copyOrg = internalMutation({
  args: { orgId: v.id("organizations"), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ created: number; updated: number; skipped: number }> => {
    const scope = await systemScope(ctx, a.orgId, MODULE);
    if (!scope) return { created: 0, updated: 0, skipped: 0 };
    const page = await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", a.orgId)).paginate({ numItems: AUDIENCES_PAGE, cursor: a.cursor ?? null });
    const counts = await copyAll(scope, page.page);
    if (scope.manifest.imports?.includes(AUDIENCES_IMPORT)) for (const audience of page.page) await ctx.scheduler.runAfter(0, internal.audienceImport.syncLegacyChildren, { orgId: a.orgId, audienceId: audience._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.audienceImport.copyOrg, { orgId: a.orgId, cursor: page.continueCursor });
    return counts;
  },
});

async function copyAll(scope: ModuleScope, rows: Doc<"audiences">[]) {
  let created = 0, updated = 0, skipped = 0;
  for (const a of rows) {
    const key = a._id as string;
    const data = audienceDoc(a);
    const doc = (await scope.view("audiences.one", { key })) as ModuleDoc | null;
    if (!doc) {
      // The op checks before it writes, so a refused row (an owner who left) leaves nothing behind.
      try {
        await scope.op("audiences.import", { key, data: { ...data, imported: fingerprints(data) } });
        created++;
      } catch (cause) {
        if (!(cause instanceof ConvexError)) throw cause;
        skipped++;
      }
      continue;
    }
    const patch = followUntouchedImports(data, doc.data);
    if (patch) {
      await scope.op("audiences.sync", { key, expect: doc.version, data: patch });
      updated++;
    }
  }
  return { created, updated, skipped };
}

export const syncLegacyChildren = internalMutation({
  args: { orgId: v.id("organizations"), audienceId: v.id("audiences"), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const scope = await systemScope(ctx, a.orgId, MODULE);
    const audience = await ctx.db.get(a.audienceId);
    if (!scope?.manifest.imports?.includes(AUDIENCES_IMPORT) || !audience || audience.orgId !== a.orgId || !await parentCopied(scope, a.audienceId)) return;
    const page = await ctx.db.query("audienceAdditions").withIndex("by_audienceId_and_contactId", (q) => q.eq("audienceId", a.audienceId)).paginate({ numItems: 100, cursor: a.cursor ?? null });
    await scope.importDocs(AUDIENCES_IMPORT, page.page.filter((r) => r.orgId === a.orgId).map((r) => ({ collection: "additions", key: importSetKey(a.audienceId, r.contactId), parentKey: a.audienceId, data: { person: r.contactId } })));
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.audienceImport.syncLegacyChildren, { ...a, cursor: page.continueCursor });
      return;
    }
    for (const run of await recentRunDocs(ctx, a.orgId, a.audienceId)) {
      const doc = await scope.view("runs.one", { key: run.key }) as ModuleDoc | null;
      if (!doc) await scope.importDocs(AUDIENCES_IMPORT, [run]);
      else {
        const patch = followUntouchedRun(run.data, doc.data);
        if (patch) await scope.op("runs.sync", { key: doc.key, expect: doc.version, data: patch });
      }
    }
  },
});
