/**
 * The workspace's CRM disagreements (lib/canon/personHold.ts): what Salesforce and HubSpot say about deal, company and
 * person fields a person holds in Canon, by record type, field and CRM, for an admin who changes the write gate. Using a CRM's values writes them
 * as that CRM record's, so each field follows the CRM again (fieldClaims.takeCrmValue), for a selection or a whole
 * filtered set; a whole set runs as a job, a page per transaction, and reports its progress. An admin may also set a
 * field to always follow a CRM (crmFieldFollows), so a person's value never holds against it.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { hiddenFields, type Access } from "./lib/access";
import { accessFor } from "./permissions";
import { asFieldClaim } from "./lib/fieldClaimStore";
import { claimObject, claimValues, groupFields, groupOf, heldField, standing, type HeldObject } from "./lib/canon/personHold";
import { claimRecord, shownValues, takeCrmValue } from "./fieldClaims";
import { followObject } from "./canon";
import * as objectValidators from "./lib/objects/validators";

const CAP = "writeGate.edit" as const;
/** Rows a page shows: each reads its record. */
const PAGE_MAX = 50;
/** Disagreements one job step takes, each a deal write. */
const JOB_STEP = 20;
/** A selection taken at once, in one transaction. */
export const SELECTION_MAX = 50;

const provider = v.union(v.literal("salesforce"), v.literal("hubspot"));
const heldObject = v.union(v.literal("deal"), v.literal("account"), v.literal("contact"));
/** `field` names a field of `object`; without an object it matches that field on every object. */
const filter = { provider: v.optional(provider), object: v.optional(heldObject), field: v.optional(v.string()) };
type Filter = { provider?: "salesforce" | "hubspot"; object?: HeldObject; field?: string };

/** The workspace's field disagreements under a filter, by CRM, object and field when named. A deal's row carries no object. */
function disagreements(ctx: QueryCtx, orgId: Id<"organizations">, f: Filter) {
  const all = ctx.db.query("parentDisagreements");
  if (f.object) {
    const object = f.object === "deal" ? undefined : f.object;
    if (f.provider) {
      const crm = f.provider;
      return all.withIndex("by_orgId_and_association_and_object_and_provider_and_attribute", (i) => {
        const byCrm = i.eq("orgId", orgId).eq("association", "field").eq("object", object).eq("provider", crm);
        return f.field ? byCrm.eq("attribute", f.field) : byCrm;
      });
    }
    return all.withIndex("by_orgId_and_association_and_object_and_attribute", (i) => {
      const byObject = i.eq("orgId", orgId).eq("association", "field").eq("object", object);
      return f.field ? byObject.eq("attribute", f.field) : byObject;
    });
  }
  if (f.provider) {
    const crm = f.provider;
    return all.withIndex("by_orgId_and_association_and_provider_and_attribute", (i) => {
      const byCrm = i.eq("orgId", orgId).eq("association", "field").eq("provider", crm);
      return f.field ? byCrm.eq("attribute", f.field) : byCrm;
    });
  }
  return all.withIndex("by_orgId_and_association_and_attribute", (i) => {
    const byField = i.eq("orgId", orgId).eq("association", "field");
    return f.field ? byField.eq("attribute", f.field) : byField;
  });
}

const rowView = v.union(
  v.object({
    id: v.string(),
    provider,
    object: heldObject,
    field: v.string(),
    streamId: v.string(),
    /** The id the record's page goes by: a deal's stream, a company's or person's register id; null when Canon does not know it. */
    pageId: v.union(v.string(), v.null()),
    title: v.string(),
    /** What the CRM says and what Canon holds, for each field of the claim the caller may read. */
    values: v.array(v.object({ field: v.string(), crm: objectValidators.factValue, canon: objectValidators.factValue })),
    /** An amount's currency on each side, to format it: kept when the two agree on it, so `values` leaves it out. */
    currency: v.optional(v.object({ crm: objectValidators.factValue, canon: objectValidators.factValue })),
    seenAt: v.number(),
  }),
  /** A record the caller may not see: counted, never named. */
  v.object({ id: v.string(), provider, object: heldObject, field: v.string(), hidden: v.literal(true) }),
);

/** One page of the workspace's standing disagreements: those a person still holds and the CRM still differs from. */
export const list = query({
  args: { ...filter, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, CAP)) return { page: [], isDone: true, continueCursor: "" };
    const access = await accessFor(ctx, user);
    const result = await disagreements(ctx, user.orgId, args).paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, PAGE_MAX) });
    const page: Array<Infer<typeof rowView>> = [];
    for (const d of result.page) {
      const claim = asFieldClaim(d);
      const object = claim && claimObject(claim);
      if (!claim || !object || hiddenFields(access, object).includes(claim.field)) continue;
      const hidden = hiddenFields(access, object);
      const streamId = ctx.db.normalizeId("canonEntities", claim.recordId);
      const record = streamId ? await claimRecord(ctx, user.orgId, access, streamId) : null;
      if (!streamId || !record || record.object !== object || !standing(record.state, claim, object)) continue;
      if (!record.visible) {
        page.push({ id: claim.id, provider: claim.provider, object, field: claim.field, hidden: true });
        continue;
      }
      // A group reads as its lead field and the fields that differ, as the record page's note does.
      const values = shownValues(record.state, claim, hidden).map(({ field, value }) => ({ field, crm: value, canon: (record.values[field] ?? null) as Infer<typeof objectValidators.factValue> }));
      const canonCurrency = (record.values.currency ?? null) as Infer<typeof objectValidators.factValue>;
      const currency = groupFields(object, claim.field).includes("currency") && !hidden.includes("currency")
        ? { crm: (claimValues(claim).currency ?? canonCurrency) as Infer<typeof objectValidators.factValue>, canon: canonCurrency }
        : null;
      page.push({ id: claim.id, provider: claim.provider, object, field: claim.field, streamId, pageId: record.pageId, title: record.title, values, ...(currency ? { currency } : {}), seenAt: claim.seenAt });
    }
    return { ...result, page };
  },
});

async function requireAdmin(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!can(user, CAP)) throw new ConvexError(refusal(CAP));
  return user;
}

/**
 * Take what a disagreement's CRM says, as `user`; false when it no longer stands, and its row is let go. A deal the
 * caller can't see is refused, as the list leaves it unnamed.
 */
async function takeIfStanding(ctx: MutationCtx, user: Doc<"users">, access: Access, d: Doc<"parentDisagreements">): Promise<boolean> {
  const claim = asFieldClaim(d);
  const streamId = claim ? ctx.db.normalizeId("canonEntities", claim.recordId) : null;
  const record = claim && streamId ? await claimRecord(ctx, user.orgId, access, streamId) : null;
  if (!claim || !record || record.object !== claimObject(claim) || !standing(record.state, claim, record.object)) {
    await ctx.db.delete(d._id);
    return false;
  }
  if (!record.visible) throw new ConvexError("Record not found");
  await takeCrmValue(ctx, user, d._id);
  return true;
}

/** Use the CRM's values for the selected disagreements. Each is taken or refused on its own; the refusals are named. */
export const useCrmValues = mutation({
  args: { ids: v.array(v.string()) },
  returns: v.object({ taken: v.number(), failed: v.array(v.object({ id: v.string(), message: v.string() })) }),
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const access = await accessFor(ctx, user);
    if (args.ids.length > SELECTION_MAX) throw new ConvexError(`Use at most ${SELECTION_MAX} at a time, or use the whole filter`);
    let taken = 0;
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of new Set(args.ids)) {
      const rowId = ctx.db.normalizeId("parentDisagreements", id);
      const row = rowId ? await ctx.db.get(rowId) : null;
      if (!row || row.orgId !== user.orgId || row.association !== "field") continue;
      try {
        if (await takeIfStanding(ctx, user, access, row)) taken++;
      } catch (e) {
        failed.push({ id, message: e instanceof ConvexError ? String(e.data) : "Could not use this value" });
      }
    }
    return { taken, failed };
  },
});

const jobView = v.union(v.null(), v.object({
  id: v.id("crmDisagreementJobs"),
  status: v.union(v.literal("running"), v.literal("done"), v.literal("cancelled"), v.literal("failed")),
  provider: v.optional(provider),
  object: v.optional(heldObject),
  field: v.optional(v.string()),
  taken: v.number(),
  failed: v.number(),
  lastError: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
}));

/** Whether the caller manages CRM disagreements, and the workspace's latest "use the CRM's values" job, for its progress. */
export const status = query({
  args: {},
  returns: v.object({ canManage: v.boolean(), job: jobView }),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, CAP)) return { canManage: false, job: null };
    const j = await ctx.db.query("crmDisagreementJobs").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").first();
    if (!j) return { canManage: true, job: null };
    return {
      canManage: true,
      job: {
        id: j._id, status: j.status, ...(j.provider ? { provider: j.provider } : {}), ...(j.object ? { object: j.object } : {}), ...(j.field ? { field: j.field } : {}), taken: j.taken, failed: j.failed,
        ...(j.lastError ? { lastError: j.lastError } : {}), startedAt: j.startedAt, ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
      },
    };
  },
});

/** Use the CRM's values for every standing disagreement under a filter, as a job; one runs per workspace at a time. */
export const startUseAll = mutation({
  args: filter,
  returns: v.id("crmDisagreementJobs"),
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const last = await ctx.db.query("crmDisagreementJobs").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").first();
    if (last?.status === "running") throw new ConvexError("Canon is already using a CRM's values here. Wait for it, or stop it.");
    const id = await ctx.db.insert("crmDisagreementJobs", {
      orgId: user.orgId, createdBy: user._id, ...(args.provider ? { provider: args.provider } : {}), ...(args.object ? { object: args.object } : {}), ...(args.field ? { field: args.field } : {}),
      status: "running", cursor: null, taken: 0, failed: 0, startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.crmDisagreements.runJob, { jobId: id });
    return id;
  },
});

export const cancelJob = mutation({
  args: { jobId: v.id("crmDisagreementJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const j = await ctx.db.get(args.jobId);
    if (j && j.orgId === user.orgId && j.status === "running") await ctx.db.patch(j._id, { status: "cancelled", finishedAt: Date.now() });
    return null;
  },
});

/**
 * One step of a job: the next disagreements under its filter, each taken as the admin who started it (who must still
 * be able to), then the next step. A disagreement refused (a record they may not edit) is counted and left.
 */
export const runJob = internalMutation({
  args: { jobId: v.id("crmDisagreementJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const j = await ctx.db.get(args.jobId);
    if (!j || j.status !== "running") return null;
    const user = await ctx.db.get(j.createdBy);
    if (!user || user.orgId !== j.orgId || user.isActive === false || !can(user, CAP)) {
      await ctx.db.patch(j._id, { status: "failed", lastError: "The admin who started this can no longer change the write gate", finishedAt: Date.now() });
      return null;
    }
    const filterOf: Filter = { ...(j.provider ? { provider: j.provider } : {}), ...(j.object ? { object: j.object } : {}), ...(j.field ? { field: j.field } : {}) };
    const access = await accessFor(ctx, user);
    const page = await disagreements(ctx, j.orgId, filterOf).paginate({ cursor: j.cursor, numItems: JOB_STEP });
    let { taken, failed } = j;
    let lastError = j.lastError;
    for (const d of page.page) {
      try {
        if (await takeIfStanding(ctx, user, access, d)) taken++;
      } catch (e) {
        failed++;
        lastError = e instanceof ConvexError ? String(e.data) : "Could not use a value";
      }
    }
    const done = page.isDone;
    await ctx.db.patch(j._id, { cursor: page.continueCursor, taken, failed, ...(lastError ? { lastError } : {}), ...(done ? { status: "done" as const, finishedAt: Date.now() } : {}) });
    if (!done) await ctx.scheduler.runAfter(0, internal.crmDisagreements.runJob, { jobId: j._id });
    return null;
  },
});


/**
 * Deal, company and person fields that always follow a CRM (crmFieldFollows): for such a field a CRM's write always
 * lands and a person's edit lasts until its next one. Every member reads them, so a record page can say an edit is temporary.
 */
export const follows = query({
  args: {},
  returns: v.array(v.object({ object: heldObject, field: v.string(), provider })),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("crmFieldFollows").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200);
    return rows.map((r) => ({ object: followObject(r), field: r.attribute, provider: r.provider }));
  },
});

/** Make a field (a group by its lead field) of a deal, company or person always follow a CRM, or hold a person's value against it again. Admins, as the write gate. */
export const setFollow = mutation({
  args: { provider, object: v.optional(heldObject), field: v.string(), follow: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const object: HeldObject = args.object ?? "deal";
    if (!heldField(object, args.field) || groupOf(object, args.field) !== args.field) throw new ConvexError("Canon holds no such field against a CRM");
    const rows = await ctx.db.query("crmFieldFollows").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200);
    const existing = rows.find((r) => r.provider === args.provider && followObject(r) === object && r.attribute === args.field);
    if (!args.follow) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (!existing) {
      await ctx.db.insert("crmFieldFollows", {
        orgId: user.orgId, provider: args.provider, attribute: args.field, ...(object !== "deal" ? { object } : {}), updatedBy: user._id, updatedAt: Date.now(),
      });
    }
    return null;
  },
});
