/**
 * Signals in the app. A daily check (cron, or "Check now" from an admin) reads
 * the public job boards of the org's best-fit accounts (Greenhouse, Lever,
 * Ashby: no key, no cost) and stores each open role as a signal that points at
 * its posting. The same check reads each account's website (sitemap, feed,
 * homepage: convex/lib/signals/website.ts) for site, blog and social signals. Heat (convex/lib/signals/heat.ts) is computed from the recent
 * ones at read time. The check itself runs in convex/signalActions.ts.
 *
 * Bounded: MAX_ACCOUNTS accounts per run, by fit. Idempotent: a role is one row
 * per (org, domain, trigger), so a re-run updates it. Every change to that open
 * set is also appended to `observations` (convex/lib/signals/observations.ts),
 * which keeps the history the open set forgets. The daily check is opt-in
 * (a manager turns it on); an org that never does is never checked.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accessFor, sightJudge } from "./permissions";
import { callerClient, requireCaller } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";
import { MAX_ACCOUNTS } from "./lib/signals/boards";
import { HEAT_DOMAINS_MAX, heatScore, signalDomain, signalPoints } from "./lib/signals/heat";
import { modelSettings } from "./lib/recipes";
import { growthKinds } from "./lib/signals/growth";
import {
  boardValidator, planSignalObservations, seedFromOpenRows, signalValidator, JOB_BUCKETS,
  type Board, type Bucket, type LoggedObservation, type PlannedObservation, type SeenSignal, type Signal,
} from "./lib/signals/observations";
import { appendObservations } from "./observations";

export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A running run with no progress for this long is treated as dead. */
const STALL_MS = 15 * 60_000;
/** Runs one cron tick starts at most. */
const DUE_BATCH = 10;
/** Signals older than this are deleted when their account is next checked. */
const KEEP_MS = 90 * 24 * 60 * 60_000;
/** Observations read per account: its whole signal history at today's volume (tens of events). */
const HISTORY_READ = 500;

async function watchOf(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">) {
  return ctx.db.query("signalWatch").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).first();
}

/** Start a run unless one is live. Returns whether it started. */
async function startRun(ctx: MutationCtx, watch: Doc<"signalWatch">, trigger: "schedule" | "manual", now: number): Promise<boolean> {
  if (!integrationEnabled("treg")) return false;
  const live = watch.run?.status === "running" && now - watch.run.updatedAt < STALL_MS;
  if (live) return false;
  await ctx.db.patch(watch._id, {
    run: { status: "running", trigger, checked: 0, withBoard: 0, newSignals: 0, startedAt: now, updatedAt: now },
  });
  await ctx.scheduler.runAfter(0, internal.signalActions.runSlice, { orgId: watch.orgId });
  return true;
}

// ───────────────────────────── Run state and controls ─────────────────────────────

export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const watch = await watchOf(ctx, user.orgId);
    const run = watch?.run;
    return {
      enabled: watch?.nextRunAt !== undefined,
      nextRunAt: watch?.nextRunAt ?? null,
      canManage: can(user, "strategy.edit"),
      maxAccounts: MAX_ACCOUNTS,
      // The screen decides "stalled" itself from updatedAt and stallMs: a query can't, as it only re-runs when the data changes.
      stallMs: STALL_MS,
      run: run
        ? {
            status: run.status, trigger: run.trigger, checked: run.checked, withBoard: run.withBoard, newSignals: run.newSignals,
            error: run.error ?? null, startedAt: run.startedAt, updatedAt: run.updatedAt,
          }
        : null,
    };
  },
});

/** Turn the daily check on or off. Turning it on checks now. */
export const setEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const now = Date.now();
    let watch = await watchOf(ctx, user.orgId);
    if (!watch) {
      const id = await ctx.db.insert("signalWatch", { orgId: user.orgId });
      watch = (await ctx.db.get(id))!;
    }
    if (!args.enabled) {
      await ctx.db.patch(watch._id, { nextRunAt: undefined });
      return null;
    }
    await ctx.db.patch(watch._id, { nextRunAt: now + CHECK_EVERY_MS });
    await startRun(ctx, watch, "manual", now);
    return null;
  },
});

/** Run one check now, whether or not the daily check is on. Returns false when one is already running. */
export const checkNow = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    let watch = await watchOf(ctx, user.orgId);
    if (!watch) {
      const id = await ctx.db.insert("signalWatch", { orgId: user.orgId });
      watch = (await ctx.db.get(id))!;
    }
    return startRun(ctx, watch, "manual", Date.now());
  },
});

/** Cron: start the daily check for every org whose time has come. `now` is for tests. */
export const startDue = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!integrationEnabled("treg")) return 0;
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("signalWatch").withIndex("by_nextRunAt", (q) => q.gte("nextRunAt", 0).lte("nextRunAt", now)).take(DUE_BATCH);
    let started = 0;
    for (const watch of due) {
      // The next time moves forward whether or not a run could start, so a stuck org is not retried every tick.
      await ctx.db.patch(watch._id, { nextRunAt: now + CHECK_EVERY_MS });
      if (await startRun(ctx, watch, "schedule", now)) started++;
    }
    return started;
  },
});

// ───────────────────────────── Used by the run (signalActions.ts) ─────────────────────────────

export const runState = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const run = (await watchOf(ctx, args.orgId))?.run;
    return run?.status === "running" ? { cursor: run.cursor ?? null, checked: run.checked } : null;
  },
});

export const boardsFor = internalQuery({
  args: { orgId: v.id("organizations"), domains: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ domain: string; source: "greenhouse" | "lever" | "ashby" | null; token: string | null; checkedAt: number }> = [];
    for (const domain of args.domains) {
      const b = await ctx.db.query("signalBoards").withIndex("by_orgId_and_domain", (q) => q.eq("orgId", args.orgId).eq("domain", domain)).first();
      if (b) out.push({ domain, source: b.source ?? null, token: b.token ?? null, checkedAt: b.checkedAt });
    }
    return out;
  },
});

type AccountRead = {
  domain: string;
  board?: { source: Board; token: string } | null;
  signals?: Array<{ trigger: string; quote: string; sourceUrl: string; source: Board; observedAt?: number; reposted?: boolean }>;
  website?: { buckets: Bucket[]; signals: Array<{ signal: Signal; occurredAt?: number }> };
};

const openSignalsOf = (ctx: QueryCtx, orgId: Id<"organizations">, domain: string) =>
  ctx.db.query("accountSignals").withIndex("by_orgId_and_domain_and_trigger", (q) => q.eq("orgId", orgId).eq("domain", domain)).take(200);

const historyOf = async (ctx: QueryCtx, orgId: Id<"organizations">, domain: string): Promise<LoggedObservation[]> =>
  (await ctx.db.query("observations").withIndex("by_orgId_subjectDomain_observedAt", (q) => q.eq("orgId", orgId).eq("subject.domain", domain)).order("desc").take(HISTORY_READ))
    .map((o) => ({ seq: o.seq, observedAt: o.observedAt, body: o.body, ...(o.occurredAt === undefined ? {} : { occurredAt: o.occurredAt }) }));

const appendToAccount = (ctx: MutationCtx, orgId: Id<"organizations">, domain: string, planned: PlannedObservation[]) =>
  appendObservations(ctx, orgId, { object: "account", domain }, { kind: "pipeline", ref: "signal-check" }, planned);

/** Append what one read of the account showed, closing the open signals of `buckets` it no longer shows. */
async function record(ctx: MutationCtx, orgId: Id<"organizations">, domain: string, read: SeenSignal[], buckets: readonly Bucket[], now: number) {
  const log = await historyOf(ctx, orgId, domain);
  const openRows = log.length ? [] : await openSignalsOf(ctx, orgId, domain);
  await appendToAccount(ctx, orgId, domain, planSignalObservations(log, openRows, read, now, buckets));
}

/** Save one account's result: its board and website, what they showed as observations, and its open signals. */
export async function applyAccount(ctx: MutationCtx, orgId: Id<"organizations">, account: AccountRead, now: number): Promise<{ read: boolean; newSignals: number }> {
  const board = await applyBoard(ctx, orgId, account, now);
  const site = account.website ? await applyWebsite(ctx, orgId, account.domain, account.website, now) : 0;
  return { read: board.read, newSignals: board.newSignals + site };
}

/**
 * The website's signals: each bucket the read vouched for is replaced by what it showed. A website signal that
 * is gone leaves the open set at once; its history stays in `observations`. Returns the new signals.
 */
async function applyWebsite(ctx: MutationCtx, orgId: Id<"organizations">, domain: string, website: NonNullable<AccountRead["website"]>, now: number): Promise<number> {
  const read = website.signals.filter((s) => s.signal.bucket !== "job" && website.buckets.includes(s.signal.bucket));
  await record(ctx, orgId, domain, read, website.buckets, now);
  const existing = (await openSignalsOf(ctx, orgId, domain)).filter((r) => website.buckets.includes(r.bucket));
  const byTrigger = new Map(existing.map((r) => [r.trigger, r]));
  let newSignals = 0;
  for (const { signal, occurredAt } of read) {
    const row = byTrigger.get(signal.trigger);
    const fields = { quote: signal.quote, sourceUrl: signal.url, source: "website", lastSeenAt: now };
    if (row) await ctx.db.patch(row._id, { ...fields, observedAt: occurredAt ?? row.observedAt });
    else {
      await ctx.db.insert("accountSignals", { orgId, domain, bucket: signal.bucket, trigger: signal.trigger, ...fields, observedAt: occurredAt ?? now, firstSeenAt: now });
      newSignals++;
    }
  }
  const current = new Set(read.map((s) => s.signal.trigger));
  for (const old of existing) if (!current.has(old.trigger)) await ctx.db.delete(old._id);
  return newSignals;
}

async function applyBoard(ctx: MutationCtx, orgId: Id<"organizations">, account: AccountRead, now: number): Promise<{ read: boolean; newSignals: number }> {
  const recordJobs = (read: SeenSignal[]) => record(ctx, orgId, account.domain, read, JOB_BUCKETS, now);
  if (account.board !== undefined) {
    const cached = await ctx.db.query("signalBoards").withIndex("by_orgId_and_domain", (q) => q.eq("orgId", orgId).eq("domain", account.domain)).first();
    const doc = { orgId, domain: account.domain, source: account.board?.source, token: account.board?.token, checkedAt: now };
    if (cached) await ctx.db.replace(cached._id, doc);
    else await ctx.db.insert("signalBoards", doc);
    // No board for this account (or one that is not its own): signals read from an earlier board are gone.
    if (account.board === null) {
      await recordJobs([]);
      for (const row of await openSignalsOf(ctx, orgId, account.domain)) if (row.bucket === "job") await ctx.db.delete(row._id);
      return { read: false, newSignals: 0 };
    }
  }
  // Signals are present exactly when the account's board was read this run (new or cached).
  if (!account.signals) return { read: false, newSignals: 0 };
  await recordJobs(account.signals.map((s) => ({
    signal: { bucket: "job", trigger: s.trigger, quote: s.quote, url: s.sourceUrl, board: s.source, ...(s.reposted ? { reposted: true as const } : {}) },
    ...(s.observedAt === undefined ? {} : { occurredAt: s.observedAt }),
  })));
  let newSignals = 0;
  const existing = (await openSignalsOf(ctx, orgId, account.domain)).filter((r) => r.bucket === "job");
  const byTrigger = new Map(existing.map((s) => [s.trigger, s]));
  for (const s of account.signals) {
    const row = byTrigger.get(s.trigger);
    const fields = { quote: s.quote, sourceUrl: s.sourceUrl, source: s.source, reposted: s.reposted, lastSeenAt: now };
    if (row) await ctx.db.patch(row._id, { ...fields, observedAt: s.observedAt ?? row.observedAt });
    else {
      await ctx.db.insert("accountSignals", { orgId, domain: account.domain, bucket: "job", trigger: s.trigger, ...fields, observedAt: s.observedAt ?? now, firstSeenAt: now });
      newSignals++;
    }
  }
  const current = new Set(account.signals.map((s) => s.trigger));
  for (const old of existing) if (!current.has(old.trigger) && old.lastSeenAt < now - KEEP_MS) await ctx.db.delete(old._id);
  return { read: true, newSignals };
}

/**
 * One-off for a human, optional: seed every account that has open signals and no observations yet, a page at a
 * time. A daily check seeds the accounts it reads anyway; this covers the ones it doesn't. Safe to rerun.
 */
export const backfillObservations = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("accountSignals").paginate({ numItems: 100, cursor: args.cursor ?? null });
    const accounts = new Map(page.page.map((r) => [`${r.orgId}:${r.domain}`, { orgId: r.orgId, domain: r.domain }]));
    let seeded = 0;
    for (const { orgId, domain } of accounts.values()) {
      const has = await ctx.db.query("observations").withIndex("by_orgId_subjectDomain_observedAt", (q) => q.eq("orgId", orgId).eq("subject.domain", domain)).first();
      if (has) continue;
      await appendToAccount(ctx, orgId, domain, seedFromOpenRows(await openSignalsOf(ctx, orgId, domain)));
      seeded++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.signals.backfillObservations, { cursor: page.continueCursor });
    return seeded;
  },
});

/**
 * Save one slice of results: boards found (and misses worth remembering),
 * signals upserted by (domain, trigger), and the run's progress.
 */
export const applySlice = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accounts: v.array(v.object({
      domain: v.string(),
      // The board to remember: found, a miss to cache, or absent to leave the cache alone (a failed probe).
      board: v.optional(v.union(v.object({ source: boardValidator, token: v.string() }), v.null())),
      // Absent when the account was not fetched this run (a cached miss).
      signals: v.optional(v.array(v.object({
        trigger: v.string(), quote: v.string(), sourceUrl: v.string(), source: boardValidator,
        observedAt: v.optional(v.number()), reposted: v.optional(v.boolean()),
      }))),
      // Absent when the website was not read. `buckets` are the ones the read vouched for.
      website: v.optional(v.object({
        buckets: v.array(v.union(v.literal("site"), v.literal("blog"), v.literal("social"))),
        signals: v.array(v.object({ signal: signalValidator, occurredAt: v.optional(v.number()) })),
      })),
    })),
    nextCursor: v.union(v.string(), v.null()),
    finished: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const watch = await watchOf(ctx, args.orgId);
    if (!watch?.run || watch.run.status !== "running") return false;
    let withBoard = 0;
    let newSignals = 0;
    for (const account of args.accounts) {
      const saved = await applyAccount(ctx, args.orgId, account, now);
      if (saved.read) withBoard++;
      newSignals += saved.newSignals;
    }
    const run = watch.run;
    await ctx.db.patch(watch._id, {
      run: {
        ...run,
        checked: run.checked + args.accounts.length,
        withBoard: run.withBoard + withBoard,
        newSignals: run.newSignals + newSignals,
        cursor: args.nextCursor ?? undefined,
        status: args.finished ? "done" : "running",
        updatedAt: now,
      },
    });
    return true;
  },
});

export const failRun = internalMutation({
  args: { orgId: v.id("organizations"), error: v.string() },
  handler: async (ctx, args) => {
    const watch = await watchOf(ctx, args.orgId);
    if (watch?.run?.status === "running") await ctx.db.patch(watch._id, { run: { ...watch.run, status: "failed", error: args.error.slice(0, 300), updatedAt: Date.now() } });
    return null;
  },
});

// ───────────────────────────── Reads for the screens ─────────────────────────────

/**
 * Heat and growth for up to HEAT_DOMAINS_MAX accounts, by domain (the screen asks in chunks: heatChunks).
 * Domains with neither a recent signal nor any growth are left out.
 */
export const heatByDomain = query({
  args: { domains: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return {};
    // A role that sees only some companies: null, and the screen asks heatByDomainScoped (CP14).
    return liveOrNull(await heatAs(ctx, user, args.domains, new Set()));
  },
});

const liveOrNull = <T,>(r: { pending: readonly unknown[]; value: T }) => (r.pending.length ? null : r.value);

/** Heat over the companies `user` sees (permissions.sightJudge, by domain): a domain they may not see is left out, as one with no signals. */
async function heatAs(ctx: QueryCtx, user: Doc<"users">, domains: readonly string[], admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
  const now = Date.now();
  const model = await modelSettings(ctx, user.orgId, "signals.heat");
  const out: Record<string, { score: number; label: string; count: number; growth: string[] }> = {};
  for (const domain of new Set(domains.slice(0, HEAT_DOMAINS_MAX).map(signalDomain))) {
    if (!judge.domain(domain)) continue;
    const rows = await ctx.db.query("accountSignals")
      .withIndex("by_orgId_and_domain_and_trigger", (q) => q.eq("orgId", user.orgId).eq("domain", domain)).take(100);
    const recent = rows.filter((r) => signalPoints(r, now, model) > 0);
    const growth = growthKinds(rows, now, model);
    if (!recent.length && !growth.length) continue;
    const { score, label } = heatScore(recent, now, model);
    out[domain] = { score, label, count: recent.length, growth };
  }
  return { pending: judge.pending, value: out };
}

/** An account's observation log, newest HISTORY_READ entries: the signal half of its timeline (convex/lib/timeline.ts). */
export const log = query({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return liveOrNull(await logAs(ctx, user, args.domain, new Set()));
  },
});

async function logAs(ctx: QueryCtx, user: Doc<"users">, domain: string, admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
  if (!judge.domain(signalDomain(domain))) return { pending: judge.pending, value: null };
  return { pending: [], value: await historyOf(ctx, user.orgId, signalDomain(domain)) };
}

/** An account's recent signals, strongest first, each with the posting it came from. */
export const forAccount = query({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return liveOrNull(await forAccountAs(ctx, user, args.domain, new Set()));
  },
});

async function forAccountAs(ctx: QueryCtx, user: Doc<"users">, domain: string, admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
  if (!judge.domain(signalDomain(domain))) return { pending: judge.pending, value: null };
  const now = Date.now();
  const model = await modelSettings(ctx, user.orgId, "signals.heat");
  const rows = await ctx.db.query("accountSignals")
    .withIndex("by_orgId_and_domain_and_trigger", (q) => q.eq("orgId", user.orgId).eq("domain", signalDomain(domain))).take(100);
  const recent = rows
    .map((r) => ({ r, points: signalPoints(r, now, model) }))
    .filter((x) => x.points > 0)
    .sort((a, b) => b.points - a.points);
  return {
    pending: [],
    value: {
      heat: heatScore(recent.map((x) => x.r), now, model),
      growth: growthKinds(rows, now, model),
      windowDays: model.windowDays,
      // The heat model the account page's score history recomputes past heat on.
      model,
      signals: recent.slice(0, 8).map(({ r }) => ({
        id: r._id, bucket: r.bucket, trigger: r.trigger, quote: r.quote, sourceUrl: r.sourceUrl, source: r.source,
        observedAt: r.observedAt, reposted: r.reposted ?? false,
      })),
    },
  };
}

/** The signal reads for a role that sees only some companies (CP14), by name: the domains are admitted through the caller's scoped client. */
const SIGNAL_READS = { heat: heatAs, log: logAs, forAccount: forAccountAs } as const;

export const signalReadFor = internalQuery({
  args: { read: v.union(v.literal("heat"), v.literal("log"), v.literal("forAccount")), domains: v.array(v.string()), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { pending: [], value: null };
    const admitted = new Set(args.admitted);
    if (args.read === "heat") return SIGNAL_READS.heat(ctx, user, args.domains, admitted);
    return SIGNAL_READS[args.read](ctx, user, args.domains[0] ?? "", admitted);
  },
});

async function signalScoped(ctx: ActionCtx, read: "heat" | "log" | "forAccount", domains: string[]): Promise<unknown> {
  const caller = await requireCaller(ctx, { read: true });
  return admitThenRead<unknown>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.signals.signalReadFor, { read, domains, admitted }));
}

export const heatByDomainScoped = action({
  args: { domains: v.array(v.string()) },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof heatAs>>["value"]> => (await signalScoped(ctx, "heat", args.domains)) as Awaited<ReturnType<typeof heatAs>>["value"],
});

export const logScoped = action({
  args: { domain: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof logAs>>["value"]> => (await signalScoped(ctx, "log", [args.domain])) as Awaited<ReturnType<typeof logAs>>["value"],
});

export const forAccountScoped = action({
  args: { domain: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof forAccountAs>>["value"]> => (await signalScoped(ctx, "forAccount", [args.domain])) as Awaited<ReturnType<typeof forAccountAs>>["value"],
});
