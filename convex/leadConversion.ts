/**
 * Convert a lead into a company, a person and (optionally) a deal (CP6,
 * lib/objects/leadConversion.ts has the field map). The company is matched by
 * domain and the person by email among the workspace's register, worked or
 * not, and created only when none exists; an existing record is kept as it
 * is. The person joins the company (a primary contact-company edge when they
 * are new), the deal puts them on it, the lead's activities also become the
 * person's, and the lead is marked converted with links to what it produced.
 * The lead is never deleted. Only admins and managers create the deal part,
 * as in deals.create.
 *
 * Steps that need the record service (creating or matching the company and
 * person, their edits) are an action's; everything the ledger owns (the deal,
 * the deal role, the activity edges, the lead's converted marks) is one
 * transaction (`finish`). A retry after a failure between them matches the
 * company and person the first run made, so nothing is created twice.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { loadDef, saveAsCaller, view } from "./objects";
import { callerClient, clientFor, recordEditPorts, requireCaller } from "./records";
import { canSeeRecord, lockedFields, may, type Access } from "./lib/access";
import { edgeStore } from "./associations";
import { createDealAsUser } from "./deals";
import { orgPipelines } from "./pipelines";
import { planDealCreate } from "./lib/pipelines";
import { applyEdgeCommand, EDGES_PER_RECORD_MAX } from "./lib/objects/associations";
import { editPartyRecord, type RecordPatch } from "./lib/canon/partyLedger";
import { lifecycleAfterConversion, planConversion, writesFor, type ConversionPlan, type MappedField } from "./lib/objects/leadConversion";
import { indexObjectDef, plainObjectDef, type FieldValue, type ObjectDef, type ResolvedObjectDef } from "./lib/objects/registry";
import { fromStored, toStored, type Stored } from "./lib/objects/validators";
import { normalizeDomain } from "./lib/recordClient";
import type { RegisterListRow } from "./lib/objects/listSpec";

/** Activities of one lead that follow it to the person in one conversion. */
export const ACTIVITIES_MOVED_MAX = 100;

const dealArgs = v.object({
  name: v.string(),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  closeDate: v.string(),
  dealType: v.optional(v.string()),
  pipelineId: v.union(v.string(), v.null()),
  stage: v.string(),
});

/**
 * The lead as a conversion reads it: its values by apiName, the three
 * definitions the map needs (with the org's custom fields), the workspace's
 * people by id for owner names, and whether the deal asked for would be
 * accepted (checked before anything is written).
 */
export type LeadRead = {
  title: string; version: number; active: boolean; convertedAt: number | null;
  values: Stored<Record<string, FieldValue>>;
  defs: { lead: Stored<ObjectDef>; contact: Stored<ObjectDef>; account: Stored<ObjectDef> };
  userNames: Record<string, string>;
  dealError: string | null;
};

export const read = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), deal: v.optional(dealArgs) },
  handler: async (ctx, args): Promise<LeadRead | null> => {
    const id = ctx.db.normalizeId("canonEntities", args.streamId);
    const record = id ? await view(ctx, args.orgId, id, 200, new Map()) : null;
    if (!record || record.object !== "lead") return null;
    const [lead, contact, account] = await Promise.all([loadDef(ctx, args.orgId, "lead"), loadDef(ctx, args.orgId, "contact"), loadDef(ctx, args.orgId, "account")]);
    const values: Record<string, FieldValue> = {};
    for (const f of lead.fields) if (!f.system) values[f.apiName] = (record.values[f.fieldId] ?? null) as FieldValue;
    const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(200);
    const caller = await ctx.db.get(args.userId);
    let dealError: string | null = null;
    if (args.deal) {
      if (!caller || !can(caller, "deals.write")) dealError = "Only admins and managers can create deals";
      else {
        const { pipelineId, ...input } = args.deal;
        const plan = planDealCreate(await orgPipelines(ctx, args.orgId), { ...input, ...(pipelineId !== null ? { pipelineId } : {}) });
        if (!plan.ok) dealError = plan.error;
      }
    }
    return {
      title: record.title, version: record.version, active: record.lifecycle.status === "active",
      convertedAt: typeof values.convertedAt === "number" ? values.convertedAt : null,
      values: toStored(values),
      defs: { lead: toStored(plainObjectDef(lead)), contact: toStored(plainObjectDef(contact)), account: toStored(plainObjectDef(account)) },
      userNames: Object.fromEntries(users.map((u) => [u._id as string, u.name])),
      dealError,
    };
  },
});

function defsOf(read: LeadRead): { lead: ResolvedObjectDef; contact: ResolvedObjectDef; account: ResolvedObjectDef } {
  const resolve = (stored: Stored<ObjectDef>) => indexObjectDef(fromStored<ObjectDef>(stored));
  return { lead: resolve(read.defs.lead), contact: resolve(read.defs.contact), account: resolve(read.defs.account) };
}

const found = (row: RegisterListRow | undefined) => (row ? { id: row.id, name: row.title || row.id, stage: typeof row.values.lifecycleStage === "string" ? row.values.lifecycleStage : null, accountId: row.accountId ?? null } : null);

/**
 * A conversion reads every lead field and writes mapped fields to a company, a person and maybe a deal (CP14): not for a
 * role with a hidden or read-only field on any of them. Merges are refused the same way.
 */
function refuseFieldLimitedConversion(access: Access) {
  if (["lead", "account", "contact", "deal"].some((o) => lockedFields(access, o).length)) {
    throw new ConvexError("Converting leads needs every lead, company, person and deal field visible and editable for your role; ask an admin");
  }
}

/** The company with this domain and the person with this email, if the register has them (worked or not). */
async function matchesOf(ctx: ActionCtx, caller: { orgId: string; access: Access }, plan: ConversionPlan) {
  const orgId = caller.orgId;
  const client = clientFor(ctx);
  const [company, person] = await Promise.all([
    plan.company.domain
      ? client.listRegister(orgId, "account", { filter: [{ field: "domain", op: "eq", value: plan.company.domain }], limit: 1 })
      : Promise.resolve({ rows: [] as RegisterListRow[] }),
    plan.person.email
      ? client.listRegister(orgId, "contact", { filter: [{ field: "email", op: "eq", value: plan.person.email }], limit: 1 })
      : Promise.resolve({ rows: [] as RegisterListRow[] }),
  ]);
  const matchedCompany = found(company.rows[0]);
  let matchedPerson = found(person.rows[0]);
  // Without an email the record service matches a person by name within the company: look the same way, so nothing it reuses is treated as new.
  if (!matchedPerson && !plan.person.email && matchedCompany) {
    const same = await client.listContacts(orgId, { filter: { accountId: matchedCompany.id, q: plan.person.fullName }, limit: 50 });
    const hit = same.rows.find((c) => c.fullName.trim().toLowerCase() === plan.person.fullName.toLowerCase());
    if (hit) matchedPerson = { id: hit.id, name: hit.fullName, stage: hit.lifecycleStage ?? null, accountId: hit.accountId || null };
  }
  // A conversion reuses and fills the company and person it matches (CP14): both must be ones the caller sees. A match
  // they cannot see is refused, not shown: the conversion would otherwise read and change another owner's record.
  if (matchedCompany && !(await callerClient(ctx, caller).get(orgId, matchedCompany.id))) throw new ConvexError("A company with this domain belongs to someone your role cannot see; ask an admin to convert this lead");
  if (matchedPerson && !(await callerClient(ctx, caller).getContact(orgId, matchedPerson.id))) throw new ConvexError("This person is already in the workspace, owned by someone your role cannot see; ask an admin to convert this lead");
  return { company: matchedCompany, person: matchedPerson };
}

/** A value as the preview shows it: a picklist's label, an owner's name, a time as a date. */
function shownValue(def: ResolvedObjectDef, apiName: string, value: FieldValue, userNames: Readonly<Record<string, string>>): string {
  const f = def.byApiName.get(apiName);
  if (Array.isArray(value)) return value.join(", ");
  if (f?.type === "picklist") return f.options.find((o) => o.value === value)?.label ?? String(value);
  if (f?.type === "user") return userNames[String(value)] ?? String(value);
  if (f?.type === "datetime" && typeof value === "number") return new Date(value).toISOString().slice(0, 10);
  return String(value);
}

const cleanDomain = (domain: string | undefined) => (domain?.trim() ? normalizeDomain(domain) : null);

/**
 * What converting this lead would do, for the dialog: the company and person
 * it would create or find, where each field lands, what is not carried over,
 * and the lifecycle stage the person would get. Writes nothing. `domain` is
 * the company's, typed by the person converting (default: the work email's).
 */
type Existing = { id: string; name: string; stage: string | null; accountId: string | null };
export type ConversionPreview = {
  title: string; convertedAt: number | null; active: boolean;
  company: { name: string; domain: string | null; existing: Existing | null };
  person: { fullName: string; email: string | null; existing: Existing | null };
  /** Where each lead field lands; `keptAsIs` when the record it would fill already exists. */
  fields: Array<{ target: "account" | "contact"; label: string; from: string; shown: string; keptAsIs: boolean }>;
  skipped: Array<{ from: string; shown: string; reason: string }>;
  lifecycle: { from: string | null; to: string | null };
};

export type Converted = {
  company: { id: string; name: string; created: boolean }; person: { id: string; name: string; created: boolean };
  deal: { streamId: string; name: string } | null; lifecycleStage: string | null; activitiesMoved: number;
};

export const preview = action({
  args: { leadId: v.string(), domain: v.optional(v.string()), createsDeal: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ConversionPreview> => {
    const caller = await requireCaller(ctx, { read: true });
    refuseFieldLimitedConversion(caller.access);
    const read = await ctx.runQuery(internal.leadConversion.read, { orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, streamId: args.leadId });
    // A lead the caller's role does not see reads as missing (CP14).
    if (!read || !canSeeRecord(caller.access, "lead", true, (read.values as Record<string, unknown>).ownerId ?? null)) throw new ConvexError("Lead not found");
    const defs = defsOf(read);
    const plan = planConversion(defs, read.values as Record<string, FieldValue>, cleanDomain(args.domain));
    const match = await matchesOf(ctx, caller, plan);
    const names = read.userNames;
    const row = (f: MappedField, keptAsIs: boolean) => ({
      target: f.target, label: f.label, from: f.from, shown: shownValue(defs[f.target], f.apiName, f.value, names), keptAsIs,
    });
    return {
      title: read.title, convertedAt: read.convertedAt, active: read.active,
      company: { ...plan.company, existing: match.company },
      person: { ...plan.person, existing: match.person },
      fields: plan.fields.map((f) => row(f, f.target === "account" ? match.company !== null : match.person !== null)),
      skipped: plan.skipped.map((s) => ({ from: s.from, shown: shownValue(defs.lead, "", s.value, names), reason: s.reason })),
      lifecycle: { from: match.person?.stage ?? null, to: lifecycleAfterConversion(match.person?.stage, args.createsDeal === true) },
    };
  },
});


/**
 * The ledger half of a conversion, in one transaction: create the deal and
 * put the person on it, make the lead's activities the person's too, and mark
 * the lead converted. Refuses a lead that is already converted.
 */
export const finish = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), leadId: v.string(),
    accountId: v.string(), contactId: v.string(), deal: v.optional(dealArgs),
  },
  handler: async (ctx, args): Promise<{ dealStreamId: string | null; activitiesMoved: number }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Not authenticated");
    const leadStream = ctx.db.normalizeId("canonEntities", args.leadId);
    const lead = leadStream ? await view(ctx, args.orgId, leadStream, 200, new Map()) : null;
    if (!leadStream || !lead || lead.object !== "lead") throw new ConvexError("Lead not found");
    if (lead.lifecycle.status !== "active") throw new ConvexError("This lead is deleted");
    if (typeof lead.values.convertedAt === "number") throw new ConvexError("This lead is already converted");
    const edgeCtx = { orgId: args.orgId, source: { kind: "user" as const, ref: `user:${user._id}` }, actor: { kind: "user" as const, id: user._id }, now: Date.now() };
    const store = edgeStore(ctx);

    let dealStream: string | null = null;
    if (args.deal) {
      const { pipelineId, ...input } = args.deal;
      const created = await createDealAsUser(ctx, user, { ...input, ...(pipelineId !== null ? { pipelineId } : {}), companyId: args.accountId });
      dealStream = created.streamId;
      const role = await applyEdgeCommand(store, edgeCtx, { op: "setRole", dealId: dealStream, contactId: args.contactId, role: "involved" });
      if (role.status === "invalid") throw new ConvexError(role.message);
    }

    // The lead's activities stay on the lead and also become the person's, so the history follows.
    const edges = await ctx.db.query("associations")
      .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", args.orgId).eq("association", "activity_target").eq("toId", args.leadId))
      .take(ACTIVITIES_MOVED_MAX + EDGES_PER_RECORD_MAX);
    const activityIds = [...new Set(edges.filter((e) => e.active).map((e) => e.fromId))].slice(0, ACTIVITIES_MOVED_MAX);
    for (const activityId of activityIds) {
      const moved = await applyEdgeCommand(store, edgeCtx, { op: "target", activityId, toIds: [args.contactId] });
      if (moved.status === "invalid") throw new ConvexError(moved.message);
    }

    const saved = await saveAsCaller(ctx, user, "lead", {
      op: "update", streamId: args.leadId,
      values: { convertedAt: edgeCtx.now, convertedAccountId: args.accountId, convertedContactId: args.contactId, ...(dealStream ? { convertedDealId: dealStream } : {}) },
    });
    if (saved.status === "invalid" || saved.status === "conflict") throw new ConvexError("The lead could not be marked converted");
    return { dealStreamId: dealStream, activitiesMoved: activityIds.length };
  },
});

/**
 * Convert a lead. `companyName` and `domain` are the company's (a company
 * with the domain is matched; otherwise it is created with that name). A
 * `deal` also creates a deal in that pipeline and stage.
 */
export const convert = action({
  args: { leadId: v.string(), domain: v.string(), companyName: v.optional(v.string()), deal: v.optional(dealArgs) },
  handler: async (ctx, args): Promise<Converted> => {
    const caller = await requireCaller(ctx);
    refuseFieldLimitedConversion(caller.access);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const read = await ctx.runQuery(internal.leadConversion.read, { orgId, userId, streamId: args.leadId, ...(args.deal ? { deal: args.deal } : {}) });
    if (!read || !canSeeRecord(caller.access, "lead", true, (read.values as Record<string, unknown>).ownerId ?? null)) throw new ConvexError("Lead not found");
    // A conversion edits the lead and creates or fills a company, a person and maybe a deal; a preview changes nothing (CP14).
    const needs: Array<[string, "edit" | "create"]> = [["lead", "edit"], ["account", "create"], ["account", "edit"], ["contact", "create"], ["contact", "edit"], ...(args.deal ? [["deal", "create"] as [string, "create"]] : [])];
    const refused = needs.find(([object, op]) => !may(caller.access, object, op));
    if (refused) throw new ConvexError(caller.access.preview ? `You are viewing as ${caller.access.preview.asName}: changes are off until you exit the preview` : `Your role cannot ${refused[1]} ${refused[0]} records`);
    if (!read.active) throw new ConvexError("This lead is deleted");
    if (read.convertedAt !== null) throw new ConvexError("This lead is already converted");
    if (read.dealError) throw new ConvexError(read.dealError);
    const defs = defsOf(read);
    const plan = planConversion(defs, read.values as Record<string, FieldValue>, cleanDomain(args.domain));
    if (!plan.person.fullName) throw new ConvexError("A lead needs a last name to become a person");
    const match = await matchesOf(ctx, caller, plan);
    if (!match.company && !plan.company.domain) throw new ConvexError("Enter the company's website domain, such as acme.com");
    const client = clientFor(ctx);
    const key = `convert:${args.leadId}`;

    const accountId = match.company?.id ?? (await (async () => {
      const name = args.companyName?.trim() || plan.company.name;
      const up = await client.upsertAccounts(caller.orgId, { source: "api", idempotencyKey: `${key}:account:${plan.company.domain}`, fill: "missing", records: [{ domain: plan.company.domain!, name }] });
      if (!up.ids[0]) throw new ConvexError(`The company could not be created: ${up.rejected?.[0]?.reason ?? "refused"}`);
      return up.ids[0];
    })());

    const writes = writesFor(plan, match, Boolean(args.deal));
    const title = writes.title;
    const contactId = match.person?.id ?? (await (async () => {
      const up = await client.upsertContacts(caller.orgId, {
        source: "api", idempotencyKey: `${key}:contact:${accountId}`, fill: "missing",
        records: [{ fullName: plan.person.fullName, accountId, ...(plan.person.email ? { email: plan.person.email } : {}), ...(typeof title === "string" ? { title } : {}) }],
      });
      if (!up.ids[0]) throw new ConvexError(`The person could not be created: ${up.rejected?.[0]?.reason ?? "refused"}`);
      return up.ids[0];
    })());

    // The person joins the company: primary when they are new. An existing person keeps the company they have as primary.
    const linked = await ctx.runMutation(internal.associations.apply, {
      orgId, userId, command: { op: "link", fromId: contactId, toId: accountId, ...(writes.primary ? { primary: true } : {}) },
      ...(match.person?.accountId ? { seed: match.person.accountId } : !match.person ? { seed: accountId } : {}),
    });
    if (linked.status === "invalid") throw new ConvexError(linked.message);

    // Fields land on the records the conversion created; an existing company or person is kept as it is, but a person's lifecycle stage moves forward.
    const stage = writes.stage;
    const edits: Array<{ object: "account" | "contact"; id: string; patch: RecordPatch }> = [];
    if (writes.accountPatch) edits.push({ object: "account", id: accountId, patch: writes.accountPatch as RecordPatch });
    if (writes.personPatch) edits.push({ object: "contact", id: contactId, patch: writes.personPatch as RecordPatch });
    // No op check here: a role with field limits never gets this far (refuseFieldLimitedConversion), an existing company or
    // person was checked visible in matchesOf, and a new one has no owner until this very edit sets the lead's (CP14).
    for (const e of edits) await editPartyRecord(await recordEditPorts(ctx, caller, { ...e, idempotencyKey: `${key}:edit:${e.object}:${e.id}` }));

    const done = await ctx.runMutation(internal.leadConversion.finish, { orgId, userId, leadId: args.leadId, accountId, contactId, ...(args.deal ? { deal: args.deal } : {}) });
    if (client.mode === "http") {
      const heads = await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId });
      await client.nudgeProjector(caller.orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
    }
    return {
      company: { id: accountId, name: match.company?.name ?? (args.companyName?.trim() || plan.company.name), created: match.company === null },
      person: { id: contactId, name: match.person?.name ?? plan.person.fullName, created: match.person === null },
      deal: done.dealStreamId ? { streamId: done.dealStreamId, name: args.deal!.name } : null,
      lifecycleStage: stage, activitiesMoved: done.activitiesMoved,
    };
  },
});

