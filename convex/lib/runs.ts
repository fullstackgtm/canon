import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { narrowsReads, type Access } from "./access";
import { researchRecords } from "./research/runVisibility";

export type LiveProgress = {
  stage?: string;
  stageIndex?: number;
  stageCount?: number;
  itemsDone?: number;
  itemsTotal?: number;
  note?: string;
  heartbeatAt: number;
};

export type JobPhase = { key: string; label: string; status: "pending" | "processing" | "completed" | "failed"; count?: number; done?: number; total?: number; note?: string };

export type RunItem = {
  id: string;
  kind: "cli" | "evidence" | "lead" | "sync" | "plan" | "health" | "records" | "research";
  title: string;
  detail?: string;
  status: string;
  at: number;
  durationMs?: number;
  counts?: unknown;
  error?: string;
  href?: string;
  startedAt?: number;
  progress?: LiveProgress;
  phases?: JobPhase[];
  stoppable?: boolean;
};

export function crmSyncHref(provider: string) {
  return provider === "hubspot" || provider === "salesforce" || provider === "granola" ? `/dashboard/integrations/${provider}` : "/dashboard/integrations";
}

const JOB_STALL_MS = 10 * 60 * 1000;

/** A member's own job (reading their inbox) is theirs alone; every other job is the workspace's. */
export const jobShownTo = (job: Pick<Doc<"backgroundJobs">, "userId">, userId: Id<"users">) => !job.userId || job.userId === userId;
/** Population jobs: the ones the fill capacity checks count (other kinds are reads, not fills). */
export const isFillJob = (job: Pick<Doc<"backgroundJobs">, "kind">) => job.kind === "contact_sweep";

export function jobEntry(job: Doc<"backgroundJobs">, now: number): { detail?: string; status: JobPhase["status"]; phases: JobPhase[] } {
  const waiting = (job.counters?.waitingUntil ?? 0) > now;
  const stalled = job.status === "processing" && !waiting && now - job.updatedAt > JOB_STALL_MS;
  return {
    detail: stalled ? `Stalled: no progress for ${Math.round((now - job.updatedAt) / 60_000)} min. ${job.detail ?? ""}`.trim() : job.detail,
    status: stalled ? "failed" : job.status,
    phases: job.phases.map((p) => (stalled && p.status === "processing" ? { ...p, status: "failed" as const } : p)),
  };
}

type Json = Record<string, unknown>;
const record = (x: unknown): Json => (x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : {});

const hasUsefulCliOutput = (run: Doc<"cliRuns">) =>
  run.status !== "success" || Boolean(run.error) || Object.keys(record(run.counts)).length > 0 || Boolean(run.findings?.length) || Boolean(run.events?.length);

export async function cliRunItem(ctx: QueryCtx, run: Doc<"cliRuns">): Promise<RunItem | null> {
  if (!hasUsefulCliOutput(run)) return null;
  const kind = run.command === "enrich acquire" ? "lead_run" : run.command.startsWith("signals ") ? "signal_run" : null;
  if (kind) {
    const retained = await ctx.db.query("cliArtifacts")
      .withIndex("by_org_kind_updatedAt", (q) => q.eq("orgId", run.orgId).eq("kind", kind).gte("updatedAt", run.startedAt - 1_000).lte("updatedAt", run.finishedAt + 10_000))
      .first();
    if (retained) return null;
  }
  return {
    id: run._id, kind: "cli", title: run.command, detail: run.profile ?? undefined, status: run.status, at: run.createdAt,
    durationMs: run.durationMs, counts: run.counts, error: run.error, href: `/dashboard/runs/${run._id}`, startedAt: run.startedAt,
    progress: run.status === "in_progress" ? run.progress : undefined,
  };
}

const icpDetail = (icpRef: Json, fallback: string) =>
  typeof icpRef.domain === "string" ? `${icpRef.domain}${icpRef.revision ? ` · ICP r${icpRef.revision}` : ""}` : fallback;

export function artifactItem(artifact: Doc<"cliArtifacts">): RunItem | null {
  const document = record(artifact.document);
  const icpRef = record(document.icpRef);
  const counts = record(document.counts);
  if (artifact.kind === "signal_run") {
    const signals = Array.isArray(document.signals) ? document.signals : [];
    return {
      id: artifact._id, kind: "evidence", title: artifact.label, detail: icpDetail(icpRef, "Public evidence discovery"), status: "success", at: artifact.updatedAt,
      counts: { fresh: typeof counts.new === "number" ? counts.new : signals.length, retained: signals.length, ...(typeof document.costUsd === "number" ? { costUsd: document.costUsd } : {}) },
      href: `/dashboard/runs/artifacts/${artifact._id}`,
      startedAt: typeof document.startedAt === "string" ? Date.parse(document.startedAt) : artifact.updatedAt,
    };
  }
  if (artifact.kind === "lead_run") {
    const plan = record(document.plan);
    const operations = Array.isArray(plan.operations) ? plan.operations : [];
    return {
      id: artifact._id, kind: "lead",
      title: typeof document.runLabel === "string" && document.runLabel !== plan.id ? document.runLabel : artifact.label,
      detail: icpDetail(icpRef, artifact.domain ?? "Untracked ICP"), status: "previewed", at: artifact.updatedAt,
      counts: { proposed: operations.length, ...(typeof counts.fetched === "number" ? { sourced: counts.fetched } : {}) },
      href: `/dashboard/runs/artifacts/${artifact._id}`,
      startedAt: typeof document.createdAt === "string" ? Date.parse(document.createdAt) : artifact.updatedAt,
    };
  }
  return null;
}

export function syncItem(sync: Doc<"integrationSyncRuns">): RunItem {
  return {
    id: sync._id, kind: "sync", title: `${sync.provider} sync`, detail: sync.trigger, status: sync.status, at: sync.startedAt,
    durationMs: sync.finishedAt ? sync.finishedAt - sync.startedAt : undefined, counts: sync.counts, error: sync.error,
    href: crmSyncHref(sync.provider), startedAt: sync.startedAt, progress: sync.status === "in_progress" ? sync.progress : undefined,
  };
}

export function auditItem(row: Doc<"operationAuditLog">): RunItem {
  const details = row.details && typeof row.details === "object" ? (row.details as Json) : undefined;
  const operationCount = typeof details?.operationCount === "number" ? details.operationCount : undefined;
  return {
    id: row._id, kind: "plan", title: `${row.verb}.${row.operation}`,
    detail: row.status === "previewed" ? `plan created${operationCount !== undefined ? ` (${operationCount} ops)` : ""}` : undefined,
    status: row.status, at: row.createdAt,
    counts: details && typeof details.providerResult === "object" && details.providerResult !== null ? details.providerResult : undefined,
    href: "/dashboard/patch-plans",
  };
}

export function healthItem(reading: Doc<"healthSnapshots">): RunItem {
  return {
    id: reading._id, kind: "health", title: "health check", detail: reading.source, status: "success", at: reading.at,
    counts: { score: reading.score, findings: reading.findings }, href: "/dashboard",
  };
}

export function jobItem(job: Doc<"backgroundJobs">, now: number): RunItem {
  const entry = jobEntry(job, now);
  const c = job.counters ?? {};
  return {
    id: job._id, kind: "records", title: job.title, detail: entry.detail,
    status: entry.status === "completed" ? "success" : entry.status === "failed" ? "failed" : "in_progress",
    at: job.startedAt, durationMs: job.completedAt ? job.completedAt - job.startedAt : undefined,
    counts: job.kind === "contact_sweep" ? { people: c.people ?? 0, calls: c.tasks ?? 0, ...(c.names ? { companyNames: c.names } : {}) } : { read: c.read ?? 0 },
    error: job.error, href: job.href, startedAt: job.startedAt, phases: entry.phases,
    stoppable: job.status === "processing" && c.pending !== undefined && !c.stopped,
  };
}

export async function researchItem(ctx: QueryCtx, run: Doc<"researchRuns">): Promise<RunItem> {
  const field = await ctx.db.get(run.agentId);
  return {
    id: run._id, kind: "research", title: `${field?.label ?? "AI field"} research`,
    detail: `${run.runtime === "pi" ? "Pi Durable" : "Convex"}${run.trigger ? ` · ${run.trigger}` : ""}`,
    status: run.status === "running" ? "in_progress" : run.status === "done" ? "success" : "failed",
    at: run.createdAt, startedAt: run.createdAt,
    durationMs: run.status === "running" ? undefined : run.updatedAt - run.createdAt,
    counts: { researched: run.done, answered: run.answered, unknown: run.unknown, withoutEvidence: run.noEvidence, errors: run.errors, pages: run.pagesRead, calls: run.llmCalls },
    progress: run.status === "running" ? { itemsDone: run.done + run.errors, itemsTotal: run.planned, heartbeatAt: run.updatedAt } : undefined,
    href: `/dashboard/runs/research/${run._id}`,
  };
}

export async function researchDetail(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, id: string) {
  const runId = ctx.db.normalizeId("researchRuns", id);
  const run = runId ? await ctx.db.get(runId) : null;
  if (!run || run.orgId !== orgId) return null;
  const { visible, records } = await researchRecords(ctx, orgId, access, run);
  return { item: { ...await researchItem(ctx, run), ...(visible && run.error ? { error: run.error } : {}) }, document: { runtime: run.runtime ?? "convex", recordsVisible: visible, records } };
}

const refuse = (message: string): never => { throw new ConvexError(message); };

/**
 * Run history from `since` to `until` (ms), newest first, excluding quiet CLI successes and duplicate retained output.
 * Refuses when a ledger or the combined history exceeds `limit`, so a reader never computes on part of a range.
 */
export async function runsBetween(ctx: QueryCtx, orgId: Id<"organizations">, since: number, until: number, limit: number, now: number): Promise<RunItem[]> {
  const over = (what: string): never => refuse(`There are more than ${limit} ${what} in this range; pick a shorter one.`);
  const take = async <T>(what: string, rows: Promise<T[]>) => {
    const list = await rows;
    return list.length > limit ? over(what) : list;
  };
  const [artifacts, cliRuns, syncs, audits, health, jobs, research] = await Promise.all([
    Promise.all((["signal_run", "lead_run"] as const).map((kind) => ctx.db.query("cliArtifacts")
      .withIndex("by_org_kind_updatedAt", (q) => q.eq("orgId", orgId).eq("kind", kind).gte("updatedAt", since).lte("updatedAt", until)).take(limit + 1)))
      .then((lists) => (lists.flat().length > limit ? over("retained runs") : lists.flat())),
    take("CLI runs", ctx.db.query("cliRuns").withIndex("by_orgId_createdAt", (q) => q.eq("orgId", orgId).gte("createdAt", since).lte("createdAt", until)).take(limit + 1)),
    take("syncs", ctx.db.query("integrationSyncRuns").withIndex("by_orgId", (q) => q.eq("orgId", orgId).gte("_creationTime", since).lte("_creationTime", until)).take(limit + 1)),
    take("plan events", ctx.db.query("operationAuditLog").withIndex("by_orgId", (q) => q.eq("orgId", orgId).gte("_creationTime", since).lte("_creationTime", until)).take(limit + 1)),
    take("health checks", ctx.db.query("healthSnapshots").withIndex("by_orgId_at", (q) => q.eq("orgId", orgId).gte("at", since).lte("at", until)).take(limit + 1)),
    take("record jobs", ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", orgId).gte("startedAt", since).lte("startedAt", until)).take(limit + 1)),
    take("research runs", ctx.db.query("researchRuns").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", orgId).gte("createdAt", since).lte("createdAt", until)).take(limit + 1)),
  ]);
  const items: RunItem[] = [];
  for (const run of cliRuns) {
    const item = await cliRunItem(ctx, run);
    if (item) items.push(item);
  }
  for (const a of artifacts) {
    const item = artifactItem(a);
    if (item) items.push(item);
  }
  items.push(...syncs.map(syncItem), ...audits.map(auditItem), ...health.map(healthItem), ...jobs.filter((j) => !j.userId).map((j) => jobItem(j, now)));
  items.push(...await Promise.all(research.map((run) => researchItem(ctx, run))));
  const inRange = items.filter((r) => r.at >= since && r.at <= until);
  if (inRange.length > limit) over("runs");
  return inRange.sort((a, b) => b.at - a.at);
}

/** One CLI run in full: its findings, events and live progress. */
export async function cliRunDetail(ctx: QueryCtx, orgId: Id<"organizations">, id: string) {
  const runId = ctx.db.normalizeId("cliRuns", id);
  const run = runId ? await ctx.db.get(runId) : null;
  if (!run || run.orgId !== orgId) return null;
  return {
    item: { id: run._id, kind: "cli" as const, title: run.command, detail: run.profile ?? undefined, status: run.status, at: run.createdAt, durationMs: run.durationMs, counts: run.counts, error: run.error, href: `/dashboard/runs/${run._id}`, startedAt: run.startedAt, progress: run.progress },
    profile: run.profile ?? null, findings: run.findings ?? [], events: run.events ?? [], crm: run.crm ?? null,
  };
}

/** One retained evidence or lead run with its document; an ICP artifact isn't a run. */
export async function artifactDetail(ctx: QueryCtx, orgId: Id<"organizations">, id: string) {
  const artifactId = ctx.db.normalizeId("cliArtifacts", id);
  const artifact = artifactId ? await ctx.db.get(artifactId) : null;
  if (!artifact || artifact.orgId !== orgId) return null;
  const item = artifactItem(artifact);
  return item ? { item, document: artifact.document ?? null } : null;
}

/**
 * A module's Canon read of run history (docs/modules.md, "Runs"), with the fields its install granted. Every member reads
 * every run. A CLI run's findings name CRM records, so a role that sees only some records reads
 * no CLI run in full.
 */
export async function runsRead(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, fields: readonly string[], read: "runs.between" | "runs.cli" | "runs.artifact" | "runs.research", args: Record<string, unknown>, limit: number) {
  const out = (item: RunItem, more: Record<string, unknown> = {}) => {
    const all: Record<string, unknown> = { ...item, ...more };
    return { id: item.id, createdAt: item.at, ...Object.fromEntries(fields.map((f) => [f, all[f] ?? null])) };
  };
  if (read === "runs.between") {
    const day = (x: unknown, end: boolean) => {
      if (x === undefined || x === null || x === "") return end ? Number.MAX_SAFE_INTEGER : 0;
      const ms = typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? Date.parse(`${x}T00:00:00Z`) : NaN;
      return Number.isNaN(ms) ? refuse("runs.between takes from and to as dates, YYYY-MM-DD.") : end ? ms + 86_400_000 - 1 : ms;
    };
    return (await runsBetween(ctx, orgId, day(args.from, false), day(args.to, true), limit, Date.now())).map((r) => out(r));
  }
  if (read === "runs.cli") {
    if (typeof args.run !== "string") return refuse("runs.cli needs run, a CLI run's id.");
    if (narrowsReads(access)) return [];
    const run = await cliRunDetail(ctx, orgId, args.run);
    return run ? [out(run.item, { findings: run.findings, events: run.events, crm: run.crm })] : [];
  }
  if (read === "runs.research") {
    if (typeof args.run !== "string") return refuse("runs.research needs run, a research run's id.");
    const run = await researchDetail(ctx, orgId, access, args.run);
    return run ? [out(run.item, { document: run.document })] : [];
  }
  if (typeof args.artifact !== "string") return refuse("runs.artifact needs artifact, a retained run's id.");
  const a = await artifactDetail(ctx, orgId, args.artifact);
  return a ? [out(a.item, { document: a.document })] : [];
}
