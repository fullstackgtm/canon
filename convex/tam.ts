/**
 * TAM explorer (the Accounts page): grouped counts and revenue for the
 * treemap, AI segments (Jev questions whose answers become account traits),
 * and the background runs that score a drill-down scope.
 *
 * Accounts live in the record service. Grouping runs there (POST
 * accounts/facets); traits and revenue are written back with accounts/annotate.
 * Homepage evidence is fetched by the Node action in convex/tamFetch.ts.
 *
 * Any workspace member may create segments and start runs (Jev is free for
 * now; RUN_CAP bounds a run). Deleting a segment needs a manager.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap, requireUser } from "./lib";
import { requireUnrestricted } from "./permissions";
import { callerClient, clientFor, requireCaller } from "./records";
import { filterValidator, type AccountScope } from "./lib/scopeValidators";
import { normalizeDomain } from "./lib/recordClient";
import { crmRevenueRecords } from "./lib/tam/crmRevenue";
import type { AccountRow, AnnotateRecord, FacetDimension, FacetsResponse } from "./lib/recordContract";
import { jevSystemOne, type SystemOneQuestion } from "./lib/segments/jev";
import {
  bucketFor,
  choiceQuestion,
  evidenceState,
  jtbdOptions,
  MAX_JTBD_OPTIONS,
  noulQuestion,
  revenueFrom,
  revenueQuestion,
  traitKeyFor,
} from "./lib/tam/jevSegments";
import { TRAIT_KEY_RE } from "../services/record-service/src/dimensions.ts";

/** Accounts one run scores at most (highest fit first). Re-run to continue. */
export const RUN_CAP = 500;
const PAGE = 24;
const JEV_CONCURRENCY = 8;
/** Reschedule well inside the 10-minute action limit. */
const SLICE_MS = 4 * 60_000;
const MAX_SEGMENTS = 50;
/** A running job with no progress for this long is treated as dead. */
const STALL_MS = 10 * 60_000;

const segmentValidator = v.object({
  key: v.string(),
  kind: v.union(v.literal("noul"), v.literal("choice")),
  label: v.string(),
  criterion: v.string(),
  options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))),
  builtin: v.optional(v.literal("jtbd")),
});

function publicSegment(s: Doc<"tamSegments">) {
  return { key: s.key, kind: s.kind, label: s.label, criterion: s.criterion, options: s.options, builtin: s.builtin };
}

// ───────────────────────────── Reads ─────────────────────────────

export const segments = query({
  args: {},
  returns: v.object({ segments: v.array(segmentValidator), jtbdAvailable: v.boolean() }),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { segments: [], jtbdAvailable: false };
    const rows = await ctx.db
      .query("tamSegments")
      .withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId))
      .take(MAX_SEGMENTS + 1);
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId))
      .order("desc")
      .first();
    return {
      segments: rows.map(publicSegment),
      jtbdAvailable: jtbdOptions(session?.marketSegments).options.length > 0,
    };
  },
});

export const jobs = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("tamJobs")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(10);
    return rows.map((j) => ({
      id: j._id,
      kind: j.kind,
      segmentKey: j.segmentKey ?? null,
      status: j.status,
      inScope: j.inScope,
      planned: j.planned,
      done: j.done,
      skipped: j.skipped,
      errors: j.errors,
      crmMatched: j.crmMatched ?? null,
      tokens: j.tokens,
      error: j.error ?? null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }));
  },
});

const groupByValidator = v.string();

function checkGroupBy(groupBy: string): FacetDimension {
  if (["industry", "sizeBand", "region", "country", "segment"].includes(groupBy)) return groupBy as FacetDimension;
  if (groupBy.startsWith("trait:") && TRAIT_KEY_RE.test(groupBy.slice(6))) return groupBy as FacetDimension;
  // An AI field's accepted answers (record service 1.21.0).
  if (groupBy.startsWith("field:") && /^[A-Za-z0-9_-]{1,64}$/.test(groupBy.slice(6))) return groupBy as FacetDimension;
  throw new ConvexError(`Unknown grouping "${groupBy}"`);
}

/** One treemap level: groups of the scope by a dimension. */
export const facets = action({
  args: { filter: v.optional(filterValidator), groupBy: groupByValidator, limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<FacetsResponse> => {
    const caller = await requireCaller(ctx, { read: true });
    return callerClient(ctx, caller).facets(caller.orgId, {
      filter: args.filter,
      groupBy: checkGroupBy(args.groupBy),
      limit: Math.min(Math.max(args.limit ?? 200, 1), 1000),
    });
  },
});

// ───────────────────────────── AI segments ─────────────────────────────

/** Insert a custom segment (yes/no, or a choice with options). Shared by the dialog and recommendations. */
export async function insertSegment(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: { label: string; criterion: string; kind?: "noul" | "choice"; options?: Array<{ key: string; label: string; description?: string }> },
): Promise<{ key: string }> {
  const label = args.label.trim().slice(0, 80);
  const criterion = args.criterion.trim();
  if (!label) throw new ConvexError("Give the segment a name.");
  if (criterion.length < 4 || criterion.length > 500) throw new ConvexError("Describe the segment in 4 to 500 characters.");
  const kind = args.kind ?? "noul";
  if (kind === "choice" && !((args.options?.length ?? 0) >= 2 && (args.options?.length ?? 0) <= MAX_JTBD_OPTIONS)) {
    throw new ConvexError(`A choice segment needs 2 to ${MAX_JTBD_OPTIONS} options.`);
  }
  const existing = await ctx.db
    .query("tamSegments")
    .withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId))
    .take(MAX_SEGMENTS + 1);
  if (existing.length >= MAX_SEGMENTS) throw new ConvexError(`A workspace can have up to ${MAX_SEGMENTS} AI segments.`);
  const key = traitKeyFor(label, new Set(existing.map((s) => s.key)));
  await ctx.db.insert("tamSegments", {
    orgId: user.orgId,
    key,
    kind,
    label,
    criterion,
    ...(kind === "choice" ? { options: args.options } : {}),
    createdBy: user._id,
    createdAt: Date.now(),
  });
  return { key };
}

export const createSegment = mutation({
  args: { label: v.string(), criterion: v.string() },
  handler: async (ctx, args) => insertSegment(ctx, await requireUser(ctx), args),
});

export const deleteSegment = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const seg = await ctx.db
      .query("tamSegments")
      .withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId).eq("key", args.key))
      .unique();
    if (seg) await ctx.db.delete(seg._id);
    return null;
  },
});

/**
 * The jobs-to-be-done level: a Choice over the jobs onboarding research found
 * for this vendor (researchSessions.marketSegments). Refreshed on each call.
 */
export const ensureJtbd = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId))
      .order("desc")
      .first();
    const { from, options } = jtbdOptions(session?.marketSegments);
    if (!options.length) throw new ConvexError("No jobs to be done yet. They come from your company's homepage research.");
    const criterion =
      from === "jobs"
        ? `Which of these jobs, the ones ${session!.domain} helps with, matters most to this company's day-to-day work?`
        : `Which of these kinds of business, the buyers ${session!.domain} sells to, best describes this company?`;
    const doc = {
      orgId: user.orgId,
      key: "jtbd",
      kind: "choice" as const,
      label: "Jobs to be done",
      criterion,
      options,
      builtin: "jtbd" as const,
      createdBy: user._id,
      createdAt: Date.now(),
    };
    const existing = await ctx.db
      .query("tamSegments")
      .withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId).eq("key", "jtbd"))
      .unique();
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("tamSegments", doc);
    return { key: "jtbd" };
  },
});

// ───────────────────────────── Runs ─────────────────────────────

/** Score a scope for one segment ("segment") or estimate its revenue ("revenue"). */
export const startJob = mutation({
  args: {
    kind: v.union(v.literal("segment"), v.literal("revenue")),
    segmentKey: v.optional(v.string()),
    filter: filterValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "scoring every account in a segment");
    if (!integrationEnabled("jev")) return { jobId: null };
    if (args.kind === "segment") {
      if (!args.segmentKey) throw new ConvexError("segmentKey is required");
      const seg = await ctx.db
        .query("tamSegments")
        .withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId).eq("key", args.segmentKey!))
        .unique();
      if (!seg) throw new ConvexError("Unknown segment");
    }
    const recent = await ctx.db
      .query("tamJobs")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(20);
    for (const j of recent) {
      if (j.status !== "running" || j.kind !== args.kind || j.segmentKey !== args.segmentKey) continue;
      // A run whose action died (deploy, crash) never reports back; don't let it block forever.
      if (Date.now() - j.updatedAt > STALL_MS) await ctx.db.patch(j._id, { status: "failed", error: "Stalled", updatedAt: Date.now() });
      else throw new ConvexError("A run for this is already in progress.");
    }
    // The scope must not filter on the trait being scored, or scoring would move accounts out of it mid-run.
    const filter: AccountScope = { ...args.filter };
    if (filter.traits && args.segmentKey) {
      const { [args.segmentKey]: _own, ...rest } = filter.traits;
      filter.traits = Object.keys(rest).length ? rest : undefined;
    }
    const now = Date.now();
    const jobId = await ctx.db.insert("tamJobs", {
      orgId: user.orgId, kind: args.kind, segmentKey: args.segmentKey, filter, scope: filter, status: "running",
      inScope: 0, planned: 0, done: 0, skipped: 0, errors: 0, tokens: 0,
      createdBy: user._id, createdAt: now, updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.tam.runJob, { jobId });
    return { jobId };
  },
});

export const cancelJob = mutation({
  args: { jobId: v.id("tamJobs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.orgId !== user.orgId) throw new ConvexError("Run not found");
    if (job.status === "running") await ctx.db.patch(args.jobId, { status: "cancelled", updatedAt: Date.now() });
    return null;
  },
});

export const getJob = internalQuery({
  args: { jobId: v.id("tamJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const segment = job.segmentKey
      ? await ctx.db
          .query("tamSegments")
          .withIndex("by_orgId_and_key", (q) => q.eq("orgId", job.orgId).eq("key", job.segmentKey!))
          .unique()
      : null;
    return { job, segment };
  },
});

export const progressJob = internalMutation({
  args: {
    jobId: v.id("tamJobs"),
    set: v.object({
      inScope: v.optional(v.number()),
      planned: v.optional(v.number()),
      cursor: v.optional(v.string()),
      crmMatched: v.optional(v.number()),
      status: v.optional(v.union(v.literal("done"), v.literal("failed"))),
      error: v.optional(v.string()),
    }),
    add: v.optional(v.object({ done: v.number(), skipped: v.number(), errors: v.number(), tokens: v.number() })),
  },
  handler: async (ctx, args): Promise<"running" | "stopped"> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return "stopped";
    const add = args.add ?? { done: 0, skipped: 0, errors: 0, tokens: 0 };
    await ctx.db.patch(args.jobId, {
      ...args.set,
      done: job.done + add.done,
      skipped: job.skipped + add.skipped,
      errors: job.errors + add.errors,
      tokens: job.tokens + add.tokens,
      updatedAt: Date.now(),
    });
    return args.set.status ? "stopped" : "running";
  },
});

export const siteTexts = internalQuery({
  args: { domains: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Record<string, string> = {};
    for (const domain of args.domains) {
      const doc = await ctx.db.query("tamSiteTexts").withIndex("by_domain", (q) => q.eq("domain", domain)).first();
      if (doc) out[domain] = doc.text;
    }
    return out;
  },
});

export const putSiteTexts = internalMutation({
  args: { pages: v.array(v.object({ domain: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    for (const p of args.pages) {
      const existing = await ctx.db.query("tamSiteTexts").withIndex("by_domain", (q) => q.eq("domain", p.domain)).first();
      const doc = { domain: p.domain, text: p.text, fetchedAt: Date.now() };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("tamSiteTexts", doc);
    }
    return null;
  },
});

/** CRM-synced annual revenue (cents) by domain, for the revenue run's first pass. */
export const crmRevenue = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(10_000);
    return rows
      .filter((r) => r.domain && typeof r.annualRevenue === "number" && r.annualRevenue > 0)
      .map((r) => ({ domain: r.domain!, annualRevenueCents: r.annualRevenue! }));
  },
});

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Pages the scope by fit (highest first) and scores accounts that don't have
 * an answer yet, up to RUN_CAP. Reschedules itself between slices.
 */
export const runJob = internalAction({
  args: { jobId: v.id("tamJobs") },
  handler: async (ctx, args): Promise<null> => {
    if (!integrationEnabled("jev")) return null;
    try {
      return await runSlice(ctx, args.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`tam: run ${args.jobId} failed: ${message}`);
      await ctx.runMutation(internal.tam.progressJob, { jobId: args.jobId, set: { status: "failed", error: message.slice(0, 500) } });
      return null;
    }
  },
});

async function runSlice(ctx: ActionCtx, jobId: Id<"tamJobs">): Promise<null> {
  const args = { jobId };
  const started = Date.now();
  const loaded: { job: Doc<"tamJobs">; segment: Doc<"tamSegments"> | null } | null = await ctx.runQuery(internal.tam.getJob, { jobId: args.jobId });
  if (!loaded || loaded.job.status !== "running") return null;
  const { job, segment } = loaded;
  const ws = job.orgId as string;
  const fail = async (error: string): Promise<null> => {
    await ctx.runMutation(internal.tam.progressJob, { jobId: args.jobId, set: { status: "failed", error } });
    return null;
  };
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) return fail("JEV_API_KEY is not set on this deployment.");
  if (job.kind === "segment" && !segment) return fail("The segment was deleted.");
  const client = clientFor(ctx);
  const filter = job.scope ?? (job.filter as AccountScope);

  // First slice: size the run; for revenue, copy CRM-synced revenue in.
  if (!job.cursor && job.planned === 0) {
    let crmMatched: number | undefined;
    if (job.kind === "revenue") {
      const crm: Array<{ domain: string; annualRevenueCents: number }> = await ctx.runQuery(internal.tam.crmRevenue, { orgId: job.orgId });
      const records = crmRevenueRecords(crm);
      crmMatched = records.length ? (await client.annotate(ws, records)).updated : 0;
    }
    const { total } = await client.countSegment(ws, filter);
    await ctx.runMutation(internal.tam.progressJob, {
      jobId: args.jobId,
      set: { inScope: total, planned: Math.min(total, RUN_CAP), ...(crmMatched !== undefined ? { crmMatched } : {}) },
    });
  }

  const question: SystemOneQuestion =
    job.kind === "revenue"
      ? revenueQuestion()
      : segment!.kind === "noul"
        ? noulQuestion(segment!.criterion)
        : choiceQuestion(segment!.criterion, segment!.options ?? []);
  const has = (row: AccountRow) => (job.kind === "revenue" ? row.revenue !== undefined : row.traits?.[segment!.key] !== undefined);

  let cursor = job.cursor;
  for (;;) {
    const current: { job: Doc<"tamJobs"> } | null = await ctx.runQuery(internal.tam.getJob, { jobId: args.jobId });
    if (!current || current.job.status !== "running") return null;
    const remaining = current.job.planned - current.job.done - current.job.errors;
    if (remaining <= 0) break;
    const page = await client.list(ws, { filter, sort: { field: "fit", dir: "desc" }, cursor, limit: PAGE });
    const todo = page.rows.filter((r) => !has(r)).slice(0, remaining);
    const skipped = page.rows.length - todo.length;
    let tokens = 0;
    let errors = 0;
    const records: AnnotateRecord[] = [];
    if (todo.length) {
      const domains = todo.map((r) => normalizeDomain(r.domain));
      const texts: Record<string, string> = await ctx.runAction(internal.tamFetch.homepages, { domains });
      const answers = await pool(todo, JEV_CONCURRENCY, async (row) => {
        try {
          const res = await jevSystemOne(apiKey, evidenceState({ ...row, siteText: texts[normalizeDomain(row.domain)] ?? null }), { q: question });
          tokens += res.usage?.input_tokens ?? 0;
          return res.answers.q ?? null;
        } catch (error) {
          console.warn(`tam: jev failed for ${row.domain}: ${error instanceof Error ? error.message : error}`);
          return null;
        }
      });
      todo.forEach((row, i) => {
        const answer = answers[i];
        if (!answer) return void errors++;
        if (job.kind === "revenue") {
          const est = revenueFrom(answer);
          if (!est) return void errors++;
          records.push({ id: row.id, revenue: est.revenue, revenueSource: "estimate", revenueConfidence: est.confidence });
        } else {
          records.push({ id: row.id, traits: { [segment!.key]: bucketFor(answer) } });
        }
      });
      if (records.length) await client.annotate(ws, records);
    }
    cursor = page.nextCursor ?? undefined;
    const finished = !page.nextCursor;
    const state: "running" | "stopped" = await ctx.runMutation(internal.tam.progressJob, {
      jobId: args.jobId,
      set: { ...(cursor ? { cursor } : {}), ...(finished ? { status: "done" as const } : {}) },
      add: { done: records.length, skipped, errors, tokens },
    });
    if (state === "stopped") return null;
    if (Date.now() - started > SLICE_MS) {
      await ctx.scheduler.runAfter(0, internal.tam.runJob, args);
      return null;
    }
  }
  await ctx.runMutation(internal.tam.progressJob, { jobId: args.jobId, set: { status: "done" } });
  return null;
}
