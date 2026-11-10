/**
 * Turning a custom field unique, or back (Recipes, Data model). Turning it on
 * marks the field `uniqueClaiming`: from then on every write is held to the
 * field's claims (lib/objects/write.ts claimsUnique), and this job checks every
 * record, active and archived, for a value another one holds, then claims the
 * existing values in batches. The field becomes `unique` only when every value
 * is claimed. Two records with one value stop it: the field goes back to not
 * unique, its claims are released, and the job lists the values. Companies and
 * people nobody has worked yet are checked but hold no claims (they are not on
 * the ledger); a later write to one is checked then. Turning it off releases
 * the claims.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { canSeeRecord, hasOwnerField, type Access } from "./lib/access";
import { scheduleNudge } from "./ledgerFeed";
import { isRegisterObject, LIST_LIMIT_MAX, type ListRequest, type ListRow, type RegisterListRow } from "./lib/objects/listSpec";
import { loadOrgObject } from "./lib/objects/orgDefs";
import { claimsUnique, indexObjectDef, plainObjectDef, type FieldId, type ObjectDef } from "./lib/objects/registry";
import { toStored } from "./lib/objects/validators";
import { claimFieldValues, uniqueClaimKeys, uniqueClaimProvider } from "./lib/objects/write";
import { convexObjectStore } from "./objects";
import { accessFor } from "./permissions";
import { clientFor } from "./records";

/** Records claimed per transaction: each may fold its stream. */
const CLAIM_BATCH = 50;
/** Claims released per transaction. */
const RELEASE_BATCH = 500;
/** How long the job waits for the list projection to reach the ledger as it stood when the job started. */
const CATCH_UP_TRIES = 120;
const CATCH_UP_WAIT_MS = 1000;
/** Duplicate values a refusal lists, and records named per value. */
const REPORT_VALUES = 10;
const REPORT_HOLDERS = 3;

const target = { orgId: v.id("organizations"), object: v.string(), fieldId: v.string() };

/** The object's definition and the field's unique state, for the job. */
export const fieldState = internalQuery({
  args: target,
  handler: async (ctx, a): Promise<{ def: ObjectDef; label: string; unique: boolean; claimingSince: number | null } | null> => {
    const def = await loadOrgObject(ctx, a.orgId, a.object);
    const field = def?.byFieldId.get(a.fieldId as FieldId);
    if (!def || !field) return null;
    return { def: toStored(plainObjectDef(def)) as unknown as ObjectDef, label: field.label, unique: field.unique === true, claimingSince: field.uniqueClaiming ?? null };
  },
});

/** What the admin who turned it on sees, so a refusal names only their records. */
export const accessOf = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, a): Promise<Access | null> => {
    const user = await ctx.db.get(a.userId);
    return user ? accessFor(ctx, user) : null;
  },
});

/** Claim the current values of these records, by stream. `stale`: the field is no longer being claimed from `claimingSince`. */
export const claimBatch = internalMutation({
  args: { ...target, claimingSince: v.number(), ids: v.array(v.string()) },
  handler: async (ctx, a): Promise<{ stale: boolean; taken: string[] }> => {
    const def = await loadOrgObject(ctx, a.orgId, a.object);
    const field = def?.byFieldId.get(a.fieldId as FieldId);
    if (!def || field?.uniqueClaiming !== a.claimingSince) return { stale: true, taken: [] };
    const store = convexObjectStore(ctx);
    const taken: string[] = [];
    for (const id of a.ids) {
      const stream = ctx.db.normalizeId("canonEntities", id);
      if (!stream) continue;
      for (const t of await claimFieldValues(store, { orgId: a.orgId, def }, stream, a.fieldId as FieldId)) taken.push(String(t.value));
    }
    return { stale: false, taken };
  },
});

/** End a claim run: the field becomes unique (`ok`) or not unique. False when it was changed meanwhile. */
export const finish = internalMutation({
  args: { ...target, claimingSince: v.number(), ok: v.boolean() },
  handler: async (ctx, a): Promise<boolean> => {
    const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", a.orgId).eq("apiName", a.object)).unique();
    const field = row?.customFields.find((f) => f.fieldId === a.fieldId);
    if (!row || field?.uniqueClaiming !== a.claimingSince) return false;
    const customFields = row.customFields.map((f) => {
      if (f.fieldId !== a.fieldId) return f;
      const { uniqueClaiming: _, unique: __, ...rest } = f;
      return a.ok ? { ...rest, unique: true } : rest;
    });
    await ctx.db.patch(row._id, { customFields, updatedAt: Date.now() });
    await scheduleNudge(ctx, a.orgId);
    return true;
  },
});

/** Release up to RELEASE_BATCH of a field's claims, unless it holds them again (turned back on meanwhile). */
export const releaseBatch = internalMutation({
  args: target,
  handler: async (ctx, a): Promise<{ released: number; done: boolean }> => {
    const def = await loadOrgObject(ctx, a.orgId, a.object);
    const field = def?.byFieldId.get(a.fieldId as FieldId);
    if (!def || !field || claimsUnique(field)) return { released: 0, done: true };
    const provider = uniqueClaimProvider(def, a.fieldId);
    const rows = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", a.orgId).eq("provider", provider)).take(RELEASE_BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
    return { released: rows.length, done: rows.length < RELEASE_BATCH };
  },
});

type Seen = { ids: Set<string>; rows: ListRow[] };

/** Duplicate values as a refusal lists them: records the admin sees by name, the rest as a count. */
export function duplicateReport(dups: ReadonlyArray<{ value: string; rows: readonly ListRow[] }>, sees: (row: ListRow) => boolean): string {
  const lines = dups.slice(0, REPORT_VALUES).map(({ value, rows }) => {
    const named = rows.filter(sees).slice(0, REPORT_HOLDERS).map((r) => r.title || "Untitled");
    const others = rows.length - named.length;
    return `"${value}": ${[...named, ...(others ? [`${others} ${named.length ? "more" : others === 1 ? "record you cannot see" : "records you cannot see"}`] : [])].join(", ")}`;
  });
  const more = dups.length > REPORT_VALUES ? `; and ${dups.length - REPORT_VALUES} more values` : "";
  return `${dups.length} ${dups.length === 1 ? "value is" : "values are"} on more than one record: ${lines.join("; ")}${more}`;
}

export const run = internalAction({
  args: { ...target, userId: v.id("users"), jobId: v.id("backgroundJobs"), claimingSince: v.optional(v.number()) },
  handler: async (ctx, a): Promise<null> => {
    const job = (patch: { detail?: string; status?: "completed" | "failed"; error?: string; phases?: Array<{ key: string; label: string; status: "pending" | "processing" | "completed" | "failed"; done?: number; total?: number }> }) =>
      ctx.runMutation(internal.backgroundJobs.update, { jobId: a.jobId, ...patch });
    const release = async () => {
      for (let released = 0; ;) {
        const r = await ctx.runMutation(internal.uniqueFields.releaseBatch, { orgId: a.orgId, object: a.object, fieldId: a.fieldId });
        released += r.released;
        if (r.done) return released;
      }
    };
    if (a.claimingSince === undefined) {
      const released = await release();
      await job({ status: "completed", detail: `Released ${released.toLocaleString("en-US")} claimed values`, phases: [{ key: "release", label: "Release values", status: "completed", done: released, total: released }] });
      return null;
    }
    const claimingSince = a.claimingSince;
    const fail = async (error: string) => {
      await ctx.runMutation(internal.uniqueFields.finish, { orgId: a.orgId, object: a.object, fieldId: a.fieldId, claimingSince, ok: false });
      await release();
      await job({ status: "failed", error, detail: "Not made unique" });
    };
    try {
      const state = await ctx.runQuery(internal.uniqueFields.fieldState, { orgId: a.orgId, object: a.object, fieldId: a.fieldId });
      if (!state || state.claimingSince !== claimingSince) return null;
      const def = indexObjectDef(state.def);
      const client = clientFor(ctx);
      const register = isRegisterObject(a.object);
      const list = (req: ListRequest) => (register ? client.listRegister(a.orgId, a.object as "account" | "contact", req) : client.listObjects(a.orgId, a.object, req));
      // The scan reads the list projection, which trails the ledger. It starts once the projection has every entry
      // written before the field began claiming; a write since then was already held to the claims by the writer.
      const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId: a.orgId });
      const caughtUp = (through: Readonly<Record<string, number>>) => Object.entries(heads).every(([shard, seq]) => (through[shard] ?? 0) >= seq);
      for (let tries = 0; !caughtUp((await list({ limit: 1 })).projectedThrough); tries++) {
        if (tries >= CATCH_UP_TRIES) throw new Error("the record index is still catching up with recent changes; turn it on again in a minute");
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_WAIT_MS));
      }
      // Every record, archived ones too: an archived record keeps its claims, so restoring it cannot collide.
      const byKey = new Map<string, Seen & { value: string }>();
      const holders: string[] = [];
      let read = 0;
      for (const deleted of [false, true]) {
        let cursor: string | undefined;
        do {
          const req = { limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}), ...(deleted ? { deleted } : {}) };
          const page = await list(req);
          for (const row of page.rows) {
            const keys = uniqueClaimKeys(def, a.fieldId, row.values[a.fieldId] ?? null);
            // A company or person nobody has worked has no stream: it is checked here and holds no claim.
            const stream = register ? (row as RegisterListRow).stream : row.id;
            if (keys.length && stream) holders.push(stream);
            for (const { key, value } of keys) {
              const seen = byKey.get(key) ?? { value: String(value), ids: new Set<string>(), rows: [] };
              byKey.set(key, seen);
              if (!seen.ids.has(row.id)) seen.rows.push(row);
              seen.ids.add(row.id);
            }
          }
          read += page.rows.length;
          cursor = page.nextCursor ?? undefined;
          await job({ detail: `Checked ${read.toLocaleString("en-US")} records`, phases: [{ key: "check", label: "Check for duplicates", status: "processing", done: read }, { key: "claim", label: "Claim values", status: "pending" }] });
        } while (cursor);
      }
      const dups = [...byKey.values()].filter((s) => s.ids.size > 1).map((s) => ({ value: s.value, rows: s.rows }));
      if (dups.length) {
        const access = await ctx.runQuery(internal.uniqueFields.accessOf, { userId: a.userId });
        const owner = hasOwnerField(a.object);
        await fail(`${state.label} was not made unique. ${duplicateReport(dups, (row) => access !== null && canSeeRecord(access, a.object, owner, row.values.ownerId ?? null))}`);
        return null;
      }
      const ids = [...new Set(holders)];
      const taken: string[] = [];
      for (let i = 0; i < ids.length; i += CLAIM_BATCH) {
        const r = await ctx.runMutation(internal.uniqueFields.claimBatch, { orgId: a.orgId, object: a.object, fieldId: a.fieldId, claimingSince, ids: ids.slice(i, i + CLAIM_BATCH) });
        if (r.stale) return null;
        taken.push(...r.taken);
        await job({ detail: `Claimed ${Math.min(ids.length, i + CLAIM_BATCH).toLocaleString("en-US")} of ${ids.length.toLocaleString("en-US")} values`, phases: [{ key: "check", label: "Check for duplicates", status: "completed", done: read, total: read }, { key: "claim", label: "Claim values", status: "processing", done: Math.min(ids.length, i + CLAIM_BATCH), total: ids.length }] });
      }
      // A value written while the check ran, onto a record the check had not reached, collides here.
      if (taken.length) {
        await fail(`${state.label} was not made unique. ${taken.length} ${taken.length === 1 ? "value was" : "values were"} given to a second record while the check ran: ${[...new Set(taken)].slice(0, REPORT_VALUES).map((t) => `"${t}"`).join(", ")}`);
        return null;
      }
      if (!(await ctx.runMutation(internal.uniqueFields.finish, { orgId: a.orgId, object: a.object, fieldId: a.fieldId, claimingSince, ok: true }))) return null;
      await job({ status: "completed", detail: `${state.label} is unique: ${ids.length.toLocaleString("en-US")} values claimed`, phases: [{ key: "check", label: "Check for duplicates", status: "completed", done: read, total: read }, { key: "claim", label: "Claim values", status: "completed", done: ids.length, total: ids.length }] });
    } catch (cause) {
      await fail(`Checking for duplicates failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return null;
  },
});
