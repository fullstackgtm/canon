import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { unrestrictedUser } from "./permissions";

// "in_progress" = a paired CLI live-streaming heartbeats under a clientRunId;
// the terminal report (success/partial/error) upserts the same row.
const runStatus = v.union(
  v.literal("success"),
  v.literal("partial"),
  v.literal("error"),
  v.literal("in_progress"),
);
// Live heartbeat payload — the shared progress vocabulary
// (engine/src/progress.ts), same shape as
// integrationSyncRuns.progress.
const runProgress = v.object({
  stage: v.optional(v.string()),
  stageIndex: v.optional(v.number()),
  stageCount: v.optional(v.number()),
  itemsDone: v.optional(v.number()),
  itemsTotal: v.optional(v.number()),
  note: v.optional(v.string()),
  heartbeatAt: v.number(),
});
const runEvents = v.array(
  v.object({ ts: v.number(), type: v.string(), detail: v.optional(v.string()) }),
);
// Per-row audit findings: IDs + issue type only (no field values).
const runFindings = v.array(
  v.object({
    objectType: v.string(),
    objectId: v.string(),
    severity: v.string(),
    ruleId: v.string(),
    field: v.optional(v.string()),
    operation: v.optional(v.string()),
  }),
);

// Server-side caps on the embedded detail arrays. A single Convex document is
// limited to 1MiB and an unbounded findings array from a big audit would also
// balloon query responses; runs that exceed the caps are stored truncated with
// findingsTruncated/eventsTruncated flags merged into `counts`.
const MAX_FINDINGS = 2000;
const MAX_EVENTS = 500;

/**
 * Insert-or-update a CLI run record. Internal-only: the broker-authenticated
 * `recordRun` action resolves orgId/userId from the CLI token and calls this.
 * The CLI never asserts its own identity.
 *
 * clientRunId semantics are an UPSERT: a streaming CLI POSTs "in_progress"
 * heartbeats under one clientRunId and each report PATCHES the same row
 * (status/progress/finishedAt/durationMs/counts/findings/events/error);
 * createdAt/startedAt are preserved from the first report. The terminal
 * report (success/partial/error) overwrites "in_progress" and clears the
 * progress payload; a late-arriving heartbeat can never resurrect a finished
 * run (terminal + incoming "in_progress" = no-op). Replays of a terminal
 * report stay idempotent in effect — they just rewrite the same values.
 *
 * Read budget: 1 indexed lookup + 1 write (plus validator-bounded payload).
 */
export const insertRun = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    cliTokenId: v.id("cliTokens"),
    command: v.string(),
    clientRunId: v.optional(v.string()),
    status: runStatus,
    profile: v.optional(v.string()),
    cliVersion: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.number(),
    durationMs: v.number(),
    counts: v.optional(v.any()),
    findings: v.optional(runFindings),
    crm: v.optional(v.object({ provider: v.string(), recordUrlBase: v.string() })),
    events: v.optional(runEvents),
    error: v.optional(v.string()),
    progress: v.optional(runProgress),
  },
  handler: async (ctx, args) => {
    const findingsTruncated = (args.findings?.length ?? 0) > MAX_FINDINGS;
    const eventsTruncated = (args.events?.length ?? 0) > MAX_EVENTS;
    const counts =
      findingsTruncated || eventsTruncated
        ? {
            ...(args.counts && typeof args.counts === "object" ? args.counts : {}),
            ...(findingsTruncated
              ? { findingsTruncated: true, findingsReported: args.findings!.length }
              : {}),
            ...(eventsTruncated
              ? { eventsTruncated: true, eventsReported: args.events!.length }
              : {}),
          }
        : args.counts;
    const findings = findingsTruncated ? args.findings!.slice(0, MAX_FINDINGS) : args.findings;
    const events = eventsTruncated ? args.events!.slice(0, MAX_EVENTS) : args.events;

    if (args.clientRunId) {
      const existing = await ctx.db
        .query("cliRuns")
        .withIndex("by_orgId_clientRunId", (q) =>
          q.eq("orgId", args.orgId).eq("clientRunId", args.clientRunId),
        )
        .first();
      if (existing) {
        // A finished run is final: ignore straggler heartbeats.
        if (existing.status !== "in_progress" && args.status === "in_progress") {
          return existing._id;
        }
        await ctx.db.patch(existing._id, {
          status: args.status,
          profile: args.profile ?? existing.profile,
          cliVersion: args.cliVersion ?? existing.cliVersion,
          finishedAt: args.finishedAt,
          durationMs: args.durationMs,
          counts,
          findings,
          crm: args.crm ?? existing.crm,
          events,
          error: args.error,
          // Terminal reports carry no progress — clearing it here is what
          // flips the UI from live chip to final status.
          progress: args.progress,
          // createdAt/startedAt intentionally NOT patched.
        });
        return existing._id;
      }
    }
    return ctx.db.insert("cliRuns", {
      ...args,
      findings,
      events,
      counts,
      // createdAt = when the run RAN, not when it was reported — keeps the
      // feed honestly ordered for backfilled history and live runs alike.
      createdAt: args.startedAt,
    });
  },
});

/**
 * Dashboard: most-recent CLI runs for the viewer's org (empty when unauthed).
 *
 * Returns run METADATA only — the unbounded `findings`/`events` arrays are
 * projected away (200 runs × up-to-2000 findings each would push the response
 * toward the 16MiB cap) and replaced with `findingsCount`/`eventsCount`.
 * The detail page uses `getRun`, which still returns the full document.
 * Read budget: ≤200 documents.
 */
export const listRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const runs = await ctx.db
      .query("cliRuns")
      .withIndex("by_orgId_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    return runs.map((run) => {
      const { findings, events, ...metadata } = run;
      return {
        ...metadata,
        findingsCount: findings?.length ?? 0,
        eventsCount: events?.length ?? 0,
      };
    });
  },
});

/** Dashboard: one run's detail (events + counts), scoped to the viewer's org. */
/** One CLI run with its findings. A finding names a CRM record, so a role that sees only some records gets none (CP14). */
export const getRun = query({
  args: { runId: v.id("cliRuns") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId) return null;
    return run;
  },
});
