/**
 * Canon's objects as module report sources (docs/modules.md, "Reports and charts"): a source's fields for one
 * workspace and caller, from the object's list definition as Canon's report builder reads it (convex/reports.ts
 * checkSpec, objects.describe), less what the caller's role hides (CP14). The fields are made in kernel/reports.ts
 * `recordReportFields`, which the browser and tests share.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { hiddenFields, permissionOf, type Access } from "../access";
import { listViewDef } from "../objects/listSpec";
import { customObjectRows, loadOrgObject } from "../objects/orgDefs";
import type { ResolvedObjectDef } from "../objects/registry";
import { ACTIVITY_OBJECT, activityReportDef, relationsOf } from "../objects/reportSpec";
import { customSource, RECORD_SOURCES, recordObjectOf, recordReportFields, type ReportField } from "../../../modules/kernel/reports.ts";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";

/** An object's list definition in the workspace, as Canon's reports read it; null for one it doesn't have. */
async function listedDefOf(ctx: QueryCtx, orgId: Id<"organizations">, object: string): Promise<ResolvedObjectDef | null> {
  if (object === ACTIVITY_OBJECT) return activityReportDef();
  const def = await loadOrgObject(ctx, orgId, object);
  return def ? listViewDef(object, def) : null;
}

/**
 * A Canon object's report as the caller reads it: its name (as the workspace calls it) and its fields, or `none` when
 * their role reads none of it. An object the workspace doesn't have, or archived, is refused.
 */
export async function recordSourcePlan(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, object: string): Promise<{ title: string; fields: ReportField[] } | { title: string; none: true }> {
  const def = await listedDefOf(ctx, orgId, object);
  if (!def) throw new ConvexError(`This workspace has no ${object} to report on.`);
  if (def.archivedAt !== undefined) throw new ConvexError(`${def.pluralLabel} is archived.`);
  if (!permissionOf(access, object).read) return { title: def.pluralLabel, none: true };
  // A related object the role can't read, or one archived, offers none of its fields.
  const related = new Map<string, ResolvedObjectDef | null>();
  for (const rel of relationsOf(object, def)) {
    if (related.has(rel.object)) continue;
    const d = permissionOf(access, rel.object).read ? await listedDefOf(ctx, orgId, rel.object) : null;
    related.set(rel.object, d && d.archivedAt === undefined ? d : null);
  }
  return { title: def.pluralLabel, fields: recordReportFields(object, def, (o) => related.get(o), (o) => new Set(hiddenFields(access, o))) };
}

/** The Canon sources `canon.*` stands for in a workspace: each registered one the module's `reads.records` grants, then its live custom objects. */
export async function everyRecordSource(ctx: QueryCtx, orgId: Id<"organizations">, manifest: Pick<ModuleManifest, "reads">): Promise<string[]> {
  if (!manifest.reads?.records) return [];
  const custom = (await customObjectRows(ctx, orgId)).filter((r) => r.object!.archivedAt === undefined).map((r) => customSource(r.apiName));
  return [...Object.keys(RECORD_SOURCES), ...custom].filter((s) => recordObjectOf(manifest, s) !== null);
}
