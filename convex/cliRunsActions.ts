"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// "in_progress" = a streaming CLI heartbeat; the terminal report (success/
// partial/error) upserts the same clientRunId row (see cliRuns.insertRun).
const runStatus = v.union(
  v.literal("success"),
  v.literal("partial"),
  v.literal("error"),
  v.literal("in_progress"),
);

/**
 * Record a CLI run via the broker token (the same credential `login --via`
 * mints). The raw token is hashed here and never persisted; orgId/userId are
 * resolved from it, so the CLI sends no identity — it just reports what it did.
 * Mirrors the auth of `cliAuthActions.mintProviderToken`.
 */
export const recordRun = action({
  args: {
    cliToken: v.string(),
    command: v.string(),
    clientRunId: v.optional(v.string()),
    status: runStatus,
    profile: v.optional(v.string()),
    cliVersion: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.number(),
    durationMs: v.number(),
    counts: v.optional(v.any()),
    findings: v.optional(
      v.array(
        v.object({
          objectType: v.string(),
          objectId: v.string(),
          severity: v.string(),
          ruleId: v.string(),
          field: v.optional(v.string()),
          operation: v.optional(v.string()),
        }),
      ),
    ),
    crm: v.optional(v.object({ provider: v.string(), recordUrlBase: v.string() })),
    events: v.optional(
      v.array(v.object({ ts: v.number(), type: v.string(), detail: v.optional(v.string()) })),
    ),
    error: v.optional(v.string()),
    // Live heartbeat payload (shared progress vocabulary — see
    // engine/src/progress.ts). Sanitized at the API route.
    progress: v.optional(
      v.object({
        stage: v.optional(v.string()),
        stageIndex: v.optional(v.number()),
        stageCount: v.optional(v.number()),
        itemsDone: v.optional(v.number()),
        itemsTotal: v.optional(v.number()),
        note: v.optional(v.string()),
        heartbeatAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ runId: string }> => {
    const tokenHash = createHash("sha256").update(args.cliToken).digest("hex");
    const token = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!token) throw new ConvexError("Invalid or revoked CLI token");
    await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: token._id });

    const { cliToken: _omit, ...run } = args;
    const runId = await ctx.runMutation(internal.cliRuns.insertRun, {
      orgId: token.orgId,
      userId: token.userId,
      cliTokenId: token._id,
      ...run,
    });
    return { runId };
  },
});

/**
 * Broker-authed health-history ingest for `backfill runs`: replays the CLI's
 * local health.jsonl timeline into healthSnapshots (deduped on timestamp) so
 * the Home trend covers the engagement's full history, not just post-pairing.
 */
export const recordHealthEntries = action({
  args: {
    cliToken: v.string(),
    entries: v.array(v.any()),
  },
  handler: async (ctx, args): Promise<{ inserted: number; deduped: number }> => {
    const tokenHash = createHash("sha256").update(args.cliToken).digest("hex");
    const token = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!token) throw new ConvexError("Invalid or revoked CLI token");
    await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: token._id });

    // Sanitize before the typed mutation: drop malformed entries rather than
    // failing the whole chunk.
    const num = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const entries = [];
    for (const raw of args.entries.slice(0, 500)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, any>;
      const at = num(entry.at);
      const score = num(entry.score);
      const findings = num(entry.findings);
      const weightedFindings = num(entry.weightedFindings);
      const records = entry.records ?? {};
      const severityCounts = entry.severityCounts ?? {};
      if (at === null || score === null || findings === null || weightedFindings === null) continue;
      entries.push({
        at,
        score,
        findings,
        weightedFindings,
        records: {
          accounts: num(records.accounts) ?? 0,
          contacts: num(records.contacts) ?? 0,
          deals: num(records.deals) ?? 0,
          total: num(records.total) ?? 0,
        },
        severityCounts: {
          info: num(severityCounts.info) ?? 0,
          warning: num(severityCounts.warning) ?? 0,
          critical: num(severityCounts.critical) ?? 0,
        },
        byObjectType:
          entry.byObjectType && typeof entry.byObjectType === "object"
            ? Object.fromEntries(
                Object.entries(entry.byObjectType as Record<string, any>).flatMap(([key, value]) => {
                  if (!value || typeof value !== "object") return [];
                  return [[key, {
                    records: num(value.records) ?? 0,
                    findings: num(value.findings) ?? 0,
                    weightedFindings: num(value.weightedFindings) ?? 0,
                    score: num(value.score) ?? 0,
                  }]];
                }),
              )
            : {},
        byRule:
          entry.byRule && typeof entry.byRule === "object"
            ? Object.fromEntries(
                Object.entries(entry.byRule as Record<string, any>).flatMap(([key, value]) =>
                  num(value) === null ? [] : [[key, num(value)!]],
                ),
              )
            : {},
      });
    }
    if (entries.length === 0) return { inserted: 0, deduped: 0 };

    return ctx.runMutation(internal.healthSnapshots.insertBackfillEntries, {
      orgId: token.orgId,
      entries,
    });
  },
});
