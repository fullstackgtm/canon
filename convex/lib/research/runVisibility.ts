import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { agentPrincipals, seesRunRecords, type Access } from "../access";
import { RUN_CAP } from "./agentLoop";

export async function researchRecords(ctx: QueryCtx, orgId: string, access: Access, run: Doc<"researchRuns">) {
  if (run.orgId !== orgId) return { visible: false, records: [] };
  const field = await ctx.db.get(run.agentId);
  const linked = field?.agentId ? await ctx.db.get(field.agentId) : null;
  const ownerUserId = linked?.ownerUserId ?? field?.createdBy ?? run.createdBy;
  if (!seesRunRecords(access, agentPrincipals({ ownerUserId, startedBy: run.createdBy }))) return { visible: false, records: [] };
  const rows = await ctx.db.query("researchTraces").withIndex("by_runId", (q) => q.eq("runId", run._id)).take(2 * RUN_CAP);
  return { visible: true, records: rows.map(({ _id, _creationTime: _c, orgId: _o, runId: _r, ...trace }) => ({ id: _id, ...trace })) };
}
