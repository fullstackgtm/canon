import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { can } from "./capabilities";
import { moduleScope, type ModuleScope } from "./modules/scope";
import { withEventDefinition } from "./agents/definitions";

/** Persistent references, including nested route/routing fields. Add readers here before storing a new reference. */
export const AUDIENCE_READERS = {
  fields: ["agents.route.audienceId", "agentTurns.routing.audienceId", "dialerSessions.queueAudienceId", "dialerCalls.audienceId", "moduleSnapshots.audienceId", "audienceRuns.audienceId", "audienceMembers.audienceId", "audienceAdditions.audienceId"],
  classification: {
    agents: "in force (including paused routes; archived routes are history)",
    dialerSessions: "in force while ready or calling_agent and unexpired; otherwise history",
    agentTurns: "history; registered but not listed (no workspace-scoped audience index)", dialerCalls: "history", moduleSnapshots: "history",
    audienceRuns: "history (sequencers, CSV and LinkedIn)", audienceMembers: "legacy history",
    audienceAdditions: "owned membership; removed with audience",
    audienceModuleImport: "independent mutable copy; kept, not an in-force reference",
  },
} as const;

export type AudienceUse = { kind: string; label: string; href?: string; at?: number };
export const USE_SCAN_MAX = 100;
export const USE_HISTORY_MAX = 50;
type Viewer = Pick<Doc<"users">, "_id" | "orgId" | "role"> & { capabilities?: readonly string[] };

/** No pagination: one call may inspect several readers. Overflow refuses deletion rather than assuming there are no uses. */
export async function inForceUses(ctx: QueryCtx, user: Viewer, audienceId: Id<"audiences">) {
  const inForce: AudienceUse[] = [];
  const agents = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(USE_SCAN_MAX + 1);
  let incomplete = agents.length > USE_SCAN_MAX;
  const definitions = [];
  for (const row of agents.slice(0, USE_SCAN_MAX)) {
    const agent = await withEventDefinition(ctx, row);
    definitions.push(agent);
    if (agent.route?.audienceId !== audienceId || agent.archivedAt !== undefined) continue;
    const visible = agent.ownerUserId === user._id || can(user, "agents.manageAll");
    inForce.push({ kind: "agent", label: visible ? `Agent: ${agent.label}` : "An agent route", ...(visible ? { href: `/dashboard/agents?agent=${agent._id}` } : {}) });
  }
  for (const status of ["calling_agent", "ready"] as const) {
    const sessions = await ctx.db.query("dialerSessions").withIndex("by_orgId_queueAudienceId_status_expiresAt", (q) => q.eq("orgId", user.orgId).eq("queueAudienceId", audienceId).eq("status", status).gt("expiresAt", Date.now())).take(USE_SCAN_MAX + 1);
    incomplete ||= sessions.length > USE_SCAN_MAX;
    for (const session of sessions.slice(0, USE_SCAN_MAX)) {
      if (session.orgId !== user.orgId || session.queueAudienceId !== audienceId) continue;
      const visible = session.userId === user._id;
      inForce.push({ kind: "dialer", label: visible ? `Active dialer session: ${session.queueName ?? "Audience queue"}` : "An active dialer session", ...(visible ? { href: "/dashboard/m/dialer" } : {}) });
    }
  }
  return { inForce, incomplete, definitions };
}

export async function audienceUses(ctx: QueryCtx, user: Viewer, audienceId: Id<"audiences">) {
  const { inForce, incomplete, definitions } = await inForceUses(ctx, user, audienceId);
  const history: AudienceUse[] = [];
  let historyTruncated = false;
  const bounded = <T>(rows: T[]) => { historyTruncated ||= rows.length > USE_HISTORY_MAX; return rows.slice(0, USE_HISTORY_MAX); };
  const runs = bounded(await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", audienceId)).order("desc").take(USE_HISTORY_MAX + 1));
  for (const run of runs) {
    if (run.orgId !== user.orgId) continue;
    // The audience history already exposes sequencer targets. Cadence names/ids require their own admission.
    if (run.target.startsWith("linkedin:")) {
      const id = ctx.db.normalizeId("linkedinCadences", run.target.slice(9));
      const cadence = id ? await ctx.db.get(id) : null;
      history.push({ kind: "linkedin", label: "LinkedIn enrolment", at: run.at, ...(cadence?.orgId === user.orgId ? { href: `/dashboard/linkedin?cadence=${cadence._id}` } : {}) });
    } else history.push({ kind: "run", label: run.target === "csv" ? "CSV export" : "Sequencer push", at: run.at, href: `/dashboard/audiences?audience=${audienceId}#audience-history` });
  }
  const snapshots = bounded(await ctx.db.query("moduleSnapshots").withIndex("by_orgId_and_audienceId", (q) => q.eq("orgId", user.orgId).eq("audienceId", audienceId)).order("desc").take(USE_HISTORY_MAX + 1));
  const seen = new Set<string>();
  const modules = new Map<string, ModuleScope | null>();
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.snapshot)) continue;
    seen.add(snapshot.snapshot);
    if (!modules.has(snapshot.moduleId)) modules.set(snapshot.moduleId, await moduleScope(ctx, snapshot.moduleId));
    const scope = modules.get(snapshot.moduleId);
    // The module's title and landing page are admitted; snapshots store no source doc owner or key.
    history.push(scope ? { kind: "snapshot", label: `${scope.manifest.title} snapshot`, href: `/dashboard/m/${encodeURIComponent(scope.slug)}`, at: snapshot.createdAt } : { kind: "snapshot", label: "A frozen module snapshot" });
  }
  const calls = bounded(await ctx.db.query("dialerCalls").withIndex("by_audienceId_and_startedAt", (q) => q.eq("audienceId", audienceId)).order("desc").take(USE_HISTORY_MAX + 1));
  for (const call of calls) if (call.orgId === user.orgId) history.push({ kind: "call", label: "Dialer call", ...(call.userId === user._id ? { at: call.startedAt, href: "/dashboard/m/dialer" } : {}) });
  for (const status of ["calling_agent", "ready", "ended", "failed"] as const) {
    const query = ctx.db.query("dialerSessions").withIndex("by_orgId_queueAudienceId_status_expiresAt", (q) => {
      const range = q.eq("orgId", user.orgId).eq("queueAudienceId", audienceId).eq("status", status);
      return status === "ready" || status === "calling_agent" ? range.lte("expiresAt", Date.now()) : range;
    });
    const sessions = bounded(await query.order("desc").take(USE_HISTORY_MAX + 1));
    for (const session of sessions) history.push({ kind: "session", label: "Past dialer session", ...(session.userId === user._id ? { at: session.startedAt, href: "/dashboard/m/dialer" } : {}) });
  }
  const members = bounded(await ctx.db.query("audienceMembers").withIndex("by_audienceId_at", (q) => q.eq("audienceId", audienceId)).order("desc").take(USE_HISTORY_MAX + 1));
  const runKeys = new Set(runs.map((run) => `${run.target}@${run.at}`));
  for (const member of members) {
    const key = `${member.target}@${member.at}`;
    if (member.orgId !== user.orgId || runKeys.has(key)) continue;
    runKeys.add(key);
    history.push({ kind: "legacy", label: "Earlier send or export", at: member.at });
  }
  for (const agent of definitions) if (agent.archivedAt !== undefined && agent.route?.audienceId === audienceId) history.push({ kind: "agent", label: "Archived agent route" });
  history.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  historyTruncated ||= history.length > USE_HISTORY_MAX || incomplete;
  return { inForce, history: history.slice(0, USE_HISTORY_MAX), incomplete, historyTruncated };
}
