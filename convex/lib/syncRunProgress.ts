/** A sync run's live progress, shared by every integration's sync (Node and default runtime alike). */
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { createProgressEmitter, type ProgressEmitter } from "../../engine/src/progress.ts";

/**
 * Progress emitter whose listener fire-and-forgets a heartbeat patch onto the
 * sync run row (internal.integrations.updateRunProgress: 1 read + 1 write per
 * heartbeat). Throttling lives in the emitter (3s); failures are swallowed
 * twice — the emitter never rethrows a listener, and the mutation promise is
 * caught — so a heartbeat can never fail the sync.
 */
export function syncRunProgressEmitter(
  ctx: any,
  syncRunId: Id<"integrationSyncRuns">,
): ProgressEmitter {
  return createProgressEmitter(
    (_event, snapshot) => {
      void ctx
        .runMutation(internal.integrations.updateRunProgress, {
          syncRunId,
          progress: {
            stage: snapshot.stage,
            stageIndex: snapshot.stageIndex,
            stageCount: snapshot.stageCount,
            itemsDone: snapshot.itemsDone,
            itemsTotal: snapshot.itemsTotal,
            note: snapshot.note,
            heartbeatAt: snapshot.updatedAt,
          },
        })
        .catch(() => {});
    },
    { throttleMs: 3000 },
  );
}

/** Thrown inside a sync whose run was stopped or ended: its run and connection already say why. */
export class SyncRunEnded extends Error {}

/** Called between a sync's stages: a run someone stopped goes no further. */
export async function stopIfEnded(ctx: any, syncRunId: Id<"integrationSyncRuns">) {
  if (!(await ctx.runQuery(internal.integrations.syncRunLive, { syncRunId }))) throw new SyncRunEnded("Sync stopped");
}
