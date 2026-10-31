import { action, internalMutation, query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { can, refusal } from "./lib/capabilities";
import { internal } from "./_generated/api";
import { callerClient, requireCaller } from "./records";
import { visibleIds } from "./lib/scopedRecordClient";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor, dealForCaller, dealVisible, requireWriteAccess, sightJudge, visibleDeals } from "./permissions";
import { may, refuseLockedWrite, type Access } from "./lib/access";

/** Refuse an edit of a deal the caller's role may not edit or see, or of a field they may not change (CP14); a hidden deal reads as missing. */
function requireDealEdit(access: Access, deal: Doc<"deals">, fields: string[]) {
  if (!may(access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
  if (!dealVisible(access, deal)) throw new ConvexError("Deal not found");
  refuseLockedWrite(access, "deal", fields);
}
import { indexById } from "./lib/collections";
import { modelSettings } from "./lib/recipes";
import { readDealDef, saveDeal, saveDealValues, type DealSource } from "./canon";
import { coerce, resolveObjectDef, STANDARD_OBJECTS } from "./lib/objects/registry";
import { orgPipelines } from "./pipelines";
import { currentPeriod } from "./targets";
import { planDealCreate, withStageOutcome } from "./lib/pipelines";
import type { DealValues } from "./lib/canon/dealLedger";
import type { FactValue } from "./lib/canon/policy";
import { companyDeals, companyLinkOf } from "./lib/dealCompany";
import { ID, normalizeDomain } from "./lib/canon/identity";

const COMPANY_DEALS_MAX = 100;
const CRM_PROVIDERS = ["hubspot", "salesforce"] as const;

/**
 * The CRM accounts of a register company: those of the ledger stream that
 * holds its record id or its domain (a CRM sync identifies an account by its
 * domain too), or of the stream the register row is linked to.
 */
async function crmAccountsOfCompany(ctx: QueryCtx, orgId: Id<"organizations">, a: { companyId: string; domain?: string; stream?: string }): Promise<Id<"crmAccounts">[]> {
  const byId = (provider: string, externalId: string) => ctx.db.query("canonExternalIds")
    .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId).eq("provider", provider).eq("externalId", externalId))
    .first();
  const found = await Promise.all([byId(ID.recordAccount, a.companyId), a.domain ? byId(ID.domain, normalizeDomain(a.domain)) : null]);
  const streamId = a.stream ? ctx.db.normalizeId("canonEntities", a.stream) : null;
  const entityIds = new Set([...found.flatMap((x) => (x ? [x.entityId] : [])), ...(streamId ? [streamId] : [])]);
  // The companies merged into this one (CP15a): their CRM accounts' deals are this company's now.
  for (const entityId of [...entityIds]) {
    const merges = await ctx.db.query("recordMerges").withIndex("by_orgId_and_survivorStream", (q) => q.eq("orgId", orgId).eq("survivorStream", entityId)).take(50);
    for (const m of merges) if (!m.undoneAt) for (const l of m.losers) entityIds.add(l.stream);
  }
  const out = new Set<Id<"crmAccounts">>();
  for (const entityId of entityIds) {
    const entity = await ctx.db.get(entityId);
    if (!entity || entity.orgId !== orgId || entity.entityType !== "account") continue;
    const own = entity.projectionTable === "crmAccounts" ? ctx.db.normalizeId("crmAccounts", entity.projectionId) : null;
    if (own) out.add(own);
    for (const ext of await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entityId)).take(20)) {
      const provider = CRM_PROVIDERS.find((p) => ext.provider === ID.crmAccount(p));
      if (!provider) continue;
      const row = await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", ext.externalId)).first();
      if (row && row.provider === provider) out.add(row._id);
    }
  }
  return [...out];
}

/** A company's deals: those linked to it and those synced from its CRM accounts, at most COMPANY_DEALS_MAX. */
export async function dealsOfCompany(ctx: QueryCtx, orgId: Id<"organizations">, a: { companyId: string; domain?: string; stream?: string }) {
  const crmAccountIds = await crmAccountsOfCompany(ctx, orgId, a);
  const [linked, ...synced] = await Promise.all([
    ctx.db.query("deals").withIndex("by_orgId_companyId", (q) => q.eq("orgId", orgId).eq("companyId", a.companyId)).take(COMPANY_DEALS_MAX),
    ...crmAccountIds.map((id) => ctx.db.query("deals").withIndex("by_accountId", (q) => q.eq("accountId", id)).take(COMPANY_DEALS_MAX)),
  ]);
  return companyDeals(a.companyId, crmAccountIds, [...linked, ...synced.flat()].filter((d) => d.orgId === orgId && d.archivedAt === undefined)).slice(0, COMPANY_DEALS_MAX);
}

/**
 * A company's deals for its account page: those linked to it and those synced
 * from its CRM accounts, each with its stage, amount, close date and stream
 * (the deal's record page).
 */
export const forCompany = query({
  args: { companyId: v.string(), domain: v.optional(v.string()), stream: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const access = await accessFor(ctx, user);
    const deals = (await dealsOfCompany(ctx, user.orgId, args)).filter((d) => dealVisible(access, d));
    return Promise.all(deals.map(async (d) => {
      const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", user.orgId).eq("projectionId", d._id)).first();
      return dealForCaller(access, {
        dealId: d._id, streamId: entity?._id ?? null, name: d.name, stage: d.stage ?? null, amount: d.amount ?? null, currency: d.currency,
        closeDate: d.closeDate, isClosed: d.isClosed, isWon: d.isWon, link: d.link, createdAt: d.createdAt,
      });
    }));
  },
});

function dealReadinessFromRows(deals: any[], callInsights: any[]) {
  const openDeals = deals.filter((deal) => !deal.isClosed);
  const openPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
  const missingNextStep = openDeals.filter((deal) => !deal.nextStep).length;
  return {
    noun: "deal",
    required: true,
    relevant: deals.length > 0,
    configured: deals.length > 0,
    lifecycle: deals.length > 0 ? "pipeline_available" : "not_connected",
    signals: {
      dealCount: deals.length,
      openDealCount: openDeals.length,
      openPipeline,
      missingNextStep,
      callInsightCount: callInsights.length,
    },
    nextActions: deals.length > 0
      ? missingNextStep > 0
        ? ["find call insights", "set deal.next_step", "set deal.forecast_category"]
        : ["find deal forecast", "do deal.inspect"]
      : ["connect CRM", "sync deals", "parse deal_evidence"],
  };
}

function emptyDealReadiness() {
  return {
    noun: "deal",
    required: true,
    relevant: false,
    configured: false,
    lifecycle: "not_connected",
    signals: { dealCount: 0, openDealCount: 0, openPipeline: 0, missingNextStep: 0, callInsightCount: 0 },
    nextActions: ["Sign in to inspect deal readiness"],
  };
}

const forecastCategoryValidator = v.union(
  v.literal("omit"),
  v.literal("pipeline"),
  v.literal("best_case"),
  v.literal("commit"),
  v.literal("closed_won"),
  v.literal("closed_lost"),
);

/**
 * Read budget: org 1 + recent-deals probe 100 + callInsights probe 250 +
 * viewer lookup ~2 ≈ 353 worst case (was take(5000) deals + take(1000)
 * insights ≈ 6,000). Deal counts/pipeline come from org.crmCounts (maintained
 * at sync end); missingNextStep is sampled over the 100 most recent deals and
 * callInsightCount saturates at 250 ("250 = 250 or more").
 */
export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return emptyDealReadiness();
    const [org, recentDeals, callInsights] = await Promise.all([
      ctx.db.get(user.orgId),
      // The deals the caller's role sees (CP14).
      accessFor(ctx, user).then((access) => visibleDeals(ctx, user.orgId, access, 100)),
      ctx.db.query("callInsights").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(250),
    ]);
    const crmCounts = org?.crmCounts;
    const openRecent = recentDeals.filter((deal) => !deal.isClosed);
    const dealCount = crmCounts?.deals ?? recentDeals.length;
    const openDealCount = crmCounts?.openDeals ?? openRecent.length;
    const missingNextStep = openRecent.filter((deal) => !deal.nextStep).length;
    return {
      noun: "deal",
      required: true,
      relevant: dealCount > 0,
      configured: dealCount > 0,
      lifecycle: dealCount > 0 ? "pipeline_available" : "not_connected",
      signals: {
        dealCount,
        openDealCount,
        openPipeline: crmCounts?.openPipeline ?? openRecent.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
        // Sampled over the 100 most recent deals — a hygiene signal, not a census.
        missingNextStep,
        callInsightCount: callInsights.length,
      },
      nextActions: dealCount > 0
        ? missingNextStep > 0
          ? ["find call insights", "set deal.next_step", "set deal.forecast_category"]
          : ["find deal forecast", "do deal.inspect"]
        : ["connect CRM", "sync deals", "parse deal_evidence"],
    };
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { readiness: emptyDealReadiness(), deals: [], forecast: null };
    // The Revenue page: the deals the caller's role sees, without the fields hidden from it, in the list and its totals (CP14).
    const access = await accessFor(ctx, user);
    const [deals, callInsights, users, accounts, commissionLineItems] = await Promise.all([
      visibleDeals(ctx, user.orgId, access, 200).then((rows) => rows.map((d) => dealForCaller(access, d))),
      ctx.db.query("callInsights").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500),
      ctx.db.query("commissionLineItems").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const usersById = indexById(users);
    const accountsById = indexById(accounts);
    const commissionByDeal = new Map<string, { amount: number; count: number }>();
    for (const lineItem of commissionLineItems) {
      const existing = commissionByDeal.get(lineItem.dealId) ?? { amount: 0, count: 0 };
      existing.amount += lineItem.commissionAmount;
      existing.count += 1;
      commissionByDeal.set(lineItem.dealId, existing);
    }
    return {
      readiness: dealReadinessFromRows(deals, callInsights),
      // What the Revenue page weighs each forecast category by.
      forecast: await modelSettings(ctx, user.orgId, "forecast.model"),
      quarter: await currentPeriod(ctx, user.orgId, "quarter"),
      deals: deals.map((deal) => {
        const rep = deal.primaryRepId ? usersById.get(deal.primaryRepId) : null;
        const account = deal.accountId ? accountsById.get(deal.accountId) : null;
        const commission = commissionByDeal.get(deal._id);
        return dealForCaller(access, {
          ...deal,
          primaryRepName: rep?.name ?? (deal.primaryRepId ? "Unknown rep" : "Unassigned"),
          primaryRepEmail: rep?.email ?? null,
          accountName: account?.name ?? null,
          accountDomain: account?.domain ?? null,
          totalCommission: commission?.amount ?? 0,
          commissionLineItems: commission?.count ?? 0,
        });
      }),
    };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    // The deals the caller's role sees (CP14), without the fields hidden from it.
    const access = await accessFor(ctx, user);
    const deals = await visibleDeals(ctx, user.orgId, access, 200);

    const [users, accounts, commissionLineItems] = await Promise.all([
      ctx.db
        .query("users")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("commissionLineItems")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
    ]);

    const usersById = indexById(users);
    const accountsById = indexById(accounts);
    const commissionByDeal = new Map<string, { amount: number; count: number }>();
    for (const lineItem of commissionLineItems) {
      const existing = commissionByDeal.get(lineItem.dealId) ?? { amount: 0, count: 0 };
      existing.amount += lineItem.commissionAmount;
      existing.count += 1;
      commissionByDeal.set(lineItem.dealId, existing);
    }

    // The ledger stream each deal's record page and dialog are keyed by.
    const streams = await Promise.all(deals.map((deal) =>
      ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", user.orgId).eq("projectionId", deal._id)).first()));
    return deals.map((deal, i) => {
      const rep = deal.primaryRepId ? usersById.get(deal.primaryRepId) : null;
      const account = deal.accountId ? accountsById.get(deal.accountId) : null;
      const commission = commissionByDeal.get(deal._id);
      return dealForCaller(access, {
        ...deal,
        primaryRepName: rep?.name ?? (deal.primaryRepId ? "Unknown rep" : "Unassigned"),
        primaryRepEmail: rep?.email ?? null,
        accountName: account?.name ?? null,
        accountDomain: account?.domain ?? null,
        /** The register company a person linked, else the CRM mirror account (named by accountName). */
        company: companyLinkOf(deal),
        streamId: streams[i]?._id ?? null,
        totalCommission: commission?.amount ?? 0,
        commissionLineItems: commission?.count ?? 0,
      });
    });
  },
});

export const get = query({
  args: { dealId: v.id("deals") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const deal = await ctx.db.get(args.dealId);
    const access = await accessFor(ctx, user);
    if (!deal || deal.orgId !== user.orgId || !dealVisible(access, deal)) return null;
    return dealForCaller(access, deal);
  },
});

/**
 * Create a deal in Canon, as the caller: the stage must be one of the chosen
 * pipeline's and sets the deal's forecast category, probability, closed and
 * won. Like deal edits, admins and managers only. The owner defaults to the
 * caller. The row and its ledger stream (a create entry naming the caller,
 * then the values) are written in this one mutation.
 */
const dealCreateArgs = {
  name: v.string(),
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  closeDate: v.string(),
  stage: v.string(),
  pipelineId: v.optional(v.union(v.string(), v.null())),
  dealType: v.optional(v.string()),
  revenueType: v.optional(v.string()),
  primaryRepId: v.optional(v.id("users")),
  /** The register company (`acc_…`) the deal is with. */
  companyId: v.optional(v.string()),
  /** Values of the org's custom deal fields, by `custom.<slug>`; a required one must be here (CP7b). */
  custom: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
};

/**
 * Create a deal. A role that sees only some companies links one through
 * createScoped, which admits it first (CP14): here a company only the record
 * service can judge reads as missing for that role.
 */
export const create = mutation({
  args: dealCreateArgs,
  handler: async (ctx, args) => createDealAsUser(ctx, await requireUser(ctx), { ...args, custom: args.custom ?? {} }, { admitted: new Set() }),
});

export const createAdmitted = internalMutation({
  args: { ...dealCreateArgs, admitted: v.array(v.string()) },
  handler: async (ctx, { admitted, ...args }) => createDealAsUser(ctx, await requireUser(ctx), { ...args, custom: args.custom ?? {} }, { admitted: new Set(admitted) }),
});

/** deals.create with its company admitted through the caller's scoped client: what the deal form, the API and MCP call. */
export const createScoped = action({
  args: dealCreateArgs,
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof createDealAsUser>>> => {
    const caller = await requireCaller(ctx);
    const company = args.companyId?.trim();
    const admitted = company ? [...await visibleIds(callerClient(ctx, caller), caller.orgId, "account", [company])] : [];
    return ctx.runMutation(internal.deals.createAdmitted, { ...args, admitted });
  },
});

/** How long after a deal is created, or loses its company, Canon looks for its gaps: time to add them by hand first. */
const GAP_CHECK_DELAY_MS = 2 * 60_000;

export type DealCreateArgs = {
  name: string; amount?: number; currency?: string; closeDate: string; stage: string; pipelineId?: string | null;
  dealType?: string; revenueType?: string; primaryRepId?: Id<"users">; companyId?: string;
  /** Custom field values by `custom.<slug>`. When given (deals.create always gives it), required custom fields and rules are checked (CP7b); lead conversion leaves it out. */
  custom?: Record<string, string | number | boolean | null>;
};

/** deals.create's work for a caller already known: lead conversion creates its deal inside its own transaction. */
export async function createDealAsUser(ctx: MutationCtx, user: Doc<"users">, { primaryRepId, companyId, custom, ...input }: DealCreateArgs, opts: {
  /** Companies an action admitted through the caller's scoped client; lead conversion, which matched its company that way already, leaves it out. */
  admitted?: ReadonlySet<string>;
} = {}) {
  if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
  const access = await requireWriteAccess(ctx, user);
  if (!may(access, "deal", "create")) throw new ConvexError("Your role cannot create deal records");
  // A company the caller may not see reads as missing (CP14).
  if (opts.admitted && companyId?.trim() && !sightJudge(ctx, [access], opts.admitted).record("account", companyId.trim())) throw new ConvexError("Company not found");
  refuseLockedWrite(access, "deal", [...Object.keys(input), ...(primaryRepId ? ["ownerId"] : []), ...(companyId ? ["companyId"] : []), ...Object.keys(custom ?? {})]);
  const rep = primaryRepId ? await ctx.db.get(primaryRepId) : user;
  if (!rep || rep.orgId !== user.orgId) throw new ConvexError("That owner is not in this workspace");
  const plan = planDealCreate(await orgPipelines(ctx, user.orgId), input);
  if (!plan.ok) throw new ConvexError(plan.error);
  // The owner goes into the ledger with the rest, so the deal's history names who owned it from the start.
  const values = { ...plan.deal, ownerId: rep._id, ...(companyId?.trim() ? { companyId: companyId.trim() } : {}) };
  const source: DealSource = { kind: "user", userId: user._id };
  let customValues: Record<string, FactValue> = {};
  if (custom) {
    // Checked before the row exists: the values as the ledger will hold them, then the required custom fields they leave out (the standard ones are planDealCreate's).
    const def = resolveObjectDef(STANDARD_OBJECTS.deal, (await readDealDef(ctx, user.orgId)).ext);
    const given = Object.fromEntries(Object.entries(custom).filter(([k]) => k.startsWith("custom.")));
    const checked = coerce(def, given, { mode: "update" });
    const missing = coerce(def, given, { mode: "create" });
    const refused = [...(checked.ok ? [] : checked.errors), ...(missing.ok ? [] : missing.errors.filter((e) => e.field.startsWith("custom.")))];
    if (refused.length) throw new ConvexError([...new Set(refused.map((e) => e.message))].join("; "));
    if (checked.ok) customValues = Object.fromEntries(checked.values.map((c) => [def.byFieldId.get(c.fieldId)!.apiName, c.value as FactValue]));
  }
  const { dealId, entityId, result } = await insertDeal(ctx, { orgId: user.orgId, repId: rep._id, plan, values, source });
  // A new deal has no people yet, and often no company: Canon looks for them a little later (convex/dealGaps.ts).
  if (!plan.deal.isClosed) await ctx.scheduler.runAfter(GAP_CHECK_DELAY_MS, internal.dealGapActions.check, { orgId: user.orgId, streamId: entityId });
  if (Object.keys(customValues).length) {
    const row = await ctx.db.get(dealId);
    if (row) await saveDealEdit(ctx, row, source, customValues);
  }
  return { dealId, streamId: entityId, result };
}

/**
 * Insert a planned deal and write its values (the plan's, and any more, such
 * as a company link) as its stream's create entry from `source`. deals.create
 * and CSV imports create deals this one way.
 */
export async function insertDeal(
  ctx: MutationCtx,
  a: { orgId: Id<"organizations">; repId: Id<"users">; plan: Extract<ReturnType<typeof planDealCreate>, { ok: true }>; values: DealValues; source: DealSource; now?: number },
) {
  const now = a.now ?? Date.now();
  const { plan } = a;
  const dealId = await ctx.db.insert("deals", {
    orgId: a.orgId, ...plan.deal, revenueType: plan.revenueType, primaryRepId: a.repId, ...(plan.deal.isClosed ? { closedAt: now } : {}),
    origin: a.source.kind === "csv" ? "csv" : "manual", createdAt: now, updatedAt: now,
  });
  const deal = await ctx.db.get(dealId);
  if (!deal) throw new ConvexError("Deal not found");
  const { result, rejected, entityId } = await saveDealValues(ctx, deal, a.source, a.values, { now, creates: true });
  return { dealId, entityId, result, rejected };
}

/**
 * Edit a deal's values from `source`: a stage sets its pipeline's probability
 * and forecast category, and the category sets closed and won
 * (withStageOutcome). A change stamps the row, as the Deals page's own edits
 * do (hygiene falls back to updatedAt for freshness). Record edits and CSV
 * imports edit deals this one way.
 */
export async function saveDealEdit(ctx: MutationCtx, deal: Doc<"deals">, source: DealSource, edited: Record<string, FactValue>) {
  const out = await saveDealValues(ctx, deal, source, withStageOutcome(await orgPipelines(ctx, deal.orgId), edited));
  if (out.result.status === "applied" || out.result.status === "deferred") {
    // The deal lost its company: Canon looks for one again (convex/dealGaps.ts).
    if ("companyId" in edited && !edited.companyId && deal.companyId) {
      const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id)).first();
      if (stream) await ctx.scheduler.runAfter(GAP_CHECK_DELAY_MS, internal.dealGapActions.check, { orgId: deal.orgId, streamId: stream._id });
    }
    // closedAt follows the closed state the ledger resolved, which a lower-ranked source (an import) may not have changed.
    const after = await ctx.db.get(deal._id);
    const closedAt = after?.isClosed ? after.closedAt ?? Date.now() : undefined;
    await ctx.db.patch(deal._id, { updatedAt: Date.now(), closedAt });
  }
  return out;
}

/**
 * Record `origin` on the deals created before insertDeal wrote it: `csv` when the deal's stream starts with a CSV row's
 * entry, else `manual`. A deal a CRM sync created keeps `crmProvider` alone. Run once per deployment (a human runs it
 * on dev and prod); it schedules itself through every page and is safe to run again.
 */
export const backfillOrigin = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("deals").paginate({ cursor: cursor ?? null, numItems: 200 });
    let patched = 0;
    for (const d of page.page) {
      if (d.origin || d.crmProvider) continue;
      const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", d.orgId).eq("projectionId", d._id)).first();
      const first = entity ? await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id)).first() : null;
      await ctx.db.patch(d._id, { origin: first?.source.ref.startsWith("csv:") ? "csv" : "manual" });
      patched++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.deals.backfillOrigin, { cursor: page.continueCursor });
    return { patched, done: page.isDone };
  },
});

export const updateNextStep = mutation({
  args: {
    dealId: v.id("deals"),
    nextStep: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
    const deal = await ctx.db.get(args.dealId);
    if (!deal || deal.orgId !== user.orgId) throw new ConvexError("Deal not found");
    requireDealEdit(await requireWriteAccess(ctx, user), deal, ["nextStep"]);
    const nextStep = args.nextStep.trim();
    if (!nextStep) throw new ConvexError("Next step is required");
    await ctx.db.patch(args.dealId, { nextStep, updatedAt: Date.now() });
    const updated = await ctx.db.get(args.dealId);
    if (updated) await saveDeal(ctx, updated, { kind: "user", userId: user._id }, ["nextStep"]);
    return { dealId: args.dealId, nextStep };
  },
});

export const updateForecast = mutation({
  args: {
    dealId: v.id("deals"),
    forecastCategory: forecastCategoryValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));

    const deal = await ctx.db.get(args.dealId);
    if (!deal || deal.orgId !== user.orgId) {
      throw new ConvexError("Deal not found");
    }
    requireDealEdit(await requireWriteAccess(ctx, user), deal, ["forecastCategory"]);

    const isWon = args.forecastCategory === "closed_won";
    const isClosed = isWon || args.forecastCategory === "closed_lost";
    await ctx.db.patch(args.dealId, {
      forecastCategory: args.forecastCategory,
      isClosed,
      isWon,
      closedAt: isClosed ? deal.closedAt ?? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(args.dealId);
    if (updated) await saveDeal(ctx, updated, { kind: "user", userId: user._id }, ["forecastCategory", "isClosed", "isWon"]);
  },
});
