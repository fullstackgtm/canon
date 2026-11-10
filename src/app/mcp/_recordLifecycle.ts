/**
 * Archive or restore one record of any object, through the function the
 * dashboard uses for that object: companies and people through
 * records.bulkRegister (the register's archive button and list selection),
 * everything else through objects.remove and objects.restore (the ledger
 * record page). The record API and the MCP tool both call this, so an archive
 * from either is the dashboard's: its role and visibility checks, its ledger
 * entry and history, its actor.
 */
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

export type LifecycleOp = "delete" | "restore";

export type LifecycleResult =
  | { status: "applied" | "proposed" | "unchanged"; streamId: string; version?: number }
  | { status: "conflict"; streamId: string; version: number; expectedVersion: number }
  | { status: "invalid"; errors: Array<{ field: string; message: string }> };

export const isRegisterObject = (object: string): object is "account" | "contact" => object === "account" || object === "contact";

/**
 * `id` is a company's or person's register id, else the record's stream id. Companies and people have no version
 * check (as their update has none), so `expectedVersion` is refused for them rather than ignored.
 */
export async function setRecordLifecycle(
  convex: Pick<ConvexHttpClient, "mutation" | "action">,
  args: { object: string; id: string; op: LifecycleOp; expectedVersion?: number },
): Promise<LifecycleResult> {
  if (isRegisterObject(args.object)) {
    if (args.expectedVersion !== undefined) throw new Error("Companies and people have no version check; omit expectedVersion");
    const out = await convex.action(api.records.bulkRegister, { object: args.object, op: args.op, ids: [args.id], batchKey: globalThis.crypto.randomUUID() });
    const result = out.results[0]?.result;
    if (!result || result.errors?.length) return { status: "invalid", errors: result?.errors ?? [{ field: "", message: "Not saved" }] };
    return { status: result.status as "applied" | "unchanged", streamId: args.id };
  }
  return convex.mutation(args.op === "delete" ? api.objects.remove : api.objects.restore, {
    object: args.object, streamId: args.id as Id<"canonEntities">, ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
  });
}
