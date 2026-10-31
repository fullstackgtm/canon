import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ActivityTarget, ModuleActivityRow } from "../activities";
import type { RecordClient } from "../recordClient";
import { IN_VALUES_MAX, LIST_LIMIT_MAX } from "../objects/listSpec";

export type ModuleActivityPrincipal = { orgId: Id<"organizations">; userId: Id<"users"> } | { orgId: Id<"organizations">; system: true };
export type ModuleActivityRequest = { targets: Array<{ object: ActivityTarget["object"]; id: string }>; since: number | null; limit: number };
const targetKey = (ref: { object: string; id: string }) => `${ref.object}/${ref.id}`;

/** Resolve refs through the same scoped client as the record read, before exposing either names or ids. */
export async function readModuleActivities(ctx: ActionCtx, client: Pick<RecordClient, "listObjects" | "listRegister">, ws: string, request: ModuleActivityRequest, principal?: ModuleActivityPrincipal): Promise<ModuleActivityRow[]> {
  if (principal && principal.orgId !== ws) throw new ConvexError("Module activity principal belongs to another workspace.");
  const rows: ModuleActivityRow[] = await ctx.runQuery(internal.moduleActivities.read, { ...request, ...(principal ? { principal } : {}) });
  const names = new Map<string, ActivityTarget>();
  for (const object of ["account", "contact", "deal"] as const) {
    const ids = [...new Set(rows.flatMap((r) => r.refs.filter((ref) => ref.object === object).map((ref) => ref.id)))];
    const pageSize = Math.min(IN_VALUES_MAX, LIST_LIMIT_MAX);
    for (let i = 0; i < ids.length; i += pageSize) {
      const wanted = ids.slice(i, i + pageSize);
      const req = { filter: [{ field: "id", op: "in" as const, value: wanted }], limit: wanted.length };
      const page = object === "deal" ? await client.listObjects(ws, object, req) : await client.listRegister(ws, object, req);
      if (page.nextCursor) throw new ConvexError("Module activity target resolution exceeded one exact page.");
      for (const r of page.rows) {
        const label = r.values[object === "contact" ? "fullName" : "name"];
        names.set(`${object}/${r.id}`, { object, id: r.id, name: typeof label === "string" && label !== "" ? label : r.id });
      }
    }
  }
  const wanted = new Set(request.targets.map(targetKey));
  return rows.flatMap((row) => {
    const refs = row.refs.filter((ref) => names.has(`${ref.object}/${ref.id}`));
    if (!refs.some((ref) => wanted.has(targetKey(ref)))) return [];
    return [{ ...row, refs, activity: { ...row.activity, targets: refs.flatMap((ref) => names.get(`${ref.object}/${ref.id}`) ?? []) } }];
  });
}
