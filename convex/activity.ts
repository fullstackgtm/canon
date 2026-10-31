import { paginationOptsValidator } from "convex/server";
import { can } from "./lib/capabilities";
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, dealVisible } from "./permissions";
import { artifactItem, auditItem, cliRunItem, crmSyncHref, healthItem, jobEntry, jobItem, jobShownTo, researchDetail, researchItem, syncItem, type JobPhase, type RunItem } from "./lib/runs";

export type ActivityItem = RunItem;

export const feed = query({
  args: {
    source: v.union(v.literal("artifacts"), v.literal("cli"), v.literal("sync"), v.literal("audit"), v.literal("health"), v.literal("jobs"), v.literal("research")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const empty = { page: [], isDone: true, continueCursor: "" };
    const user = await getCurrentUser(ctx);
    if (!user) return empty;
    // CLI rows may each need one retained-artifact read (up to 1 MiB).
    const opts = { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, args.source === "cli" ? 10 : 50), maximumBytesRead: 2_000_000 };
    const orgId = user.orgId;
    const now = Date.now();
    const page = await (async () => {
      switch (args.source) {
        case "research": {
          const p = await ctx.db.query("researchRuns").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: await Promise.all(p.page.map((run) => researchItem(ctx, run))) };
        }
        case "artifacts": {
          const p = await ctx.db.query("cliArtifacts").withIndex("by_org_kind_updatedAt", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: p.page.flatMap((a) => artifactItem(a) ?? []) };
        }
        case "cli": {
          const p = await ctx.db.query("cliRuns").withIndex("by_orgId_createdAt", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: (await Promise.all(p.page.map((r) => cliRunItem(ctx, r)))).flatMap((x) => x ?? []) };
        }
        case "sync": {
          const p = await ctx.db.query("integrationSyncRuns").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: p.page.map(syncItem) };
        }
        case "audit": {
          const p = await ctx.db.query("operationAuditLog").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: p.page.map(auditItem) };
        }
        case "health": {
          const p = await ctx.db.query("healthSnapshots").withIndex("by_orgId_at", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          return { ...p, page: p.page.map(healthItem) };
        }
        case "jobs": {
          const p = await ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", orgId)).order("desc").paginate(opts);
          const stops = can(user, "strategy.edit");
          return { ...p, page: p.page.filter((j) => jobShownTo(j, user._id)).map((j) => { const item = jobItem(j, now); return { ...item, stoppable: stops && item.stoppable }; }) };
        }
      }
    })();
    return { ...page, page: page.page.sort((a, b) => b.at - a.at) };
  },
});

export const research = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? researchDetail(ctx, user.orgId, await accessFor(ctx, user), args.runId) : null;
  },
});

/** In-flight syncs/CLI runs whose last heartbeat is older than this are not shown as live. */
const LIVE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TRAY_RECENT = 12;
/** Research shown per source (AI field runs, deal account research, deal people research): the newest, running or not. */
const TRAY_RESEARCH = 6;
/** Finished research stays in the tray this long. */
const RESEARCH_RECENT_MS = 24 * 60 * 60 * 1000;

const RUN_STATUS: Record<Doc<"researchRuns">["status"], BackgroundActivityStatus> = { running: "processing", done: "completed", failed: "failed", cancelled: "failed" };
const PLAY_STATUS = { running: "processing", done: "completed", failed: "failed" } as const;

export type BackgroundActivityStatus = "pending" | "processing" | "completed" | "failed";
export type BackgroundActivityEntry = {
  id: string;
  kind: Doc<"backgroundJobs">["kind"] | "crm_sync" | "cli" | "research";
  title: string;
  detail?: string;
  status: BackgroundActivityStatus;
  startedAt: number;
  completedAt?: number;
  href: string;
  phases?: JobPhase[];
};

/**
 * Everything the background activity tray shows: background jobs (contact
 * sweeps, ...), live CRM syncs and CLI runs, and research: AI field runs and
 * deals' account and people research. Read budget: 12 + 50 + 20 + 3 × 6 (+ their fields and deals).
 */
export const background = query({
  args: {},
  handler: async (ctx): Promise<BackgroundActivityEntry[]> => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const now = Date.now();
    const [jobs, syncRows, cliRows, fieldRuns, accountResearch, peopleResearch] = await Promise.all([
      ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(TRAY_RECENT),
      ctx.db.query("integrationSyncRuns").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(50),
      ctx.db.query("cliRuns").withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", "in_progress")).order("desc").take(20),
      ctx.db.query("researchRuns").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(TRAY_RESEARCH),
      ctx.db.query("dealPlays").withIndex("by_orgId_and_researchStartedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(TRAY_RESEARCH),
      ctx.db.query("dealPlays").withIndex("by_orgId_and_peopleResearchStartedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(TRAY_RESEARCH),
    ]);
    const entries: BackgroundActivityEntry[] = [];
    for (const job of jobs) {
      if (!jobShownTo(job, user._id)) continue;
      entries.push({ id: job._id, kind: job.kind, title: job.title, startedAt: job.startedAt, completedAt: job.completedAt, href: job.href, ...jobEntry(job, now) });
    }
    const fresh = (startedAt: number, progress?: { heartbeatAt: number }) => now - (progress?.heartbeatAt ?? startedAt) < LIVE_RUN_MAX_AGE_MS;
    for (const sync of syncRows) {
      if (sync.status !== "in_progress" || !fresh(sync.startedAt, sync.progress)) continue;
      const p = sync.progress;
      entries.push({
        id: sync._id, kind: "crm_sync", title: `${sync.provider} sync`, status: "processing", startedAt: sync.startedAt,
        href: crmSyncHref(sync.provider),
        detail: p ? [p.stage, p.itemsTotal ? `${(p.itemsDone ?? 0).toLocaleString("en-US")} of ${p.itemsTotal.toLocaleString("en-US")}` : undefined].filter(Boolean).join(" · ") : undefined,
      });
    }
    for (const run of cliRows) {
      if (!fresh(run.startedAt, run.progress)) continue;
      entries.push({ id: run._id, kind: "cli", title: run.command, status: "processing", startedAt: run.startedAt, href: `/dashboard/runs/${run._id}`, detail: run.progress?.stage });
    }
    const recent = (status: string, at: number) => status === "running" || now - at < RESEARCH_RECENT_MS;
    for (const run of fieldRuns) {
      if (!recent(run.status, run.updatedAt)) continue;
      const field = await ctx.db.get(run.agentId);
      const of = run.planned || run.inScope;
      entries.push({
        id: run._id, kind: "research", title: `${field?.label ?? "AI field"} research${run.trigger === "refresh" ? " (scheduled refresh)" : run.trigger === "probe" ? " (sample)" : ""}`,
        status: RUN_STATUS[run.status], startedAt: run.createdAt, ...(run.status === "running" ? {} : { completedAt: run.updatedAt }), href: "/dashboard/fields",
        detail: run.error ?? [
          of ? `${run.done} of ${of} researched` : null, run.answered ? `${run.answered} answered` : null,
          run.skipped ? `${run.skipped} skipped (answered or tried recently)` : null,
        ].filter(Boolean).join(" · "),
      });
    }
    // Research on a deal the caller can't see is left out.
    const access = accountResearch.length || peopleResearch.length ? await accessFor(ctx, user) : null;
    const dealName = async (play: Doc<"dealPlays">) => {
      const deal = await ctx.db.get(play.dealId);
      return deal && access && dealVisible(access, deal) ? deal.name : null;
    };
    for (const play of accountResearch) {
      const r = play.research;
      const name = r && recent(r.status, r.finishedAt ?? r.startedAt) ? await dealName(play) : null;
      if (!r || !name) continue;
      entries.push({
        id: `${play._id}:research`, kind: "research", title: `Account research · ${name}`, status: PLAY_STATUS[r.status],
        startedAt: r.startedAt, ...(r.finishedAt ? { completedAt: r.finishedAt } : {}), href: `/dashboard/records/deal/${play.streamId}`,
        detail: r.status === "failed" ? r.error : r.status === "done" ? `${r.kept ?? 0} kept, ${r.dropped ?? 0} dropped for lack of evidence` : undefined,
      });
    }
    for (const play of peopleResearch) {
      const r = play.peopleResearch;
      const name = r && recent(r.status, r.finishedAt ?? r.startedAt) ? await dealName(play) : null;
      if (!r || !name) continue;
      const n = r.contactIds.length;
      entries.push({
        id: `${play._id}:people`, kind: "research", title: `People research · ${name}`, status: PLAY_STATUS[r.status],
        startedAt: r.startedAt, ...(r.finishedAt ? { completedAt: r.finishedAt } : {}), href: `/dashboard/records/deal/${play.streamId}`,
        detail: [`${n} ${n === 1 ? "person" : "people"}`, r.note].filter(Boolean).join(" · "),
      });
    }
    return entries.sort((a, b) => b.startedAt - a.startedAt);
  },
});
