/**
 * Saved ICPs (lib/icps.ts): a workspace keeps several. Anyone in the workspace
 * reads them; admins and managers edit them. Each active ICP is a gate: an
 * account is in it only when it passes every criterion (AI-field answers
 * included), and its fit is its rank inside the ICPs it passes, 0 outside them.
 * Each change that touches them rescores the workspace (a new icpVersions row,
 * then the record service's /rescore). The default one starts Add records.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { Icp } from "../engine/src/icp.ts";
import { getCurrentUser, requireCap } from "./lib";
import { reconcileFit } from "./fitReconciler";
import { invalidateFit } from "./lib/fitInvalidation";
import { scheduleGapCheck } from "./icpFills";
import { marketView } from "./marketSize";
import { icpMarketFilter } from "./lib/icpGap";
import { icpSpecValidator, type IcpSpec } from "../modules/kernel/icpSpec";
import { MAX_ICPS, specBuyer, specFromIcp } from "./lib/icps";
import { queryToSpec } from "../modules/kernel/icpQuery";
import { checkQuery, removeSubtree, MAX_NODES } from "./icpTree";
import { callerClient, clientFor, requireCaller } from "./records";
import { atLeastVersion } from "./lib/recordClient";
import type { IcpStats } from "./lib/recordContract";
import { modelSettings } from "./lib/recipes";
import { assertLegacyIcpsWritable, interfaceOwner } from "./lib/modules/interfaceOwnership";
import { systemScope } from "./lib/modules/scope";
import { specToQuery } from "../modules/kernel/icpQuery";
import { readIcps } from "./lib/icpsInterface";
import { researchTree, type ResearchTreeNode } from "../modules/kernel/icpResearchTree";
import { cleanResearchSpec, cleanSpecStrings } from "../modules/kernel/icpResearchSpec";

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds strategy.edit. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "strategy.edit");

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Trimmed, de-duplicated and capped, so a spec stays a reasonable search; AI-field criteria must name the workspace's account fields. */
async function cleanSpec(ctx: QueryCtx, orgId: Id<"organizations">, spec: IcpSpec): Promise<IcpSpec> {
  const c = cleanSpecStrings;
  const custom: NonNullable<IcpSpec["custom"]> = [];
  for (const criterion of (spec.custom ?? []).slice(0, 20)) {
    const field = SLUG_RE.test(criterion.slug)
      ? await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", criterion.slug)).unique()
      : null;
    if (!field || field.entityType !== "account") throw new ConvexError(`"${criterion.slug}" is not one of this workspace's account AI fields.`);
    const values = criterion.values ? c(criterion.values, 50) : undefined;
    if (!values?.length && criterion.min === undefined && criterion.max === undefined) throw new ConvexError(`Pick at least one answer for ${field.label}.`);
    custom.push({ slug: criterion.slug, ...(values?.length ? { values } : {}), ...(criterion.min !== undefined ? { min: criterion.min } : {}), ...(criterion.max !== undefined ? { max: criterion.max } : {}) });
  }
  return { ...cleanResearchSpec(spec), ...(custom.length ? { custom } : {}) };
}

/** A point of view is a sentence or two; an empty one clears it. */
export const POINT_OF_VIEW_MAX = 400;
export function cleanPointOfView(text: string | undefined): string | undefined {
  return text?.trim().slice(0, POINT_OF_VIEW_MAX) || undefined;
}

function cleanName(name: string): string {
  const n = name.trim().slice(0, 80);
  if (!n) throw new ConvexError("Name the ICP.");
  return n;
}

const forOrg = (ctx: MutationCtx, orgId: Id<"organizations">) =>
  ctx.db.query("icps").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_ICPS + 1);

async function owned(ctx: MutationCtx, icpId: Id<"icps">, orgId: Id<"organizations">): Promise<Doc<"icps">> {
  await assertLegacyIcpsWritable(ctx, orgId);
  const icp = await ctx.db.get(icpId);
  if (!icp || icp.orgId !== orgId) throw new ConvexError("ICP not found.");
  return icp;
}

/**
 * Insert an ICP. The workspace's first one is active and the default; later
 * ones start inactive, so adding one never changes scores until it is switched on.
 */
export async function insertIcp(ctx: MutationCtx, row: Omit<Doc<"icps">, "_id" | "_creationTime" | "active" | "isDefault" | "createdAt" | "updatedAt"> & { active?: boolean }) {
  await assertLegacyIcpsWritable(ctx, row.orgId);
  const existing = await forOrg(ctx, row.orgId);
  if (existing.length >= MAX_ICPS) throw new ConvexError(`A workspace keeps at most ${MAX_ICPS} ICPs. Delete one first.`);
  const first = existing.length === 0;
  const now = Date.now();
  const active = first || Boolean(row.active);
  const icpId = await ctx.db.insert("icps", {
    ...row, name: cleanName(row.name), spec: await cleanSpec(ctx, row.orgId, row.spec), active, isDefault: first, createdAt: now, updatedAt: now,
  });
  if (active) {
    await invalidateFit(ctx, row.orgId);
    await scheduleGapCheck(ctx, row.orgId, icpId);
  }
  return icpId;
}

async function claimedSession(ctx: QueryCtx, orgId: Id<"organizations">) {
  return ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", orgId)).order("desc").first();
}

/** The workspace's ICPs (default first), whether the caller may edit them, and a claimed research ICP not saved yet. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const moduleOwned = !!(await interfaceOwner(ctx, user.orgId));
    const icps = (await readIcps(ctx, user.orgId)).map((i) => ({ ...i, description: i.description ?? undefined, pointOfView: i.pointOfView ?? undefined, offer: i.offer ?? undefined, _id: i.key as Id<"icps">, _creationTime: i.createdAt, orgId: user.orgId }));
    const session = await claimedSession(ctx, user.orgId);
    const research = session?.icp && !icps.some((i) => i.source === "research" && i.sourceDomain === session.domain)
      ? { domain: session.domain, heuristic: session.icpSource === "heuristic" }
      : null;
    const { buyerLevels } = await modelSettings(ctx, user.orgId, "scoring.fit");
    return { canEdit: !moduleOwned && isManager(user), moduleOwned, icps, research, buyerLevels };
  },
});

/** An ICP's criteria from its spec, or from its query line (modules/kernel/icpQuery.ts) when given instead. */
async function specOf(ctx: QueryCtx, orgId: Id<"organizations">, args: { spec?: IcpSpec; query?: string }): Promise<IcpSpec | undefined> {
  if (args.spec !== undefined && args.query !== undefined) throw new ConvexError("Give the ICP's spec or its query, not both.");
  return args.query !== undefined ? queryToSpec((await checkQuery(ctx, orgId, args.query, "icp")).query) : args.spec;
}

export const create = mutation({
  args: { name: v.string(), description: v.optional(v.string()), pointOfView: v.optional(v.string()), offer: v.optional(v.string()), spec: v.optional(icpSpecValidator), query: v.optional(v.string()), active: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const spec = await specOf(ctx, user.orgId, args);
    if (!spec) throw new ConvexError("Give the ICP's criteria: a spec or a query.");
    return insertIcp(ctx, { orgId: user.orgId, name: args.name, description: args.description?.trim() || undefined, pointOfView: cleanPointOfView(args.pointOfView), offer: cleanPointOfView(args.offer), spec, active: args.active, source: "manual", createdBy: user._id });
  },
});

export const update = mutation({
  args: {
    icpId: v.id("icps"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    pointOfView: v.optional(v.string()),
    offer: v.optional(v.string()),
    spec: v.optional(icpSpecValidator),
    query: v.optional(v.string()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, { query: text, ...rest }) => {
    const user = await requireCap(ctx, "strategy.edit");
    const args = { ...rest, spec: await specOf(ctx, user.orgId, { spec: rest.spec, query: text }) };
    const icp = await owned(ctx, args.icpId, user.orgId);
    const patch: Partial<Doc<"icps">> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = cleanName(args.name);
    if (args.description !== undefined) patch.description = args.description.trim() || undefined;
    if (args.pointOfView !== undefined) patch.pointOfView = cleanPointOfView(args.pointOfView);
    if (args.offer !== undefined) patch.offer = cleanPointOfView(args.offer);
    if (args.spec !== undefined) patch.spec = await cleanSpec(ctx, user.orgId, args.spec);
    if (args.active !== undefined) patch.active = args.active;
    const specChanged = patch.spec !== undefined && JSON.stringify(patch.spec) !== JSON.stringify(icp.spec);
    const scoringChanged = (args.active !== undefined && args.active !== icp.active) || specChanged;
    await ctx.db.patch(icp._id, patch);
    if (scoringChanged) await invalidateFit(ctx, user.orgId);
    // Turned on, or its criteria changed while on: check its market for a gap the TAM doesn't cover.
    if ((args.active ?? icp.active) && (scoringChanged || args.spec !== undefined)) await scheduleGapCheck(ctx, user.orgId, icp._id);
    return null;
  },
});

/** The ICP the Add records form starts from. */
export const setDefault = mutation({
  args: { icpId: v.id("icps") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const icp = await owned(ctx, args.icpId, user.orgId);
    const changed = !icp.isDefault;
    for (const other of await forOrg(ctx, user.orgId)) {
      if (other.isDefault && other._id !== icp._id) await ctx.db.patch(other._id, { isDefault: false });
    }
    await ctx.db.patch(icp._id, { isDefault: true });
    if (changed) await invalidateFit(ctx, user.orgId);
    return null;
  },
});

export const remove = mutation({
  args: { icpId: v.id("icps") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const icp = await owned(ctx, args.icpId, user.orgId);
    await removeSubtree(ctx, icp._id);
    await ctx.db.delete(icp._id);
    if (icp.isDefault) {
      const next = (await forOrg(ctx, user.orgId)).sort((a, b) => Number(b.active) - Number(a.active) || a.createdAt - b.createdAt)[0];
      if (next) await ctx.db.patch(next._id, { isDefault: true });
    }
    if (icp.active || icp.isDefault) await invalidateFit(ctx, user.orgId);
    return null;
  },
});

async function insertResearchNodes(ctx: MutationCtx, orgId: Id<"organizations">, icpId: Id<"icps">, spec: IcpSpec, createdBy?: Id<"users">, nodes = researchTree(spec)) {
  if (!nodes.length) return;
  const existing = await ctx.db.query("icpNodes").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_NODES + 1);
  if (existing.length + nodes.length > MAX_NODES) throw new ConvexError("There is no room for the signup research's segments and personas. Remove unused nodes first.");
  const ids: Id<"icpNodes">[] = [];
  const now = Date.now();
  for (const { parent, ...node } of nodes) ids.push(await ctx.db.insert("icpNodes", {
    ...node, orgId, icpId, ...(parent !== undefined ? { parentId: ids[parent] } : {}), ...(createdBy ? { createdBy } : {}), createdAt: now, updatedAt: now,
  }));
}

async function adoptableResearchNodes(ctx: MutationCtx, sessionId: Id<"researchSessions">, spec: IcpSpec, count: number, supported = true): Promise<ResearchTreeNode[]> {
  let nodes: ResearchTreeNode[] = [], note: string | undefined;
  try { nodes = researchTree(spec); }
  catch { note = "The ICP was saved. Some generated conditions need review before its segments and personas can be added."; }
  if (!supported) note = "The ICP was saved. Upgrade the ICPs module to add its signup segments and personas.";
  else if (count + nodes.length > MAX_NODES) note = "The ICP was saved. Remove unused segments or personas to make room for the signup tree.";
  if (note) await ctx.db.patch(sessionId, { icpNote: note, updatedAt: Date.now() });
  return note ? [] : nodes;
}

/** Save the claimed research's ICP (derived from the workspace's website at signup) as an ICP. */
export const importFromResearch = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    await assertLegacyIcpsWritable(ctx, user.orgId);
    const session = await claimedSession(ctx, user.orgId);
    if (!session?.icp) throw new ConvexError("This workspace has no research ICP to import.");
    const saved = (await forOrg(ctx, user.orgId)).find((i) => i.source === "research" && i.sourceDomain === session.domain);
    if (saved) return saved._id;
    const spec = await cleanSpec(ctx, user.orgId, specFromIcp(session.icp as Icp));
    const icpId = await insertIcp(ctx, {
      orgId: user.orgId, name: `${session.domain} (signup research)`, spec,
      source: "research", sourceDomain: session.domain, createdBy: user._id,
    });
    await insertResearchNodes(ctx, user.orgId, icpId, spec, user._id);
    return icpId;
  },
});

// ───────────────────────────── Internal ─────────────────────────────

export const editor = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!isManager(user)) throw new ConvexError("Only admins and managers can edit ICPs.");
    return { orgId: user.orgId, userId: user._id };
  },
});

/** An ICP derived from a website (icpActions.deriveFromWebsite). */
export const insertDerived = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), name: v.string(), domain: v.string(), spec: icpSpecValidator },
  handler: async (ctx, args) =>
    insertIcp(ctx, { orgId: args.orgId, name: args.name, spec: args.spec, source: "website", sourceDomain: args.domain, createdBy: args.userId }),
});

/**
 * A claimed research session's ICP, saved when it is imported. It is active
 * when nothing else is; returns whether it is the only active ICP.
 */
export const adoptResearch = internalMutation({
  args: { orgId: v.id("organizations"), sessionId: v.id("researchSessions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session?.icp || session.claimedByOrgId !== args.orgId) return false;
    if (await interfaceOwner(ctx, args.orgId)) {
      const existing = await readIcps(ctx, args.orgId);
      const anyActive = existing.some((i) => i.active);
      if (!existing.some((i) => i.source === "research" && i.sourceDomain === session.domain)) {
        const scope = await systemScope(ctx, args.orgId, "@canon/icps");
        if (!scope) throw new ConvexError("The owning ICP provider is unavailable.");
        const spec = await cleanSpec(ctx, args.orgId, specFromIcp(session.icp as Icp));
        const currentNodes = await scope.view("nodes.all", {}) as unknown[];
        const nodes = await adoptableResearchNodes(ctx, args.sessionId, spec, currentNodes.length, !!scope.manifest.ops.adoptResearchNode);
        const root = await scope.op("adoptResearch", { data: { name: `${session.domain} (signup research)`, spec, query: specToQuery(spec), active: !anyActive, isDefault: existing.length === 0, source: "research", sourceDomain: session.domain, createdAt: Date.now() } });
        if (!("key" in root)) throw new ConvexError("Signup adoption must create an ICP.");
        const keys: string[] = [];
        for (const { parent, ...node } of nodes) {
          const result = await scope.op("adoptResearchNode", { data: { ...node, icp: root.key, ...(parent !== undefined ? { parent: keys[parent] } : {}), createdAt: Date.now() } });
          if (!("key" in result)) throw new ConvexError("Signup adoption must create a tree node.");
          keys.push(result.key);
        }
      }
      return !anyActive;
    }
    await assertLegacyIcpsWritable(ctx, args.orgId);
    const existing = await forOrg(ctx, args.orgId);
    const anyActive = existing.some((i) => i.active);
    if (!existing.some((i) => i.source === "research" && i.sourceDomain === session.domain) && existing.length < MAX_ICPS) {
      const now = Date.now();
      const spec = await cleanSpec(ctx, args.orgId, specFromIcp(session.icp as Icp));
      const currentNodes = await ctx.db.query("icpNodes").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(MAX_NODES + 1);
      const nodes = await adoptableResearchNodes(ctx, args.sessionId, spec, currentNodes.length);
      const icpId = await ctx.db.insert("icps", {
        orgId: args.orgId, name: `${session.domain} (signup research)`, spec, active: !anyActive,
        isDefault: existing.length === 0, source: "research", sourceDomain: session.domain,
        ...(session.claimedByUserId ? { createdBy: session.claimedByUserId } : {}), createdAt: now, updatedAt: now,
      });
      await insertResearchNodes(ctx, args.orgId, icpId, spec, session.claimedByUserId, nodes);
      await invalidateFit(ctx, args.orgId);
    }
    return !anyActive;
  },
});

/** Reconcile the current configuration, with durable delivery and snapshot-bound versions. */
export async function rescoreOrg(ctx: ActionCtx, orgId: Id<"organizations">) {
  return reconcileFit(ctx, orgId);
}

export const rescore = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await rescoreOrg(ctx, args.orgId);
    return null;
  },
});

export const viewer = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    return { orgId: user.orgId };
  },
});

export type IcpSizes = Record<string, { market: number | null; tam: number | null; members: number | null; unverified: number | null }>;

export const specsForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<Array<{ id: string; spec: IcpSpec }>> =>
    (await readIcps(ctx, args.orgId)).map((i) => ({ id: i.key, spec: i.spec })),
});

/**
 * Each ICP's three sizes (docs/tam-and-icps.md): its market (companies that exist for its industries,
 * company countries and sizes, from the shared cache), how many of those the CRM holds, and its members
 * (accounts passing its whole gate, active ICPs only). Null where it can't be known.
 */
export const sizes = action({
  args: {},
  handler: async (ctx): Promise<IcpSizes> => {
    const { orgId } = await ctx.runQuery(internal.icps.viewer, {});
    // Gates stored before buyers counted (record service 1.30.0) admit companies with nobody to sell to: rescore
    // once, when the service checks buyers (it may deploy after Convex).
    if (await ctx.runQuery(internal.icps.gatesLackBuyer, { orgId }) && atLeastVersion(await clientFor(ctx).contractVersion(), BUYER_CONTRACT)) {
      await rescoreOrg(ctx, orgId);
    }
    const icps: Array<{ id: string; spec: IcpSpec }> = await ctx.runQuery(internal.icps.specsForOrg, { orgId });
    // Counts over the register are the caller's: a role that sees only some companies counts those (CP14).
    const client = callerClient(ctx, await requireCaller(ctx, { read: true }));
    const stats = await client.icpStats(orgId).catch(() => ({ gates: [] }));
    const out: IcpSizes = {};
    for (const icp of icps) {
      const gate = stats.gates.find((g) => g.id === icp.id);
      const filter = icpMarketFilter(icp.spec);
      const market = filter ? await marketView(ctx, filter, "sizeBand").then((m) => m.total, () => null) : null;
      const tam = filter ? await client.countSegment(orgId, filter).then((r) => r.total, () => null) : null;
      out[icp.id] = { market, tam, members: gate?.members ?? null, unverified: gate?.unverified ?? null };
    }
    return out;
  },
});

/** Per ICP: the accounts inside it, and those it can't decide yet because a value it checks is unknown. */
export const stats = action({
  args: {},
  handler: async (ctx): Promise<IcpStats> => {
    const { orgId } = await ctx.runQuery(internal.icps.viewer, {});
    return callerClient(ctx, await requireCaller(ctx, { read: true })).icpStats(orgId);
  },
});

/** The workspace's active ICPs with their points of view, for the deal drafts (dealPlays.ts, the recipe's pointOfView). */
export const pointsOfView = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const icps = await readIcps(ctx, args.orgId);
    const { buyerLevels } = await modelSettings(ctx, args.orgId, "scoring.fit");
    return icps.filter((i) => i.active).map((i) => ({ id: i.key, name: i.name, pointOfView: i.pointOfView ?? null, offer: i.offer ?? null, isDefault: i.isDefault, createdAt: i.createdAt, buyer: specBuyer(i.spec, buyerLevels) }));
  },
});

/** The record service contract that checks an ICP's buyer (contract.ts IcpGate.buyer). */
const BUYER_CONTRACT = "1.30.0";

/** The workspace's latest accepted gates predate buyers (record service 1.30.0), so its ICP membership ignores who works there. */
export const gatesLackBuyer = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const latest = await ctx.db.query("icpVersions").withIndex("by_orgId_and_version", (q) => q.eq("orgId", args.orgId)).order("desc").first();
    return Boolean(latest?.gates?.some((g) => !g.buyer));
  },
});
