/**
 * Each deal as it stood over time (P1a, docs/modules.md "Server code"): `dealVersions` holds one row per version of a
 * deal's ledger stream, valid from the entry's time until the next one's. `step` folds the ledger's deal entries into
 * it in shard order from per-shard cursors, as the module feed reads the ledger, so the first run is the backfill and
 * every later one keeps it current. Module reads `deals.asOf` and `deals.changesBetween` (lib/modules/canonReads.ts)
 * read it through `by_orgId_validTo`: the rows current now plus those changed since the time asked, never older ones.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { statesAround } from "./automations";
import { loadDef } from "./objects";
import { rowOf } from "./lib/automations";
import { SHARDS } from "./lib/objects/write";

/** A version still current. */
export const MAX_TIME = 8_640_000_000_000_000;
/** Deal entries one step folds, and ledger entries it reads per shard. */
const STEP_FOLDS = 2000;
const STEP_PAGE = 100;
/** The cursor row that records when the fold first caught up with the ledger. */
const BUILT = -1;

type VersionFields = Doc<"dealVersions">["fields"];
const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** The fields a version keeps, from a fold state; the owner falls back to the deal row's, as the module feed reads it. */
function fieldsOf(def: Awaited<ReturnType<typeof loadDef>>, state: Parameters<typeof rowOf>[1], rowOwner: string | null): VersionFields {
  const row = rowOf(def, state), x = row.values;
  return {
    name: str(x.name), amount: num(x.amount), currency: str(x.currency), closeDate: str(x.closeDate), stage: str(x.stage),
    forecastCategory: str(x.forecastCategory), probability: num(x.probability), isClosed: x.isClosed === true, isWon: x.isWon === true,
    ownerId: str(x.ownerId) ?? rowOwner, companyId: str(x.companyId), dealType: str(x.dealType), archived: row.deletedAt !== null,
  };
}

/** Close the deal's current version at `at` and open the next; a second entry at the same instant replaces it. */
async function putVersion(ctx: MutationCtx, orgId: Id<"organizations">, dealId: string, version: number, at: number, fields: VersionFields) {
  const last = await ctx.db.query("dealVersions").withIndex("by_dealId_validFrom", (q) => q.eq("dealId", dealId)).order("desc").first();
  if (last && last.version >= version) return;
  // An entry observed before the current version began (a late write) starts when that version did: intervals never overlap.
  const from = last ? Math.max(at, last.validFrom) : at;
  if (last && last.validFrom === from) { await ctx.db.patch(last._id, { version, fields }); return; }
  if (last && last.validTo === MAX_TIME) await ctx.db.patch(last._id, { validTo: from });
  await ctx.db.insert("dealVersions", { orgId, dealId, version, validFrom: from, validTo: MAX_TIME, fields });
}

async function cursorRows(ctx: QueryCtx, orgId: Id<"organizations">) {
  return ctx.db.query("dealVersionCursors").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).collect();
}

/** How far the fold has come: built once it first caught up; otherwise the share of the ledger folded so far. */
export async function historyState(ctx: QueryCtx, orgId: Id<"organizations">): Promise<{ built: boolean; percent: number }> {
  const rows = await cursorRows(ctx, orgId);
  if (rows.some((r) => r.shard === BUILT && r.builtAt !== undefined)) return { built: true, percent: 100 };
  const heads = await ctx.db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).collect();
  const total = heads.reduce((n, h) => n + h.seq, 0), done = rows.filter((r) => r.shard >= 0).reduce((n, r) => n + r.seq, 0);
  return { built: false, percent: total ? Math.min(99, Math.floor((done / total) * 100)) : 0 };
}

/**
 * Fold the next deal entries after the cursors, each shard in `seq` order and stopped at the first gap, then move the
 * cursors with the versions it wrote, in this one transaction. Schedules itself again while there is more.
 */
export const step = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }): Promise<{ more: boolean }> => {
    const rows = await cursorRows(ctx, orgId);
    const cursor = new Map(rows.filter((r) => r.shard >= 0).map((r) => [r.shard, r]));
    const def = await loadDef(ctx, orgId, "deal");
    let folds = 0, more = false;
    for (let shard = 0; shard < SHARDS; shard++) {
      const row = cursor.get(shard);
      const after = row?.seq ?? 0;
      const page = await ctx.db.query("ledgerEntries").withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", orgId).eq("shard", shard).gt("seq", after)).take(STEP_PAGE + 1);
      let seq = after;
      for (const e of page.slice(0, STEP_PAGE)) {
        if (e.seq !== seq + 1) break;
        if (folds >= STEP_FOLDS) { more = true; break; }
        seq = e.seq;
        if (e.object !== "deal" || e.redactedAt !== undefined) continue;
        const entity = await ctx.db.get(e.streamId);
        const dealId = entity?.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
        if (!dealId) continue;
        const { states, read } = await statesAround(ctx, e.streamId, e.version, e.observedAt);
        folds += read;
        if (!states || states === "too_long") continue;
        const deal = await ctx.db.get(dealId);
        await putVersion(ctx, orgId, dealId, e.version, e.observedAt, fieldsOf(def, states.after, deal?.primaryRepId ?? null));
      }
      if (page.length > STEP_PAGE || seq < (page.at(-1)?.seq ?? seq)) more = true;
      if (row) { if (seq !== row.seq) await ctx.db.patch(row._id, { seq }); }
      else await ctx.db.insert("dealVersionCursors", { orgId, shard, seq });
    }
    if (more) await ctx.scheduler.runAfter(0, internal.dealHistory.step, { orgId });
    else if (!rows.some((r) => r.shard === BUILT)) await ctx.db.insert("dealVersionCursors", { orgId, shard: BUILT, seq: 0, builtAt: Date.now() });
    return { more };
  },
});

const woken = new WeakMap<object, Set<string>>();
/** Wake the fold after a deal entry, once per transaction and org. */
export async function scheduleDealHistory(ctx: MutationCtx, orgId: Id<"organizations">) {
  const done = woken.get(ctx) ?? new Set<string>();
  woken.set(ctx, done);
  if (done.has(orgId)) return;
  done.add(orgId);
  await ctx.scheduler.runAfter(0, internal.dealHistory.step, { orgId });
}
