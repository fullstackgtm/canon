/**
 * Moving a board card: the same edit the record page makes to that one field, so validation, field permissions,
 * the record's visibility, the ledger and its history treat it as an edit from the record page. Pure of React and
 * of the app's path aliases, so a test drives it against the real mutations.
 */
import type { ListRow, Scalar } from "../../../convex/lib/objects/listSpec";

export type Save = { shard: number; seq: number };
export type SaveResult = { status: string; shard?: number; seq?: number; errors?: Array<{ field: string; message: string }> };

export const saveOf = (r: SaveResult): Save[] => (typeof r.shard === "number" && typeof r.seq === "number" ? [{ shard: r.shard, seq: r.seq }] : []);

/** A save that didn't land, as a sentence; null when it did (or changed nothing). */
export function saveProblem(r: SaveResult): string | null {
  switch (r.status) {
    case "applied":
    case "proposed":
    case "unchanged":
      return null;
    case "conflict":
      return "Someone else changed this record; reload and try again.";
    case "invalid":
      return r.errors?.map((e) => e.message).join("; ") || "Invalid value";
    default:
      return r.status;
  }
}

function messageOf(cause: unknown): string {
  const data = typeof cause === "object" && cause !== null && "data" in cause ? (cause as { data: unknown }).data : undefined;
  if (typeof data === "string") return data;
  return cause instanceof Error ? cause.message : "Something went wrong";
}

/** The two edit endpoints the record pages call: `objects.write` for ledger records, `records.edit` for companies and people. */
export type MoveCalls = {
  write: (args: { object: string; streamId: string; values: Record<string, Scalar | null>; expectedVersion: number }) => Promise<SaveResult>;
  edit: (args: { object: "account" | "contact"; id: string; patch: Record<string, Scalar | null>; idempotencyKey: string }) => Promise<unknown>;
};

export type MoveOutcome = { saves: Save[]; problem: string | null };

/** Set `field` on the card's record to the column's key (null clears it), as the caller, at the version the card shows. */
export async function moveRecord(calls: MoveCalls, target: { object: string; register: boolean; field: string }, row: Pick<ListRow, "id" | "version">, key: Scalar | null, idempotencyKey: string): Promise<MoveOutcome> {
  try {
    if (target.register) {
      // records.edit returns once the row shows the move, so the columns reload straight away.
      await calls.edit({ object: target.object as "account" | "contact", id: row.id, patch: { [target.field]: key }, idempotencyKey });
      return { saves: [], problem: null };
    }
    const r = await calls.write({ object: target.object, streamId: row.id, values: { [target.field]: key }, expectedVersion: row.version });
    return { saves: saveOf(r), problem: saveProblem(r) };
  } catch (cause) {
    return { saves: [], problem: messageOf(cause) };
  }
}
