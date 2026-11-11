/**
 * Post-claim CRM population: a waterfall of free people sources through
 * treg.to (lib/peopleSources.ts). The job is a queue of tasks, each its own
 * scheduled action:
 *
 *   people (leadsforge)  one search; one capped at 1,000 results is split
 *                        into narrower searches (splitFilters).
 *   people (quickenrich) one page of 100; the next cursor is the next task,
 *                        and a big query's first page splits it instead.
 *
 * Accounts whose name a source did not give (guessed from the domain) go on
 * the job's populateNames queue, which one name worker per job (runNames)
 * drains through Crustdata, 25 domains a call, in its own paced loop.
 *
 * recordTask schedules a task's children in the same transaction that counts
 * them as pending, so the job finishes exactly when the last task records.
 * Every page is written with fill: "missing" (a free source never overwrites
 * an existing value), and the CRM deduplicates people across sources.
 *
 * Limits: every call must cost $0. When a provider's free allowance runs out
 * or it rate-limits, providerPacing pauses that provider for every job until
 * the reset it names (or a doubling guess, at most 6 h); its tasks wait and
 * resume rather than fail. There is no volume cap on our side; a job gives up
 * waiting after MAX_JOB_MS.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { can, refusal } from "./lib/capabilities";
import { agentClientOf, requireUser } from "./lib";
import { fakeModel } from "./lib/modules/ai";
import { freePopulationQuery } from "./lib/modules/freePopulation";
import { stopPopulation } from "./lib/populationStop";
import { clientFor } from "./records";
import { atLeastVersion } from "./lib/recordClient";
import { leadsToPeople, splitFilters, type LeadsforgeFilters } from "./lib/leadsforge";
import { QE_PAGE, QE_SPLIT_ABOVE, splitQuickEnrich, type QuickEnrichQuery } from "./lib/quickenrich";
import { IDENTIFY_BATCH } from "./lib/crustdata";
import { companyName, identifyNames, leadsPage, peoplePage, tregFor, tregKey } from "./lib/providers/treg";
import { cacheAnswer, type CachedName } from "./lib/nameCache";
import { batchKey, nameFromDomain, normDomain, peopleToRecords, type Person } from "./lib/peopleSources";
import { icpGeosToCountries, segmentFor } from "./lib/researchPipeline";
import { TregRefusal } from "./lib/treg";
import { CALLS_PER_MIN, NO_FREE_ALLOWANCE, nextPause, nextSlot } from "./lib/pacing";
import { PHASE_LABEL, phasesOf } from "./lib/jobPhases";
import { acceptable, paidProvider } from "./lib/paidProviders";
import { MICRO, creditsPerRecord } from "./lib/creditPacks";
import type { Market, Persona } from "./lib/addRecords";
import { createStagedRun, readyRun, stagePage } from "./staging";
import { isFillJob } from "./lib/runs";

export type PopulateTask =
  | { kind: "people"; source: "leadsforge"; query: LeadsforgeFilters }
  /** `left`: the pages this search still needs, this one included, from its first page's total (the progress bar's estimate). */
  | { kind: "people"; source: "quickenrich"; transport?: "fake"; query: QuickEnrichQuery; cursor?: string | null; left?: number }
  /** Accounts the user named (Add records): written as unworked rows, their missing names queued for lookup. */
  | { kind: "accounts"; accounts: Array<{ domain: string; name?: string }> }
  /**
   * One page of a paid source run (lib/paidProviders.ts), spending the workspace's credits:
   * held before the call, settled to treg's metered cost x1.1 after it. `left`: pages the bar expects.
   */
  | { kind: "people"; source: "paid"; provider: string; market: Market; persona: Persona; cursor?: string | null; page: number; left?: number };

const MAX_ATTEMPTS = 3;
/** A paid run with no credits left checks again this often (until the job's deadline). */
const CREDITS_RECHECK_MS = 10 * 60 * 1000;
const OUT_OF_CREDITS = "out_of_credits";
/** How often a running job publishes progress to the session (the contacts page reloads on it). */
const SESSION_PUBLISH_MS = 20_000;
/** Leave this many of QuickEnrich's reported requests for treg's other users. */
const QE_QUOTA_FLOOR = 500;
/** A paced call waits in its action for a slot this close; a later slot reschedules the task instead. */
const SLOT_WAIT_MS = 5_000;
/** Stop waiting for free allowances this long after the job started. */
const MAX_JOB_MS = 24 * 60 * 60 * 1000;

/** The treg provider a task spends, and how far apart its sibling tasks start. */
function providerOf(task: PopulateTask): { provider: string; staggerMs: number } {
  if (task.kind === "accounts") return { provider: "accounts", staggerMs: 0 };
  if (task.source === "paid") return { provider: task.provider, staggerMs: 0 };
  return task.source === "leadsforge" ? { provider: "leadsforge", staggerMs: 2_000 } : { provider: "quickenrich", staggerMs: 1_000 };
}

/** The calls a queued task stands for: a QuickEnrich page counts the rest of its search. */
function expectedCalls(task: PopulateTask): number {
  return task.kind === "people" && (task.source === "quickenrich" || task.source === "paid") ? Math.max(1, task.left ?? 1) : 1;
}

function describe(task: PopulateTask): string {
  if (task.kind === "accounts") return `accounts ${task.accounts.length}`;
  if (task.source === "paid") return `${task.provider} page ${task.page}`;
  return task.source === "quickenrich" ? `quickenrich${task.cursor ? "+" : ""}` : `leadsforge ${JSON.stringify(task.query).length}`;
}

const NAMES_PROVIDER = "crustdata";
/** One name worker action runs this long, then hands off to a fresh one (actions are capped at 10 min). */
const NAMES_RUN_MS = 8 * 60 * 1000;

const isoToCountry = (iso: string) => icpGeosToCountries([iso.toLowerCase()])[0];

/**
 * Population relies on record service 1.5.0 (fill: "missing", nameIfCurrently):
 * an older service ignores them and would overwrite curated values. Convex and
 * the service deploy separately, so writers wait until the service catches up.
 */
const MIN_RECORD_CONTRACT = "1.5.0";
const RECORD_WAIT_MS = 2 * 60 * 1000;
async function recordServiceReady(ctx: ActionCtx): Promise<boolean> {
  return atLeastVersion(await clientFor(ctx).contractVersion(), MIN_RECORD_CONTRACT);
}

export const runTask = internalAction({
  args: {
    /** The research session a signup population reports progress to; absent for jobs started from Add records. */
    sessionId: v.optional(v.id("researchSessions")),
    jobId: v.id("backgroundJobs"),
    task: v.any(),
    attempt: v.number(),
    /** Stable across this task's retries and waits: its completion counts once. */
    taskId: v.optional(v.string()),
    /** A call slot this task already reserved (it was rescheduled to reach it). */
    slot: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    try {
      await taskBody(ctx, args);
    } catch (error) {
      // Convex doesn't retry a scheduled action: anything that escapes (a failed read
      // before the task's own handling, a bookkeeping write) would leave the task
      // pending forever. Run it again, and after a few tries settle it as failed.
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
      console.error(`populate task crashed (attempt ${args.attempt + 1}): ${message}`);
      if (args.attempt + 1 < MAX_ATTEMPTS + 2) {
        await ctx.scheduler.runAfter(10_000 * (args.attempt + 1), internal.populateActions.runTask, { ...args, attempt: args.attempt + 1 });
      } else {
        const job = await ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId });
        await recordAndMaybeFinish(ctx, { jobId: args.jobId, sessionId: args.sessionId, taskId: args.taskId, task: args.task as PopulateTask, people: 0, children: [], error: message }, job?.orgId);
      }
    }
    return null;
  },
});

async function taskBody(ctx: ActionCtx, args: TaskArgs): Promise<null> {
  {
    const task = args.task as PopulateTask;
    if (task.kind !== "people" && task.kind !== "accounts") return null; // a task kind this version no longer runs
    const { provider } = providerOf(task);
    const [session, job, pacing, staged] = await Promise.all([
      args.sessionId ? ctx.runQuery(internal.researchSessions.getInternal, { sessionId: args.sessionId }) : null,
      ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId }),
      task.kind === "people" ? ctx.runQuery(internal.populateActions.getPacing, { provider }) : null,
      ctx.runQuery(internal.staging.runFor, { jobId: args.jobId }),
    ]);
    const token = tregKey("people.search");
    // The job belongs to the workspace it fills (for a signup population, the org that claimed the session).
    const ws = job?.orgId as string | undefined;
    const base = { jobId: args.jobId, sessionId: args.sessionId, taskId: args.taskId, task, people: 0, children: [] as PopulateTask[] };
    if (task.kind === "people" && task.source === "quickenrich" && task.transport === "fake") {
      if (!fakeModel() || !staged || !ws || !job || job.counters?.stopped) {
        await recordAndMaybeFinish(ctx, { ...base, error: "Explicit test transport is unavailable for this staged run", fatal: true }, ws);
      } else await recordAndMaybeFinish(ctx, base, ws);
      return null;
    }
    if (!ws || !token || !job || job.counters?.stopped) {
      await recordAndMaybeFinish(ctx, { ...base, ...(ws && token ? {} : { error: "TREG_TOKEN or the workspace is missing", fatal: true }) }, ws);
      return null;
    }
    const now = Date.now();
    // The job's deadline holds whatever the provider is doing: a source that keeps
    // refusing would otherwise be retried after every pause, forever.
    if (now - job.startedAt > MAX_JOB_MS) {
      await recordAndMaybeFinish(ctx, { ...base, abandoned: true }, ws);
      return null;
    }
    if (pacing && pacing.pausedUntil > now) {
      // A provider that would now charge has no reset to wait for: skip the search.
      if (pacing.reason?.startsWith(NO_FREE_ALLOWANCE)) {
        await recordAndMaybeFinish(ctx, { ...base, skipped: true }, ws);
        return null;
      }
      await wait(ctx, args, provider, pacing.pausedUntil, pacing.reason ?? "free allowance used up");
      return null;
    }
    if (!(await recordServiceReady(ctx))) {
      // Not yet on the record service this population needs: try again shortly (not counted as a call).
      await ctx.scheduler.runAfter(RECORD_WAIT_MS, internal.populateActions.runTask, args);
      await withRetry(() => ctx.runMutation(internal.populateActions.markWaiting, { jobId: args.jobId, provider: "record service", until: Date.now() + RECORD_WAIT_MS, reason: "update" }));
      return null;
    }
    const started = Date.now();
    const meta = { customer: ws, feature: "populate" };
    const baseUrl = process.env.TREG_BASE_URL;
    try {
      let people: Person[] = [];
      const children: PopulateTask[] = [];
      let queuedNames = false;
      let namesQueued = 0;
      if (task.kind === "accounts") {
        // Named accounts carry no people: write them as they are, guessing a missing name for the name worker.
        ({ queued: queuedNames, added: namesQueued } = await writeNamedAccounts(ctx, ws, args.jobId, task.accounts, Boolean(staged)));
      } else if (task.source === "leadsforge") {
        const page = await leadsPage({ filters: task.query, meta, baseUrl });
        people = leadsToPeople(page.leads);
        const split = page.saturated ? splitFilters(task.query) : null;
        for (const query of split ?? []) children.push({ kind: "people", source: "leadsforge", query });
      } else if (task.source === "paid") {
        const paid = paidProvider(task.provider);
        if (!paid) throw new TregRefusal(400, "unknown_source", `No paid source "${task.provider}"`, null);
        // One hold per call: a page run again (after a crash, a pause or a credit wait) holds and is
        // charged for its own call. The ref only has to be stable within this call's retried mutations.
        const ref = `${args.jobId}:${task.provider}:${task.page}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // A page holds what it would cost if every row were kept; it is charged for the rows that are.
        const perRecordMicro = creditsPerRecord(paid.usdPerRecord) * MICRO;
        const amountMicro = perRecordMicro * paid.pageSize;
        const held = await withRetry(() => ctx.runMutation(internal.credits.hold, {
          orgId: job.orgId, spender: { jobId: args.jobId }, ref, amountMicro, note: `${paid.label}: page ${task.page}`,
        }));
        if (!held.ok) {
          if (held.reason === "balance") {
            // Out of credits: keep what the run found and continue once the workspace buys more.
            await wait(ctx, args, task.provider, Date.now() + CREDITS_RECHECK_MS, OUT_OF_CREDITS);
            return null;
          }
          // The run's own cap is spent: its search ends here.
          await recordAndMaybeFinish(ctx, { ...base, capped: true }, ws);
          return null;
        }
        let charged = 0;
        try {
          const res = await tregFor("people.search", {
            endpoint: paid.endpoint, body: paid.body(task.market, task.persona, paid.pageSize, task.cursor),
            meta: { customer: ws, feature: "paid_run" }, maxCostUsd: paid.usdPerRecord * paid.pageSize * 1.33, baseUrl,
          });
          if (res.status >= 400) throw new TregRefusal(res.status, "provider_error", `${paid.label} answered ${res.status}`, res.callId);
          // Only rows that meet the bar (full last name, LinkedIn URL, company domain) are kept.
          people = paid.rows(res.body).filter(acceptable).map((r) => ({
            fullName: `${r.firstName} ${r.lastName}`.trim(),
            ...(r.title ? { title: r.title } : {}),
            ...(r.linkedinUrl ? { linkedinUrl: r.linkedinUrl } : {}),
            company: { domain: r.companyDomain!, ...(r.companyName ? { name: r.companyName } : {}) },
          }));
          charged = people.length * perRecordMicro;
          const next = paid.page(res.body);
          const pages = next.total !== null ? Math.ceil(next.total / paid.pageSize) : undefined;
          if (next.next) children.push({ ...task, cursor: next.next, page: task.page + 1, ...(pages ? { left: Math.max(1, pages - task.page) } : {}) });
        } finally {
          // Settled even when the call fails: an unbilled call gives its hold back.
          await withRetry(() => ctx.runMutation(internal.credits.settle, { ref, chargeMicro: charged }));
        }
        await ctx.runAction(internal.credits.meterRun, { spender: { jobId: args.jobId }, provider: task.provider })
          .catch((error) => console.warn(`paid run: Metronome report failed, retried at the next page: ${error instanceof Error ? error.message.slice(0, 160) : error}`));
      } else {
        // Every job shares one QuickEnrich call rate: wait for this call's slot, or come back when it is far off.
        const slot = args.slot !== undefined && Date.now() - args.slot < 2_000
          ? args.slot
          : await withRetry(() => ctx.runMutation(internal.populateActions.takeSlot, { provider }));
        if (slot - Date.now() > SLOT_WAIT_MS) {
          await ctx.scheduler.runAt(slot, internal.populateActions.runTask, { ...args, slot });
          return null;
        }
        await sleepUntil(slot);
        const page = await peoplePage({ query: task.query, cursor: task.cursor, meta, countryName: isoToCountry, baseUrl });
        people = page.people;
        // A big query's first page: split it so the slices page in parallel, instead of one long cursor chain.
        const split = !task.cursor && (page.total ?? 0) > QE_SPLIT_ABOVE ? splitQuickEnrich(task.query) : null;
        // A first page knows the search's size: carry the pages left so the bar shows the whole search, not the next page.
        const pages = !task.cursor && page.total !== null ? Math.max(1, Math.ceil(page.total / QE_PAGE)) : task.left;
        // The slices are disjoint: share the parent's pages until each slice's first page reports its own total.
        if (split) for (const query of split) children.push({ kind: "people", source: "quickenrich", query, ...(pages ? { left: Math.ceil(pages / split.length) } : {}) });
        else if (page.next) children.push({ ...task, cursor: page.next, ...(pages ? { left: Math.max(1, pages - 1) } : {}) });
        // Stop before QuickEnrich's request quota runs dry rather than at it.
        if (page.rateRemaining !== null && page.rateRemaining < QE_QUOTA_FLOOR) {
          await withRetry(() => ctx.runMutation(internal.populateActions.pause, { provider, reason: `quota low: ${page.rateRemaining} requests left` }));
        }
      }
      // Start the next pages before writing this one, so our writes don't pace the provider's cursor chain.
      const spawned = children.length > 0 && Boolean(args.taskId);
      if (spawned) await withRetry(() => ctx.runMutation(internal.populateActions.spawnChildren, { jobId: args.jobId, sessionId: args.sessionId, taskId: args.taskId!, task, children }));
      // Never the user's own company: the preview excludes it, and so does population.
      const own = session?.domain ? normDomain(session.domain) : null;
      people = people.filter((p) => normDomain(p.company.domain) !== own);
      // A search for named companies keeps only their people: never attach anyone to an account nobody asked for.
      const named = task.kind === "people" ? targetDomains(task) : null;
      if (named) people = people.filter((p) => named.has(normDomain(p.company.domain)));
      if (people.length) {
        const recs = peopleToRecords(people);
        const client = clientFor(ctx);
        // Content-addressed keys: a retry of the same batch is a no-op, two different batches never collide.
        // The preview's segments (industry x size), so new accounts show in the segment
        // views the user lands on; fill-only keeps any segments an account already has.
        const accounts = recs.accounts.map((a) => ({ ...a, segmentIds: [segmentFor(a).id] }));
        if (staged) {
          // Held for review: nothing reaches the CRM until a selection is approved (staging.ts).
          const guessed = new Set(recs.derivedNames);
          await stagePage(ctx, ws, args.jobId, provider, accounts.map((a) => ({ ...a, nameGuessed: guessed.has(a.domain) })), recs.contacts);
        } else {
          // Accounts first: contacts attach to their account by domain.
          if (accounts.length) await client.upsertAccounts(ws, { records: accounts, source: provider, idempotencyKey: batchKey(args.jobId, "a", accounts), fill: "missing" });
          if (recs.contacts.length) await client.upsertContacts(ws, { records: recs.contacts, source: provider, idempotencyKey: batchKey(args.jobId, "c", recs.contacts), fill: "missing" });
        }
        const routed = await routeAccountNames(ctx, ws, args.jobId, recs.accounts, recs.derivedNames, provider);
        queuedNames ||= routed.queued;
        namesQueued += routed.added;
      }
      if (pacing?.strikes) await withRetry(() => ctx.runMutation(internal.populateActions.clearPacing, { provider }));
      console.log(`populate ${describe(task)}: ${people.length} people, ${children.length} next${queuedNames ? ", names queued" : ""}, ${Date.now() - started}ms`);
      await recordAndMaybeFinish(ctx, { ...base, people: people.length, children: spawned ? [] : children, startNames: queuedNames, namesQueued }, ws);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
      if (error instanceof TregRefusal && error.temporary) {
        // Out of free capacity or rate-limited: pause the provider for every job and wait.
        // With no free allowance left the pause still spaces out later probes, but this search is skipped.
        const free = error.noFreeAllowance;
        const until = await withRetry(() => ctx.runMutation(internal.populateActions.pause, {
          provider, retryAt: error.retryAt ?? undefined, rateLimited: error.brief, reason: `${free ? NO_FREE_ALLOWANCE : error.code}: ${message.slice(0, 120)}`,
        }));
        if (free) {
          console.warn(`populate ${describe(task)}: ${provider} has no free allowance left, skipped`);
          await recordAndMaybeFinish(ctx, { ...base, skipped: true }, ws);
          return null;
        }
        console.warn(`populate ${describe(task)}: ${provider} paused until ${new Date(until).toISOString()} (${error.code})`);
        await wait(ctx, args, provider, until, error.code);
        return null;
      }
      if (!(error instanceof TregRefusal) && args.attempt + 1 < MAX_ATTEMPTS) {
        console.warn(`populate ${describe(task)} attempt ${args.attempt + 1} failed, retrying: ${message}`);
        await ctx.scheduler.runAfter(5_000 * (args.attempt + 1), internal.populateActions.runTask, { ...args, attempt: args.attempt + 1 });
        return null;
      }
      console.error(`populate ${describe(task)} failed after ${Date.now() - started}ms: ${message}`);
      // A permanent refusal (e.g. the token is blocked) stops the whole job.
      await recordAndMaybeFinish(ctx, { ...base, error: message, fatal: error instanceof TregRefusal }, ws);
    }
    return null;
  }
}

type TaskArgs = { sessionId?: Id<"researchSessions">; jobId: Id<"backgroundJobs">; task: unknown; attempt: number; taskId?: string; slot?: number };

/** Re-run this task once the provider's pause ends (with jitter, so waiting tasks don't stampede). */
async function wait(ctx: ActionCtx, args: TaskArgs, provider: string, until: number, reason: string) {
  const at = until + Math.floor(Math.random() * 60_000);
  await ctx.scheduler.runAt(at, internal.populateActions.runTask, { ...args, attempt: 0 });
  await withRetry(() => ctx.runMutation(internal.populateActions.markWaiting, { jobId: args.jobId, provider, until: at, reason }));
}

type RecordArgs = {
  jobId: Id<"backgroundJobs">;
  sessionId?: Id<"researchSessions">;
  /** The task (or name-worker lineage) recording: a second record for it is ignored. */
  taskId?: string;
  task?: PopulateTask;
  people: number;
  names?: number;
  children: PopulateTask[];
  /** This task queued account names: start the job's name worker if none is running. */
  startNames?: boolean;
  /** Names this task newly queued (the names bar's total). */
  namesQueued?: number;
  /** The name worker found its queue empty and stops (it counted as one pending task). */
  namesDone?: boolean;
  /** The name worker gives up (deadline or repeated crashes): don't restart it for names still queued. */
  namesAbandon?: boolean;
  error?: string;
  fatal?: boolean;
  abandoned?: boolean;
  /** The provider has no free allowance left: the search was not run. */
  skipped?: boolean;
  /** A paid page that found its run's credit cap spent: the search ends. */
  capped?: boolean;
};

/**
 * Every task records into the one job row, so under many concurrent tasks
 * Convex's own conflict retries can run out. A failed mutation never
 * committed, so retrying it is safe; a lost record would leave the job
 * pending forever.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 500));
    }
  }
}

async function recordAndMaybeFinish(ctx: ActionCtx, args: RecordArgs, ws: string | undefined) {
  const { finished } = await withRetry(() => ctx.runMutation(internal.populateActions.recordTask, args));
  if (finished) await finish(ctx, args.jobId, args.sessionId, ws);
}

async function finish(ctx: ActionCtx, jobId: Id<"backgroundJobs">, sessionId: Id<"researchSessions"> | undefined, ws: string | undefined) {
  // Exact totals when the store can count them; a finished job still finishes if it can't.
  let totals: { accounts: number; contacts: number } | undefined;
  if (ws) {
    try {
      const client = clientFor(ctx);
      const [accounts, contacts] = await Promise.all([client.list(ws, { limit: 1 }), client.listContacts(ws, { limit: 1 })]);
      totals = { accounts: accounts.total, contacts: contacts.total };
    } catch (error) {
      console.warn(`populate: could not count the workspace's records: ${error instanceof Error ? error.message.slice(0, 160) : error}`);
    }
  }
  await withRetry(() => ctx.runMutation(internal.populateActions.finishJob, { jobId, sessionId, ...totals }));
}

/** The domains a search for named companies asked for, or null for a market search. */
function targetDomains(task: Extract<PopulateTask, { kind: "people" }>): Set<string> | null {
  if (task.source === "paid") return null;
  const list = task.source === "leadsforge" ? task.query.companyDomains?.include : task.query.company_url?.include;
  return list?.length ? new Set(list.map(normDomain)) : null;
}

/**
 * Write the accounts a user named (fill-only) and queue lookups for the names
 * they left out. A name the user typed stays in this workspace: it never
 * reaches the shared name cache other workspaces read.
 */
async function writeNamedAccounts(ctx: ActionCtx, ws: string, jobId: Id<"backgroundJobs">, named: Array<{ domain: string; name?: string }>, staged: boolean) {
  const accounts = named.map((a) => ({ domain: a.domain, name: a.name ?? nameFromDomain(a.domain) }));
  const derived = named.filter((a) => !a.name).map((a) => a.domain);
  if (staged) await stagePage(ctx, ws, jobId, "manual", accounts.map((a, i) => ({ ...a, nameGuessed: !named[i].name })), []);
  else await clientFor(ctx).upsertAccounts(ws, { records: accounts, source: "manual", idempotencyKey: batchKey(jobId, "a", accounts), fill: "missing" });
  const guessed = new Set(derived);
  return routeAccountNames(ctx, ws, jobId, accounts.filter((a) => guessed.has(a.domain)), derived, "manual");
}

/**
 * Queue guessed names for the name worker and write supplied ones over any guess.
 * `queued`: names wait for the worker; `added`: rows this call put on the queue (the names bar's total).
 */
async function routeAccountNames(ctx: ActionCtx, ws: string, jobId: Id<"backgroundJobs">, accounts: Array<{ domain: string; name: string }>, derivedNames: string[], source: string): Promise<{ queued: boolean; added: number }> {
  const derived = new Set(derivedNames);
  const named = accounts.filter((a) => !derived.has(a.domain)).map((a) => ({ domain: a.domain, name: a.name }));
  let queued = false;
  let added = 0;
  for (let i = 0; i < Math.max(derivedNames.length, named.length); i += 400) {
    const routed = await withRetry(() => ctx.runMutation(internal.populateActions.routeNames, {
      jobId, derived: derivedNames.slice(i, i + 400), named: named.slice(i, i + 400), source,
    }));
    queued ||= routed.queued > 0;
    added += routed.added;
    if (routed.overwrite.length) await writeNames(ctx, ws, jobId, routed.overwrite);
  }
  return { queued, added };
}

/**
 * Sort one page's account names. Names a source supplied go into the cache,
 * settle any of this job's queued domains, and come back to be written over
 * any guess still stored (guarded, so a real name is never replaced; a failed
 * write is replayed when the task retries). Guessed names are queued for the
 * name worker.
 */
export const routeNames = internalMutation({
  args: {
    jobId: v.id("backgroundJobs"),
    derived: v.array(v.string()),
    named: v.array(v.object({ domain: v.string(), name: v.string() })),
    source: v.string(),
  },
  handler: async (ctx, a): Promise<{ queued: number; added: number; overwrite: Array<{ domain: string; name: string; linkedinUrl?: string }> }> => {
    const now = Date.now();
    const overwrite: Array<{ domain: string; name: string; linkedinUrl?: string }> = [];
    for (const n of a.named) {
      const cached = await ctx.db.query("companyNames").withIndex("by_domain", (q) => q.eq("domain", n.domain)).unique();
      if (!cached) await ctx.db.insert("companyNames", { domain: n.domain, name: n.name, source: a.source, updatedAt: now });
      else if (!cached.name) await ctx.db.patch(cached._id, { name: n.name, source: a.source, updatedAt: now });
      const queued = await ctx.db.query("populateNames").withIndex("by_jobId_and_domain", (q) => q.eq("jobId", a.jobId).eq("domain", n.domain)).first();
      if (queued && !queued.resolved) await ctx.db.patch(queued._id, { resolved: true });
      else if (!queued) await ctx.db.insert("populateNames", { jobId: a.jobId, domain: n.domain, resolved: true });
      // Always send the (placeholder-guarded) name: the account may hold a guess
      // from the preview or an earlier page even when nothing is queued for it.
      overwrite.push(cached?.name ? { domain: n.domain, name: cached.name, ...(cached.linkedinUrl ? { linkedinUrl: cached.linkedinUrl } : {}) } : n);
    }
    // Guessed names only go on the queue; the worker writes them (from the cache
    // when it can) and settles each row only after its write, so nothing is lost
    // if this task fails. `queued` counts every unresolved row this page touches,
    // so a retried task restarts a worker for work an earlier attempt queued.
    let queued = 0;
    let added = 0;
    for (const domain of a.derived) {
      const seen = await ctx.db.query("populateNames").withIndex("by_jobId_and_domain", (q) => q.eq("jobId", a.jobId).eq("domain", domain)).first();
      if (seen) {
        if (!seen.resolved) queued++;
        continue;
      }
      await ctx.db.insert("populateNames", { jobId: a.jobId, domain, resolved: false });
      queued++;
      added++;
    }
    return { queued, added, overwrite };
  },
});

/** Settle resolved queue rows and remember the names found, for every later workspace. */
export const settleNames = internalMutation({
  args: {
    ids: v.array(v.id("populateNames")),
    found: v.array(v.object({ domain: v.string(), name: v.string(), linkedinUrl: v.optional(v.string()), source: v.string() })),
    /** Domains every resolver tried and could not name. */
    missed: v.optional(v.array(v.string())),
    /** Rows one resolver missed: they stay queued for the others. */
    tried: v.optional(v.array(v.object({ id: v.id("populateNames"), tried: v.array(v.string()) }))),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    for (const id of a.ids) await ctx.db.patch(id, { resolved: true });
    for (const t of a.tried ?? []) await ctx.db.patch(t.id, { tried: t.tried });
    for (const f of a.found) {
      const cached = await ctx.db.query("companyNames").withIndex("by_domain", (q) => q.eq("domain", f.domain)).unique();
      if (cached) await ctx.db.patch(cached._id, { name: f.name, ...(f.linkedinUrl ? { linkedinUrl: f.linkedinUrl } : {}), source: f.source, updatedAt: now });
      else await ctx.db.insert("companyNames", { ...f, updatedAt: now });
    }
    for (const domain of a.missed ?? []) {
      const cached = await ctx.db.query("companyNames").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
      if (cached?.name) continue;
      if (cached) await ctx.db.patch(cached._id, { updatedAt: now });
      else await ctx.db.insert("companyNames", { domain, source: "miss", updatedAt: now });
    }
    return null;
  },
});

export const cachedNames = internalQuery({
  args: { domains: v.array(v.string()) },
  handler: async (ctx, a): Promise<CachedName[]> => {
    const now = Date.now();
    const out: CachedName[] = [];
    for (const domain of a.domains) {
      const known = cacheAnswer(await ctx.db.query("companyNames").withIndex("by_domain", (q) => q.eq("domain", domain)).unique(), now);
      if (known) out.push(known);
    }
    return out;
  },
});

/**
 * Replace guessed account names with real ones. Only while the stored name is
 * still the placeholder we guessed (nameIfCurrently): a name a rep or a CRM
 * wrote is never touched, and the LinkedIn page only fills an empty field.
 */
async function writeNames(ctx: ActionCtx, ws: string, jobId: Id<"backgroundJobs">, names: Array<{ domain: string; name: string; linkedinUrl?: string }>) {
  if (!names.length) return;
  // A run held for review names its staged accounts instead.
  if (await ctx.runQuery(internal.staging.runFor, { jobId })) {
    await withRetry(() => ctx.runMutation(internal.staging.renameAccounts, { jobId, names }));
    return;
  }
  const records = names.map((n) => ({
    domain: n.domain,
    name: n.name,
    nameIfCurrently: nameFromDomain(n.domain),
    ...(n.linkedinUrl ? { linkedinUrl: n.linkedinUrl } : {}),
  }));
  await clientFor(ctx).upsertAccounts(ws, { records, source: "names", idempotencyKey: batchKey(jobId, "n", records), fill: "missing" });
}


type NamesPage = { rows: Array<{ id: Id<"populateNames">; domain: string; tried: string[] }>; next: string | null };

/** One page of the job's unresolved names; the worker pages on so blocked rows can't hide later ones. */
export const nextNames = internalQuery({
  args: { jobId: v.id("backgroundJobs"), limit: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<NamesPage> => {
    const page = await ctx.db
      .query("populateNames")
      .withIndex("by_jobId_and_resolved", (q) => q.eq("jobId", a.jobId).eq("resolved", false))
      .paginate({ numItems: a.limit, cursor: a.cursor });
    return {
      rows: page.page.map((row) => ({ id: row._id, domain: row.domain, tried: row.tried ?? [] })),
      next: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Queue rows a worker pass reads. Cache hits settle without paced calls, so a
 * wide page keeps a cache-heavy queue fast; lookups stay capped per provider.
 */
const NAMES_BATCH = 1000;

/** Every resolver a domain must miss before it is cached as a miss. */
const NAME_RESOLVERS = ["crustdata", "companyenrich"];
/** A name lookup gives up after this, so a pass stays well inside the action limit. */
const NAME_CALL_TIMEOUT_MS = 20_000;
/** No lookup starts later than this into a worker run (Convex kills actions at 10 min). */
const NAMES_HARD_STOP_MS = 9 * 60 * 1000 - NAME_CALL_TIMEOUT_MS - 15_000;

/** CompanyEnrich lookups per worker pass, beside one 25-domain Crustdata call. */
const COMPANYENRICH_PER_PASS = 4;

/**
 * The job's one name worker. Each pass takes queued guessed names, settles
 * the ones the shared cache knows, and resolves the rest in parallel: up to
 * 25 through Crustdata (one call) and up to 4 through CompanyEnrich (one
 * domain a call), each on its own shared call slots and pauses. A provider
 * that is paused just gets no work that pass. Hands off to a fresh action
 * before the action time limit; stops when the queue is empty.
 */
export const runNames = internalAction({
  args: { sessionId: v.optional(v.id("researchSessions")), jobId: v.id("backgroundJobs"), crashes: v.optional(v.number()), workerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    try {
      await nameWorker(ctx, args);
    } catch (error) {
      // Convex does not retry a scheduled action: an unexpected failure (e.g. the
      // record service down) would strand the job with its worker counted as
      // pending. The queue is intact, so run again, and give up after a few crashes.
      const crashes = (args.crashes ?? 0) + 1;
      console.error(`populate names worker crashed (${crashes}): ${error instanceof Error ? error.message.slice(0, 200) : error}`);
      if (crashes >= NAMES_MAX_CRASHES) {
        const job = await ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId });
        await recordAndMaybeFinish(ctx, { jobId: args.jobId, sessionId: args.sessionId, taskId: args.workerId, people: 0, children: [], namesDone: true, namesAbandon: true, error: "name lookups kept failing" }, job?.orgId);
      } else {
        await ctx.scheduler.runAfter(30_000 * crashes, internal.populateActions.runNames, { sessionId: args.sessionId, jobId: args.jobId, crashes, workerId: args.workerId });
      }
    }
    return null;
  },
});

const NAMES_MAX_CRASHES = 5;

async function nameWorker(ctx: ActionCtx, args: { sessionId?: Id<"researchSessions">; jobId: Id<"backgroundJobs">; crashes?: number; workerId?: string }) {
  {
    const token = tregKey("company.enrich");
    const ws = (await ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId }))?.orgId as string | undefined;
    let resolved = 0;
    const done = (abandon = false) =>
      recordAndMaybeFinish(ctx, { jobId: args.jobId, sessionId: args.sessionId, taskId: args.workerId, people: 0, names: resolved, children: [], namesDone: true, ...(abandon ? { namesAbandon: true } : {}) }, ws);
    // A later run starts with a clean crash count, in the same lineage.
    const next = { sessionId: args.sessionId, jobId: args.jobId, workerId: args.workerId };
    // Without a token or workspace no later run can do better: abandon the queue.
    if (!ws || !token) return void (await done(true));
    const meta = { customer: ws, feature: "populate_names" };
    const baseUrl = process.env.TREG_BASE_URL;
    const started = Date.now();
    const failures: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const rowFailures = new Map<string, number>();
    let refused: TregRefusal | null = null;
    let cursor: string | null = null;
    let workThisSweep = false;
    let crust: Doc<"providerPacing"> | null = null;
    let ce: Doc<"providerPacing"> | null = null;
    const getPacingFor = (provider: string): Promise<Doc<"providerPacing"> | null> => ctx.runQuery(internal.populateActions.getPacing, { provider });
    /** Every queued name needs a paused resolver: run again when the first one resumes (at least a minute). */
    const waitForResolvers = async () => {
      const resumes = [crust, ce].filter((p) => p && p.pausedUntil > Date.now()).map((p) => p!.pausedUntil);
      const until = Math.max(Date.now() + 60_000, resumes.length ? Math.min(...resumes) : 0);
      await withRetry(() => ctx.runMutation(internal.populateActions.addNames, { jobId: args.jobId, names: resolved }));
      resolved = 0;
      await ctx.scheduler.runAt(until, internal.populateActions.runNames, next);
      if (resumes.length) {
        await withRetry(() => ctx.runMutation(internal.populateActions.markWaiting, { jobId: args.jobId, provider: "name lookup", until, reason: "rate limit" }));
      }
    };
    let pass = 0;
    while (Date.now() - started < NAMES_RUN_MS) {
      pass++;
      const job = await ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId });
      if (!job || job.counters?.stopped) return void (await done());
      // Past the job's deadline the worker stops, whatever else is wrong; any names left keep their guesses.
      if (Date.now() - job.startedAt > MAX_JOB_MS) {
        await done(true);
        return;
      }
      if (pass === 1 && !(await recordServiceReady(ctx))) {
        await ctx.scheduler.runAfter(RECORD_WAIT_MS, internal.populateActions.runNames, next);
        return;
      }
      [crust, ce] = await Promise.all([getPacingFor(NAMES_PROVIDER), getPacingFor("companyenrich")]);
      const now = Date.now();
      const crustOpen = !crust || crust.pausedUntil <= now;
      const ceOpen = !ce || ce.pausedUntil <= now;
      // A wide page: cache hits settle without provider calls; only misses wait for lookups.
      const page: NamesPage = await ctx.runQuery(internal.populateActions.nextNames, { jobId: args.jobId, limit: NAMES_BATCH, cursor });
      const batch = page.rows;
      const sweepStart = cursor === null;
      cursor = page.next;
      if (!batch.length) {
        if (sweepStart) return void (await done()); // the whole queue is empty
        if (!workThisSweep) {
          await waitForResolvers();
          return;
        }
        workThisSweep = false;
        continue; // end of a sweep that did work: start the next one
      }

      // The shared cache first: another workspace may have resolved these already.
      const cached = await ctx.runQuery(internal.populateActions.cachedNames, { domains: batch.map((b) => b.domain) });
      const cachedSet = new Set(cached.map((c) => c.domain));
      const cachedNamesFound = cached.filter((c): c is { domain: string; name: string; linkedinUrl?: string } => "name" in c);
      const misses = batch.filter((b) => !cachedSet.has(b.domain));
      // Each miss goes to a resolver that hasn't tried it yet.
      const toCrust = crustOpen ? misses.filter((b) => !b.tried.includes(NAMES_PROVIDER)).slice(0, IDENTIFY_BATCH) : [];
      const inCrust = new Set(toCrust.map((b) => b.id));
      const toCe = ceOpen ? misses.filter((b) => !inCrust.has(b.id) && !b.tried.includes("companyenrich")).slice(0, COMPANYENRICH_PER_PASS) : [];
      const hardStop = started + NAMES_HARD_STOP_MS;
      // Nothing on this page can run now (its misses need a paused resolver): page on.
      // Only a whole sweep with no work waits for a resolver to resume.
      if (!cached.length && !toCrust.length && !toCe.length) {
        if (cursor === null) {
          if (!workThisSweep) {
            await waitForResolvers();
            return;
          }
          workThisSweep = false;
        }
        continue;
      }
      workThisSweep = true;

      const found: Array<{ domain: string; name: string; linkedinUrl?: string; source: string }> = cachedNamesFound.map((c) => ({ ...c, source: "cache" }));
      const missedBy = new Map<string, string>(); // row id -> the resolver that just missed it
      const settled = batch.filter((b) => cachedSet.has(b.domain)).map((b) => b.id);
      type Got = { names: Array<{ domain: string; name: string; linkedinUrl?: string }>; processed: typeof batch };
      const attempt = async (provider: string, items: typeof batch, run: () => Promise<Got>) => {
        if (!items.length) return;
        try {
          const got = await run();
          for (const f of got.names) found.push({ ...f, source: provider });
          const named = new Set(got.names.map((f) => f.domain));
          // Only items actually looked up count; ones skipped for time stay queued as they were.
          for (const b of got.processed) {
            if (named.has(b.domain)) settled.push(b.id);
            else missedBy.set(b.id, provider);
          }
          failures[provider] = 0;
        } catch (error) {
          if (error instanceof TregRefusal && error.temporary) {
            await withRetry(() => ctx.runMutation(internal.populateActions.pause, {
              provider, retryAt: error.retryAt ?? undefined, rateLimited: error.brief, reason: `${error.code}: ${error.message.slice(0, 120)}`,
            }));
            return; // these domains stay queued for the next pass
          }
          // A permanent refusal (e.g. a call that cost money) is never retried: stop the job.
          if (error instanceof TregRefusal) {
            refused = error;
            return;
          }
          // Retry a failing batch a few passes (a 502 passes), then skip it: names are cosmetic.
          failures[provider] = (failures[provider] ?? 0) + 1;
          console.error(`populate names via ${provider} failed (${failures[provider]}): ${error instanceof Error ? error.message.slice(0, 200) : error}`);
          // After repeated failures count the batch as this resolver's miss: the other resolver
          // still gets to try it, and nothing is settled without a name or every resolver's miss.
          if (failures[provider] >= 3) {
            for (const b of items) missedBy.set(b.id, provider);
            failures[provider] = 0;
          }
        }
      };
      // A negative slot means "not before -slot": refused, nothing reserved.
      const crustSlot = toCrust.length ? await withRetry(() => ctx.runMutation(internal.populateActions.takeSlot, { provider: NAMES_PROVIDER, notAfter: hardStop })) : 0;
      const ceSlot = toCe.length ? await withRetry(() => ctx.runMutation(internal.populateActions.takeSlot, { provider: "companyenrich", count: toCe.length, notAfter: hardStop })) : 0;
      if (crustSlot < 0) toCrust.length = 0;
      if (ceSlot < 0) toCe.length = 0;
      if (!cached.length && !toCrust.length && !toCe.length) {
        // No slot fits this run's budget: hand off to a fresh run at the earliest one.
        const at = Math.min(...[crustSlot, ceSlot].filter((x) => x < 0).map((x) => -x));
        await withRetry(() => ctx.runMutation(internal.populateActions.addNames, { jobId: args.jobId, names: resolved }));
        resolved = 0;
        await ctx.scheduler.runAt(at, internal.populateActions.runNames, next);
        return;
      }
      const ceInterval = Math.ceil(60_000 / CALLS_PER_MIN.companyenrich);
      let ceStop: TregRefusal | null = null;
      await Promise.all([
        attempt(NAMES_PROVIDER, toCrust, async () => {
          await sleepUntil(crustSlot);
          const m = await identifyNames({ domains: toCrust.map((b) => b.domain), meta, baseUrl, timeoutMs: NAME_CALL_TIMEOUT_MS });
          return { names: [...m].map(([domain, c]) => ({ domain, ...c })), processed: toCrust };
        }),
        attempt("companyenrich", toCe, async () => {
          const names: Array<{ domain: string; name: string }> = [];
          const processed: typeof batch = [];
          for (let i = 0; i < toCe.length; i++) {
            // Past the budget the rest stay queued for the next run.
            if (ceSlot + i * ceInterval > hardStop || Date.now() > hardStop) break;
            await sleepUntil(ceSlot + i * ceInterval);
            let name: string | null;
            try {
              name = await companyName({ domain: toCe[i].domain, meta, baseUrl, timeoutMs: NAME_CALL_TIMEOUT_MS });
            } catch (error) {
              // A refusal ends this resolver's pass, keeping what it already found.
              if (error instanceof TregRefusal) {
                ceStop = error;
                break;
              }
              // An ordinary failure costs only this row a retry; after three it counts as a miss.
              const n = (rowFailures.get(toCe[i].id) ?? 0) + 1;
              rowFailures.set(toCe[i].id, n);
              console.error(`populate names via companyenrich failed for ${toCe[i].domain} (${n}): ${error instanceof Error ? error.message.slice(0, 160) : error}`);
              if (n >= 3) processed.push(toCe[i]);
              continue;
            }
            if (name) names.push({ domain: toCe[i].domain, name });
            processed.push(toCe[i]);
          }
          return { names, processed };
        }),
      ]);
      const stop = ceStop as TregRefusal | null;
      if (stop?.temporary) {
        await withRetry(() => ctx.runMutation(internal.populateActions.pause, {
          provider: "companyenrich", retryAt: stop.retryAt ?? undefined, rateLimited: stop.brief, reason: `${stop.code}: ${stop.message.slice(0, 120)}`,
        }));
      } else if (stop) refused = stop;
      if (refused) {
        const r: TregRefusal = refused;
        console.error(`populate names: stopping the job, ${r.code}: ${r.message.slice(0, 160)}`);
        await recordAndMaybeFinish(ctx, { jobId: args.jobId, sessionId: args.sessionId, taskId: args.workerId, people: 0, children: [], namesDone: true, namesAbandon: true, fatal: true, error: r.message.slice(0, 300) }, ws);
        return;
      }
      if (found.length) await writeNames(ctx, ws, args.jobId, found);
      // A miss settles (and is cached for every workspace) only once every resolver has missed it.
      const missed: string[] = [];
      const triedUpdates: Array<{ id: Id<"populateNames">; tried: string[] }> = [];
      for (const b of batch) {
        const by = missedBy.get(b.id);
        if (!by) continue;
        const tried = [...new Set([...b.tried, by])];
        if (NAME_RESOLVERS.every((r) => tried.includes(r))) {
          settled.push(b.id);
          missed.push(b.domain);
        } else triedUpdates.push({ id: b.id, tried });
      }
      if (settled.length || found.length || triedUpdates.length) {
        await withRetry(() => ctx.runMutation(internal.populateActions.settleNames, {
          ids: settled,
          found: found.filter((f) => f.source !== "cache"),
          missed,
          tried: triedUpdates,
        }));
      }
      resolved += found.length;
      for (const f of found) bySource[f.source] = (bySource[f.source] ?? 0) + 1;
      // Nothing could run this pass (both handed their work back): don't spin.
      if (!settled.length && !found.length && !triedUpdates.length) await new Promise((r) => setTimeout(r, 2_000));
    }
    console.log(`populate names: ${resolved} resolved this run (${JSON.stringify(bySource)}, ${pass} passes), handing off`);
    await withRetry(() => ctx.runMutation(internal.populateActions.addNames, { jobId: args.jobId, names: resolved }));
    await ctx.scheduler.runAfter(0, internal.populateActions.runNames, next);
    return;
  }
}

async function sleepUntil(at: number) {
  const ms = at - Date.now();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export const addNames = internalMutation({
  args: { jobId: v.id("backgroundJobs"), names: v.number() },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "processing") return null;
    const counters = { ...(job.counters ?? {}), names: (job.counters?.names ?? 0) + a.names };
    await ctx.db.patch(a.jobId, { counters, detail: progressOf(counters), phases: phasesOf(counters, Date.now()), updatedAt: Date.now() });
    return null;
  },
});

export const getJob = internalQuery({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, args) => ctx.db.get(args.jobId),
});

export const getPacing = internalQuery({
  args: { provider: v.string() },
  handler: async (ctx, args) => ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", args.provider)).unique(),
});

/**
 * Pause a provider for every job. Concurrent refusals in one episode share it
 * (strikes only grow when the previous pause had ended). Returns the end.
 */
export const pause = internalMutation({
  args: { provider: v.string(), retryAt: v.optional(v.number()), rateLimited: v.optional(v.boolean()), reason: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const now = Date.now();
    const row = await ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", args.provider)).unique();
    const next = nextPause(row, now, args.retryAt, args.rateLimited);
    if (!next.changed) return next.pausedUntil;
    const { pausedUntil, strikes } = next;
    if (row) await ctx.db.patch(row._id, { pausedUntil, strikes, reason: args.reason, updatedAt: now });
    else await ctx.db.insert("providerPacing", { provider: args.provider, pausedUntil, strikes, reason: args.reason, updatedAt: now });
    return pausedUntil;
  },
});

/** Reserve the next call slot for a rate-limited provider (shared by every job). */
export const takeSlot = internalMutation({
  /** `notAfter`: refuse (without reserving) a slot that would start later than this. */
  args: { provider: v.string(), count: v.optional(v.number()), notAfter: v.optional(v.number()) },
  handler: async (ctx, args): Promise<number> => {
    const now = Date.now();
    const row = await ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", args.provider)).unique();
    const { at, next, intervalMs } = nextSlot(row?.nextSlotAt, now, CALLS_PER_MIN[args.provider] ?? 60, args.count ?? 1);
    // A caller that can't use the slot in time leaves the shared queue where it was.
    if (args.notAfter !== undefined && at + ((args.count ?? 1) - 1) * intervalMs > args.notAfter) return -at;
    if (row) await ctx.db.patch(row._id, { nextSlotAt: next, updatedAt: now });
    else await ctx.db.insert("providerPacing", { provider: args.provider, pausedUntil: 0, strikes: 0, nextSlotAt: next, updatedAt: now });
    return at;
  },
});

/**
 * Count one call against a provider's daily cap across all workspaces (UTC
 * day); false once the cap is reached. For free calls that spend treg's own
 * credits, so we take only a modest share.
 */
export const takeDaily = internalMutation({
  args: { provider: v.string(), cap: v.number() },
  handler: async (ctx, a): Promise<boolean> => {
    const day = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const row = await ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", a.provider)).unique();
    const count = row?.day === day ? row.dayCount ?? 0 : 0;
    if (count >= a.cap) return false;
    if (row) await ctx.db.patch(row._id, { day, dayCount: count + 1, updatedAt: now });
    else await ctx.db.insert("providerPacing", { provider: a.provider, pausedUntil: 0, strikes: 0, day, dayCount: 1, updatedAt: now });
    return true;
  },
});

/** A success after pauses: the provider is healthy again, so the next pause starts from the shortest guess. */
export const clearPacing = internalMutation({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", args.provider)).unique();
    if (row && row.strikes && row.pausedUntil <= Date.now()) await ctx.db.patch(row._id, { strikes: 0, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Ops: end a provider's pause now (strikes too) and pull its waiting tasks
 * forward, e.g. after a pause outlived its cause. Run with `convex run`.
 * Pages through the scheduler's table: a deployment keeps days of finished runs.
 */
export const resumeProvider = internalAction({
  args: { provider: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const before = Date.now();
    let cursor: string | null = null;
    let moved = 0;
    for (;;) {
      const page: { moved: number; cursor: string; isDone: boolean } = await ctx.runMutation(internal.populateActions.resumeProviderPage, { provider: args.provider, before, cursor, offset: moved });
      moved += page.moved;
      if (page.isDone) return moved;
      cursor = page.cursor;
    }
  },
});

export const resumeProviderPage = internalMutation({
  /**
   * `before`: only runs scheduled before the resume began, so a task moved by an earlier page isn't moved again.
   * `offset`: tasks moved by earlier pages, so the stagger continues across pages.
   */
  args: { provider: v.string(), before: v.number(), cursor: v.union(v.string(), v.null()), offset: v.number() },
  handler: async (ctx, args): Promise<{ moved: number; cursor: string; isDone: boolean }> => {
    const now = Date.now();
    if (args.cursor === null) {
      const row = await ctx.db.query("providerPacing").withIndex("by_provider", (q) => q.eq("provider", args.provider)).unique();
      if (row) await ctx.db.patch(row._id, { pausedUntil: 0, strikes: 0, reason: "resumed by hand", updatedAt: now });
    }
    const page = await ctx.db.system.query("_scheduled_functions").paginate({ cursor: args.cursor, numItems: 1000 });
    let moved = 0;
    for (const fn of page.page) {
      if (fn._creationTime >= args.before || fn.state.kind !== "pending" || fn.scheduledTime <= now || !fn.name.includes("populateActions") || !fn.name.endsWith("runTask")) continue;
      const taskArgs = fn.args[0] as TaskArgs;
      const task = taskArgs.task as PopulateTask;
      if (task?.kind !== "people" || providerOf(task).provider !== args.provider) continue;
      await ctx.scheduler.cancel(fn._id);
      // Same args, same taskId: the task still counts once.
      await ctx.scheduler.runAfter((args.offset + moved) * providerOf(task).staggerMs, internal.populateActions.runTask, taskArgs);
      const c = { ...((await ctx.db.get(taskArgs.jobId))?.counters ?? {}) };
      if (c.waitingUntil) {
        delete c.waitingUntil;
        await ctx.db.patch(taskArgs.jobId, { counters: c, updatedAt: now });
      }
      moved++;
    }
    return { moved, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const markWaiting = internalMutation({
  args: { jobId: v.id("backgroundJobs"), provider: v.string(), until: v.number(), reason: v.string() },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "processing") return null;
    const c = { ...(job.counters ?? {}) };
    const key = `wait_${a.provider.replace(/\W+/g, "_")}`;
    if ((c.waitingUntil ?? 0) >= a.until && (c[key] ?? 0) >= a.until) return null;
    c.waitingUntil = Math.max(c.waitingUntil ?? 0, a.until);
    c[key] = Math.max(c[key] ?? 0, a.until);
    const mins = Math.max(1, Math.round((a.until - Date.now()) / 60_000));
    if (a.reason === OUT_OF_CREDITS) c.waiting_credits = 1;
    await ctx.db.patch(a.jobId, {
      counters: c,
      detail: a.reason === OUT_OF_CREDITS ? `${progressOf(c)} · out of credits: buy more in Settings → Billing & usage and the run continues` : `${progressOf(c)} · waiting about ${mins} min for ${/budget_unavailable/.test(a.reason) ? `treg to confirm ${a.provider}'s budget` : `${a.provider}'s ${/rate|429/.test(a.reason) ? "rate limit" : "free allowance"} to reset`}`,
      phases: phasesOf(c, Date.now()),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Why the job is still open while other tasks finish: shown until the wait ends. */
function waitingNote(until: number, now: number): string {
  return `a search is waiting for its provider and resumes around ${new Date(until).toISOString().slice(11, 16)} UTC (about ${Math.max(1, Math.round((until - now) / 60_000))} min)`;
}

function progressOf(c: Record<string, number>): string {
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  const bySource = ["leadsforge", "quickenrich"].filter((s) => c[`people_${s}`]).map((s) => `${s} ${fmt(c[`people_${s}`])}`);
  return `${fmt(c.people)} people found${bySource.length ? ` (${bySource.join(", ")})` : ""} · ${fmt(c.tasks)} calls${c.names ? ` · ${fmt(c.names)} company names resolved` : ""}${c.pending > 0 ? ` · ${fmt(c.pending)} to go` : ""}`;
}

/** The populateDone key that marks a task's children as already scheduled. */
const spawnKey = (taskId: string) => `${taskId}>`;

/** Schedule a task's children (staggered to the provider's rate limit) and count them as pending. */
async function scheduleChildren(ctx: MutationCtx, c: Record<string, number>, a: { jobId: Id<"backgroundJobs">; sessionId?: Id<"researchSessions"> }, children: PopulateTask[]) {
  const add = (k: string, n: number) => (c[k] = (c[k] ?? 0) + n);
  const perProvider = new Map<string, number>();
  for (const child of children) {
    const { provider, staggerMs } = providerOf(child);
    const i = perProvider.get(provider) ?? 0;
    perProvider.set(provider, i + 1);
    add("pending", 1);
    add(`pending_${provider}`, 1);
    add(`expect_${provider}`, expectedCalls(child));
    const taskId = `t${(c.nextTaskId = (c.nextTaskId ?? 0) + 1)}`;
    await ctx.scheduler.runAfter(i * staggerMs, internal.populateActions.runTask, { sessionId: a.sessionId, jobId: a.jobId, task: child, attempt: 0, taskId });
  }
}

/**
 * Schedule a task's children as soon as its provider call returns, before its
 * writes. Once per task: a retry that fetches the same page again spawns nothing.
 */
export const spawnChildren = internalMutation({
  args: { jobId: v.id("backgroundJobs"), sessionId: v.optional(v.id("researchSessions")), taskId: v.string(), task: v.any(), children: v.array(v.any()) },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "processing" || job.counters?.stopped) return null;
    const key = spawnKey(a.taskId);
    if (await ctx.db.query("populateDone").withIndex("by_jobId_and_taskId", (q) => q.eq("jobId", a.jobId).eq("taskId", key)).first()) return null;
    await ctx.db.insert("populateDone", { jobId: a.jobId, taskId: key });
    const c = { ...(job.counters ?? {}) };
    // This task's page estimate moves to its children now, so the bar never counts it twice.
    const task = a.task as PopulateTask;
    const { provider } = providerOf(task);
    c[`expect_${provider}`] = Math.max(0, (c[`expect_${provider}`] ?? 0) - expectedCalls(task));
    await scheduleChildren(ctx, c, a, a.children as PopulateTask[]);
    await ctx.db.patch(a.jobId, { counters: c, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Add one task's results to the job, schedule its children (staggered to the
 * provider's rate limit), and report whether the job just finished.
 */
export const recordTask = internalMutation({
  args: {
    jobId: v.id("backgroundJobs"),
    sessionId: v.optional(v.id("researchSessions")),
    taskId: v.optional(v.string()),
    task: v.optional(v.any()),
    people: v.number(),
    names: v.optional(v.number()),
    children: v.array(v.any()),
    startNames: v.optional(v.boolean()),
    namesQueued: v.optional(v.number()),
    namesDone: v.optional(v.boolean()),
    namesAbandon: v.optional(v.boolean()),
    error: v.optional(v.string()),
    fatal: v.optional(v.boolean()),
    abandoned: v.optional(v.boolean()),
    skipped: v.optional(v.boolean()),
    capped: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<{ finished: boolean }> => {
    const job = await ctx.db.get(a.jobId);
    // A task still in flight when the job was stopped by hand: the job is already settled.
    if (!job || job.status !== "processing") return { finished: false };
    // A task that ran twice (a retry after a partial failure) counts once.
    if (a.taskId) {
      const seen = await ctx.db.query("populateDone").withIndex("by_jobId_and_taskId", (q) => q.eq("jobId", a.jobId).eq("taskId", a.taskId!)).first();
      // Already counted: report the job's real state, so a retry can still finalize a
      // job whose last record committed but whose final note did not.
      if (seen) return { finished: job.status === "processing" && (job.counters?.pending ?? 1) <= 0 };
      await ctx.db.insert("populateDone", { jobId: a.jobId, taskId: a.taskId });
    }
    const c = { ...(job.counters ?? {}) };
    const newId = (prefix: string) => `${prefix}${(c.nextTaskId = (c.nextTaskId ?? 0) + 1)}`;
    const add = (k: string, n: number) => (c[k] = (c[k] ?? 0) + n);
    const task = a.task as PopulateTask | undefined;
    if (task) {
      const { provider } = providerOf(task);
      add("tasks", 1);
      add("people", a.people);
      add(`done_${provider}`, 1);
      if (a.error) add(`failed_${provider}`, 1);
      if (a.skipped) add(`skipped_${provider}`, 1);
      if (a.capped) c.capped = 1;
      c[`pending_${provider}`] = Math.max(0, (c[`pending_${provider}`] ?? 0) - 1);
      // A task that spawned its children early already handed its estimate on to them.
      const spawned = a.taskId ? await ctx.db.query("populateDone").withIndex("by_jobId_and_taskId", (q) => q.eq("jobId", a.jobId).eq("taskId", spawnKey(a.taskId!))).first() : null;
      if (!spawned) c[`expect_${provider}`] = Math.max(0, (c[`expect_${provider}`] ?? 0) - expectedCalls(task));
      if (task.kind === "people") add(`people_${provider}`, a.people);
      // A paid page that ran means credits were there: any wait for them is over.
      if (task.kind === "people" && task.source === "paid") delete c.waiting_credits;
    }
    if (a.names) add("names", a.names);
    if (a.namesQueued) add("namesQueued", a.namesQueued);
    if (a.error) add("failed", 1);
    if (a.abandoned) add("abandoned", 1);
    if (a.skipped) add("skipped", 1);
    if (a.fatal) c.stopped = 1;
    const children = (c.stopped ? [] : a.children) as PopulateTask[];
    // The name worker counts as one pending task while it runs.
    let worker = 0;
    if (a.namesDone) {
      // Names queued after the worker's last look keep it going rather than strand.
      const more = c.stopped || a.namesAbandon ? null : await ctx.db.query("populateNames").withIndex("by_jobId_and_resolved", (q) => q.eq("jobId", a.jobId).eq("resolved", false)).first();
      if (more) {
        // The same worker carries on: a new lineage id, as its old one just counted as done.
        await ctx.scheduler.runAfter(0, internal.populateActions.runNames, { sessionId: a.sessionId, jobId: a.jobId, workerId: newId("w") });
        worker++;
      } else c.namesWorker = 0;
    }
    if (a.namesAbandon) c.namesAbandoned = 1;
    if (a.startNames && !c.namesWorker && !c.stopped && !c.namesAbandoned) {
      c.namesWorker = 1;
      await ctx.scheduler.runAfter(0, internal.populateActions.runNames, { sessionId: a.sessionId, jobId: a.jobId, workerId: newId("w") });
      worker++;
    }
    add("pending", worker - 1);
    await scheduleChildren(ctx, c, a, children);
    const finished = c.pending <= 0;
    const now = Date.now();
    if ((c.waitingUntil ?? 0) <= now) delete c.waitingUntil;
    for (const k of Object.keys(c)) if (k.startsWith("wait_") && c[k] <= now) delete c[k];
    // The contacts page reloads when the session's count changes: publish progress,
    // throttled so the session row (read by every page view) stays uncontended.
    const publish = !finished && a.people > 0 && now - (c.sessionPublishedAt ?? 0) >= SESSION_PUBLISH_MS;
    if (publish) c.sessionPublishedAt = now;
    await ctx.db.patch(a.jobId, {
      counters: c,
      detail: finished ? "Counting your new records…" : `${progressOf(c)}${c.waitingUntil ? ` · ${waitingNote(c.waitingUntil, now)}` : ""}`,
      phases: phasesOf(c, now),
      updatedAt: now,
      ...(a.fatal && a.error ? { error: a.error } : {}),
    });
    if (publish && a.sessionId) await ctx.db.patch(a.sessionId, { contactsSampled: c.people, contactsNote: `Populating your CRM… ${progressOf(c)}.`, updatedAt: now });
    return { finished };
  },
});

/** The last task read the workspace's real totals: write the final note and finish the job. */
export const finishJob = internalMutation({
  args: { jobId: v.id("backgroundJobs"), sessionId: v.optional(v.id("researchSessions")), accounts: v.optional(v.number()), contacts: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job || job.status !== "processing") return null;
    const c = job.counters ?? {};
    const fmt = (n: number) => n.toLocaleString("en-US");
    const staged = await readyRun(ctx, a.jobId);
    const counted = !staged && a.accounts !== undefined && a.contacts !== undefined;
    const sources = ["leadsforge", "quickenrich", "icypeas", "prospeo", "crustdata"].filter((s) => c[`people_${s}`]).map((s) => `${s} ${fmt(c[`people_${s}`])}`);
    const notes = [
      staged
        ? `Ready for review: ${fmt(staged.accounts)} accounts and ${fmt(staged.contacts)} contacts (${fmt(staged.existingAccounts)} and ${fmt(staged.existingContacts)} already in your CRM). Nothing is added until you approve.`
        : counted
        ? `Your CRM has ${fmt(a.accounts!)} accounts and ${fmt(a.contacts!)} contacts from your market.`
        : `Found ${fmt(c.people ?? 0)} people in your market (some found by more than one source).`,
      sources.length ? `People found by source: ${sources.join(", ")}.` : "",
      c.names ? `${fmt(c.names)} company names resolved.` : "",
      c.abandoned ? `${c.abandoned} searches gave up waiting for a free allowance to reset.` : "",
      ...["leadsforge", "quickenrich"].filter((s) => c[`skipped_${s}`]).map((s) => `${fmt(c[`skipped_${s}`])} ${s} searches skipped: its free allowance is used up.`),
      c.stoppedByUser ? "Stopped by hand before every search ran." : c.stopped ? `Stopped early: ${job.error ?? "the free search is unavailable"}.` : "",
      c.failed && !c.stopped ? `${c.failed} calls failed.` : "",
      c.cap_micro !== undefined ? `Spent ${Math.round((c.spent_micro ?? 0) / MICRO).toLocaleString("en-US")} credits${c.capped ? `, stopping at its ${Math.round(c.cap_micro / MICRO).toLocaleString("en-US")}-credit cap` : ""}.` : "",
    ].filter(Boolean);
    const note = notes.join(" ");
    console.log(`populate finished: ${note}`);
    const found = staged ? staged.accounts + staged.contacts : a.contacts ?? c.people ?? 0;
    const ok = found > 0 || c.stoppedByUser === 1 || !(c.failed || c.stopped);
    const now = Date.now();
    await ctx.db.patch(a.jobId, {
      detail: note,
      phases: phasesOf(c, now, ok ? "completed" : "failed", staged ? staged.contacts : a.contacts ?? c.people ?? 0),
      status: ok ? "completed" : "failed",
      updatedAt: now,
      completedAt: now,
    });
    if (a.sessionId) await ctx.db.patch(a.sessionId, {
      contactsNote: note,
      updatedAt: now,
      ...(counted ? { contactsSampled: a.contacts, importedAccounts: a.accounts } : {}),
    });
    if (c.cap_micro !== undefined) {
      // A paid run: report its last charges to Metronome now, and again once any unsettled hold is stale.
      const provider = ["icypeas", "prospeo", "crustdata"].find((p) => c[`done_${p}`] !== undefined) ?? "paid";
      await ctx.scheduler.runAfter(0, internal.credits.meterRun, { spender: { jobId: a.jobId }, provider });
      await ctx.scheduler.runAfter(16 * 60 * 1000, internal.credits.meterRun, { spender: { jobId: a.jobId }, provider });
    }
    return null;
  },
});

/**
 * A manager stops a running population: no new searches start, its waiting
 * tasks are cancelled, and the job settles with what it found so far.
 */
export const stop = mutation({
  args: { jobId: v.id("backgroundJobs") },
  handler: stopPopulation,
});

/** Cancel a stopped job's scheduled tasks and name worker, then finish it. */
export const settleStopped = internalAction({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, args) => {
    let cursor: string | null = null;
    let sessionId: Id<"researchSessions"> | undefined;
    for (;;) {
      const page: { sessionId?: Id<"researchSessions">; cursor: string; isDone: boolean } = await ctx.runMutation(internal.populateActions.cancelJobPage, { jobId: args.jobId, cursor });
      sessionId ??= page.sessionId;
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const job = await ctx.runQuery(internal.populateActions.getJob, { jobId: args.jobId });
    await finish(ctx, args.jobId, sessionId, job?.orgId);
    return null;
  },
});

export const cancelJobPage = internalMutation({
  args: { jobId: v.id("backgroundJobs"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ sessionId?: Id<"researchSessions">; cursor: string; isDone: boolean }> => {
    const page = await ctx.db.system.query("_scheduled_functions").paginate({ cursor: args.cursor, numItems: 1000 });
    let sessionId: Id<"researchSessions"> | undefined;
    for (const fn of page.page) {
      if (!["pending", "inProgress"].includes(fn.state.kind) || !fn.name.includes("populateActions") || !/(runTask|runNames)$/.test(fn.name)) continue;
      const fnArgs = fn.args[0] as { jobId: Id<"backgroundJobs">; sessionId?: Id<"researchSessions"> };
      if (fnArgs.jobId !== args.jobId) continue;
      // A running task can't be cancelled, but it still names the session to settle.
      sessionId ??= fnArgs.sessionId;
      if (fn.state.kind === "pending") await ctx.scheduler.cancel(fn._id);
    }
    return { sessionId, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Start populating a workspace: create the tray job and schedule each root task.
 * `sessionId` is the claimed research session a signup population reports to;
 * a job started from Add records has none.
 */
export async function startPopulation(
  ctx: Pick<ActionCtx, "runMutation" | "scheduler">,
  sessionId: Id<"researchSessions"> | undefined,
  orgId: Id<"organizations">,
  roots: PopulateTask[],
  label?: { title: string; detail: string },
  /** Hold what the fill finds for review instead of writing it (staging.ts); `capMicro`: a paid run's credit cap. */
  opts?: { stage?: boolean; capMicro?: number },
): Promise<Id<"backgroundJobs">> {
  const jobId = await ctx.runMutation(internal.backgroundJobs.create, {
    orgId,
    kind: "contact_sweep",
    title: label?.title ?? "Populate your CRM",
    detail: label?.detail ?? "Searching your market…",
    href: "/dashboard/contacts",
    phases: [{ key: "find", label: PHASE_LABEL, status: "processing", count: 0 }],
  });
  if (opts?.stage) await ctx.runMutation(internal.staging.create, { jobId, orgId, title: label?.title ?? "Populate your CRM" });
  const byProvider: Record<string, number> = {};
  for (const root of roots) byProvider[providerOf(root).provider] = (byProvider[providerOf(root).provider] ?? 0) + 1;
  await ctx.runMutation(internal.populateActions.initJob, { jobId, pending: roots.length, byProvider, ...(opts?.capMicro !== undefined ? { capMicro: opts.capMicro } : {}) });
  for (let i = 0; i < roots.length; i++) {
    await ctx.scheduler.runAfter(0, internal.populateActions.runTask, { ...(sessionId ? { sessionId } : {}), jobId, task: roots[i], attempt: 0, taskId: `root${i}` });
  }
  return jobId;
}

export const initJob = internalMutation({
  args: { jobId: v.id("backgroundJobs"), pending: v.number(), byProvider: v.optional(v.record(v.string(), v.number())), capMicro: v.optional(v.number()) },
  handler: initPopulationJob,
});

async function initPopulationJob(ctx: MutationCtx, args: { jobId: Id<"backgroundJobs">; pending: number; byProvider?: Record<string, number>; capMicro?: number }) {
  const counters: Record<string, number> = { pending: args.pending, tasks: 0, people: 0, ...(args.capMicro !== undefined ? { cap_micro: args.capMicro, spent_micro: 0 } : {}) };
  for (const [provider, n] of Object.entries(args.byProvider ?? {})) counters[`pending_${provider}`] = counters[`expect_${provider}`] = n;
  await ctx.db.patch(args.jobId, { counters, phases: phasesOf(counters, Date.now()) });
  return null;
}

/** A free staged run and all its initial tasks, created inside the caller's transaction. */
export async function startFreePopulation(ctx: MutationCtx, input: { query: string; title: string; detail?: string }): Promise<{ jobId: Id<"backgroundJobs"> }> {
  const user = await requireUser(ctx);
  if (!can(user, "strategy.edit")) throw new ConvexError(refusal("strategy.edit"));
  if (await agentClientOf(ctx)) throw new ConvexError("Only a person can start this staged population.");
  const query = freePopulationQuery(input.query);
  const fake = fakeModel();
  if (!fake && !process.env.TREG_TOKEN) throw new ConvexError("Data sources are not configured on this deployment (TREG_TOKEN is missing).");
  const jobs = await ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId).gte("startedAt", Date.now() - MAX_JOB_MS)).order("desc").take(51);
  if (jobs.length > 50 || jobs.filter((j) => isFillJob(j) && j.status === "processing").length >= 3) throw new ConvexError("Three fills are already running, or the running-fill census is incomplete. Wait for one to finish.");
  const session = await ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId)).order("desc").first();
  if (!session) throw new ConvexError("This free population needs a claimed signup research session.");
  const now = Date.now(), title = `${input.title}${fake ? " (test transport)" : ""}`;
  const jobId = await ctx.db.insert("backgroundJobs", { orgId: user.orgId, kind: "contact_sweep", title, detail: input.detail ?? "Searching your market…", href: "/dashboard/contacts", phases: [{ key: "find", label: PHASE_LABEL, status: "processing", count: 0 }], status: "processing", startedAt: now, updatedAt: now });
  await createStagedRun(ctx, { jobId, orgId: user.orgId, title });
  await initPopulationJob(ctx, { jobId, pending: 1, byProvider: { quickenrich: 1 } });
  const task: PopulateTask = { kind: "people", source: "quickenrich", query, ...(fake ? { transport: "fake" as const } : {}) };
  await ctx.scheduler.runAfter(0, internal.populateActions.runTask, { sessionId: session._id, jobId, task, attempt: 0, taskId: "root0" });
  return { jobId };
}
