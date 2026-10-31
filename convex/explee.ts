/**
 * Explee connection and hot-lead sync state. Explee runs the cold email; Canon
 * polls its hot-leads feed (expleeActions.ts) and logs each lead on its contact.
 * The API key is stored like Instantly's: encrypted on the `integrations` row,
 * readable only by the actions. The poll's cursor and the latest imports live in
 * that row's `syncConfig`.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";
import { appendObservations } from "./observations";
import { RECENT_MAX } from "./lib/outbound/hotLeads";
import { observationBodyValidator } from "./lib/signals/observations";

const expleeRow = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "explee")).first();

type SyncConfig = { hotLeadsSince?: string | null; recent?: Array<{ contactId: string; name: string; company: string; at: number }>; imported?: number };
const configOf = (x: unknown): SyncConfig => (x && typeof x === "object" ? (x as SyncConfig) : {});

/** Whether Explee is connected, how the last poll went and the latest imports: never the key. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const row = user && (await expleeRow(ctx, user.orgId));
    const config = configOf(row?.syncConfig);
    return {
      connected: Boolean(row?.isActive),
      connectedAt: row?.connectedAt ?? null,
      lastSyncAt: row?.lastSyncAt ?? null,
      lastSyncStatus: row?.lastSyncStatus ?? null,
      lastSyncError: row?.lastSyncError ?? null,
      imported: config.imported ?? 0,
      recent: row?.isActive ? (config.recent ?? []) : [],
    };
  },
});

/** The encrypted key and the poll cursor, for the actions only. */
export const syncState = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const row = await expleeRow(ctx, args.orgId);
    if (!row?.isActive) return null;
    return { apiKey: row.accessToken, since: configOf(row.syncConfig).hotLeadsSince ?? null, connectedBy: row.connectedBy ?? null };
  },
});

/** Orgs with Explee connected: the cron polls each. */
export const connectedOrgs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("integrations").withIndex("by_provider", (q) => q.eq("provider", "explee")).collect();
    return rows.filter((r) => r.isActive).map((r) => r.orgId);
  },
});

export const storeKey = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), apiKey: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptForStorage(args.apiKey);
    const existing = await expleeRow(ctx, args.orgId);
    if (existing) {
      // A reconnect keeps the cursor and history: the same leads are not imported twice either way.
      await ctx.db.patch(existing._id, { accessToken: encrypted, isActive: true, connectedBy: args.userId, connectedAt: now, lastSyncError: undefined, updatedAt: now });
      return;
    }
    await ctx.db.insert("integrations", {
      orgId: args.orgId, provider: "explee", accessToken: encrypted, refreshToken: await encryptForStorage(""),
      isActive: true, connectedBy: args.userId, connectedAt: now, createdAt: now, updatedAt: now,
    });
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await expleeRow(ctx, user.orgId);
    if (row) await ctx.db.patch(row._id, { isActive: false, accessToken: await encryptForStorage(""), updatedAt: Date.now() });
  },
});

/** Append the hot-lead observation unless the contact already has one with its key. */
export const logHotLead = internalMutation({
  args: { orgId: v.id("organizations"), contactId: v.string(), body: observationBodyValidator, observedAt: v.number(), occurredAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<boolean> => {
    const seen = await ctx.db
      .query("observations")
      .withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", args.orgId).eq("subject.contactId", args.contactId).eq("body.key", args.body.key))
      .first();
    if (seen) return false;
    await appendObservations(ctx, args.orgId, { object: "contact", contactId: args.contactId }, { kind: "pipeline", ref: "explee" }, [
      { body: args.body, observedAt: args.observedAt, ...(args.occurredAt === undefined ? {} : { occurredAt: args.occurredAt }) },
    ]);
    return true;
  },
});

const recentValidator = v.array(v.object({ contactId: v.string(), name: v.string(), company: v.string(), at: v.number() }));

/** A poll's outcome: the cursor moves only on success, and the newest imports go to the top of the card's list. */
export const finishSync = internalMutation({
  args: {
    orgId: v.id("organizations"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    imported: v.optional(v.number()),
    recent: v.optional(recentValidator),
  },
  handler: async (ctx, args) => {
    const row = await expleeRow(ctx, args.orgId);
    if (!row?.isActive) return;
    const now = Date.now();
    if (!args.ok) {
      await ctx.db.patch(row._id, { lastSyncStatus: "error", lastSyncError: args.error, updatedAt: now });
      return;
    }
    const config = configOf(row.syncConfig);
    const recent = [...(args.recent ?? []), ...(config.recent ?? [])].slice(0, RECENT_MAX);
    await ctx.db.patch(row._id, {
      syncConfig: { ...config, hotLeadsSince: args.cursor ?? config.hotLeadsSince ?? null, recent, imported: (config.imported ?? 0) + (args.imported ?? 0) },
      lastSyncAt: now, lastSyncStatus: "success", lastSyncError: undefined, updatedAt: now,
    });
  },
});
