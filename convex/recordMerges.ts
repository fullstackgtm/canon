/**
 * Merge duplicate companies or people, and undo it (CP15a, lib/canon/partyMerge.ts).
 *
 * `preview` reads the records side by side with each value's source and the default pick per field. `merge`
 * and `undo` are actions: they read what the register knows (the people at a company, the activities that
 * name a record in a lookup), run the merge or its undo in one transaction, and return once the record
 * service has projected it, so the list the caller reloads is current. Only admins and managers merge.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalMutation, internalQuery, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, sightJudge } from "./permissions";
import { visibleIds } from "./lib/scopedRecordClient";
import { identitySeed, partyStores, saveDealValues } from "./canon";
import { edgeStore } from "./associations";
import { callerClient, clientFor, contactSnapshotOf, recordSnapshotOf, requireCaller, type ActionCaller } from "./records";
import { lockedFields, may } from "./lib/access";
import { foldAll, project, type LedgerEntry } from "./lib/objects/fold";
import { WRITE_FOLD_CAP } from "./lib/objects/write";
import { resolveObjectDef, STANDARD_OBJECTS, type OrgObjectExtension } from "./lib/objects/registry";
import { fromStored } from "./lib/objects/validators";
import { linkedActivities } from "./lib/activities";
import { asState } from "./objects";
import {
  defaultPicks, MergeError, mergeableFields, mergeParties, MERGE_RECORDS_MAX, unmergeParties,
  type MergeCell, type MergeStores, type MergeUndo,
} from "./lib/canon/partyMerge";
import type { RecordClient } from "./lib/recordClient";
import type { AccountRow, ContactRow } from "./lib/recordContract";
import type { RegisterListRow } from "./lib/objects/listSpec";

const object = v.union(v.literal("account"), v.literal("contact"));
type PartyObject = "account" | "contact";
/** People read per losing company, to seed the ones nobody has worked yet. */
const PEOPLE_PER_COMPANY = 200;

const accountSnapshot = v.object({
  id: v.string(), domain: v.string(), name: v.string(), updatedAt: v.number(),
  industry: v.optional(v.string()), employees: v.optional(v.number()), country: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()), status: v.optional(v.string()), ownerId: v.optional(v.string()),
});
const contactSnapshot = v.object({
  id: v.string(), fullName: v.string(), updatedAt: v.number(),
  email: v.optional(v.string()), title: v.optional(v.string()), linkedinUrl: v.optional(v.string()),
});
const party = v.object({ recordId: v.string(), streamId: v.optional(v.string()), snapshot: v.optional(v.union(accountSnapshot, contactSnapshot)) });

function mergeStores(ctx: MutationCtx): MergeStores {
  return {
    ...partyStores(ctx),
    edges: edgeStore(ctx),
    async setMergedInto(entityId, into) {
      await ctx.db.patch(entityId as Id<"canonEntities">, { mergedInto: into ? (into as Id<"canonEntities">) : undefined });
    },
    async dealsOfCompany(orgId, companyId) {
      const rows = await ctx.db.query("deals").withIndex("by_orgId_companyId", (q) => q.eq("orgId", orgId as Id<"organizations">).eq("companyId", companyId)).take(200);
      return rows.map((d) => d._id);
    },
    async setDealCompany(dealId, from, to, userId) {
      const deal = await ctx.db.get(dealId as Id<"deals">);
      if (!deal || deal.companyId !== from) return;
      await saveDealValues(ctx, deal, { kind: "user", userId }, { companyId: to });
    },
    async supersedeFact(factId) {
      await ctx.db.patch(factId as Id<"facts">, { status: "superseded" });
    },
  };
}

/** A failure the person can act on, as a ConvexError; anything else is a bug and stays one. */
async function asMergeError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof MergeError) throw new ConvexError(cause.message);
    throw cause;
  }
}

/** A merge as its transaction writes it: the parties as the register named them, the picks, and what moves. */
export const mergeWriteArgs = v.object({
  orgId: v.id("organizations"), userId: v.id("users"), object, mergeId: v.string(),
  survivor: party, losers: v.array(party), picks: v.record(v.string(), v.string()),
  seeds: v.array(v.object({ contactId: v.string(), accountId: v.string() })), activityIds: v.array(v.string()),
});
export type MergeWrite = Infer<typeof mergeWriteArgs>;

/** Write a merge in one transaction and keep its undo. */
export const apply = internalMutation({
  args: mergeWriteArgs.fields,
  returns: v.null(),
  handler: (ctx, a) => writeMerge(ctx, a),
});

/** A merge in the caller's transaction, so another write can commit with it (an approved account hierarchy merge). */
export async function writeMerge(ctx: MutationCtx, a: MergeWrite): Promise<null> {
  return asMergeError(async () => {
    const now = Date.now();
    if (await mergeOf(ctx, a.orgId, a.mergeId)) throw new MergeError("This merge was already made");
    const seed = (entityId: string) => identitySeed(ctx, entityId as Id<"canonEntities">);
    const withSeed = (p: typeof a.survivor) => ({ ...p, identitySeed: seed });
    const undo = await mergeParties(mergeStores(ctx), {
      orgId: a.orgId, object: a.object, userId: a.userId, now, mergeId: a.mergeId,
      survivor: withSeed(a.survivor), losers: a.losers.map(withSeed), picks: a.picks, seeds: a.seeds, activityIds: a.activityIds,
    });
    await ctx.db.insert("recordMerges", {
      orgId: a.orgId, mergeId: a.mergeId, object: a.object, survivorStream: undo.survivor.streamId as Id<"canonEntities">, survivorId: a.survivor.recordId,
      losers: undo.losers.map((l) => ({ stream: l.streamId as Id<"canonEntities">, recordId: l.recordId, title: l.title })),
      undo: JSON.stringify(undo), mergedBy: a.userId, mergedAt: now,
    });
    return null;
  });
}

async function mergeOf(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, mergeId: string): Promise<Doc<"recordMerges"> | null> {
  return ctx.db.query("recordMerges").withIndex("by_orgId_and_mergeId", (q) => q.eq("orgId", orgId).eq("mergeId", mergeId)).unique();
}

export const survivorOf = internalQuery({
  args: { orgId: v.id("organizations"), mergeId: v.string() },
  handler: async (ctx, a) => {
    const merge = await mergeOf(ctx, a.orgId, a.mergeId);
    return merge ? { object: merge.object, survivorId: merge.survivorId } : null;
  },
});

/** Undo a merge in one transaction. Returns the fields that kept a change made after the merge. */
export const revert = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), mergeId: v.string() },
  returns: v.object({ kept: v.array(v.string()), object }),
  handler: async (ctx, a) => asMergeError(async () => {
    const merge = await mergeOf(ctx, a.orgId, a.mergeId);
    if (!merge) throw new MergeError("Merge not found");
    if (merge.undoneAt) throw new MergeError("This merge was already undone");
    const undo = JSON.parse(merge.undo) as MergeUndo;
    const { kept } = await unmergeParties(mergeStores(ctx), { orgId: a.orgId, userId: a.userId, now: Date.now(), mergeId: a.mergeId, undo });
    await ctx.db.patch(merge._id, { undoneAt: Date.now(), undoneBy: a.userId });
    return { kept, object: merge.object };
  }),
});

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds cleanup.run. */
const mayMerge = (who: { role: string; capabilities?: readonly string[] }) => can(who, "cleanup.run");

/** Wait until the record service has projected the org's ledger, so the next read shows the change. */
async function settle(ctx: ActionCtx, client: RecordClient, orgId: string) {
  if (client.mode !== "http") return;
  const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId: orgId as Id<"organizations"> });
  await client.nudgeProjector(orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
}

/** The live register rows `ids` name, in that order; a deleted, merged or unknown one is an error. */
async function liveRows(client: RecordClient, orgId: string, obj: PartyObject, ids: readonly string[]): Promise<RegisterListRow[]> {
  const page = await client.listRegister(orgId, obj, { filter: [{ field: "id", op: "in", value: [...ids] }], limit: ids.length });
  const byId = new Map(page.rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new ConvexError(`${obj === "account" ? "Company" : "Person"} ${id} is not in the list; reload and try again`);
    return row;
  });
}

const checkIds = (ids: readonly string[]) => {
  if (ids.length < 2 || ids.length > MERGE_RECORDS_MAX) throw new ConvexError(`Pick 2 to ${MERGE_RECORDS_MAX} records to merge`);
  if (new Set(ids).size !== ids.length) throw new ConvexError("Pick each record once");
};

/** Each stream's values with their sources and times, as the merge dialog shows them. */
export const streamCells = internalQuery({
  args: { orgId: v.id("organizations"), object, streams: v.array(v.string()) },
  handler: async (ctx, a): Promise<Record<string, Record<string, MergeCell>>> => {
    const ext = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", a.orgId).eq("apiName", a.object)).unique();
    const def = resolveObjectDef(STANDARD_OBJECTS[a.object], ext ? fromStored<OrgObjectExtension>(ext) : undefined);
    const out: Record<string, Record<string, MergeCell>> = {};
    for (const stream of a.streams) {
      const id = ctx.db.normalizeId("canonEntities", stream);
      const entity = id ? await ctx.db.get(id) : null;
      if (!entity || entity.orgId !== a.orgId) continue;
      const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", a.orgId).eq("streamId", entity._id)).unique();
      const state = hot ? asState(hot) : foldAll((await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id)).take(WRITE_FOLD_CAP))
        .map((e) => ({ streamId: e.streamId, version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: fromStored<LedgerEntry["body"]>(e.body) })));
      if (!state) continue;
      const row = project(def, state);
      const cells: Record<string, MergeCell> = {};
      for (const f of def.fields) {
        if (f.system || f.type === "formula") continue;
        const meta = row.meta[f.fieldId];
        const fact = meta?.factId ? state.fields[f.fieldId]?.candidates.find((c) => c.factId === meta.factId) : undefined;
        cells[f.apiName] = { value: row.values[f.fieldId] ?? null, sourceKind: meta?.sourceKind ?? null, at: fact ? fact.validFrom ?? fact.observedAt : null };
      }
      out[stream] = cells;
    }
    return out;
  },
});

export type MergePreview = {
  object: PartyObject;
  /** The fields a merge picks values for, and the unique ones (a domain or email) that stay the survivor's. */
  fields: Array<{ apiName: string; label: string; fixed: boolean }>;
  records: Array<{ id: string; title: string; cells: Record<string, MergeCell> }>;
  /** Field -> the record whose value it keeps unless the person picks another. */
  picks: Record<string, string>;
};

/** The records side by side, each value with its source and when it became true, and the default pick per field. */
export const preview = action({
  args: { object, ids: v.array(v.string()) },
  handler: async (ctx, a): Promise<MergePreview> => {
    checkIds(a.ids);
    const caller = await requireCaller(ctx, { read: true });
    if (!mayMerge(caller)) throw new ConvexError("Only admins and managers can merge records");
    // A merge shows and picks every field of every record: not for a role with a hidden or read-only one (CP14).
    if (lockedFields(caller.access, a.object).length) throw new ConvexError("Merging needs every field visible and editable for your role; ask an admin");
    // The records as the caller sees them (CP14): one they cannot see is not in the list.
    const client = callerClient(ctx, caller);
    const rows = await liveRows(client, caller.orgId, a.object, a.ids);
    const streamed = await ctx.runQuery(internal.recordMerges.streamCells, {
      orgId: caller.orgId as Id<"organizations">, object: a.object, streams: rows.flatMap((r) => (r.stream ? [r.stream] : [])),
    });
    const def = resolveObjectDef(STANDARD_OBJECTS[a.object]);
    const listed = def.fields.filter((f) => !f.system && f.type !== "formula");
    const records = rows.map((r) => ({
      id: r.id, title: r.title || r.id,
      // A row nobody has worked has no stream: its values are the register's, as an import from the row.
      cells: (r.stream && streamed[r.stream]) || Object.fromEntries(listed.map((f) => [f.apiName, {
        value: (r.values[f.apiName] ?? null) as MergeCell["value"], sourceKind: r.values[f.apiName] == null ? null : "import", at: r.updatedAt,
      }])),
    }));
    const pickable = mergeableFields(def).map((f) => f.apiName);
    return {
      object: a.object,
      fields: listed.map((f) => ({ apiName: f.apiName, label: f.label, fixed: !pickable.includes(f.apiName) })),
      records,
      picks: defaultPicks(pickable, records),
    };
  },
});

/** The row a promotion starts its stream from, for a row nobody has worked yet. */
async function partyOf(client: RecordClient, orgId: string, obj: PartyObject, row: RegisterListRow) {
  if (row.stream) return { recordId: row.id, streamId: row.stream };
  const full = obj === "account" ? (await client.get(orgId, row.id))?.account ?? null : await client.getContact(orgId, row.id);
  if (!full) throw new ConvexError(`${row.id} is not in the list; reload and try again`);
  return { recordId: row.id, snapshot: obj === "account" ? recordSnapshotOf(full as AccountRow) : contactSnapshotOf(full as ContactRow) };
}

/**
 * Merge `loserIds` into `survivorId`. `picks` names, per field, the record whose value survives; a field
 * not named keeps the survivor's. Returns the merge's id, which its undo names.
 */
export const merge = action({
  args: { object, survivorId: v.string(), loserIds: v.array(v.string()), picks: v.record(v.string(), v.string()) },
  handler: async (ctx, a): Promise<{ mergeId: string; survivorId: string }> => mergeAs(ctx, await requireCaller(ctx), a),
});

/**
 * A merge as `caller`, with their role's checks and their sight of every record (CP14). `write` commits it:
 * by default its own transaction (`apply`); an approved account hierarchy merge commits its decision with it.
 */
export async function mergeAs(
  ctx: ActionCtx, caller: ActionCaller, a: { object: PartyObject; survivorId: string; loserIds: readonly string[]; picks: Record<string, string> },
  write: (merge: MergeWrite) => Promise<unknown> = (merge) => ctx.runMutation(internal.recordMerges.apply, merge),
): Promise<{ mergeId: string; survivorId: string }> {
  const ids = [a.survivorId, ...a.loserIds];
  checkIds(ids);
  if (!mayMerge(caller)) throw new ConvexError("Only admins and managers can merge records");
  // A merge shows and picks every field of every record: not for a role with a hidden or read-only one (CP14).
  if (lockedFields(caller.access, a.object).length) throw new ConvexError("Merging needs every field visible and editable for your role; ask an admin");
  // A merge edits the survivor and deletes the others: the caller's role does both and sees every one (CP14).
  if (!may(caller.access, a.object, "edit") || !may(caller.access, a.object, "delete")) throw new ConvexError("Your role cannot merge these records");
  const client = callerClient(ctx, caller);
  const rows = await liveRows(client, caller.orgId, a.object, ids);
  // The caller's client chose the rows; a stream starts from the whole row (lib/recordPromotion.ts).
  const parties = await Promise.all(rows.map((r) => partyOf(clientFor(ctx), caller.orgId, a.object, r)));
  // The people whose company nobody has worked yet: their register company becomes their first edge.
  const seeds = a.object === "account"
    ? (await Promise.all(a.loserIds.map((id) => client.listContacts(caller.orgId, { filter: { accountId: id }, limit: PEOPLE_PER_COMPANY }))))
      .flatMap((page) => page.rows.map((c) => ({ contactId: c.id, accountId: c.accountId })))
    : rows.flatMap((r) => (r.accountId ? [{ contactId: r.id, accountId: r.accountId }] : []));
  const lookups = await linkedActivities(client, caller.orgId, { field: a.object === "account" ? "accountId" : "contactId", id: a.loserIds });
  const mergeId = crypto.randomUUID();
  await write({
    orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, object: a.object, mergeId,
    survivor: parties[0], losers: parties.slice(1), picks: a.picks, seeds: seeds.filter((s) => s.accountId), activityIds: lookups.activities.map((x) => x.id),
  });
  await settle(ctx, client, caller.orgId);
  return { mergeId, survivorId: a.survivorId };
}

/** Undo a merge from its history entry: the merged records, their edges and the survivor's values come back. */
export const undo = action({
  args: { mergeId: v.string() },
  handler: async (ctx, a): Promise<{ kept: string[] }> => undoAs(ctx, await requireCaller(ctx), a.mergeId),
});

/** Undo a merge as `caller`: an admin or manager who sees its survivor. */
export async function undoAs(ctx: ActionCtx, caller: ActionCaller, mergeId: string): Promise<{ kept: string[] }> {
  if (!mayMerge(caller)) throw new ConvexError("Only admins and managers can undo a merge");
  if (caller.access.preview) throw new ConvexError(`You are viewing as ${caller.access.preview.asName}: changes are off until you exit the preview`);
  // Undo restores the losers: only a merge whose survivor the caller sees (CP14).
  const merge = await ctx.runQuery(internal.recordMerges.survivorOf, { orgId: caller.orgId as Id<"organizations">, mergeId });
  if (!merge || !(await visibleIds(callerClient(ctx, caller), caller.orgId, merge.object, [merge.survivorId])).has(merge.survivorId)) throw new ConvexError("Merge not found");
  const out = await ctx.runMutation(internal.recordMerges.revert, { orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, mergeId });
  await settle(ctx, clientFor(ctx), caller.orgId);
  return { kept: out.kept };
}

/** A merge as its history entry shows it: who merged what, and whether it was undone. */
export const get = query({
  args: { mergeId: v.string() },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    const merge = user ? await mergeOf(ctx, user.orgId, a.mergeId) : null;
    if (!user || !merge) return null;
    // A merge names its losers: only for a caller whose role sees the survivor without an action (CP14). Unused by the
    // app; a role that sees only some companies or people reads it as missing.
    if (!sightJudge(ctx, [await accessFor(ctx, user)]).record(merge.object, merge.survivorId)) return null;
    return {
      object: merge.object, survivorId: merge.survivorId, losers: merge.losers.map((l) => ({ recordId: l.recordId, title: l.title })),
      mergedAt: merge.mergedAt, undoneAt: merge.undoneAt ?? null, mayUndo: mayMerge(user),
    };
  },
});
