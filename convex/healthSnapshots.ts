import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, activeClerkOrgIdFromIdentity } from "./lib";
import { snapshotFromPages } from "./hygiene";
import type { CanonicalGtmSnapshot, PatchPlan } from "../engine/src/types.ts";
// Node-free imports only (see the note in hygiene.ts): audit engine + pure
// health scoring, never the package barrel.
import { auditSnapshot } from "../engine/src/audit.ts";
import { hygienePolicy, hygieneRules } from "./lib/hygienePolicy";
import { computeHealth } from "../engine/src/healthScore.ts";

const HISTORY_LIMIT = 30;
const OPPORTUNITY_RULE_CAP = 500;

function objectLabel(snapshot: CanonicalGtmSnapshot, objectType: string, objectId: string): string {
  if (objectType === "contact") {
    const contact = snapshot.contacts.find((row) => row.id === objectId || row.crmId === objectId);
    const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim();
    return name || contact?.email || objectId;
  }
  if (objectType === "account") {
    const account = snapshot.accounts.find((row) => row.id === objectId || row.crmId === objectId);
    return account?.name || account?.domain || objectId;
  }
  if (objectType === "deal") {
    const deal = snapshot.deals.find((row) => row.id === objectId || row.crmId === objectId);
    return deal?.name || objectId;
  }
  return objectId;
}

async function activeCrmIntegration(ctx: { runQuery: any }, orgId: Id<"organizations">) {
  const rows = await ctx.runQuery(internal.healthSnapshots.activeCrmIntegrations, { orgId });
  return rows[0] ?? null;
}

function opportunitiesFromPlan(plan: PatchPlan, snapshot: CanonicalGtmSnapshot) {
  const totals = new Map<string, number>();
  for (const finding of plan.findings) totals.set(finding.ruleId, (totals.get(finding.ruleId) ?? 0) + 1);

  const counts = new Map<string, number>();
  return plan.findings.flatMap((finding) => {
    const count = counts.get(finding.ruleId) ?? 0;
    counts.set(finding.ruleId, count + 1);
    if (count >= OPPORTUNITY_RULE_CAP) return [];
    return [{
      rule: finding.ruleId,
      severity: finding.severity,
      objectType: finding.objectType,
      objectId: finding.objectId,
      objectLabel: objectLabel(snapshot, finding.objectType, finding.objectId),
      summary: finding.summary || finding.title,
      truncated: (totals.get(finding.ruleId) ?? 0) > OPPORTUNITY_RULE_CAP,
    }];
  });
}

async function existingNonTerminalRules(ctx: { runQuery: any }, orgId: Id<"organizations">) {
  const rules = new Set<string>();
  for (const status of ["open", "planned"] as const) {
    let cursor: string | null = null;
    while (true) {
      const page: { rules: string[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
        internal.opportunities.nonTerminalRulesPage,
        { orgId, status, cursor },
      );
      for (const rule of page.rules) rules.add(rule);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  return rules;
}

async function replaceOpportunitiesForSnapshot(
  ctx: { runQuery: any; runMutation: any },
  args: {
    orgId: Id<"organizations">;
    integrationId?: Id<"integrations">;
    provider: string;
    snapshotAt: number;
    opportunities: ReturnType<typeof opportunitiesFromPlan>;
  },
) {
  const byRule = new Map<string, ReturnType<typeof opportunitiesFromPlan>>();
  for (const op of args.opportunities) {
    const rows = byRule.get(op.rule) ?? [];
    rows.push(op);
    byRule.set(op.rule, rows);
  }

  const rules = await existingNonTerminalRules(ctx, args.orgId);
  for (const rule of byRule.keys()) rules.add(rule);

  for (const rule of rules) {
    const incoming = byRule.get(rule) ?? [];
    const incomingObjectIds = incoming.map((op) => op.objectId);

    let cleanupCursor: string | null = null;
    while (true) {
      const page: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
        internal.opportunities.cleanupResolvedRulePage,
        { orgId: args.orgId, rule, snapshotAt: args.snapshotAt, cursor: cleanupCursor },
      );
      if (page.isDone) break;
      cleanupCursor = page.continueCursor;
    }

    for (const status of ["open", "planned"] as const) {
      let cursor: string | null = null;
      while (true) {
        const page: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
          internal.opportunities.resolveVanishedRulePage,
          { orgId: args.orgId, rule, snapshotAt: args.snapshotAt, status, incomingObjectIds, cursor },
        );
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }

    await ctx.runMutation(internal.opportunities.upsertIncomingRule, {
      orgId: args.orgId,
      integrationId: args.integrationId,
      provider: args.provider,
      snapshotAt: args.snapshotAt,
      rule,
      opportunities: incoming,
    });
  }
}

export const activeCrmIntegrations = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("integrations")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .take(20)
      .then((rows) => rows.filter((row) => row.isActive && (row.provider === "hubspot" || row.provider === "salesforce")));
  },
});

/**
 * Capture runs as an ACTION assembling the snapshot from per-table queries —
 * each table gets its own 4096-read budget, so a real CRM (thousands of
 * contacts) scores fine where a single-mutation read would blow the limit.
 */
async function captureReading(
  ctx: { runQuery: any; runMutation: any },
  orgId: Id<"organizations">,
  source: "sync" | "manual",
): Promise<{ score: number; findings: number }> {
  const snapshot = await snapshotFromPages(ctx, orgId);
  const model = await ctx.runQuery(internal.hygiene.modelFor, { orgId });
  const plan = auditSnapshot(snapshot, hygienePolicy(model), hygieneRules(model));
  const entry = computeHealth(plan, snapshot, snapshot.generatedAt);

  const snapshotAt = await ctx.runMutation(internal.healthSnapshots.insertReading, {
    orgId,
    source,
    score: entry.score,
    findings: entry.findings,
    weightedFindings: entry.weightedFindings,
    records: entry.records,
    severityCounts: entry.severityCounts,
    byObjectType: entry.byObjectType,
    byRule: entry.byRule,
  });
  const integration = await activeCrmIntegration(ctx, orgId);
  await replaceOpportunitiesForSnapshot(ctx, {
    orgId,
    integrationId: integration?._id,
    provider: integration?.provider ?? snapshot.provider ?? "convex",
    snapshotAt,
    opportunities: opportunitiesFromPlan(plan, snapshot),
  });
  return { score: entry.score, findings: entry.findings };
}

export const insertReading = internalMutation({
  args: {
    orgId: v.id("organizations"),
    source: v.string(),
    score: v.number(),
    findings: v.number(),
    weightedFindings: v.number(),
    records: v.object({
      accounts: v.number(),
      contacts: v.number(),
      deals: v.number(),
      total: v.number(),
    }),
    severityCounts: v.object({
      info: v.number(),
      warning: v.number(),
      critical: v.number(),
    }),
    byObjectType: v.record(
      v.string(),
      v.object({
        records: v.number(),
        findings: v.number(),
        weightedFindings: v.number(),
        score: v.number(),
      }),
    ),
    byRule: v.record(v.string(), v.number()),
  },
  handler: async (ctx, args) => {
    const at = Date.now();
    await ctx.db.insert("healthSnapshots", { ...args, at });
    return at;
  },
});

/**
 * Backfill ingest for CLI health history (`backfill runs` replays the local
 * health.jsonl timeline). Deduped on (orgId, at) — replays are idempotent.
 * Chunked by the caller; each call is a single bounded mutation.
 */
export const insertBackfillEntries = internalMutation({
  args: {
    orgId: v.id("organizations"),
    entries: v.array(
      v.object({
        at: v.number(),
        score: v.number(),
        findings: v.number(),
        weightedFindings: v.number(),
        records: v.object({
          accounts: v.number(),
          contacts: v.number(),
          deals: v.number(),
          total: v.number(),
        }),
        severityCounts: v.object({
          info: v.number(),
          warning: v.number(),
          critical: v.number(),
        }),
        byObjectType: v.record(
          v.string(),
          v.object({
            records: v.number(),
            findings: v.number(),
            weightedFindings: v.number(),
            score: v.number(),
          }),
        ),
        byRule: v.record(v.string(), v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let deduped = 0;
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("healthSnapshots")
        .withIndex("by_orgId_at", (q) => q.eq("orgId", args.orgId).eq("at", entry.at))
        .first();
      if (existing) {
        deduped += 1;
        continue;
      }
      await ctx.db.insert("healthSnapshots", {
        orgId: args.orgId,
        ...entry,
        source: "cli",
      });
      inserted += 1;
    }
    return { inserted, deduped };
  },
});

/**
 * Capture a hygiene reading for the signed-in user's org (the Home page's
 * "Run health check" action).
 */
export const capture = action({
  args: {},
  handler: async (ctx): Promise<{ score: number; findings: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "a CRM health reading" });
    return captureReading(ctx, user.orgId, "manual");
  },
});

/** Capture a reading after a CRM sync; scheduled from the sync pipeline. */
export const captureForOrg = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ score: number; findings: number }> => {
    return captureReading(ctx, args.orgId, "sync");
  },
});

/**
 * The Home health panel: latest reading, delta vs the previous one, and a
 * bounded history for the trend line. Null when no reading exists yet.
 */
export const timeline = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    const rows = await ctx.db
      .query("healthSnapshots")
      .withIndex("by_orgId_at", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(HISTORY_LIMIT);
    if (rows.length === 0) return { current: null, previous: null, scoreDelta: null, history: [] };

    const [current, previous] = rows;
    return {
      current,
      previous: previous ?? null,
      scoreDelta: previous ? current.score - previous.score : null,
      history: [...rows]
        .reverse()
        .map((row) => ({ at: row.at, score: row.score, findings: row.findings })),
    };
  },
});
