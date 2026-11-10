/**
 * Phase 1b workstream B: Salesforce Bulk API 2.0 import into the record
 * service.
 *
 * `start` (admin/manager) creates an sfImportJobs row and schedules `run`.
 * `run` fetches the org token only through
 * internal.salesforceActions.getOrgAccessToken, imports chunk by chunk with
 * idempotency keys `sf-import:{orgId}:{object}:{bulkJobId}:{chunkIndex}`,
 * checkpoints after every chunk, and reschedules itself after RUN_SLICE_MS so
 * no action approaches the 10-minute limit. Only sfImportJobs is written.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor } from "./permissions";
import { narrowsReads } from "./lib/access";
import { clientFor } from "./records";
import { rowsById } from "./associations";
import { OWNERS_CAP, REJECTED_SAMPLE_CAP, RUN_SLICE_MS, compact, mergeOwners, objectStateValidator, ownerTallyValidator, rejectedRowValidator } from "./lib/sfImportMapping";
import { planObjects, runImport } from "../engine/src/sync/salesforceImport/engine.ts";
import { httpSink } from "../engine/src/sync/salesforceImport/sinks.ts";
import type { CanonSink, ImportSink, ObjectImportState, OwnerTally, SfConn, UpsertResult } from "../engine/src/sync/salesforceImport/contracts.ts";

const SF_API_VERSION = "60.0";
const PAGE = 100;

// ───────────────────────────── Caller scope ─────────────────────────────

export const importCaller = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return { orgId: user.orgId, role: user.role as string, ...(user.capabilities ? { capabilities: user.capabilities } : {}) };
  },
});

/**
 * The reader of an import job: its org, and whether they see the whole
 * workspace. A rejected row names a record; only a role that sees every record
 * is shown them (CP14), anyone else the counts.
 */
async function readerOf(ctx: QueryCtx): Promise<{ orgId: Id<"organizations">; whole: boolean } | null> {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  const access = await accessFor(ctx, user);
  return { orgId: user.orgId, whole: !narrowsReads(access) && !access.preview };
}

// ───────────────────────────── Public API ─────────────────────────────

export const start = action({
  args: { objects: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<{ jobId: Id<"sfImportJobs"> }> => {
    const caller = await ctx.runQuery(internal.salesforceImport.importCaller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (!can(caller, "imports.run")) throw new ConvexError(refusal("imports.run"));
    const integration = await ctx.runQuery(internal.salesforce.getIntegration, { orgId: caller.orgId });
    if (!integration || !integration.isActive) throw new ConvexError("Connect Salesforce before importing");
    const jobId = await ctx.runMutation(internal.salesforceImport.createJob, { orgId: caller.orgId, objects: args.objects });
    await ctx.scheduler.runAfter(0, internal.salesforceImport.run, { jobId });
    return { jobId };
  },
});

/** The objects an import would bring across, with Salesforce's count of each. Reads Salesforce only. */
export const preview = action({
  args: {},
  handler: async (ctx): Promise<Array<{ apiName: string; sfTotal: number }>> => {
    const caller = await ctx.runQuery(internal.salesforceImport.importCaller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (!can(caller, "imports.run")) throw new ConvexError(refusal("imports.run"));
    const objects = await planObjects(await connFor(ctx, caller.orgId));
    return objects.map(({ apiName, sfTotal }) => ({ apiName, sfTotal }));
  },
});

const SPOT_OBJECTS = ["Account", "Contact", "Lead", "Opportunity", "Task", "Event", "Note", "ContentDocument"] as const;

/**
 * What Canon holds for up to 100 Salesforce records of one object, found by
 * their Salesforce ids the way a person would find them (the register's sfId,
 * the deal's CRM id), for the 50-record spot check (scripts/sf-spot-check.ts).
 * Read-only; admins and managers.
 */
export const spotCheck = action({
  args: { object: v.union(...SPOT_OBJECTS.map((o) => v.literal(o))), sfIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ records: unknown[]; unmappedOwners: string[]; reportedFailures: string[] }> => {
    const caller = await ctx.runQuery(internal.salesforceImport.importCaller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (!can(caller, "imports.run")) throw new ConvexError(refusal("imports.run"));
    await ctx.runQuery(internal.permissions.requireUnrestrictedCaller, { what: "the import spot check" });
    const orgId = caller.orgId;
    const sfIds = args.sfIds.slice(0, 100);
    const job = await ctx.runQuery(internal.salesforceImport.latestJobInternal, { orgId });
    const unmappedOwners = (job?.owners ?? []).filter((o) => !o.memberId).map((o) => o.sfUserId);
    const asked = new Set(sfIds);
    const reportedFailures = (job?.rejectedSample ?? []).flatMap((r) => (r.sfId && asked.has(r.sfId) ? [r.sfId] : []));
    const members = await ctx.runQuery(internal.salesforceImport.memberEmails, { orgId });
    const emailOf = (id: string | undefined | null) => (id ? members[id] ?? null : null);
    const rs = recordServiceReader(orgId);
    const domainOf = async (accountId: string | undefined) => (accountId ? ((await rs("accounts/get", { id: accountId }))?.account?.domain ?? null) : null);
    if (args.object === "Opportunity") {
      const deals = await ctx.runQuery(internal.salesforceImportCanon.dealsForSpotCheck, { orgId, sfIds });
      const records = [];
      for (const d of deals) {
        if (!d.found) { records.push(d); continue; }
        const contacts = await rowsById(clientFor(ctx), orgId, "contact", d.roles.map((r) => r.contactId));
        const roles = await Promise.all(d.roles.map(async (r) => ({ label: r.label, contactSfId: (await rs("contacts/get", { id: r.contactId }))?.contact?.sfId ?? null, email: contacts.get(r.contactId)?.values.email ?? null })));
        records.push({ ...d, deal: { ...d.deal, companyDomain: await domainOf(d.deal.companyId ?? undefined) }, roles });
      }
      return { records, unmappedOwners, reportedFailures };
    }
    if (args.object !== "Account" && args.object !== "Contact" && args.object !== "Lead") {
      // Activities name their targets by Canon id; the check compares Salesforce ids, so each target is named by the one it came from.
      const activities = await ctx.runQuery(internal.salesforceImportCanon.activitiesForSpotCheck, { orgId, sfIds });
      const sfIdOf = async (id: string) => {
        if (id.startsWith("acc_")) return (await rs("accounts/get", { id }))?.account?.sfId ?? null;
        if (id.startsWith("con_")) return (await rs("contacts/get", { id }))?.contact?.sfId ?? null;
        return ctx.runQuery(internal.salesforceImport.dealCrmIdOfStream, { orgId, streamId: id });
      };
      const records = [];
      for (const a of activities) records.push(a.found ? { ...a, targetSfIds: await Promise.all(a.targets.map(sfIdOf)) } : a);
      return { records, unmappedOwners, reportedFailures };
    }
    const records = [];
    for (const sfId of sfIds) {
      if (args.object === "Account") {
        const row = (await rs("accounts/list", { filter: { sfId }, limit: 1 }))?.rows?.[0];
        records.push(row
          ? { sfId, found: true, account: { name: row.name, domain: row.domain, industry: row.industry ?? null, employees: row.employees ?? null, country: row.country ?? null, ownerEmail: emailOf(row.ownerId) } }
          : { sfId, found: false });
      } else {
        const row = (await rs("contacts/list", { filter: { sfId }, limit: 1 }))?.rows?.[0];
        records.push(row
          ? { sfId, found: true, contact: { fullName: row.fullName, email: row.email ?? null, title: row.title ?? null, companyDomain: await domainOf(row.accountId) } }
          : { sfId, found: false });
      }
    }
    return { records, unmappedOwners, reportedFailures };
  },
});

/** The Salesforce id of the deal a stream projects, if it came from Salesforce. */
export const dealCrmIdOfStream = internalQuery({
  args: { orgId: v.id("organizations"), streamId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("canonEntities", args.streamId);
    const entity = id ? await ctx.db.get(id) : null;
    const dealId = entity?.orgId === args.orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
    return dealId ? ((await ctx.db.get(dealId))?.crmId ?? null) : null;
  },
});

export const latestJobInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => ctx.db.query("sfImportJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", args.orgId)).order("desc").first(),
});

/** Each member's email by user id. */
export const memberEmails = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(2000);
    return Object.fromEntries(users.map((u) => [u._id as string, u.email]));
  },
});

/** Read routes of the record service that the Convex record client does not type (sfId filters, raw rows). */
function recordServiceReader(ws: string) {
  const url = process.env.RECORD_SERVICE_URL;
  const token = process.env.RECORD_SERVICE_TOKEN;
  if (!url || !token) throw new ConvexError("The spot check needs the record service (RECORD_SERVICE_URL)");
  return async (path: string, body: unknown): Promise<any> => {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(ws)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": ws, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`record service ${path} failed: ${res.status}`);
    return res.json();
  };
}

export const get = query({
  args: { jobId: v.id("sfImportJobs") },
  handler: async (ctx, args) => {
    const reader = await readerOf(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!reader || !job || job.orgId !== reader.orgId) return null;
    return publicJob(job, reader.whole);
  },
});

export const latest = query({
  args: {},
  handler: async (ctx) => {
    const reader = await readerOf(ctx);
    if (!reader) return null;
    const job = await ctx.db.query("sfImportJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", reader.orgId)).order("desc").first();
    return job ? publicJob(job, reader.whole) : null;
  },
});

/** Rejected rows with reasons, newest job's sample (first REJECTED_SAMPLE_CAP), paged. */
export const listRejected = query({
  args: { jobId: v.id("sfImportJobs"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const reader = await readerOf(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!reader || !job || job.orgId !== reader.orgId) return { rows: [], nextCursor: null, total: 0, sampled: 0 };
    if (!reader.whole) return { rows: [], nextCursor: null, total: job.rejectedCount ?? job.rejectedSample.length, sampled: 0 };
    const start = Math.max(0, Number.parseInt(args.cursor ?? "0", 10) || 0);
    const rows = job.rejectedSample.slice(start, start + PAGE);
    const next = start + PAGE < job.rejectedSample.length ? String(start + PAGE) : null;
    return { rows, nextCursor: next, total: job.rejectedCount ?? job.rejectedSample.length, sampled: job.rejectedSample.length };
  },
});

function publicJob(job: Doc<"sfImportJobs">, whole: boolean) {
  return {
    _id: job._id,
    status: job.status,
    objects: job.objects.map(({ apiName, sfTotal, upserted, merged, rejected, bulkJobId, state, seen, error }) => ({ apiName, sfTotal, upserted, merged, rejected, bulkJobId, state, seen, error })),
    rejectedCount: job.rejectedCount ?? 0,
    rejectedSample: whole ? job.rejectedSample.slice(0, 20) : [],
    owners: job.owners ?? [],
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

// ───────────────────────────── Internal ─────────────────────────────

export const createJob = internalMutation({
  args: { orgId: v.id("organizations"), objects: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const prev = await ctx.db.query("sfImportJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", args.orgId)).order("desc").first();
    if (prev && (prev.status === "queued" || prev.status === "running")) throw new ConvexError("A Salesforce import is already running");
    return ctx.db.insert("sfImportJobs", {
      orgId: args.orgId,
      status: "queued",
      objects: [],
      requestedObjects: args.objects,
      rejectedSample: [],
      rejectedCount: 0,
      startedAt: Date.now(),
    });
  },
});

export const getJobInternal = internalQuery({
  args: { jobId: v.id("sfImportJobs") },
  handler: (ctx, args) => ctx.db.get(args.jobId),
});

export const checkpoint = internalMutation({
  args: {
    jobId: v.id("sfImportJobs"),
    objects: v.array(objectStateValidator),
    rejected: v.array(rejectedRowValidator),
    owners: v.optional(v.array(ownerTallyValidator)),
    status: v.optional(v.union(v.literal("running"), v.literal("done"), v.literal("failed"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const room = Math.max(0, REJECTED_SAMPLE_CAP - job.rejectedSample.length);
    const owners = args.owners?.map(({ memberId, ...o }) => {
      const id = memberId ? ctx.db.normalizeId("users", memberId) : null;
      return { ...o, ...(id ? { memberId: id } : {}) };
    });
    await ctx.db.patch(args.jobId, {
      objects: args.objects,
      ...(owners?.length ? { owners: mergeOwners(job.owners ?? [], owners, OWNERS_CAP) } : {}),
      rejectedSample: room ? [...job.rejectedSample, ...args.rejected.slice(0, room).map((r) => ({ ...r, reason: r.reason.slice(0, 300) }))] : job.rejectedSample,
      rejectedCount: (job.rejectedCount ?? 0) + args.rejected.length,
      ...(args.status ? { status: args.status } : {}),
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      ...(args.status === "done" || args.status === "failed" ? { finishedAt: Date.now() } : {}),
    });
  },
});

export const run = internalAction({
  args: { jobId: v.id("sfImportJobs") },
  handler: async (ctx, args): Promise<null> => {
    const job = await ctx.runQuery(internal.salesforceImport.getJobInternal, { jobId: args.jobId });
    if (!job || job.status === "done" || job.status === "failed") return null;
    const save = (
      objects: ObjectImportState[], rejected: Array<{ object: string; sfId?: string; reason: string }>,
      extra: { status?: "running" | "done" | "failed"; error?: string; owners?: OwnerTally[] } = {},
    ) =>
      ctx.runMutation(internal.salesforceImport.checkpoint, {
        jobId: args.jobId,
        objects: objects.map((o) => compact(o)),
        rejected: rejected.map((r) => compact(r)),
        ...extra,
        ...(extra.owners ? { owners: extra.owners.map((o) => compact(o)) } : {}),
      });
    try {
      const conn = await connFor(ctx, job.orgId);
      const sink = sinkFor(ctx, job.orgId);
      const canon = canonSinkFor(ctx, job.orgId, conn.instanceUrl);
      let objects = job.objects as ObjectImportState[];
      if (!objects.length) {
        objects = await planObjects(conn, job.requestedObjects ?? undefined);
        await save(objects, [], { status: "running" });
      }
      const { done } = await runImport({
        conn,
        sink,
        canon,
        orgId: job.orgId,
        objects,
        deadlineAt: Date.now() + RUN_SLICE_MS,
        checkpoint: async (objs, rejected, owners) => { await save(objs, rejected, owners ? { owners } : {}); },
      });
      if (!done) {
        await ctx.scheduler.runAfter(0, internal.salesforceImport.run, args);
        return null;
      }
      const failed = objects.filter((o) => o.state === "failed");
      await save(objects, [], failed.length ? { status: "failed", error: failed.map((o) => `${o.apiName}: ${o.error}`).join("; ") } : { status: "done" });
    } catch (error) {
      await ctx.runMutation(internal.salesforceImport.checkpoint, {
        jobId: args.jobId,
        objects: job.objects,
        rejected: [],
        status: "failed",
        error: error instanceof Error ? error.message : "Import failed",
      });
    }
    return null;
  },
});

async function connFor(ctx: ActionCtx, orgId: Id<"organizations">): Promise<SfConn> {
  let creds = await ctx.runAction(internal.salesforceActions.getOrgAccessToken, { orgId });
  return {
    instanceUrl: creds.instanceUrl,
    apiVersion: SF_API_VERSION,
    getToken: async () => creds.accessToken,
    refreshToken: async () => {
      const r = await ctx.runAction(internal.salesforceActions.refreshAccessToken, { orgId });
      creds = { ...creds, accessToken: r.accessToken };
      return r.accessToken;
    },
  };
}

/** Deals per Canon mutation: a new deal writes about 25 documents through the ledger (CP10 imports 20 rows a batch). */
const DEAL_BATCH = 20;
/** History points per deal mutation, on top of its deals. */
const HISTORY_BATCH = 60;
/** Activities per Canon mutation: a new one is a stream, its entry and an edge per target. */
const ACTIVITY_BATCH = 25;

/** The import's writes into Canon's own tables (convex/salesforceImportCanon.ts). */
function canonSinkFor(ctx: ActionCtx, orgId: Id<"organizations">, instanceUrl: string): CanonSink {
  return {
    membersByEmail: (emails) => ctx.runQuery(internal.salesforceImportCanon.membersByEmail, { orgId, emails }),
    prepareCustomFields: (object, specs) => ctx.runMutation(internal.salesforceImportCanon.prepareCustomFields, { orgId, object, specs: specs.map((x) => compact(x)) }),
    preparePipelines: (processes) => ctx.runMutation(internal.salesforceImportCanon.preparePipelines, { orgId, processes: processes.map((p) => ({ ...p, stages: [...p.stages] })) }),
    rememberIds: async (object, pairs) => { await ctx.runMutation(internal.salesforceImportCanon.rememberIds, { orgId, object, pairs }); },
    async upsertDeals(rows) {
      const out = { created: 0, updated: 0, rejected: [] as Array<{ index: number; reason: string }> };
      // A batch holds up to DEAL_BATCH deals and HISTORY_BATCH history points: each point is a ledger write too.
      for (let i = 0; i < rows.length;) {
        let end = i;
        let points = 0;
        while (end < rows.length && end - i < DEAL_BATCH && (end === i || points + (rows[end].history?.length ?? 0) <= HISTORY_BATCH)) points += rows[end++].history?.length ?? 0;
        const r = await ctx.runMutation(internal.salesforceImportCanon.upsertDeals, { orgId, instanceUrl, deals: rows.slice(i, end).map((d) => compact(d)) });
        out.created += r.created;
        out.updated += r.updated;
        out.rejected.push(...r.rejected.map((x) => ({ ...x, index: x.index + i })));
        i = end;
      }
      return out;
    },
    async upsertActivities(rows) {
      const out = { created: 0, updated: 0, rejected: [] as Array<{ index: number; reason: string }> };
      for (let i = 0; i < rows.length; i += ACTIVITY_BATCH) {
        const r = await ctx.runMutation(internal.salesforceImportCanon.upsertActivities, { orgId, rows: rows.slice(i, i + ACTIVITY_BATCH).map((a) => compact(a)) });
        out.created += r.created;
        out.updated += r.updated;
        out.rejected.push(...r.rejected.map((x) => ({ ...x, index: x.index + i })));
      }
      return out;
    },
    setDealRoles: (deals) => ctx.runMutation(internal.salesforceImportCanon.setDealRoles, { orgId, deals: deals.map((d) => ({ ...d, roles: d.roles.map((r) => compact(r)) })) }),
    setAccountParents: (links) => ctx.runMutation(internal.salesforceImportCanon.setAccountParents, { orgId, links }),
  };
}

/**
 * Record service 1.2.0 over HTTP when RECORD_SERVICE_URL is set. Otherwise
 * the Convex fake record client (dev only): it has no sfId, merge reporting
 * or custom objects, so custom-object imports fail with a clear error there.
 */
function sinkFor(ctx: ActionCtx, orgId: string): ImportSink {
  const url = process.env.RECORD_SERVICE_URL;
  if (url) {
    const token = process.env.RECORD_SERVICE_TOKEN;
    if (!token) throw new Error("RECORD_SERVICE_URL is set but RECORD_SERVICE_TOKEN is missing.");
    return httpSink({ baseUrl: url, token, ws: orgId });
  }
  const client = clientFor(ctx);
  const adapt = (r: { upserted: number; ids: string[] }): UpsertResult => ({ upserted: r.upserted, ids: r.ids, created: r.upserted, merged: 0, rejected: [] });
  return {
    upsertAccounts: async (body) => adapt(await client.upsertAccounts(orgId, body as never)),
    upsertContacts: async (body) => adapt(await client.upsertContacts(orgId, body as never)),
    defineObjects: async () => {
      throw new Error("Custom objects need record service 1.2.0 (RECORD_SERVICE_URL is unset)");
    },
    upsertCustom: async () => {
      throw new Error("Custom objects need record service 1.2.0 (RECORD_SERVICE_URL is unset)");
    },
  };
}
