/**
 * A module's proposed writes to Canon's own records (docs/modules.md, "Writes to Canon records"). A call returns a
 * `propose` intent; its action lists the records the write would change, as the caller reads them (`expandProposal`);
 * the call's mutation holds them as a patch plan, one row per record with its value and version then
 * (`insertRecordProposal`), which is never applied until a person approves it. Applying it (`applyRecordRows`, from
 * the Patch plans page) writes each row as the person applying, through the records edit path, and skips a record
 * that changed since: CAS on its version. The outcome is stored on the plan, and the job key the proposal named is
 * dirtied, so the module reads what happened (`proposalOutcomes`).
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { RecordClient } from "../recordClient";
import { permissionOf, type Access } from "../access";
import { dealVisible, roleIn, sightJudge } from "../../permissions";
import { moduleDealTarget } from "./dealTarget";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { userBelongsToOrg } from "../../lib";
import { markDirty } from "./jobs";
import { systemScope } from "./scope";
import { treeSpecOf } from "./territories";
import { MODULE_RECORDS, MAX_PROPOSAL_ROWS, MAX_SKIPPED_NAMED, moveSummary, proposalArgsProblem, type ProposalOperation, type ProposalOutcome, type ProposalRow, type ProposalSetRow, type MeetingCreateRow, type MeetingLogArgs, type ReassignArgs, type AssignTerritoriesArgs, type TargetsSetArgs, PROPOSAL_OPERATIONS } from "../../../modules/kernel/proposals.ts";
import { jobKeyProblem } from "../../../modules/kernel/calls.ts";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";

export { MODULE_RECORDS };

/** What a record proposal's plan keeps in `args`: which module proposed what, and the job key it hears back on. */
export type RecordProposalArgs = { module: string; operation: ProposalOperation; args: Record<string, unknown>; stamp?: { collection: string; key: string; field: string }; outcome?: { job: string; key: string } };
/** What applying a record proposal found, kept on its plan (`runRecord.outcome`). */
export type AppliedOutcome = { applied: number; skipped: number; failed: number; skippedRows: Array<{ id: string; name: string; why: string }> };

const refuse = (message: string): never => { throw new ConvexError(message); };
/** The page size a proposal lists records in. */
const PAGE = 200;

export function canonicalMeetingArgs(args: MeetingLogArgs): MeetingLogArgs {
  return { deal: args.deal, title: args.title.trim(), startAt: args.startAt, ownerId: args.ownerId,
    ...(args.endAt !== undefined ? { endAt: args.endAt } : {}), ...(args.notes !== undefined ? { notes: args.notes.trim() } : {}), ...(args.location !== undefined ? { location: args.location.trim() } : {}) };
}

/** The host resolves and admits the deal, never an arbitrary stream supplied by module code. */
export async function meetingProposalRow(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, args: MeetingLogArgs): Promise<MeetingCreateRow> {
  const problem = proposalArgsProblem("meetings.log", args);
  if (problem) refuse(problem);
  const target = await moduleDealTarget(ctx, orgId, args.deal);
  if (!target || !dealVisible(access, target.deal)) return refuse("Deal not found");
  const ownerId = ctx.db.normalizeId("users", args.ownerId);
  const owner = ownerId ? await ctx.db.get(ownerId) : null;
  if (!owner || owner.isHidden || !(await roleIn(ctx, owner, orgId))) refuse("The meeting owner must be an active workspace member");
  return { kind: "meeting.create", id: args.deal, name: args.title.trim(), meeting: canonicalMeetingArgs(args), dealStreamId: target.entity._id };
}

/** A stamp is scoped to this exact module document, operation and canonical request, including terminal decisions. */
export async function stampedMeetingPlan(ctx: QueryCtx, orgId: Id<"organizations">, module: string, raw: string, args: MeetingLogArgs, stamp: NonNullable<RecordProposalArgs["stamp"]>): Promise<Id<"patchPlans">> {
  const id = ctx.db.normalizeId("patchPlans", raw);
  const plan = id ? await ctx.db.get(id) : null;
  const stored = plan?.args as RecordProposalArgs | undefined;
  if (!plan || plan.orgId !== orgId || plan.operation !== MODULE_RECORDS || stored?.module !== module || stored.operation !== "meetings.log"
    || canonicalJson(stored.stamp) !== canonicalJson(stamp) || proposalArgsProblem("meetings.log", stored.args)
    || canonicalJson(canonicalMeetingArgs(stored.args as MeetingLogArgs)) !== canonicalJson(canonicalMeetingArgs(args))) return refuse("The meeting stamp belongs to a different proposal or request");
  return plan._id;
}

/**
 * The records `operation` would change, as `client` (the caller's) reads them, each with its value and version now.
 * Refuses past MAX_PROPOSAL_ROWS rather than propose part of what it names.
 */
export async function expandProposal(client: RecordClient, orgId: string, operation: string, args: Record<string, unknown>, label: string, currentTarget?: (year: number) => Promise<{ total: number; updatedAt: number } | null>): Promise<ProposalSetRow[]> {
  const problem = proposalArgsProblem(operation, args);
  if (problem) refuse(`${label}: ${problem}.`);
  if (operation === "meetings.log") return refuse("Meeting proposals require hosted deal admission");
  if (operation === "targets.set") {
    // One row: the year's plan as it stands (its total and version) and the total proposed.
    const { year, total } = args as TargetsSetArgs;
    const now = currentTarget ? await currentTarget(year) : null;
    return [{ id: `fy${year}`, name: `FY${year} target`, field: "total", before: now ? String(now.total) : null, after: String(total), version: now?.updatedAt ?? 0 }];
  }
  if (operation === "accounts.assignTerritories") return expandTerritories(client, orgId, args as AssignTerritoriesArgs, label);
  const { from, to } = args as ReassignArgs;
  const rows: ProposalSetRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.list(orgId, { filter: { ownerId: from }, sort: { field: "name", dir: "asc" }, limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const a of page.rows) {
      // The service's filter is the first word; the row's own owner is the last (a row edited since the page was cut).
      if ((a.ownerId ?? null) !== from) continue;
      rows.push({ id: a.id, name: a.name, field: "ownerId", before: from, after: to, version: a.updatedAt });
      if (rows.length > MAX_PROPOSAL_ROWS) refuse(`${label} would move more than ${MAX_PROPOSAL_ROWS} companies at once; move them in smaller parts.`);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/**
 * The companies a territory tree moves (docs/modules.md, "Territories"): the tree counted by the record service as the
 * caller sees companies, each company going to the owner of the nearest territory on its path that has one. A line
 * that doesn't read refuses the proposal, so a typo never moves a book.
 */
async function expandTerritories(client: RecordClient, orgId: string, a: AssignTerritoriesArgs, label: string): Promise<ProposalSetRow[]> {
  const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 0, owner: null, parentKey: null, createdAt: 0, updatedAt: 0, data });
  const spec = treeSpecOf({ nodes: "t", query: "query", parent: "parent", order: "order", named: { read: "n", node: "territory", company: "company" } },
    { t: a.territories.map((t) => doc(t.key, { query: t.query, parent: t.parent, order: t.order })), n: (a.named ?? []).map((x, i) => doc(String(i), { territory: x.territory, company: x.company })) }, null, null);
  if (spec.errors.length) refuse(`${label}: ${spec.errors.length} ${spec.errors.length === 1 ? "territory's line doesn't" : "territories' lines don't"} read (${spec.errors[0].message}); fix them before moving owners.`);
  const owners = Object.fromEntries(a.territories.filter((t) => t.owner).map((t) => [t.key, t.owner!]));
  const counted = await client.territoryTreeCounts(orgId, { ...spec.body, moves: { owners, scope: a.scope, limit: a.limit ?? MAX_PROPOSAL_ROWS } });
  if (a.limit === undefined && (counted.movesTotal ?? 0) > MAX_PROPOSAL_ROWS) refuse(`${label} would move ${counted.movesTotal} companies; at most ${MAX_PROPOSAL_ROWS} move at once. Give owners to smaller territories first, a few at a time.`);
  return (counted.moves ?? []).slice(0, a.limit ?? MAX_PROPOSAL_ROWS).map((m) => ({ id: m.id, name: m.name, field: "ownerId", before: m.from, after: m.to, version: m.version }));
}

const nameOf = async (db: QueryCtx["db"], orgId: Id<"organizations">, id: string | null) => {
  if (id === null) return "no owner";
  const uid = db.normalizeId("users", id);
  const u = uid ? await db.get(uid) : null;
  return u && (await userBelongsToOrg({ db } as QueryCtx, u, orgId)) ? u.name : null;
};

/**
 * Hold a module's proposed record write as a patch plan pending a person's approval, one operation row per record:
 * its name, the value then (with the version Apply checks) and the value proposed. Never auto-applied: its approval
 * requirement is `required`, whoever ran the call. Returns the plan's id.
 */
export async function insertRecordProposal(
  db: MutationCtx["db"],
  who: { orgId: Id<"organizations">; userId: Id<"users">; agent: string | null },
  module: { id: string; title: string },
  proposal: { operation: ProposalOperation; args: Record<string, unknown>; reason: string; stamp?: RecordProposalArgs["stamp"]; outcome?: { job: string; key: string } },
  proposedRows: readonly ProposalRow[],
): Promise<Id<"patchPlans">> {
  if (proposal.operation === "meetings.log") {
    if (proposedRows.length !== 1 || proposedRows[0].kind !== "meeting.create") return refuse("A meeting proposal requires one meeting create row");
    return insertPlan(db, who, module, proposal, proposedRows, (r) => r.name, `Log meeting: ${proposedRows[0].name}`);
  }
  if (proposedRows.some((r) => r.kind === "meeting.create")) return refuse("A create row cannot change an existing field");
  const rows = proposedRows as readonly ProposalSetRow[];
  if (proposal.operation === "targets.set") return insertPlan(db, who, module, proposal, rows, (r) => `${r.name}: ${r.before === null ? "none" : usd(Number(r.before))} to ${usd(Number(r.after))}`, `${rows[0].name} to ${usd(Number(rows[0].after))}`);
  const names = new Map<string | null, string>([[null, "no owner"]]);
  // Every member a row moves a company to must be one of the workspace's; a current owner who left reads by name or as someone else.
  const reassign = proposal.operation === "accounts.reassign" ? (proposal.args as ReassignArgs) : null;
  const targets = new Set([...rows.map((r) => r.after), ...(reassign ? [reassign.from, reassign.to] : [])]);
  for (const id of targets) names.set(id, (await nameOf(db, who.orgId, id)) ?? refuse(`${module.title}: ${id} isn't a member of this workspace.`));
  for (const r of rows) if (r.before !== null && !names.has(r.before)) { const n = await nameOf(db, who.orgId, r.before); if (n) names.set(r.before, n); }
  if (!rows.length) refuse(reassign ? `${module.title}: nothing to propose; ${names.get(reassign.from)} owns no companies you can see.` : `${module.title}: nothing to propose; every company you can see already has its territory's owner.`);
  const label = (id: string | null) => names.get(id) ?? "someone else";
  return insertPlan(db, who, module, proposal, rows, (r) => `${r.name}: ${label(r.before)} to ${label(r.after)}`, moveSummary(rows, label));
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** The plan, its operation rows (each a record and its value then, with the version Apply checks), its request and audit. */
async function insertPlan<R extends ProposalRow>(
  db: MutationCtx["db"], who: { orgId: Id<"organizations">; userId: Id<"users">; agent: string | null }, module: { id: string; title: string },
  proposal: { operation: ProposalOperation; args: Record<string, unknown>; reason: string; stamp?: RecordProposalArgs["stamp"]; outcome?: { job: string; key: string } },
  rows: readonly R[], rowReason: (r: R) => string, summary: string,
): Promise<Id<"patchPlans">> {
  const now = Date.now();
  const reason = `${module.title}: ${proposal.reason} (${summary})${who.agent ? ` (proposed by ${who.agent})` : ""}`;
  const args: RecordProposalArgs = { module: module.id, operation: proposal.operation, args: proposal.args, ...(proposal.stamp ? { stamp: proposal.stamp } : {}), ...(proposal.outcome ? { outcome: proposal.outcome } : {}) };
  const patchPlanId = await db.insert("patchPlans", {
    orgId: who.orgId, createdBy: who.userId, verb: "do", operation: MODULE_RECORDS, args, reason,
    status: "pending_approval", riskLevel: "high", approvalRequirement: "required", source: "hosted", createdAt: now, updatedAt: now,
    totalOperationCount: rows.length, storedOperationCount: rows.length,
  });
  const objectType = PROPOSAL_OPERATIONS[proposal.operation].object;
  for (const [i, r] of rows.entries()) {
    await db.insert("patchOperations", {
      orgId: who.orgId, patchPlanId, objectType, objectId: r.id, fieldOrAction: r.kind === "meeting.create" ? "create" : r.field,
      beforeValue: r.kind === "meeting.create" ? { kind: r.kind, dealStreamId: r.dealStreamId, name: r.name } : { value: r.before, version: r.version, name: r.name }, afterValue: r.kind === "meeting.create" ? r.meeting : r.after,
      reason: rowReason(r), sourceRuleOrPolicy: `module ${module.id}`, riskLevel: "high",
      approvalRequirement: "required", packageOpId: `r${i + 1}`, status: "pending", createdAt: now, updatedAt: now,
    });
  }
  await db.insert("approvalRequests", { orgId: who.orgId, patchPlanId, requestedBy: who.userId, status: "pending", reason, createdAt: now, updatedAt: now });
  await db.insert("operationAuditLog", {
    orgId: who.orgId, userId: who.userId, patchPlanId, verb: "do", operation: MODULE_RECORDS, status: "previewed",
    details: { module: module.id, operation: proposal.operation, rows: rows.length, summary, ...(who.agent ? { agent: who.agent } : {}) }, createdAt: now,
  });
  return patchPlanId;
}

/** Why a proposal's `outcome` isn't a key of one of the module's jobs, or null. */
export function outcomeProblem(m: ModuleManifest, outcome: { job: string; key: string }): string | null {
  const job = m.jobs?.[outcome.job];
  if (!job) return `outcome names ${outcome.job}, which is not a job of ${m.title}`;
  return jobKeyProblem(outcome.key, job.key.length);
}

/**
 * The plan's outcome fed back to the module that proposed it: the job key the proposal named is dirtied, so its call
 * reads the plan (`proposals.byIds`) and moves on. A module that is off or gone hears nothing; the plan stands.
 */
export async function feedProposalOutcome(ctx: MutationCtx, plan: Pick<Doc<"patchPlans">, "orgId" | "operation" | "args">) {
  if (plan.operation !== MODULE_RECORDS) return;
  const a = plan.args as RecordProposalArgs;
  if (!a.outcome) return;
  const scope = await systemScope(ctx, plan.orgId, a.module);
  if (!scope || outcomeProblem(scope.manifest, a.outcome)) return;
  await markDirty(ctx, plan.orgId, scope.moduleId, scope.manifest, a.outcome.job, a.outcome.key);
}

/**
 * The module's own proposals among `ids`, as `proposals.byIds` reads them: each plan's status and its rows counted by
 * what happened to them. The skipped rows are named only to a reader who sees every company (Canon's own calls too),
 * since a name is the company's.
 */
export async function proposalOutcomes(ctx: QueryCtx, orgId: Id<"organizations">, moduleId: string, access: Access | null, ids: readonly string[]): Promise<ProposalOutcome[]> {
  const named = access === null || permissionOf(access, "account").visibility === "all";
  const out: ProposalOutcome[] = [];
  for (const raw of new Set(ids)) {
    const id = ctx.db.normalizeId("patchPlans", raw);
    const p = id ? await ctx.db.get(id) : null;
    if (!p || p.orgId !== orgId || p.operation !== MODULE_RECORDS || (p.args as RecordProposalArgs).module !== moduleId) continue;
    const total = p.totalOperationCount ?? 0;
    const done = (p.runRecord as { outcome?: AppliedOutcome } | undefined)?.outcome;
    const created: ProposalOutcome["created"] = [];
    if ((p.args as RecordProposalArgs).operation === "meetings.log") {
      const requested = (p.args as RecordProposalArgs).args as MeetingLogArgs;
      const target = await moduleDealTarget(ctx, orgId, requested.deal);
      if (!target || (access && !dealVisible(access, target.deal))) continue;
      const ops = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", p._id)).take(2);
      if (ops.length === 1) {
        const receipt = ops[0].providerData as { operation?: unknown; object?: unknown; streamId?: unknown } | undefined;
        const sid = typeof receipt?.streamId === "string" ? ctx.db.normalizeId("canonEntities", receipt.streamId) : null;
        const entity = sid ? await ctx.db.get(sid) : null;
        if (receipt?.operation === "meetings.log" && receipt.object === "meeting" && entity?.orgId === orgId && entity.entityType === "meeting" && !entity.mergedInto
          && (!access || await sightJudge(ctx, [access]).entity(entity))) created.push({ operation: "meetings.log", object: "meeting", streamId: entity._id });
      }
    }
    out.push({
      id: p._id, operation: (p.args as RecordProposalArgs).operation, status: p.status, reason: p.reason ?? null, createdAt: p.createdAt,
      decidedAt: p.appliedAt ?? p.approvedAt ?? (p.status === "rejected" || p.status === "failed" ? p.updatedAt : null),
      // Rows a person left out of the approval count as skipped once the plan is done; none is pending then.
      total, applied: done?.applied ?? 0, skipped: done ? total - done.applied - done.failed : 0, failed: done?.failed ?? 0,
      pending: done ? 0 : total,
      skippedRows: named ? (done?.skippedRows ?? []).slice(0, MAX_SKIPPED_NAMED) : [],
      created,
    });
  }
  return out;
}
