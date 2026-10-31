/**
 * Record webhooks (CP16b, docs/record-api.md "Webhooks"). An admin registers a
 * URL; every accepted change on the ledger for the endpoint's objects and
 * events is POSTed to it, signed like the agent webhooks.
 *
 * Driver: the ledger itself. Each endpoint keeps a cursor per shard (the last
 * `seq` it was given). `fanout` reads the entries after the cursors, inserts
 * one delivery row per matching entry and advances the cursors in ONE
 * transaction, so an entry is enqueued exactly once per endpoint whatever
 * crashes. It runs after every ledger append for an org that has an endpoint
 * (scheduled from `appendEntry`) and from a one-minute sweep that also
 * re-dispatches deliveries whose send never settled. `deliver` sends one
 * delivery: at-least-once, with backoff, then `failed`.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { roleIn } from "./permissions";
import { orgObjectDefs, shardHeads } from "./ledgerFeed";
import { signWebhook } from "./lib/agents/webhook";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";
import { boundedPage } from "./lib/objects/tail";
import { SHARDS } from "./lib/objects/write";
import { fromStored } from "./lib/objects/validators";
import type { ObjectDef } from "./lib/objects/registry";
import type { EntryBody } from "./lib/objects/fold";
import {
  LEASE_MS, RECEIVER_TIMEOUT_MS, RECORD_EVENTS, backoffMs, destinationProblem, newSecret, planShard, publicAddresses, resolvesPrivate,
  type EventEntry,
} from "./lib/recordWebhooks";

const MAX_ENDPOINTS = 10;
const BATCH = 50;
const SHARD_BYTES = 400_000;
const DELIVERIES_SHOWN = 25;
const KEEP_FINISHED_MS = 14 * 24 * 60 * 60_000;
const ERROR_MAX = 300;

/** A local dev stack (loopback Convex site) may register loopback receivers; a deployed one never. */
const localStack = () => {
  try { return ["localhost", "127.0.0.1"].includes(new URL(process.env.CONVEX_SITE_URL ?? "").hostname); } catch { return false; }
};

const isAdmin = (user: Doc<"users">) => can(user, "webhooks.manage");

async function admin(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!isAdmin(user)) throw new ConvexError(refusal("webhooks.manage"));
  return user;
}

async function ownEndpoint(ctx: MutationCtx, user: Doc<"users">, id: Id<"recordWebhookEndpoints">) {
  const endpoint = await ctx.db.get(id);
  if (!endpoint || endpoint.orgId !== user.orgId) throw new ConvexError("Webhook not found");
  return endpoint;
}

async function checkChoices(ctx: MutationCtx, orgId: Id<"organizations">, objects: readonly string[], events: readonly string[]) {
  const known = new Set((await orgObjectDefs(ctx, orgId)).map((d) => d.apiName));
  const badObject = objects.find((o) => !known.has(o));
  if (badObject) throw new ConvexError(`Unknown object ${badObject}`);
  if (!events.length) throw new ConvexError("Pick at least one event");
  const badEvent = events.find((e) => !(RECORD_EVENTS as readonly string[]).includes(e));
  if (badEvent) throw new ConvexError(`Unknown event ${badEvent}`);
}

/** Cursors that start an endpoint at "now": it is told about changes from here on, never the past. */
const headCursors = (ctx: MutationCtx, orgId: Id<"organizations">) => shardHeads(ctx, orgId);

// ───────────────────────────── Admin surface ─────────────────────────────

const endpointView = (e: Doc<"recordWebhookEndpoints">) => ({
  id: e._id, url: e.url, description: e.description ?? null, objects: e.objects, events: e.events, enabled: e.enabled, createdAt: e.createdAt,
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !isAdmin(user)) return null;
    const rows = await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(MAX_ENDPOINTS);
    const defs = await orgObjectDefs(ctx, user.orgId);
    const out = [];
    for (const e of rows) {
      const last = await ctx.db.query("recordWebhookDeliveries").withIndex("by_endpointId_and_createdAt", (q) => q.eq("endpointId", e._id)).order("desc").first();
      out.push({ ...endpointView(e), lastDelivery: last ? { status: last.status, at: last.createdAt, statusCode: last.lastStatusCode ?? null } : null });
    }
    return { endpoints: out, objects: defs.map((d) => ({ apiName: d.apiName, label: d.label })), events: [...RECORD_EVENTS], local: localStack() };
  },
});

export const deliveries = query({
  args: { endpointId: v.id("recordWebhookEndpoints") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const endpoint = user && isAdmin(user) ? await ctx.db.get(args.endpointId) : null;
    if (!user || !endpoint || endpoint.orgId !== user.orgId) return [];
    const rows = await ctx.db.query("recordWebhookDeliveries").withIndex("by_endpointId_and_createdAt", (q) => q.eq("endpointId", endpoint._id)).order("desc").take(DELIVERIES_SHOWN);
    return rows.map((d) => ({
      id: d._id, event: d.event, object: d.object, eventId: `${d.shard}.${d.seq}`, status: d.status, attempts: d.attempts, createdAt: d.createdAt,
      nextAttemptAt: d.status === "pending" ? d.nextAttemptAt : null, statusCode: d.lastStatusCode ?? null, error: d.lastError ?? null,
    }));
  },
});

/** Register an endpoint. The signing secret comes back once, here, and is stored encrypted. */
export const create = action({
  args: { url: v.string(), description: v.optional(v.string()), objects: v.array(v.string()), events: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ id: Id<"recordWebhookEndpoints">; secret: string }> => {
    const secret = newSecret();
    const id: Id<"recordWebhookEndpoints"> = await ctx.runMutation(internal.recordWebhooks.insertEndpoint, { ...args, secret: await encryptForStorage(secret) });
    return { id, secret };
  },
});

export const insertEndpoint = internalMutation({
  args: { url: v.string(), description: v.optional(v.string()), objects: v.array(v.string()), events: v.array(v.string()), secret: v.string() },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const url = args.url.trim();
    const problem = destinationProblem(url, localStack());
    if (problem) throw new ConvexError(problem);
    await checkChoices(ctx, user.orgId, args.objects, args.events);
    const existing = await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(MAX_ENDPOINTS);
    if (existing.length >= MAX_ENDPOINTS) throw new ConvexError(`A workspace can have ${MAX_ENDPOINTS} webhooks`);
    const now = Date.now();
    const description = args.description?.trim().slice(0, 200);
    const id = await ctx.db.insert("recordWebhookEndpoints", {
      orgId: user.orgId, url, ...(description ? { description } : {}), objects: [...new Set(args.objects)], events: [...new Set(args.events)],
      secret: args.secret, enabled: true, cursors: await headCursors(ctx, user.orgId), createdBy: user._id, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "record_webhook.create", status: "applied", details: { url }, createdAt: now });
    return id;
  },
});

/** Change what an endpoint hears, or turn it off or on. Turning it on starts it at now: what happened while it was off is not sent. */
export const update = mutation({
  args: { id: v.id("recordWebhookEndpoints"), enabled: v.optional(v.boolean()), objects: v.optional(v.array(v.string())), events: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const endpoint = await ownEndpoint(ctx, user, args.id);
    const objects = args.objects ?? endpoint.objects;
    const events = args.events ?? endpoint.events;
    await checkChoices(ctx, user.orgId, objects, events);
    const patch: Partial<Doc<"recordWebhookEndpoints">> = { objects: [...new Set(objects)], events: [...new Set(events)], updatedAt: Date.now() };
    if (args.enabled !== undefined) {
      patch.enabled = args.enabled;
      if (args.enabled && !endpoint.enabled) patch.cursors = await headCursors(ctx, user.orgId);
    }
    await ctx.db.patch(endpoint._id, patch);
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("recordWebhookEndpoints") },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const endpoint = await ownEndpoint(ctx, user, args.id);
    await ctx.db.delete(endpoint._id);
    await ctx.db.insert("operationAuditLog", { orgId: user.orgId, userId: user._id, verb: "do", operation: "record_webhook.delete", status: "applied", details: { url: endpoint.url }, createdAt: Date.now() });
    return null;
  },
});

// ───────────────────────────── Fan-out: ledger to deliveries ─────────────────────────────

const scheduled = new WeakMap<MutationCtx, Set<string>>();
/** After a ledger append: wake the fan-out once per transaction, only for an org that has a live endpoint. */
export async function scheduleWebhookFanout(ctx: MutationCtx, orgId: Id<"organizations">) {
  const done = scheduled.get(ctx) ?? new Set<string>();
  scheduled.set(ctx, done);
  if (done.has(orgId)) return;
  done.add(orgId);
  const live = await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_ENDPOINTS);
  if (live.some((e) => e.enabled)) await ctx.scheduler.runAfter(0, internal.recordWebhooks.fanout, { orgId });
}

export const fanout = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const enabled = (await ctx.db.query("recordWebhookEndpoints").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(MAX_ENDPOINTS)).filter((e) => e.enabled);
    // An endpoint sends what its creator may see (CP14). Only admins create endpoints and admins see every record, so an
    // endpoint sends everything while its creator is an active admin here, and pauses (its cursors held) once they are not.
    const endpoints = [];
    for (const e of enabled) {
      const creator = await ctx.db.get(e.createdBy);
      if (creator && (await roleIn(ctx, creator, args.orgId)) === "admin") endpoints.push(e);
    }
    if (!endpoints.length) return;
    const defs = new Map<string, ObjectDef>((await orgObjectDefs(ctx, args.orgId)).map((d) => [d.apiName, d]));
    const state = endpoints.map((e) => ({ id: e._id as string, objects: e.objects, events: e.events, cursors: e.cursors }));
    const nextCursors = new Map(endpoints.map((e) => [e._id as string, { ...e.cursors }]));
    const recordIds = new Map<string, string>();
    const now = Date.now();
    let more = false;
    const queued: Id<"recordWebhookDeliveries">[] = [];

    for (let shard = 0; shard < SHARDS; shard++) {
      const lowest = Math.min(...state.map((e) => e.cursors[String(shard)] ?? 0));
      const page = await boundedPage(ctx.db.query("ledgerEntries")
        .withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", args.orgId).eq("shard", shard).gt("seq", lowest)), { limit: BATCH, maxBytes: SHARD_BYTES });
      if (!page.items.length) continue;
      more ||= page.more;
      const entries: EventEntry[] = page.items.map((r) => ({
        object: r.object, version: r.version, seq: r.seq, shard: r.shard, observedAt: r.observedAt, body: fromStored<EntryBody>(r.body),
        ...(r.redactedAt !== undefined ? { redactedAt: r.redactedAt } : {}),
      }));
      // The id a receiver can use against /api/v1/records: a company's or person's register id, else the stream id.
      for (const r of page.items) {
        const entity = await ctx.db.get(r.streamId);
        recordIds.set(`${shard}.${r.seq}`, entity && (entity.projectionTable === "recordAccounts" || entity.projectionTable === "recordContacts") ? entity.projectionId : r.streamId);
      }
      const plan = planShard(state, shard, entries, defs, (e) => recordIds.get(`${e.shard}.${e.seq}`) ?? "");
      for (const d of plan.deliveries) {
        queued.push(await ctx.db.insert("recordWebhookDeliveries", {
          orgId: args.orgId, endpointId: d.endpointId as Id<"recordWebhookEndpoints">, shard, seq: d.body.seq, event: d.body.event, object: d.body.object,
          payload: JSON.stringify(d.body), status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now,
        }));
      }
      for (const [id, seq] of Object.entries(plan.cursors)) nextCursors.get(id)![String(shard)] = seq;
    }
    for (const e of endpoints) {
      const next = nextCursors.get(e._id)!;
      if (JSON.stringify(next) !== JSON.stringify(e.cursors)) await ctx.db.patch(e._id, { cursors: next });
    }
    for (const id of queued) await ctx.scheduler.runAfter(0, internal.recordWebhooks.deliver, { deliveryId: id });
    if (more) await ctx.scheduler.runAfter(0, internal.recordWebhooks.fanout, { orgId: args.orgId });
  },
});

// ───────────────────────────── Delivery ─────────────────────────────

/** Start one attempt: only a pending delivery that is due, and the attempt holds it for LEASE_MS so a second sender backs off. */
export const claim = internalMutation({
  args: { deliveryId: v.id("recordWebhookDeliveries") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId);
    const now = Date.now();
    if (!d || d.status !== "pending" || d.nextAttemptAt > now) return null;
    const endpoint = await ctx.db.get(d.endpointId);
    if (!endpoint) {
      await ctx.db.delete(d._id);
      return null;
    }
    if (!endpoint.enabled) {
      await ctx.db.patch(d._id, { status: "failed", lastError: "Webhook disabled", nextAttemptAt: now });
      return null;
    }
    await ctx.db.patch(d._id, { attempts: d.attempts + 1, nextAttemptAt: now + LEASE_MS });
    return { url: endpoint.url, secret: endpoint.secret, payload: d.payload, eventId: `${d.shard}.${d.seq}`, event: d.event };
  },
});

export const settle = internalMutation({
  args: { deliveryId: v.id("recordWebhookDeliveries"), ok: v.boolean(), statusCode: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId);
    if (!d || d.status !== "pending") return null;
    const now = Date.now();
    const note = { ...(args.statusCode !== undefined ? { lastStatusCode: args.statusCode } : {}), ...(args.error ? { lastError: args.error.slice(0, ERROR_MAX) } : {}) };
    if (args.ok) {
      await ctx.db.patch(d._id, { status: "delivered", nextAttemptAt: now, ...note });
      return null;
    }
    const wait = backoffMs(d.attempts);
    if (wait === null) {
      await ctx.db.patch(d._id, { status: "failed", nextAttemptAt: now, ...note });
      return null;
    }
    await ctx.db.patch(d._id, { nextAttemptAt: now + wait, ...note });
    await ctx.scheduler.runAfter(wait, internal.recordWebhooks.deliver, { deliveryId: d._id });
    return null;
  },
});

export const deliver = internalAction({
  args: { deliveryId: v.id("recordWebhookDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runMutation(internal.recordWebhooks.claim, { deliveryId: args.deliveryId });
    if (!job) return;
    const settle = (r: { ok: boolean; statusCode?: number; error?: string }) => ctx.runMutation(internal.recordWebhooks.settle, { deliveryId: args.deliveryId, ...r });
    try {
      const local = localStack();
      const problem = destinationProblem(job.url, local);
      if (problem) return void (await settle({ ok: false, error: problem }));
      const url = new URL(job.url);
      if (!local && resolvesPrivate(await publicAddresses(url.hostname))) return void (await settle({ ok: false, error: "The hostname points to a private address" }));
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await fetch(job.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "Canon-Webhooks/1",
          "x-canon-event": job.event,
          "x-canon-delivery": job.eventId,
          "x-canon-timestamp": String(timestamp),
          "x-canon-signature": await signWebhook(await decryptFromStorage(job.secret), timestamp, job.payload),
        },
        body: job.payload,
      });
      await settle(res.status >= 200 && res.status < 300 ? { ok: true, statusCode: res.status } : { ok: false, statusCode: res.status, error: `Receiver answered ${res.status}` });
    } catch (cause) {
      await settle({ ok: false, error: cause instanceof Error ? cause.message : "Request failed" });
    }
  },
});

// ───────────────────────────── Sweep ─────────────────────────────

/**
 * Every minute: wake the fan-out for each org with a live endpoint (a lost
 * scheduled run costs a minute, not an event), send deliveries that are due
 * (a crashed attempt's lease has run out), and drop finished rows after two weeks.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const live = await ctx.db.query("recordWebhookEndpoints").withIndex("by_enabled", (q) => q.eq("enabled", true)).take(200);
    for (const orgId of new Set(live.map((e) => e.orgId))) await ctx.scheduler.runAfter(0, internal.recordWebhooks.fanout, { orgId });
    const due = await ctx.db.query("recordWebhookDeliveries").withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", "pending").lte("nextAttemptAt", now)).take(100);
    for (const d of due) await ctx.scheduler.runAfter(0, internal.recordWebhooks.deliver, { deliveryId: d._id });
    for (const status of ["delivered", "failed"] as const) {
      const old = await ctx.db.query("recordWebhookDeliveries").withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", status).lt("nextAttemptAt", now - KEEP_FINISHED_MS)).take(100);
      for (const d of old) await ctx.db.delete(d._id);
    }
    return null;
  },
});
