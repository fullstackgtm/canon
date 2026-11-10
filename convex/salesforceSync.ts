// Salesforce shadow sync (Phase 1b, workstream C): read-only. Salesforce
// changes flow into the record service; nothing is written to Salesforce.
// Salesforce writes go through Canon fields, never through this sync.
//
// Public:   getState, setMode
// Internal: tick (15 s cron) -> tickOrg per org; the state and cursor
//           mutations used by the engine's ports.
//
// The engine itself is engine/src/sync/salesforceSync (pure,
// tested in tests/salesforceSync*.test.ts). This file wires its ports:
//   RecordPort -> record service over HTTP (RECORD_SERVICE_URL/TOKEN)
//   SfPort     -> Salesforce REST, token from internal.salesforceActions.getOrgAccessToken
//   PlanSink   -> a patchPlans row (operation "salesforce.sync_patch", keyed by
//                 externalPlanId) + patchOperations rows + operationAuditLog
//                 entries carrying the patchPlanId
//   parents    -> internal.salesforceImportCanon.setAccountParents (Account
//                 ParentId as Canon's account_parent edge)
//   CdcSource  -> SystemModstamp polling ("poll"), or sf-sim CDC when
//                 SF_SYNC_SIM_CDC=1 ("cdc"). Real Pub/Sub cannot run in a
//                 Convex action and reports an error instead.
//
// Every field is Salesforce's (readOnlyPolicy) and the Salesforce port refuses
// writes (guardSfPort with read-only always on), so the engine's outbound path
// never runs.

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";
import { splitRecordPatch } from "./lib/canon/partyLedger";
import { clientFor } from "./records";
import { salesforceCanRefresh } from "./lib/salesforceClientCredentials";
import type { ActionCtx } from "./_generated/server";
import {
  DEFAULT_POLICY,
  guardSfPort,
  policyFromDefinitions,
  pollingSource,
  pubSubCdcSource,
  recordServicePort,
  runTick,
  salesforceRest,
  simCdcSource,
  type CdcSource,
  type EnginePorts,
  type RecordPort,
  type SyncPolicy,
  type SyncState,
} from "../engine/src/sync/salesforceSync/index.ts";

export const SYNC_SOURCE = "salesforce-sync";
const DEFAULT_POLL_MS = 60_000;
const LEASE_MS = 120_000;

function publicState(row: Doc<"sfSyncState"> | null) {
  if (!row) {
    return { configured: false, readOnly: true, mode: "poll" as const, outboxCursor: 0, pollIntervalMs: DEFAULT_POLL_MS };
  }
  const { tickLeaseUntil: _lease, ...rest } = row;
  return { configured: true, ...rest };
}

async function stateRow(ctx: { db: any }, orgId: Id<"organizations">): Promise<Doc<"sfSyncState"> | null> {
  return ctx.db.query("sfSyncState").withIndex("by_orgId", (q: any) => q.eq("orgId", orgId)).first();
}

async function ensureState(ctx: { db: any }, orgId: Id<"organizations">): Promise<Doc<"sfSyncState">> {
  const existing = await stateRow(ctx, orgId);
  if (existing) return existing;
  const id = await ctx.db.insert("sfSyncState", {
    orgId,
    readOnly: true,
    mode: "poll",
    inboundCursor: { modstampByObject: {} },
    outboxCursor: 0,
    pollIntervalMs: DEFAULT_POLL_MS,
  });
  return (await ctx.db.get(id))!;
}

// ───────────────────────────── public API ─────────────────────────────

export const getState = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const row = await stateRow(ctx, user.orgId);
    const openConflicts = await ctx.db
      .query("sfConflicts")
      .withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId).eq("status", "open"))
      .take(1001);
    return { ...publicState(row), openConflicts: Math.min(openConflicts.length, 1000), openConflictsCapped: openConflicts.length > 1000 };
  },
});

export const setMode = mutation({
  args: { mode: v.union(v.literal("cdc"), v.literal("poll")), pollIntervalMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "integrations.manage");
    const row = await ensureState(ctx, user.orgId);
    const pollIntervalMs = args.pollIntervalMs === undefined ? row.pollIntervalMs : Math.max(15_000, Math.min(3_600_000, args.pollIntervalMs));
    await ctx.db.patch(row._id, { mode: args.mode, pollIntervalMs });
    return { mode: args.mode, pollIntervalMs };
  },
});

// ───────────────────────────── internal: state ─────────────────────────────

export const activeOrgs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: Id<"organizations">[] = [];
    for await (const row of ctx.db.query("integrations")) {
      if (row.provider === "salesforce" && row.isActive !== false && row.instanceUrl && salesforceCanRefresh(row)) out.push(row.orgId);
      if (out.length >= 500) break;
    }
    return out;
  },
});

/** Takes the per-org tick lease; returns the state, or null when another tick holds it. */
export const claimTick = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const row = await ensureState(ctx, args.orgId);
    const now = Date.now();
    if (row.tickLeaseUntil && row.tickLeaseUntil > now) return null;
    await ctx.db.patch(row._id, { tickLeaseUntil: now + LEASE_MS, lastTickAt: now });
    return { ...row, tickLeaseUntil: now + LEASE_MS };
  },
});

/** Saves cursors only; readOnly and mode are owned by the public mutations. */
export const saveCursors = internalMutation({
  args: {
    orgId: v.id("organizations"),
    inboundCursor: v.object({
      replayId: v.optional(v.string()),
      modstampByObject: v.record(v.string(), v.number()),
      lastIdByObject: v.optional(v.record(v.string(), v.string())),
    }),
    outboxCursor: v.number(),
    lastInboundAt: v.optional(v.number()),
    lastOutboundAt: v.optional(v.number()),
    lastPollAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ensureState(ctx, args.orgId);
    const { orgId: _o, ...patch } = args;
    // The outbox cursor never moves backwards.
    await ctx.db.patch(row._id, { ...patch, outboxCursor: Math.max(row.outboxCursor, args.outboxCursor) });
  },
});

export const releaseTick = internalMutation({
  args: { orgId: v.id("organizations"), stats: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await stateRow(ctx, args.orgId);
    if (!row) return;
    await ctx.db.patch(row._id, { tickLeaseUntil: undefined, lastStats: args.stats, lastError: args.error });
  },
});

export const loadPolicyRows = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const objects = await ctx.db.query("objectDefinitions").withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", args.orgId)).take(2000);
    const enabled = objects.filter((o) => o.syncEnabled && o.provider === "salesforce");
    const fields: Doc<"fieldDefinitions">[] = [];
    for (const o of enabled) {
      fields.push(...(await ctx.db.query("fieldDefinitions").withIndex("by_orgId_and_object_and_apiName", (q) => q.eq("orgId", args.orgId).eq("object", o.apiName)).take(1000)));
    }
    return {
      objects: enabled.map((o) => ({ apiName: o.apiName, isCustom: o.isCustom, syncEnabled: o.syncEnabled })),
      fields: fields.map((f) => ({ object: f.object, apiName: f.apiName, updateable: f.updateable, syncAuthority: f.syncAuthority, mappedTo: f.mappedTo })),
    };
  },
});

// ───────────────────────────── internal: plan path ─────────────────────────────

async function systemActor(ctx: { db: any }, orgId: Id<"organizations">): Promise<Id<"users">> {
  const users = await ctx.db.query("users").withIndex("by_orgId", (q: any) => q.eq("orgId", orgId)).take(200);
  const admin = users.find((u: Doc<"users">) => u.role === "admin") ?? users.find((u: Doc<"users">) => u.role === "manager");
  if (!admin) throw new ConvexError("Organization has no admin to own sync patch plans");
  return admin._id;
}

/**
 * Creates (or finds, by externalPlanId = key) the patch plan for one outbound
 * record patch. Sync plans are pre-approved by policy (field syncAuthority),
 * so they are created approved with approvalRequirement "not_required".
 */
export const beginPlan = internalMutation({
  args: {
    orgId: v.id("organizations"),
    key: v.string(),
    object: v.string(),
    recordId: v.string(),
    sfObject: v.string(),
    sfId: v.string(),
    fields: v.any(),
    before: v.any(),
    seq: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.key))
      .first();
    if (existing) return { patchPlanId: existing._id as string, alreadyApplied: existing.status === "applied" };
    const now = Date.now();
    const createdBy = await systemActor(ctx, args.orgId);
    const patchPlanId = await ctx.db.insert("patchPlans", {
      orgId: args.orgId,
      createdBy,
      verb: "set",
      operation: "salesforce.sync_patch",
      args: { object: args.object, recordId: args.recordId, sfObject: args.sfObject, sfId: args.sfId, fields: args.fields, seq: args.seq, source: SYNC_SOURCE },
      reason: `Salesforce shadow sync of outbox seq ${args.seq}`,
      status: "approved",
      riskLevel: "low",
      approvalRequirement: "not_required",
      approvedBy: createdBy,
      approvedAt: now,
      externalPlanId: args.key,
      createdAt: now,
      updatedAt: now,
    });
    for (const [field, after] of Object.entries(args.fields as Record<string, unknown>)) {
      await ctx.db.insert("patchOperations", {
        orgId: args.orgId,
        patchPlanId,
        objectType: args.sfObject,
        objectId: args.sfId,
        fieldOrAction: field,
        beforeValue: (args.before as Record<string, unknown>)[field] ?? null,
        afterValue: after,
        reason: "syncAuthority allows FSGTM -> Salesforce",
        sourceRuleOrPolicy: SYNC_SOURCE,
        riskLevel: "low",
        approvalRequirement: "not_required",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    return { patchPlanId: patchPlanId as string, alreadyApplied: false };
  },
});

export const completePlan = internalMutation({
  args: { orgId: v.id("organizations"), patchPlanId: v.id("patchPlans"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== args.orgId) throw new ConvexError("Patch plan not found");
    if (plan.status === "applied") return;
    const now = Date.now();
    const status = args.ok ? "applied" : "failed";
    await ctx.db.patch(plan._id, { status, appliedAt: args.ok ? now : undefined, appliedBy: args.ok ? plan.createdBy : undefined, error: args.error, updatedAt: now, lastExecutionReplica: "hosted" });
    for await (const op of ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id))) {
      if (op.status === "pending") await ctx.db.patch(op._id, { status, error: args.error, updatedAt: now });
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: args.orgId,
      patchPlanId: plan._id,
      verb: "set",
      operation: "salesforce.sync_patch",
      status,
      details: { source: SYNC_SOURCE, ...(plan.args as object), error: args.error },
      createdAt: now,
    });
  },
});

export const openConflict = internalMutation({
  args: {
    orgId: v.id("organizations"),
    object: v.string(),
    recordId: v.string(),
    sfId: v.string(),
    field: v.string(),
    fsgtmValue: v.any(),
    sfValue: v.any(),
    fsgtmAt: v.number(),
    sfAt: v.number(),
  },
  handler: async (ctx, args) => {
    const open = await ctx.db
      .query("sfConflicts")
      .withIndex("by_orgId_and_recordId_and_field_and_status", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId).eq("field", args.field).eq("status", "open"))
      .first();
    if (open) {
      await ctx.db.patch(open._id, { fsgtmValue: args.fsgtmValue, sfValue: args.sfValue, fsgtmAt: args.fsgtmAt, sfAt: args.sfAt });
      return open._id;
    }
    return ctx.db.insert("sfConflicts", { ...args, status: "open" });
  },
});

// ───────────────────────────── internal: actions ─────────────────────────────

function recordEnv() {
  const baseUrl = process.env.RECORD_SERVICE_URL;
  const token = process.env.RECORD_SERVICE_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function sfConnection(ctx: any, orgId: Id<"organizations">) {
  let creds: { accessToken: string; instanceUrl: string } = await ctx.runAction(internal.salesforceActions.getOrgAccessToken, { orgId });
  let calls = 0;
  const rest = salesforceRest({
    instanceUrl: creds.instanceUrl,
    apiVersion: process.env.SF_SYNC_API_VERSION ?? "v62.0",
    onCall: () => { calls++; },
    getToken: async (force) => {
      if (force) creds = await ctx.runAction(internal.salesforceActions.refreshAccessToken, { orgId });
      return creds.accessToken;
    },
  });
  return { rest, instanceUrl: creds.instanceUrl, calls: () => calls, token: () => creds.accessToken };
}

/** The sync's policy with every field Salesforce's: changes come in from Salesforce and none go out. */
function readOnlyPolicy(policy: SyncPolicy): SyncPolicy {
  return { objects: policy.objects.map((o) => ({ ...o, fields: o.fields.map((f) => ({ ...f, authority: "salesforce" as const })) })) };
}

async function loadPolicy(ctx: any, orgId: Id<"organizations">): Promise<SyncPolicy> {
  const rows = await ctx.runQuery(internal.salesforceSync.loadPolicyRows, { orgId });
  const policy = policyFromDefinitions(rows.objects, rows.fields);
  return readOnlyPolicy(policy.objects.length ? policy : DEFAULT_POLICY);
}

export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    if (!recordEnv()) return { orgs: 0, skipped: "RECORD_SERVICE_URL/TOKEN not set" };
    const orgs: Id<"organizations">[] = await ctx.runQuery(internal.salesforceSync.activeOrgs, {});
    for (const orgId of orgs) await ctx.scheduler.runAfter(0, internal.salesforceSync.tickOrg, { orgId });
    return { orgs: orgs.length };
  },
});

export const tickOrg = internalAction({
  args: { orgId: v.id("organizations"), force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<unknown> => {
    const env = recordEnv();
    if (!env) throw new ConvexError("RECORD_SERVICE_URL/TOKEN not set");
    const claimed: Doc<"sfSyncState"> | null = await ctx.runMutation(internal.salesforceSync.claimTick, { orgId: args.orgId });
    if (!claimed) return { skipped: "tick already running" };
    try {
      const conn = await sfConnection(ctx, args.orgId);
      const policy = await loadPolicy(ctx, args.orgId);
      const now = Date.now();
      const pollDue = args.force || !claimed.lastPollAt || now - claimed.lastPollAt >= claimed.pollIntervalMs;
      let cdc: CdcSource;
      if (claimed.mode === "cdc") {
        cdc = process.env.SF_SYNC_SIM_CDC === "1"
          ? simCdcSource({ baseUrl: conn.instanceUrl, getToken: async () => conn.token() })
          : pubSubCdcSource();
      } else if (pollDue) {
        cdc = pollingSource({ soql: conn.rest.soql, policy });
      } else {
        cdc = { kind: "poll", next: async (c) => ({ events: [], cursor: c }) };
      }
      const orgId = args.orgId;
      const state: SyncState = {
        readOnly: true,
        mode: claimed.mode,
        inboundCursor: claimed.inboundCursor,
        outboxCursor: claimed.outboxCursor,
        lastInboundAt: claimed.lastInboundAt,
        lastOutboundAt: claimed.lastOutboundAt,
      };
      const sf = guardSfPort(conn.rest.port, () => true);
      const ports: EnginePorts = {
        records: registerRecordPort(ctx, orgId, recordServicePort({ ...env, workspaceId: orgId, actorId: SYNC_SOURCE }), salesforceAuthority(policy)),
        sf,
        cdc,
        plans: {
          begin: (p) => ctx.runMutation(internal.salesforceSync.beginPlan, { orgId, key: p.key, object: p.object, recordId: p.recordId, sfObject: p.sfObject, sfId: p.sfId, fields: p.fields, before: p.before, seq: p.seq }),
          complete: async (patchPlanId, r) => {
            await ctx.runMutation(internal.salesforceSync.completePlan, { orgId, patchPlanId: patchPlanId as Id<"patchPlans">, ok: r.ok, error: r.ok ? undefined : r.error });
          },
        },
        conflicts: { open: async (c) => { await ctx.runMutation(internal.salesforceSync.openConflict, { orgId, ...c }); } },
        parents: (links) => ctx.runMutation(internal.salesforceImportCanon.setAccountParents, { orgId, links }),
        saveState: async (s) => {
          await ctx.runMutation(internal.salesforceSync.saveCursors, {
            orgId,
            inboundCursor: s.inboundCursor,
            outboxCursor: s.outboxCursor,
            lastInboundAt: s.lastInboundAt,
            lastOutboundAt: s.lastOutboundAt,
            lastPollAt: claimed.mode === "poll" && pollDue ? now : claimed.lastPollAt,
          });
        },
      };
      const stats = await runTick(ports, policy, state, { maxBatches: 10 });
      if (claimed.mode === "poll" && pollDue) await ports.saveState(state);
      const result = { ...stats, sfApiCalls: conn.calls(), sfWrites: sf.writes() };
      await ctx.runMutation(internal.salesforceSync.releaseTick, { orgId, stats: result, error: stats.errors[0] });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.salesforceSync.releaseTick, { orgId: args.orgId, error: message.slice(0, 500) });
      throw e;
    }
  },
});

/**
 * The record port the sync uses, over the one register (docs/cp0-object-layer.md,
 * "One register"): a change to an account or contact that is on the ledger goes
 * to its stream as a partial Salesforce snapshot (canon.saveSyncedRecordPatch)
 * and reaches the row through the projector's write-back; only the fields the
 * ledger does not track go to the row directly.
 */
function registerRecordPort(
  ctx: ActionCtx, orgId: Id<"organizations">, port: RecordPort,
  /**
   * Fields whose Salesforce value the sync applies because Salesforce is their authority (or because a person
   * resolved a conflict for it), not because it is newer: dated when applied, so the ledger resolves to it too.
   */
  authoritative: (object: string, field: string, sfId: string) => boolean,
): RecordPort {
  const client = clientFor(ctx);
  return {
    ...port,
    async edit(object, id, fields, opts) {
      if (object !== "account" && object !== "contact") return port.edit(object, id, fields, opts);
      const local = await port.get(object, id);
      if (!local?.fields.stream || !local.sfId) return port.edit(object, id, fields, opts);
      const split = splitRecordPatch(object, fields as Record<string, string | number | null>);
      if (Object.keys(split.ledger).length) {
        // A newer Salesforce value is dated by its commit; one Salesforce is the authority for is dated now, so it wins whatever is newer.
        const now = Date.now();
        const sfId = local.sfId;
        const won: Record<string, string | number | null> = {};
        const newer: Record<string, string | number | null> = {};
        for (const [field, value] of Object.entries(split.ledger)) (authoritative(object, field, sfId) ? won : newer)[field] = value as string | number | null;
        // The sync only applies a value it decided wins, so it is re-asserted even when Salesforce said it before
        // (Salesforce changing back after a Canon edit): a newer change dated by its commit, an authority value now.
        const writes = [
          ...(Object.keys(newer).length ? [{ patch: newer, at: opts.sourceTimestamp, reassert: true, idempotencyKey: `${opts.idempotencyKey}:newer` }] : []),
          ...(Object.keys(won).length ? [{ patch: won, at: Math.max(now, opts.sourceTimestamp), reassert: true, idempotencyKey: `${opts.idempotencyKey}:won` }] : []),
        ];
        for (const write of writes) {
          const out = await ctx.runMutation(internal.canon.saveSyncedRecordPatch, {
            orgId, object, recordId: id, sfId, streamId: String(local.fields.stream), ...write,
          });
          if (out.rejected.length) throw new Error(`ledger refused ${object} ${id}: ${out.rejected.map((e) => e.message).join("; ")}`);
        }
        if (client.mode === "http") await client.nudgeProjector(orgId, await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId }), process.env.CONVEX_SITE_URL, { wait: true });
      }
      // The row's version moved with the write-back; the rest goes to the row against that version.
      const rest = Object.keys(split.service).length ? await port.edit(object, id, split.service, { ...opts, expectedVersion: undefined }) : null;
      return rest ?? { version: (await port.get(object, id))?.version ?? local.version };
    },
  };
}

/**
 * Whether Salesforce is a mapped field's authority under the org's sync policy, for the Salesforce object the
 * record is (its id's key prefix): a Lead and a Contact can both live in `contact` with different authorities.
 */
function salesforceAuthority(policy: SyncPolicy) {
  return (object: string, field: string, sfId: string) => {
    const rule = policy.objects.find((o) => o.local === object && (!o.keyPrefix || sfId.startsWith(o.keyPrefix)));
    return Boolean(rule?.fields.some((f) => f.local === field && f.authority === "salesforce"));
  };
}

// ───────────────────────────── internal: revert ─────────────────────────────

const REVERT_PAGE = 100;
// Salesforce's country and state picklists store a written value under their own label ("united states" reads back as
// "United States"), so those fields compare without case; every other field compares exactly.
const PICKLIST_LABELLED = /(Country|State)$/;
const SAME = (field: string, a: unknown, b: unknown) =>
  PICKLIST_LABELLED.test(field) && typeof a === "string" && typeof b === "string"
    ? a.toLowerCase() === b.toLowerCase()
    : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
type SyncWrite = { patchPlanId: string; sfObject: string; sfId: string; field: string; before: unknown; after: unknown; seq: number; at: number };
type RevertField = { sfObject: string; sfId: string; field: string; before: unknown; wrote: unknown[]; plans: Set<string> };

/** One page of the org's applied plans: the outbound sync writes among them between `since` and `until`, field by field. */
export const appliedSyncWritesPage = internalQuery({
  args: { orgId: v.id("organizations"), since: v.number(), until: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    const page = await ctx.db.query("patchPlans").withIndex("by_orgId_status", (q) => q.eq("orgId", a.orgId).eq("status", "applied")).paginate({ cursor: a.cursor, numItems: REVERT_PAGE });
    const writes: SyncWrite[] = [];
    for (const plan of page.page) {
      const at = plan.appliedAt ?? 0;
      if (plan.operation !== "salesforce.sync_patch" || at < a.since || at > a.until) continue;
      const seq = Number((plan.args as { seq?: unknown } | undefined)?.seq ?? 0);
      for (const op of await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(50)) {
        if (op.status === "applied" && op.objectType && op.objectId) {
          writes.push({ patchPlanId: plan._id, sfObject: op.objectType, sfId: op.objectId, field: op.fieldOrAction, before: op.beforeValue, after: op.afterValue, seq, at });
        }
      }
    }
    return { writes, cursor: page.isDone ? null : page.continueCursor };
  },
});

export const logRevert = internalMutation({
  args: { orgId: v.id("organizations"), ok: v.boolean(), details: v.any() },
  handler: async (ctx, a) => {
    await ctx.db.insert("operationAuditLog", {
      orgId: a.orgId, verb: "set", operation: "salesforce.sync_revert", status: a.ok ? "applied" : "failed", details: { source: SYNC_SOURCE, ...a.details }, createdAt: Date.now(),
    });
  },
});

/**
 * Put back what the two-way sync wrote to Salesforce between `since` and `until`: each field it changed returns to its
 * value before the sync's first write (by outbox seq, the order CanonCRM made the changes), and only while Salesforce
 * still holds a value the sync wrote. Each record is read just before its write, and the write is conditional on the
 * record not having changed since (If-Unmodified-Since on LastModifiedDate), so an edit made in Salesforce is kept,
 * even one made while this runs. Run by an operator (never from a client); every record is audited
 * (salesforce.sync_revert). `dryRun` reads Salesforce and reports what it would restore, writing nothing.
 */
export const revertSyncWrites = internalAction({
  args: { orgId: v.id("organizations"), since: v.number(), until: v.number(), dryRun: v.boolean() },
  handler: async (ctx, a) => {
    const writes: SyncWrite[] = [];
    let cursor: string | null = null;
    do {
      const page: { writes: SyncWrite[]; cursor: string | null } = await ctx.runQuery(internal.salesforceSync.appliedSyncWritesPage, { orgId: a.orgId, since: a.since, until: a.until, cursor });
      writes.push(...page.writes);
      cursor = page.cursor;
    } while (cursor);
    writes.sort((x, y) => x.seq - y.seq || x.at - y.at);
    // Per record and field: the value before the sync's first write, and every value it wrote.
    const fields = new Map<string, RevertField>();
    for (const w of writes) {
      const key = `${w.sfObject}:${w.sfId}:${w.field}`;
      const f = fields.get(key) ?? { sfObject: w.sfObject, sfId: w.sfId, field: w.field, before: w.before, wrote: [], plans: new Set<string>() };
      f.wrote.push(w.after);
      f.plans.add(w.patchPlanId);
      fields.set(key, f);
    }
    const records = new Map<string, RevertField[]>();
    for (const f of fields.values()) records.set(`${f.sfObject}:${f.sfId}`, [...(records.get(`${f.sfObject}:${f.sfId}`) ?? []), f]);

    const conn = await sfConnection(ctx, a.orgId);
    let token = conn.token();
    const apiVersion = process.env.SF_SYNC_API_VERSION ?? "v62.0";
    const request = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${conn.instanceUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status !== 401 || attempt > 0) return res;
        token = ((await ctx.runAction(internal.salesforceActions.refreshAccessToken, { orgId: a.orgId })) as { accessToken: string }).accessToken;
      }
    };
    const out = { records: records.size, fields: fields.size, restored: 0, alreadyRestored: 0, kept: [] as Array<Record<string, unknown>>, failed: [] as Array<Record<string, unknown>> };
    for (const list of records.values()) {
      const { sfObject, sfId } = list[0];
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(sfObject) || !/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(sfId) || list.some((f) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.field))) {
        out.failed.push({ sfObject, sfId, error: "bad target" });
        continue;
      }
      const cols = [...new Set(["Id", "LastModifiedDate", ...list.map((f) => f.field)])];
      const read = await request("GET", `/services/data/${apiVersion}/query?q=${encodeURIComponent(`SELECT ${cols.join(", ")} FROM ${sfObject} WHERE Id = '${sfId}'`)}`);
      if (!read.ok) {
        out.failed.push({ sfObject, sfId, error: `soql ${read.status}: ${(await read.text()).slice(0, 300)}` });
        continue;
      }
      const now = ((await read.json()) as { records: Array<Record<string, unknown>> }).records[0];
      const restore: Record<string, unknown> = {};
      for (const f of list) {
        // Already back at its value before the sync: nothing to write (a country the picklist relabelled reads the same).
        if (now && JSON.stringify(now[f.field] ?? null) === JSON.stringify(f.before ?? null)) {
          out.alreadyRestored++;
          continue;
        }
        if (now && f.wrote.some((w) => SAME(f.field, now[f.field], w))) restore[f.field] = f.before ?? null;
        else out.kept.push({ sfObject, sfId, field: f.field, now: now ? now[f.field] ?? null : "record not found", wrote: f.wrote.at(-1) });
      }
      if (!Object.keys(restore).length) continue;
      if (a.dryRun) {
        out.restored += Object.keys(restore).length;
        continue;
      }
      const details = { sfObject, sfId, fields: restore, patchPlanIds: [...new Set(list.flatMap((f) => [...f.plans]))] };
      const res = await request("PATCH", `/services/data/${apiVersion}/sobjects/${sfObject}/${sfId}`, {
        // Refused (412) when the record changed after it was read: an edit made in the meantime is kept.
        "If-Unmodified-Since": new Date(String(now!.LastModifiedDate)).toUTCString(),
        // These are the record's own earlier values: Salesforce's duplicate rules alert on them, but the save goes ahead.
        "Sforce-Duplicate-Rule-Header": "allowSave=true",
      }, restore);
      if (res.ok) {
        out.restored += Object.keys(restore).length;
        await ctx.runMutation(internal.salesforceSync.logRevert, { orgId: a.orgId, ok: true, details });
      } else {
        const error = res.status === 412 ? "changed in Salesforce while reverting; kept" : `salesforce PATCH ${res.status}: ${(await res.text()).slice(0, 300)}`;
        out.failed.push({ ...details, error });
        await ctx.runMutation(internal.salesforceSync.logRevert, { orgId: a.orgId, ok: false, details: { ...details, error } });
      }
    }
    return out;
  },
});
