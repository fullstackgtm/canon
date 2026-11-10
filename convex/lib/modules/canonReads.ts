import { orgRecipe, termsFor } from "../recipes";
import { sourceStatus } from "../../moduleMe";
import { accountIdFor } from "../recordClient";
import { OBSERVATION_CHANNELS } from "../signals/observationTouches.ts";
import { fakeModel } from "./ai";
import { specFromIcp, cleanResearchSpec } from "../../../modules/kernel/icpResearchSpec";
import { specToQuery } from "../../../modules/kernel/icpQuery";
import { readIcps } from "../icpsInterface";
import type { Icp } from "../../../engine/src/icp.ts";
import { agentOptionsRead } from "../agents/managementOptions";
/**
 * The Canon records a module's read plan may name (docs/modules.md, "Server code"): deals, members and teams, read
 * only, as the caller sees them, and only the fields the module's install granted (`reads` in its manifest). A deal
 * the caller's role can't see, an archived deal and a field their role hides are left out, as on every other
 * surface. Every record carries its `id` and `createdAt`. Each read goes through an index and refuses past its cap
 * rather than return part of what it names.
 */
import { senderFields, senderReader } from "./senders";
import { inboundMatchInput } from "../../../modules/kernel/inboundMatchInput.ts";
import { SUPPRESSION_PURPOSES, type SuppressionPurpose } from "../suppressions/domain";
import { readPolicy } from "../recordingPolicy";
import { ConvexError } from "convex/values";
import { fiscalMonth } from "../../../modules/kernel/pacing";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { dealVisible } from "../../permissions";
import { canSee } from "../../audiences";
import { withRole } from "../../lib";
import { fieldLevel, isRestricted, permissionOf, type Access } from "../access";
import { stateForReader } from "../plays/state";
import { mayReadText } from "../conversations/intake";
import { runsRead } from "../runs";
import { agentsRead } from "../agentReads";
import { CANON_READS, MAX_IN_VALUES, RECORD_PAGE_MAX, SNAPSHOT_PAGE, type CanonRead, type ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { planFactsRead } from "../../../modules/kernel/facts.ts";
import { isStructuredAttribute } from "../canon/attributes.ts";
import type { AddedSource, RecordReadSpec } from "./recordReads";
import type { ListFilter } from "../objects/listSpec";
import { shardHeads } from "../../ledgerFeed";
import { historyState, MAX_TIME } from "../../dealHistory";
import { proposalOutcomes } from "./recordProposals";
import { dealCustomValues } from "../../objects";
import { callReader, callsRead } from "./transcripts";
import { researchRecords } from "../research/runVisibility";
import { isFactualField } from "../research/agentLoop";
import { estimateRun } from "../research/runPlan";
import { fieldsFor, researchRunsFor } from "../../researchAgents";

/** A module interface doc's people, as the caller read the doc (scope.ts peopleQuery): what people.snapshot freezes. */
export type PeopleQuery = { key: string; source: string; filter: ListFilter[]; added?: AddedSource };

/** The most deals one read carries custom fields for: each is a read of its ledger stream. */
const CUSTOM_DEALS_MAX = 500;
/** How far a deal read looks for the deals the caller sees before it refuses rather than return part of them. */
const DEALS_SCANNED_MAX = 8000;
/** The most users and memberships a member read looks through. */
const MEMBERS_SCANNED_MAX = 2000;

/** A deal's granted fields, by the name a module reads them with (`ownerId` and `splits` are Canon's names). */
const DEAL_FIELDS: Record<string, (d: Doc<"deals">, access: Access) => unknown> = {
  name: (d) => d.name, amount: (d) => d.amount ?? null, currency: (d) => d.currency, closeDate: (d) => d.closeDate, stage: (d) => d.stage ?? null,
  dealType: (d) => d.dealType, revenueType: (d) => d.revenueType, forecastCategory: (d) => d.forecastCategory ?? null, probability: (d) => d.probability ?? null,
  isClosed: (d) => d.isClosed, isWon: (d) => d.isWon, closedAt: (d) => d.closedAt ?? null, nextStep: (d) => d.nextStep ?? null, ownerId: (d) => d.primaryRepId ?? null,
  splits: (d) => d.splitAllocations ?? [], companyId: (d) => d.companyId ?? null,
  products: (d, access) => (permissionOf(access, "lineItem").read && fieldLevel(access, "lineItem", "name") !== "hidden" ? d.lineItemProducts : undefined) ?? d.products ?? [],
  // The company's name is the record service's: a read plan carries the company's id here, and the call's action
  // (convex/modules.ts runCall) puts its name in, as the caller may read it, or null. A deal synced from a CRM that no
  // person linked to a company names its CRM account instead, as Canon's deals list does (`withCrmAccountNames`).
  companyName: (d) => d.companyId ?? (d.accountId ? { crmAccount: d.accountId } : null),
  contractLengthMonths: (d) => d.contractLengthMonths ?? null, arr: (d) => d.arr ?? null, mrr: (d) => d.mrr ?? null, createdAt: (d) => d.createdAt,
  updatedAt: (d) => d.updatedAt, crmProvider: (d) => d.crmProvider ?? null, crmId: (d) => d.crmId ?? null,
  // How the deal came in: the CRM it syncs from, else how Canon created it (`manual`, `csv`); null where not recorded.
  source: (d) => d.crmProvider ?? d.origin ?? null,
};
/** The deal fields a role's field rules may hide, by the module's name for them: a company's name hides with its link. */
export const DEAL_API_NAME: Record<string, string> = { ownerId: "ownerId", splits: "splitAllocations", companyName: "companyId" };

type Member = { user: Doc<"users">; role: string; isActive: boolean };
const USER_FIELDS: Record<string, (m: Member) => unknown> = {
  name: (m) => m.user.name, email: (m) => m.user.email, role: (m) => m.role, managerId: (m) => m.user.managerId ?? null,
  startDate: (m) => m.user.startDate ?? null, endDate: (m) => m.user.endDate ?? null, title: (m) => m.user.title ?? null,
  department: (m) => m.user.department ?? null, isActive: (m) => m.isActive,
};
const TEAM_FIELDS: Record<string, (t: Doc<"teamGroups">) => unknown> = {
  name: (t) => t.name, managerId: (t) => t.managerId ?? null, memberIds: (t) => t.memberIds,
};

const refuse = (message: string): never => { throw new ConvexError(message); };

/** A deal's `fields`, by the names a module reads them with; `companyName` only a call's read resolves, so a join has none. */
export const dealFieldsOf = (d: Doc<"deals">, fields: readonly string[], access: Access) => Object.fromEntries(fields.filter((f) => Object.hasOwn(DEAL_FIELDS, f) && f !== "companyName").map((f) => [f, DEAL_FIELDS[f](d, access)]));
/** A member's `fields` from their user row (their home workspace's role and status). */
export const memberFieldsOf = (u: Doc<"users">, fields: readonly string[]) => {
  const m: Member = { user: u, role: u.role, isActive: u.isActive };
  return Object.fromEntries(fields.filter((f) => Object.hasOwn(USER_FIELDS, f)).map((f) => [f, USER_FIELDS[f](m)]));
};

/**
 * The workspace's members, as `workspaceMembers` reads them (home-org users and memberships, never hidden ones),
 * sorted by name. `inactive`: those who left too, with `isActive` false.
 */
async function members(ctx: QueryCtx, orgId: Id<"organizations">, inactive: boolean, read: string): Promise<Member[]> {
  const out = new Map<string, Member>();
  const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MEMBERS_SCANNED_MAX + 1);
  const memberships = await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MEMBERS_SCANNED_MAX + 1);
  if (users.length > MEMBERS_SCANNED_MAX || memberships.length > MEMBERS_SCANNED_MAX) refuse(`${read} reads more than ${MEMBERS_SCANNED_MAX} members.`);
  for (const u of users) if (!u.isHidden && (inactive || u.isActive)) out.set(u._id, { user: u, role: u.role, isActive: u.isActive });
  for (const m of memberships) {
    const u = m.isActive || inactive ? await ctx.db.get(m.userId) : null;
    if (u && !u.isHidden) out.set(u._id, { user: u, role: m.role, isActive: m.isActive });
    else if (!m.isActive) out.delete(m.userId);
  }
  return [...out.values()].sort((a, b) => a.user.name.localeCompare(b.user.name));
}

/**
 * The workspace's members as a report's rows (docs/modules.md, "Reports and charts"), those who left too: each one's
 * granted `fields`, their `team` (the first, by name, they are on or manage) and themselves as `member`. Only the
 * members `owners` names when given: the caller's role-derived owner scope, as their deals are.
 */
export async function memberReportRows(ctx: QueryCtx, orgId: Id<"organizations">, fields: readonly string[], owners: readonly string[] | null) {
  const teams = (await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MEMBERS_SCANNED_MAX)).sort((a, b) => a.name.localeCompare(b.name));
  return (await members(ctx, orgId, true, "A team report"))
    .filter((m) => owners === null || owners.includes(m.user._id))
    .map((m) => ({
      id: m.user._id as string, createdAt: m.user.createdAt,
      data: {
        ...Object.fromEntries(fields.filter((f) => Object.hasOwn(USER_FIELDS, f)).map((f) => [f, USER_FIELDS[f](m)])),
        member: m.user._id as string, team: teams.find((t) => t.managerId === m.user._id || t.memberIds.includes(m.user._id))?.name ?? null,
      } as Record<string, unknown>,
    }));
}

/** One Canon read of a read plan, as `access` sees it: at most `limit` records, or a refusal when there are more. */
export async function canonRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, manifest: ModuleManifest, read: CanonRead, args: Record<string, unknown>, limit: number, withCustomFields = false) {
  if (read === "deals.state") {
    if (!access || !permissionOf(access, "deal").read || isRestricted(access)) return [];
    const out: Array<Record<string, unknown>> = [];
    const plays = manifest.reads?.dealState?.includes("terms") ? (await orgRecipe(ctx, orgId)).plays : null;
    const terms = plays ? termsFor(plays) : [];
    for (const raw of idsOf(read, args.ids)) {
      const id = ctx.db.normalizeId("deals", raw);
      const deal = id ? await ctx.db.get(id) : null;
      if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined || !dealVisible(access, deal)) continue;
      if (out.length >= limit) refuse(`${read} reads more than ${limit} deals.`);
      const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", deal._id)).first();
      const play = entity ? await ctx.db.query("dealPlays").withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", orgId).eq("streamId", entity._id)).unique() : null;
      const visible = { ...stateForReader(play?.state ?? null, { restricted: isRestricted(access), mayRead: (owner) => mayReadText(access, owner) }), terms };
      out.push({ id: deal._id, createdAt: deal.createdAt, ...Object.fromEntries((manifest.reads?.dealState ?? []).map((f) => [f, visible[f as keyof typeof visible]])) });
    }
    return out;
  }
  if (read === "deals.conversations") return refuse("deals.conversations is read in a call action.");
  if (read === "me.status") {
    if (access.userId === "system") return refuse("Personal context requires a member.");
    if (!["profile", "posts", "counterparts"].every((f) => manifest.reads?.me?.includes(f))) return refuse("me.status requires its install grants.");
    return sourceStatus(ctx, orgId, access.userId as Id<"users">);
  }
  if (read === "me.context") return refuse("me.context is an explicit member action read, unavailable in queries and printing.");
  if (read === "social.search") return refuse("social.search is an explicit action read, unavailable in queries and printing.");
  if (read === "market.sample") return refuse("market.sample is an explicit action read.");
  if (read === "ai.plan") {
    if (access.userId === "system") return refuse("Plan status requires a member.");
    const userId = ctx.db.normalizeId("users", access.userId);
    const row = userId ? await ctx.db.query("chatgptAuth").withIndex("by_userId", (q) => q.eq("userId", userId)).unique() : null;
    const status = fakeModel() ? "test-model" : row?.status ?? "signed-out";
    const fields = manifest.reads?.plan ?? [];
    const value = { status, available: (status === "connected" && Boolean(row?.accessToken && row.refreshToken && row.idToken && row.accountId)) || status === "test-model" };
    return [{ id: access.userId, ...Object.fromEntries(fields.map((f) => [f, value[f as keyof typeof value]])) }];
  }
  if (read === "web.pages" || read === "web.search") return refuse(`${read} is an explicit action read, unavailable in queries and printing.`);
  if (read === "research.signup") {
    if (access.userId === "system") return refuse("Signup research requires a member.");
    const fields = manifest.reads?.signup;
    if (!fields?.length) return refuse("This module has no signup research grant.");
    const session = await ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", orgId)).order("desc").first();
    if (!session?.icp) return [];
    if (fields.includes("icp") && JSON.stringify(session.icp).length > 20_000) return refuse("The claimed current ICP exceeds this bounded read.");
    const spec = cleanResearchSpec(specFromIcp(session.icp as Icp));
    const row = { icp: session.icp, sells: [...(session.marketSegments?.jobs ?? []), ...(session.marketSegments?.buyers ?? []).map((b) => `Sold to ${b.label}: ${b.why}`)].slice(0, 60).map((s) => s.slice(0, 500)), domain: session.domain.slice(0, 253), spec, query: specToQuery(spec), heuristic: session.icpSource === "heuristic", saved: (await readIcps(ctx, orgId)).some((i) => i.source === "research" && i.sourceDomain === session.domain) };
    return [{ id: session._id as string, createdAt: session.createdAt, ...Object.fromEntries(fields.map((f) => [f, row[f as keyof typeof row]])) }];
  }
  const over = (what: string) => refuse(`${read} has more than ${limit} ${what}; ${read.startsWith("deals.") ? "narrow it or " : ""}raise the read's limit.`);
  if (read === "senders.byIds" || read === "senders.forMembers") {
    const fields = manifest.reads?.senders;
    if (!fields) return refuse("This module has no sender read grant.");
    const ids = idsOf(read, args.ids);
    const reader = senderReader(ctx, orgId, access);
    const rows = read === "senders.forMembers" ? await reader.forMembers(ids, limit)
      : (await Promise.all(ids.map((id) => reader.byId(id)))).filter((s) => s !== null);
    if (rows.length > limit) over("senders");
    return rows.map((s) => ({ id: s.id, createdAt: s.createdAt, ...senderFields(s, fields) }));
  }
  if (read === "users.all" || read === "users.withInactive") {
    const fields = manifest.reads?.users ?? [];
    const list = await members(ctx, orgId, read === "users.withInactive", read);
    if (list.length > limit) over("members");
    return list.map((m) => ({ id: m.user._id as string, createdAt: m.user.createdAt, ...Object.fromEntries(fields.map((f) => [f, USER_FIELDS[f](m)])) }));
  }
  if (read === "proposals.byIds") {
    // The module's own proposals (docs/modules.md, "Writes to Canon records"): another module's, or none, read as missing.
    const ids = args.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return refuse("proposals.byIds needs ids, a list of proposal ids.");
    if (new Set(ids).size > MAX_IN_VALUES) refuse(`proposals.byIds names ${new Set(ids).size} proposals; one read takes at most ${MAX_IN_VALUES}.`);
    const fields = manifest.reads?.proposals ?? [];
    return (await proposalOutcomes(ctx, orgId, manifest.id, access, ids as string[])).map((p) => ({
      id: p.id, createdAt: p.createdAt, ...Object.fromEntries(fields.map((f) => [f, p[f as keyof typeof p]])),
    }));
  }
  if (read === "recording.policy") {
    const policy = await readPolicy(ctx, orgId);
    const fields = manifest.reads?.recording ?? [];
    const allowed = { consent: policy.consent, internalRecording: policy.internalRecording, internalDomains: policy.internalDomains, retentionDays: policy.retentionDays, region: policy.region };
    return [{ id: orgId as string, createdAt: 0, ...Object.fromEntries(fields.filter((f) => Object.hasOwn(allowed, f)).map((f) => [f, allowed[f as keyof typeof allowed]])) }];
  }
  if (read === "targets.forYear") return targetsRead(ctx, orgId, manifest, args);
  if (read === "agents.options") return agentOptionsRead(ctx, orgId, access, manifest.reads?.agentOptions ?? [], args, limit);
  if (read === "research.fields") return researchFields(ctx, orgId, access, manifest, args, limit);
  if (read === "research.runs" || read === "research.traces") {
    if (!access || access.userId === "system") return refuse(`${read} reads as a person.`);
    const project = (row: Record<string, unknown>, fields: readonly string[]) => ({ id: row.id, createdAt: row.createdAt ?? 0, ...Object.fromEntries(fields.map((f) => [f, row[f] ?? null])) });
    if (read === "research.traces") {
      const id = typeof args.run === "string" ? ctx.db.normalizeId("researchRuns", args.run) : null;
      const run = id ? await ctx.db.get(id) : null;
      if (!run || run.orgId !== orgId) return [];
      const { records } = await researchRecords(ctx, orgId, access, run);
      if (records.length > limit) over("record traces");
      return records.map((row) => project(row, manifest.reads?.researchTraces ?? []));
    }
    if (typeof args.slug !== "string" || (args.run !== undefined && typeof args.run !== "string")) return refuse("research.runs needs a field slug and an optional run id.");
    const userId = ctx.db.normalizeId("users", access.userId);
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user) return [];
    const rows = await researchRunsFor(ctx, { ...user, orgId }, access, args.slug, args.run);
    if (rows.length > limit) over("research runs");
    return rows.map((row) => project({ ...row, progress: row.planned ? (row.done + row.errors) / row.planned : 0 }, manifest.reads?.researchRuns ?? []));
  }
  if (read === "research.answers") return refuse("research.answers requires scoped admission in a call's action.");
  if (read === "runs.between" || read === "runs.cli" || read === "runs.artifact" || read === "runs.research") return runsRead(ctx, orgId, access, manifest.reads?.runs ?? [], read, args, limit);
  if (read === "agents.event" || read === "agents.turns" || read === "agents.grants") return agentsRead(ctx, orgId, access, manifest.reads, read, args, limit);
  if (read === "calls.between" || read === "calls.byIds" || read === "calls.transcript") return callsRead(ctx, callReader(ctx, orgId, access), manifest, read, args, limit);
  if (read === "teams.all") {
    const fields = manifest.reads?.teams ?? [];
    const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(limit + 1);
    if (teams.length > limit) over("teams");
    return teams.map((t) => ({ id: t._id as string, createdAt: t.createdAt, ...Object.fromEntries(fields.map((f) => [f, TEAM_FIELDS[f](t)])) }));
  }

  if (read === "audiences.all") {
    const fields = manifest.reads?.audiences ?? [];
    const sees = await audienceViewer(ctx, orgId, access);
    const list = (await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(AUDIENCES_SCANNED_MAX)).filter(sees);
    if (list.length > limit) over("audiences you can see");
    return list.map((a) => ({ id: a._id as string, createdAt: a.createdAt, ...Object.fromEntries(fields.map((f) => [f, AUDIENCE_FIELDS[f](a)])) }));
  }

  if (!permissionOf(access, "deal").read) return [];
  const granted = (manifest.reads?.deals ?? []).filter((f) => fieldLevel(access, "deal", DEAL_API_NAME[f] ?? f) !== "hidden");
  // `custom`: each deal's custom fields, from its ledger stream (objects.ts dealCustomValues), for a read that asks.
  const custom = withCustomFields && granted.includes("custom");
  const fields = granted.filter((f) => f !== "custom");
  const out: Array<Record<string, unknown>> = [];
  const add = (d: Doc<"deals">) => {
    if (d.archivedAt !== undefined || !dealVisible(access, d)) return;
    if (out.length >= limit) over("deals you can see");
    out.push({ id: d._id as string, createdAt: d.createdAt, ...Object.fromEntries(fields.map((f) => [f, DEAL_FIELDS[f](d, access)])) });
  };
  const withCustom = async (rows: Array<Record<string, unknown>>) => {
    if (!custom || !rows.length) return rows;
    if (rows.length > CUSTOM_DEALS_MAX) refuse(`${read} reads ${rows.length} deals' custom fields; one read carries them for at most ${CUSTOM_DEALS_MAX}. Narrow it.`);
    const values = await dealCustomValues(ctx, orgId, rows.map((r) => String(r.id)), (apiName) => fieldLevel(access, "deal", apiName) !== "hidden");
    return rows.map((r) => ({ ...r, custom: values[String(r.id)] ?? {} }));
  };
  if (read === "deals.latestClosed") {
    if (access.userId === "system" || typeof args.won !== "boolean") return refuse("deals.latestClosed requires a member and a won boolean.");
    if (["closeDate", "isClosed", "isWon"].some((f) => fieldLevel(access, "deal", f) === "hidden")) return [];
    const latest = await ctx.db.query("deals").withIndex("by_orgId_closeDate", (q) => q.eq("orgId", orgId)).order("desc").take(300);
    for (const d of latest) {
      if (!d.isClosed || d.isWon !== args.won || d.archivedAt !== undefined || !dealVisible(access, d)) continue;
      if (out.length >= Math.min(limit, 15)) break;
      const account = fields.includes("companyId") && !d.companyId && d.accountId ? await ctx.db.get(d.accountId) : null;
      const companyId = d.companyId ?? (account?.orgId === orgId && account.domain ? accountIdFor(account.domain) : null);
      out.push({ id: d._id as string, createdAt: d.createdAt, ...Object.fromEntries(fields.filter((f) => f !== "companyName").map((f) => [f, f === "companyId" ? companyId : DEAL_FIELDS[f](d, access)])) });
    }
    return out;
  }
  if (read === "deals.byIds") {
    // One id (a page's bound deal) reads as a list of one; none reads nothing.
    const ids = typeof args.ids === "string" ? [args.ids] : args.ids === null || args.ids === undefined ? [] : args.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return refuse("deals.byIds needs ids, a list of deal ids.");
    const unique = [...new Set(ids as string[])];
    if (unique.length > MAX_IN_VALUES) refuse(`deals.byIds names ${unique.length} deals; one read takes at most ${MAX_IN_VALUES}.`);
    for (const raw of unique) {
      const id = ctx.db.normalizeId("deals", raw);
      const d = id ? await ctx.db.get(id) : null;
      if (d && d.orgId === orgId) add(d);
    }
    return withCustom(await withCrmAccountNames(ctx, orgId, out));
  }
  // A change's two sides carry no company name: only a flat read of deals resolves it (convex/modules.ts fillCompanyNames).
  if (read === "deals.asOf" || read === "deals.changesBetween") return dealHistoryRead(ctx, orgId, access, read, args, read === "deals.changesBetween" ? fields.filter((f) => f !== "companyName") : fields, limit);
  let rows: AsyncIterable<Doc<"deals">>, what: string;
  if (read === "deals.forOwner") {
    // One member's deals by the owner index: a rep's own deals read without the workspace's.
    const owner = typeof args.owner === "string" ? ctx.db.normalizeId("users", args.owner) : null;
    if (!owner) return refuse("deals.forOwner needs owner, a member's id.");
    rows = ctx.db.query("deals").withIndex("by_orgId_and_primaryRepId", (q) => q.eq("orgId", orgId).eq("primaryRepId", owner));
    what = "for that owner";
  } else if (read === "deals.updatedSince") {
    const { since } = args;
    if (typeof since !== "number") return refuse("deals.updatedSince needs since, a time in ms.");
    rows = ctx.db.query("deals").withIndex("by_orgId_updatedAt", (q) => q.eq("orgId", orgId).gte("updatedAt", since));
    what = `since ${new Date(since).toISOString()}`;
  } else {
    const { from, to } = args;
    if (typeof from !== "string" || typeof to !== "string") return refuse("deals.closedBetween needs from and to as dates, YYYY-MM-DD.");
    rows = ctx.db.query("deals").withIndex("by_orgId_closeDate", (q) => q.eq("orgId", orgId).gte("closeDate", from).lte("closeDate", to));
    what = `${from} to ${to}`;
  }
  let scanned = 0;
  for await (const d of rows) {
    if (++scanned > DEALS_SCANNED_MAX) refuse(`${read} ${what} reads more than ${DEALS_SCANNED_MAX} deals; narrow it.`);
    add(d);
  }
  return withCustom(await withCrmAccountNames(ctx, orgId, out));
}

/**
 * The deals' `companyName` where it names a CRM account (`{ crmAccount }`): that account's name, as `{ crm: name }`
 * (the call's action keeps it, where it reads a register company's id from the record service), or null.
 */
async function withCrmAccountNames(ctx: QueryCtx, orgId: Id<"organizations">, deals: Array<Record<string, unknown>>) {
  const names = new Map<string, string | null>();
  for (const d of deals) {
    const v = d.companyName;
    if (v === null || typeof v !== "object" || !("crmAccount" in v)) continue;
    const id = String((v as { crmAccount: string }).crmAccount);
    if (!names.has(id)) {
      const row = await ctx.db.get(id as Id<"crmAccounts">);
      names.set(id, row && row.orgId === orgId ? row.name : null);
    }
    const name = names.get(id);
    d.companyName = name ? { crm: name } : null;
  }
  return deals;
}

/** The most deals a field's suggestions look through, newest changed first. */
const SUGGEST_DEALS_SCANNED = 2000;
/**
 * The values a granted deal field holds across the deals the caller sees (not archived, not a field their role
 * hides), most used first, matching `search`: a form's suggestions for a deal field's value (docs/modules.md, "Forms").
 */
export async function dealValues(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, manifest: ModuleManifest, field: string, search: string, max: number): Promise<string[]> {
  if (!(manifest.reads?.deals ?? []).includes(field as never) || !Object.hasOwn(DEAL_FIELDS, field) || field === "companyName") return refuse(`${manifest.title} doesn't read deals' ${field}.`);
  if (!permissionOf(access, "deal").read || fieldLevel(access, "deal", DEAL_API_NAME[field] ?? field) === "hidden") return [];
  const needle = search.trim().toLowerCase();
  const seen = new Map<string, number>();
  let scanned = 0;
  for await (const d of ctx.db.query("deals").withIndex("by_orgId_updatedAt", (q) => q.eq("orgId", orgId)).order("desc")) {
    if (++scanned > SUGGEST_DEALS_SCANNED) break;
    if (d.archivedAt !== undefined || !dealVisible(access, d)) continue;
    for (const v of [DEAL_FIELDS[field](d, access)].flat()) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
      const t = String(v);
      if (t.trim() && (!needle || t.toLowerCase().includes(needle))) seen.set(t, (seen.get(t) ?? 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([v]) => v);
}

/** A list argument's ids: a list of texts, or one id (a page's bound deal). */
function idsOf(read: CanonRead, raw: unknown): string[] {
  const list = typeof raw === "string" ? [raw] : raw === null || raw === undefined ? [] : raw;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return refuse(`${read} needs ids, a list of ids.`);
  const ids = [...new Set(list as string[])].filter((x) => x.length > 0);
  if (ids.length > MAX_IN_VALUES) refuse(`${read} names ${ids.length} records; one read takes at most ${MAX_IN_VALUES}.`);
  return ids;
}

/** The most audiences `audiences.all` looks through. */
const AUDIENCES_SCANNED_MAX = 1000;
const AUDIENCE_FIELDS: Record<string, (a: Doc<"audiences">) => unknown> = {
  name: (a) => a.name, size: (a) => a.summary?.total ?? null, shared: (a) => a.shared !== false, createdBy: (a) => a.createdBy,
};
/** Whether `access` sees an audience, as on the Audiences page (convex/audiences.ts canSee); Canon's own sees every one. */
async function audienceViewer(ctx: QueryCtx, orgId: Id<"organizations">, access: Access | null): Promise<(a: Doc<"audiences">) => boolean> {
  if (!access || access.userId === "system") return (a) => a.orgId === orgId;
  const id = ctx.db.normalizeId("users", access.userId);
  const user = id ? await withRole(ctx, await ctx.db.get(id)) : null;
  return (a) => user !== null && user.orgId === orgId && canSee({ ...user, role: access.role }, a);
}

/** The most contacts one deal lists (its edges, or its legacy rows while it has none), as the deal page reads them. */
const DEAL_MEMBERS_MAX = 200;
/**
 * deals.people, in the plan's query: the people on each deal the caller sees (Canon's own: every one), by its
 * `deal_contact` edges, or its legacy committee rows while it has no edge (convex/dealCommittee.ts membersOf). The
 * action then reads the people as the caller sees them.
 */
async function dealMembers(ctx: QueryCtx, orgId: Id<"organizations">, access: Access | null, dealIds: readonly string[]): Promise<{ ids: string[]; members: NonNullable<RecordReadSpec["members"]> }> {
  const members: NonNullable<RecordReadSpec["members"]> = {};
  if (access && !permissionOf(access, "deal").read) return { ids: [], members };
  for (const raw of dealIds) {
    const id = ctx.db.normalizeId("deals", raw);
    const deal: Doc<"deals"> | null = id ? await ctx.db.get(id) : null;
    if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined || (access && !dealVisible(access, deal))) continue;
    const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", deal._id)).first();
    const edges = stream ? await ctx.db.query("associations")
      .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", orgId).eq("association", "deal_contact").eq("fromId", stream._id))
      .take(DEAL_MEMBERS_MAX) : [];
    const on = edges.length
      ? edges.filter((e) => e.active).sort((a, b) => a.createdAt - b.createdAt).map((e) => ({ contactId: e.toId, role: e.label ?? "" }))
      : (await ctx.db.query("dealContacts").withIndex("by_dealId", (q) => q.eq("dealId", deal._id)).take(DEAL_MEMBERS_MAX)).map((r) => ({ contactId: r.contactId, role: r.slot as string }));
    for (const m of on) (members[m.contactId] ??= []).push({ dealId: deal._id, role: m.role });
  }
  return { ids: Object.keys(members), members };
}

/**
 * In the plan's query: a record read's ids and granted fields, and for a deal's activities each deal's stream. An
 * audience snapshot's audience (as the caller sees it), its filter and the people added to it one at a time; an
 * audience page's ids, from a snapshot this module took in this workspace.
 */
export async function planRecordRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access | null, manifest: ModuleManifest, read: CanonRead, args: Record<string, unknown>, limit: number, moduleId?: string, query?: PeopleQuery): Promise<RecordReadSpec> {
  if (read === "deals.conversations") {
    if (!access || access.userId === "system") return refuse("deals.conversations requires a member.");
    const companies: Record<string, string> = {};
    const ids: string[] = [];
    for (const raw of idsOf(read, args.ids)) {
      const id = ctx.db.normalizeId("deals", raw);
      const deal = id ? await ctx.db.get(id) : null;
      if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined || !permissionOf(access, "deal").read || !dealVisible(access, deal)) continue;
      ids.push(deal._id);
      if (deal.companyId && fieldLevel(access, "deal", "companyId") !== "hidden") companies[deal._id] = deal.companyId;
    }
    return { read, ids, companies, since: null, limit, fields: [...(manifest.reads?.conversations ?? [])] };
  }
  if (read === "companies.bestFit") {
    if (!access || access.userId === "system") return refuse("companies.bestFit requires a member.");
    if (!permissionOf(access, "account").read || fieldLevel(access, "account", "fit") === "hidden") return { read, ids: [], since: null, limit: 0, fields: [] };
    return { read, ids: [], since: null, limit: Math.min(limit, 15), fields: [...(manifest.reads?.companies ?? [])] };
  }
  if (read === "match.inbound") {
    if (access !== null) return refuse("match.inbound runs only as Canon.");
    if (typeof args.email !== "string" || (args.companyName !== undefined && args.companyName !== null && typeof args.companyName !== "string")) return refuse("match.inbound needs an email and an optional company name.");
    let match;
    try { match = inboundMatchInput({ email: args.email, ...(typeof args.companyName === "string" ? { companyName: args.companyName } : {}) }); }
    catch { return refuse("match.inbound needs a valid email address and a company name of at most 200 characters."); }
    return { read, ids: [], since: null, limit: 1, fields: [...(manifest.reads?.match ?? [])], match };
  }
  if (read === "people.snapshot" || read === "people.count") {
    if (!moduleId || !query) return refuse(`${read} is read by a module.`);
    return { read, ids: [query.key], since: null, limit, fields: [], audience: { moduleId, filter: query.filter, source: query.source, ...(query.added ? { added: query.added } : {}) } };
  }
  if (read === "audiences.snapshot") {
    const id = typeof args.audience === "string" ? ctx.db.normalizeId("audiences", args.audience) : null;
    const audience = id ? await ctx.db.get(id) : null;
    if (!audience || !(await audienceViewer(ctx, orgId, access))(audience)) return refuse("audiences.snapshot names an audience you can't see.");
    if (!moduleId) return refuse("audiences.snapshot is read by a module.");
    // The people added one at a time are read in the action, a page at a time (an array crosses here only up to 8,192).
    return { read, ids: [audience._id], since: null, limit, fields: [], audience: { moduleId, filter: audience.filter } };
  }
  if (read === "audiences.members" || read === "people.snapshotPage") {
    const page = typeof args.page === "number" ? args.page : typeof args.page === "string" && /^\d+$/.test(args.page) ? Number(args.page) : null;
    if (typeof args.snapshot !== "string" || page === null) return refuse(`${read} needs snapshot, a snapshot's id, and page, a page number from 0.`);
    const row = moduleId ? await ctx.db.query("moduleSnapshots").withIndex("by_orgId_moduleId_snapshot_page", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("snapshot", args.snapshot as string).eq("page", page)).unique() : null;
    if (!row && page === 0) return refuse(`${read} names a snapshot this module doesn't have, or one that expired.`);
    return { read, ids: row?.ids ?? [], since: null, limit: Math.max(limit, SNAPSHOT_PAGE), fields: [...(manifest.reads?.people ?? [])].filter((f) => f !== "suppression"), ...(access && access.userId !== "system" && manifest.reads?.people?.includes("suppression") ? { withSuppression: true } : {}) };
  }
  if (read === "suppression.check") {
    if (!access || access.userId === "system" || !manifest.reads?.people?.includes("suppression")) return refuse("suppression.check needs a caller and the people.suppression grant.");
    const purpose = args.purpose ?? "automated_outreach";
    if (!(SUPPRESSION_PURPOSES as readonly unknown[]).includes(purpose)) return refuse("Choose a supported suppression preview purpose.");
    return { read, ids: idsOf(read, args.ids), since: null, limit, fields: [], withSuppression: true, purpose: purpose as SuppressionPurpose };
  }
  if (read === "facts.forRecords") {
    if (!access || access.userId === "system") return refuse("facts.forRecords requires a member.");
    const plan = planFactsRead(manifest.facts, args);
    if ("problem" in plan) return refuse(plan.problem);
    const entityType = plan.object === "deals" ? "opportunity" : plan.object === "companies" ? "account" : "contact";
    const structured = plan.attributes.filter((a) => isStructuredAttribute(entityType, a));
    if (structured.length) return refuse(`facts.forRecords reads one value per field; ${structured.join(", ")} has several (read deals.byIds).`);
    return { read, ids: plan.ids, since: null, limit, fields: [], facts: { object: plan.object, attributes: plan.attributes, receipts: plan.receipts } };
  }
  if (read === "observations.forPeople") {
    const ms = (k: "since" | "until") => args[k] === null || args[k] === undefined ? null : typeof args[k] === "number" ? args[k] as number : refuse(`${read} needs ${k} as a time in ms.`);
    const types = args.types === null || args.types === undefined ? undefined : Array.isArray(args.types) && args.types.every((t) => (OBSERVATION_CHANNELS as readonly unknown[]).includes(t)) ? args.types as string[] : refuse(`${read} types are some of ${OBSERVATION_CHANNELS.join(", ")}.`);
    return { read, ids: idsOf(read, args.people), since: ms("since"), until: ms("until"), ...(types ? { types } : {}), limit, fields: [...(manifest.reads?.observations ?? [])] };
  }
  if (read === "companies.updatedSince" || read === "people.updatedSince") {
    const object = read === "companies.updatedSince" ? "companies" : "people";
    if (typeof args.since !== "number") return refuse(`${read} needs since, a time in ms.`);
    const text = (k: "cursor" | "owner") => args[k] === null || args[k] === undefined || args[k] === "" ? null : typeof args[k] === "string" && (args[k] as string).length <= 400 ? args[k] as string : refuse(`${read} takes ${k} as text.`);
    const owner = text("owner");
    if (owner !== null && !manifest.reads?.[object]?.includes("ownerId" as never)) return refuse(`${read} filters by owner, which reads.${object} doesn't grant (ownerId).`);
    const granted = [...(manifest.reads?.[object] ?? [])] as string[];
    return {
      read, ids: [], since: args.since, limit: Math.min(limit, RECORD_PAGE_MAX), fields: granted.filter((f) => f !== "suppression"), page: { cursor: text("cursor"), owner },
      ...(object === "people" && access && access.userId !== "system" && granted.includes("suppression") ? { withSuppression: true } : {}),
    };
  }
  const object = CANON_READS[read].object as "companies" | "people" | "activities";
  const since = args.since === null || args.since === undefined ? null : typeof args.since === "number" ? args.since : refuse(`${read} needs since as a time in ms.`);
  const spec: RecordReadSpec = { read, ids: idsOf(read, args.ids), since, limit, fields: [...(manifest.reads?.[object] ?? [])].filter((f) => f !== "suppression"), ...(object === "people" && access && access.userId !== "system" && manifest.reads?.people?.includes("suppression") ? { withSuppression: true } : {}) };
  // An activity read sees every activity the ledger holds now (a watch's job reads the meeting that woke it), or refuses.
  if (object === "activities") spec.through = await shardHeads(ctx, orgId);
  if (read === "deals.people") return { ...spec, ...await dealMembers(ctx, orgId, access, spec.ids) };
  if (read !== "activities.forDeals") return spec;
  // A deal's activities name its ledger stream; only the deals the caller sees are asked about (Canon's own: every one).
  const streams: Record<string, string> = {};
  if (access && !permissionOf(access, "deal").read) return { ...spec, ids: [], streams };
  for (const raw of spec.ids) {
    const id = ctx.db.normalizeId("deals", raw);
    const deal: Doc<"deals"> | null = id ? await ctx.db.get(id) : null;
    if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined || (access && !dealVisible(access, deal))) continue;
    const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", deal._id)).first();
    if (entity) streams[entity._id] = deal._id;
  }
  return { ...spec, ids: Object.keys(streams), streams };
}

/**
 * targets.forYear (forecast plan P8): the workspace's saved target plan for a fiscal year, as Settings > Targets saves it
 * (convex/targets.ts): each rep's and team's target by fiscal month, `months` their sum, all in minor units. `year`
 * names the fiscal year by the year it ends in; `on` (a date) names the fiscal year holding that day. One record, or
 * none when no plan is saved. Every member reads it, as Reports does.
 */
async function targetsRead(ctx: QueryCtx, orgId: Id<"organizations">, manifest: ModuleManifest, args: Record<string, unknown>) {
  const fyStart = (await ctx.db.get(orgId))?.fiscalYearStartMonth ?? 1;
  const year = args.year === undefined && args.on === undefined ? fiscalMonth(new Date().toISOString().slice(0, 10), fyStart).fy : typeof args.year === "number" ? args.year : typeof args.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.on) ? fiscalMonth(args.on, fyStart).fy : null;
  if (year === null) return refuse("targets.forYear needs year, a fiscal year, or on, a date in it (YYYY-MM-DD).");
  const plan = await ctx.db.query("targetPlans").withIndex("by_orgId_and_year", (q) => q.eq("orgId", orgId).eq("year", year)).unique();
  if (!plan) return [];
  const months = Array.from({ length: 12 }, (_, m) => Object.values(plan.teamMonths ?? {}).reduce((n, t) => n + (t[m] ?? 0), 0));
  const all: Record<string, unknown> = { year, fyStart: plan.fyStart ?? fyStart, total: plan.total, coverage: plan.coverage, months, repMonths: plan.repMonths ?? {}, teamMonths: plan.teamMonths ?? {}, repTeam: plan.repTeam ?? {} };
  return [{ id: plan._id as string, createdAt: plan.updatedAt, ...Object.fromEntries((manifest.reads?.targets ?? []).map((f) => [f, all[f]])) }];
}

async function researchFields(ctx: QueryCtx, orgId: Id<"organizations">, access: Access | null, manifest: ModuleManifest, args: Record<string, unknown>, limit: number) {
  if (!access || access.userId === "system") return refuse("research.fields reads as a person.");
  const id = ctx.db.normalizeId("users", access.userId);
  const found = id ? await ctx.db.get(id) : null;
  const user = found ? await withRole(ctx, { ...found, orgId, role: access.role }) : null;
  if (!user) return [];
  const { agents, canEditGate, canRefresh } = await fieldsFor(ctx, user, access);
  if (args.slug !== undefined && typeof args.slug !== "string") return refuse("research.fields takes an optional field slug.");
  const selected = args.slug === undefined ? agents : agents.filter((a) => a.slug === args.slug);
  if (selected.length > limit) refuse(`research.fields has more than ${limit} AI fields; raise the read's limit.`);
  return selected.map((a) => {
    const run = a.latestRun;
    const all: Record<string, unknown> = {
      label: a.label, attribute: a.attribute, kind: a.kind, question: a.question, options: a.options, answerType: a.answerType, entity: a.entityType,
      autoAccept: a.autoAcceptMinConfidence, refreshCadence: a.refresh.cadence, refreshNextAt: a.refresh.nextAt, refreshHold: a.refresh.hold?.message ?? null,
      refreshEstimate: estimateRun({ inScope: Infinity, autoAccept: a.autoAcceptMinConfidence !== null, factual: isFactualField({ ...a, answerType: a.answerType ?? undefined }), jevReads: a.kind === "classify" || a.answerType === "boolean" }),
      recipe: a.recipe ? { title: a.recipe.title, version: a.recipe.version } : null, owner: a.agent.owner?.name ?? null,
      agentStatus: a.agent.status, agentMessage: a.agent.message,
      latestRun: run ? { status: run.status, answered: run.answered, errors: run.errors, planned: run.planned, done: run.done } : null,
      canEditGate, canRefresh,
    };
    return { id: a.slug, createdAt: a.createdAt, ...Object.fromEntries((manifest.reads?.research ?? []).map((f) => [f, all[f]])) };
  });
}

/** The versions a history read looks through (current ones plus those changed since its time) before it refuses. */
const VERSIONS_SCANNED_MAX = 20_000;
/** The fields a deal version keeps, by the names a module reads them with; the rest come from the deal as it is now. */
const VERSIONED = ["name", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "ownerId", "companyId", "dealType"] as const;
type Versioned = Doc<"dealVersions">;

/** Every deal's version at `at`, by deal id: the rows valid then, read from the ones current now plus those closed since. */
async function versionsAt(ctx: QueryCtx, orgId: Id<"organizations">, at: number, read: string): Promise<Map<string, Versioned>> {
  const out = new Map<string, Versioned>();
  let scanned = 0;
  for await (const r of ctx.db.query("dealVersions").withIndex("by_orgId_validTo", (q) => q.eq("orgId", orgId).gt("validTo", at))) {
    if (++scanned > VERSIONS_SCANNED_MAX) refuse(`${read} looks through more than ${VERSIONS_SCANNED_MAX} deal versions; ask about a later time.`);
    if (r.validFrom <= at && !r.fields.archived) out.set(r.dealId, r);
  }
  return out;
}

/**
 * deals.asOf and deals.changesBetween (P1a): deals as they stood at a time, closing in a range then, as the caller may
 * see them now (decision D5: today's rule). A deal's versioned fields are the ones it held then; the rest are its own now.
 */
async function dealHistoryRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, read: "deals.asOf" | "deals.changesBetween", args: Record<string, unknown>, fields: readonly string[], limit: number) {
  const { from, to } = args;
  if (typeof from !== "string" || typeof to !== "string") return refuse(`${read} needs from and to as dates, YYYY-MM-DD.`);
  const state = await historyState(ctx, orgId);
  if (!state.built) refuse(`Deal history is still being built (${state.percent}%). Try again in a few minutes.`);
  const deals = new Map<string, Doc<"deals"> | null>();
  const dealOf = async (id: string) => {
    if (!deals.has(id)) {
      const key = ctx.db.normalizeId("deals", id);
      const d = key ? await ctx.db.get(key) : null;
      deals.set(id, d && d.orgId === orgId && d.archivedAt === undefined && dealVisible(access, d) ? d : null);
    }
    return deals.get(id)!;
  };
  const inRange = (v: Versioned | undefined) => !!v && v.fields.closeDate !== null && v.fields.closeDate >= from && v.fields.closeDate <= to;
  const shape = (v: Versioned, d: Doc<"deals">) => Object.fromEntries(fields.map((f) => [f, (VERSIONED as readonly string[]).includes(f) ? v.fields[f as (typeof VERSIONED)[number]] : DEAL_FIELDS[f](d, access)]));
  const over = () => refuse(`${read} has more than ${limit} deals you can see; narrow it or raise the read's limit.`);
  if (read === "deals.asOf") {
    if (typeof args.at !== "number") return refuse("deals.asOf needs at, a time in ms.");
    const out: Array<Record<string, unknown>> = [];
    for (const v of (await versionsAt(ctx, orgId, args.at, read)).values()) {
      if (!inRange(v)) continue;
      const d = await dealOf(v.dealId);
      if (!d) continue;
      if (out.length >= limit) over();
      out.push({ id: v.dealId, createdAt: d.createdAt, ...shape(v, d) });
    }
    // A deal as it stood carries no custom fields: those are read as they are now, on a flat read.
    return withCrmAccountNames(ctx, orgId, out);
  }
  const { since, until } = args;
  if (typeof since !== "number" || typeof until !== "number" || since > until) return refuse("deals.changesBetween needs since and until, times in ms, since first.");
  const [before, after] = [await versionsAt(ctx, orgId, since, read), await versionsAt(ctx, orgId, until === MAX_TIME ? MAX_TIME - 1 : until, read)];
  const ids = [...new Set([...before.keys(), ...after.keys()])].filter((id) => inRange(before.get(id)) || inRange(after.get(id)));
  const out: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const d = await dealOf(id);
    if (!d) continue;
    if (out.length >= limit) over();
    // Every close date it held in the window, in order, repeats dropped: what "pushed twice" is read from.
    const held = await ctx.db.query("dealVersions").withIndex("by_dealId_validFrom", (q) => q.eq("dealId", id).gt("validFrom", since).lte("validFrom", until)).take(500);
    const dates = [before.get(id)?.fields.closeDate, ...held.map((v) => v.fields.closeDate)].filter((x): x is string => !!x).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    // And every amount and forecast category, so a drop from a peak inside the window (or since the deal was created in
    // it) is seen.
    const amounts = [before.get(id)?.fields.amount, ...held.map((v) => v.fields.amount)].filter((x): x is number => typeof x === "number").filter((x, i, a) => i === 0 || a[i - 1] !== x);
    const categories = [before.get(id)?.fields.forecastCategory, ...held.map((v) => v.fields.forecastCategory)].filter((x): x is string => typeof x === "string").filter((x, i, a) => i === 0 || a[i - 1] !== x);
    const b = before.get(id), a = after.get(id);
    // The dates and amounts are those fields' history: only for a module granted them and a caller whose role doesn't hide them.
    out.push({ id, createdAt: d.createdAt, before: b ? shape(b, d) : null, after: a ? shape(a, d) : null,
      ...(fields.includes("closeDate") ? { closeDates: dates } : {}), ...(fields.includes("amount") ? { amounts } : {}),
      ...(fields.includes("forecastCategory") ? { categories } : {}) });
  }
  return out;
}
