/**
 * What a CRM says about a deal's, company's or person's field a person holds (lib/canon/personHold.ts): read on the
 * record's page, and the one way to take it. Taking it writes the CRM's value as the CRM record's, by the person, so
 * the field follows the CRM again and later imports and syncs change it. Fields that move together (a stage and its
 * outcome, an amount and its currency, a person's emails) are one claim, under the group's lead field, and are taken
 * together.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { hiddenFields, type Access } from "./lib/access";
import { accessFor, recordVisible, requireWriteAccess } from "./permissions";
import { asState, loadDef, requireWritable, view } from "./objects";
import { crmPartyTakenValues, crmTakenValues, readDealDef, saveDealValues, saveParty } from "./canon";
import { asFieldClaim, fieldClaimsOf } from "./lib/fieldClaimStore";
import { claimObject, claimValues, crmRecordOfRef, heldField, standing, winningFact, type FieldClaim, type HeldObject } from "./lib/canon/personHold";
import { project, type FoldState } from "./lib/objects/fold";
import { resolveObjectDef, STANDARD_OBJECTS } from "./lib/objects/registry";
import { ID } from "./lib/canon/identity";
import { clientFor, requireCaller } from "./records";
import { sameValue, type FactValue } from "./lib/canon/policy";
import * as objectValidators from "./lib/objects/validators";
import type { DealValues } from "./lib/canon/dealLedger";
import type { PartyValues } from "./lib/canon/partyLedger";

const claimView = v.object({
  id: v.string(),
  /** The field, or a group's lead field. */
  field: v.string(),
  provider: v.union(v.literal("salesforce"), v.literal("hubspot")),
  value: objectValidators.factValue,
  /** What the CRM says each field is: the one field, or each of a group's that differs from Canon's or leads it. */
  values: v.array(v.object({ field: v.string(), value: objectValidators.factValue })),
  /** The owner's name, for an owner. */
  label: v.union(v.string(), v.null()),
});

/**
 * A record a claim names, as its caller may see it: its object, its state and values in Canon, its name, and the id
 * its page goes by (a deal's stream; a company's or person's register id, when Canon knows it), and whether the
 * caller sees it. Null when the record is gone or is not a deal, company or person.
 */
export async function claimRecord(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, streamId: Id<"canonEntities">) {
  const entity = await ctx.db.get(streamId);
  const hot = entity?.orgId === orgId ? await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", streamId)).unique() : null;
  if (!entity || !hot) return null;
  const state = asState(hot);
  if (entity.entityType === "opportunity") {
    const record = await view(ctx, orgId, streamId, 1000, new Map());
    if (!record || record.object !== "deal") return null;
    return { object: "deal" as HeldObject, state, values: record.values, title: record.title || "Untitled deal", pageId: streamId as string, visible: await recordVisible(ctx, access, record) };
  }
  if (entity.entityType !== "account" && entity.entityType !== "contact") return null;
  const object = entity.entityType;
  const values = project(await loadDef(ctx, orgId, object), state).values as Record<string, unknown>;
  const title = (object === "account" ? values.name : values.fullName) as string | undefined;
  return {
    object: object as HeldObject, state, values, title: title || (object === "account" ? "Untitled company" : "Unnamed person"), pageId: await registerIdOf(ctx, entity),
    visible: await recordVisible(ctx, access, { streamId, object, values }),
  };
}

/** The register id a company's or person's page goes by: the record-service row a person edited it on, or its projection's. */
async function registerIdOf(ctx: QueryCtx, entity: Doc<"canonEntities">): Promise<string | null> {
  const provider = entity.entityType === "account" ? ID.recordAccount : ID.recordContact;
  const ids = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entity._id)).take(50);
  const linked = ids.find((x) => x.provider === provider)?.externalId;
  if (linked) return linked;
  return entity.projectionTable === "recordAccounts" || entity.projectionTable === "recordContacts" ? entity.projectionId : null;
}

/** A claim's values as its note shows them: the lead field, then each of its group's fields that differs from Canon's. */
export function shownValues(state: FoldState, c: FieldClaim, hidden: readonly string[]) {
  const current = (f: string) => (winningFact(state.fields[f]?.candidates ?? [])?.value ?? null) as FactValue;
  return Object.entries(claimValues(c))
    .filter(([f, value]) => !hidden.includes(f) && (f === c.field || !sameValue(current(f), value)))
    .map(([field, value]) => ({ field, value: value as Infer<typeof objectValidators.factValue> }));
}

/** The CRM values that differ from a deal's, company's or person's field a person holds now, one per field and CRM record. */
export const forRecord = query({
  args: { streamId: v.id("canonEntities") },
  returns: v.array(claimView),
  handler: async (ctx, { streamId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const claims = await fieldClaimsOf(ctx, user.orgId, streamId);
    if (!claims.length) return [];
    const access = await accessFor(ctx, user);
    const record = await claimRecord(ctx, user.orgId, access, streamId);
    if (!record?.visible) return [];
    const hidden = hiddenFields(access, record.object);
    const out: Array<Infer<typeof claimView>> = [];
    for (const c of claims) {
      if (claimObject(c) !== record.object || hidden.includes(c.field) || !standing(record.state, c, record.object)) continue;
      const owner = c.field === "ownerId" && typeof c.value === "string" ? ctx.db.normalizeId("users", c.value) : null;
      const member = owner ? await ctx.db.get(owner) : null;
      out.push({ id: c.id, field: c.field, provider: c.provider, value: c.value as Infer<typeof objectValidators.factValue>, values: shownValues(record.state, c, hidden), label: member && member.orgId === user.orgId ? member.name : null });
    }
    return out;
  },
});

/** forRecord under the name the deal page read before companies and people had notes; a page loaded before then still asks for it. */
export const forDeal = forRecord;

/** Use what a CRM record says a field is, where a person's value in Canon held against it. */
export const useCrmValue = mutation({
  args: { id: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => takeCrmValue(ctx, await requireUser(ctx), args.id),
});

export const useCrmValueAs = internalMutation({
  args: { userId: v.id("users"), id: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.isActive === false) throw new ConvexError("You are no longer a member of this workspace");
    return takeCrmValue(ctx, user, args.id);
  },
});

/**
 * useCrmValue on a company or a person: their page reads the record service's row, which the ledger's value reaches
 * through the projector, so this returns once the row shows it.
 */
export const useCrmRecordValue = action({
  args: { id: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: string }> => {
    const caller = await requireCaller(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const out: { status: string } = await ctx.runMutation(internal.fieldClaims.useCrmValueAs, { userId: caller.userId as Id<"users">, id: args.id });
    const client = clientFor(ctx);
    if (client.mode === "http") await client.nudgeProjector(caller.orgId, await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId }), process.env.CONVEX_SITE_URL, { wait: true });
    return out;
  },
});

/** useCrmValue as `user`, who may edit the record's field: the CRM record's value, written as that record's by them, and its claim gone. */
export async function takeCrmValue(ctx: MutationCtx, user: Doc<"users">, id: string): Promise<{ status: string }> {
  const rowId = ctx.db.normalizeId("parentDisagreements", id);
  const row = rowId ? await ctx.db.get(rowId) : null;
  const claim = row && row.orgId === user.orgId ? asFieldClaim(row) : null;
  if (!row || !claim) throw new ConvexError("Canon already follows the CRM here");
  const object = claimObject(claim);
  const crm = crmRecordOfRef(claim.provider, claim.ref, object);
  const streamId = ctx.db.normalizeId("canonEntities", claim.recordId);
  const entity = streamId ? await ctx.db.get(streamId) : null;
  if (!crm || !streamId || !entity || entity.orgId !== user.orgId) throw new ConvexError("Record not found");
  if (claim.field === "ownerId" && typeof claim.value === "string") {
    const ownerId = ctx.db.normalizeId("users", claim.value);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.orgId !== user.orgId) throw new ConvexError("That owner is not in this workspace");
  }
  const result = object === "deal" ? await takeDealValue(ctx, user, entity, claim, crm) : await takePartyValue(ctx, user, entity, object, claim, crm);
  await ctx.db.delete(row._id);
  return { status: result };
}

async function takeDealValue(ctx: MutationCtx, user: Doc<"users">, entity: Doc<"canonEntities">, claim: FieldClaim, crm: { provider: "salesforce" | "hubspot"; crmId: string }): Promise<string> {
  const def = resolveObjectDef(STANDARD_OBJECTS.deal, (await readDealDef(ctx, user.orgId)).ext);
  if (!heldField("deal", claim.field, def)) throw new ConvexError("Canon already follows the CRM here");
  const dealId = entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  if (!deal) throw new ConvexError("Deal not found");
  // Taking a group takes all of it, so every field it writes is one the person may edit.
  const taken = await crmTakenValues(ctx, deal, crm.provider, crm.crmId, claimValues(claim) as DealValues);
  await requireWritable(ctx, user, await requireWriteAccess(ctx, user), "deal", "edit", entity._id, taken);
  if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
  const { result } = await saveDealValues(ctx, deal, { kind: crm.provider, crmId: crm.crmId, takenBy: user._id }, taken);
  if (result.status === "deferred") throw new ConvexError("This deal's history is still being converted. Try again in a minute.");
  if (result.status === "invalid") throw new ConvexError(result.errors.map((e) => e.message).join("; "));
  if (result.status === "conflict") throw new ConvexError("The deal changed. Reload the page.");
  return result.status;
}

async function takePartyValue(ctx: MutationCtx, user: Doc<"users">, entity: Doc<"canonEntities">, object: "account" | "contact", claim: FieldClaim, crm: { provider: "salesforce" | "hubspot"; crmId: string }): Promise<string> {
  if (entity.entityType !== object || !heldField(object, claim.field, await loadDef(ctx, user.orgId, object))) throw new ConvexError("Canon already follows the CRM here");
  const access = await requireWriteAccess(ctx, user);
  // The record's visibility is its owner's (CP14), which the view of a deal checks and a company's or person's needs here.
  if (!(await claimRecord(ctx, user.orgId, access, entity._id))?.visible) throw new ConvexError("Record not found");
  const taken = await crmPartyTakenValues(ctx, object, entity._id, crm.provider, crm.crmId, claimValues(claim) as PartyValues);
  await requireWritable(ctx, user, access, object, "edit", undefined, taken);
  const out = await saveParty(ctx, { orgId: user.orgId, object, identity: { entityId: entity._id }, seed: null, source: { kind: crm.provider, crmId: crm.crmId, takenBy: user._id }, values: taken });
  if (out.result.status === "deferred") throw new ConvexError("This record's history is still being moved onto the ledger. Try again in a minute.");
  if (out.rejected.length) throw new ConvexError(out.rejected.map((e) => e.message).join("; "));
  if (out.result.status === "invalid") throw new ConvexError(out.result.errors.map((e) => e.message).join("; "));
  if (out.result.status === "conflict") throw new ConvexError("The record changed. Reload the page.");
  return out.result.status;
}
