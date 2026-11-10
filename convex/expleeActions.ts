/**
 * Explee actions: connect with the workspace's API key, and poll its hot-leads
 * feed (every 10 minutes from crons.ts, or on demand) so each lead who replied
 * with real interest lands as a contact with the reply on its timeline. The key
 * is read and decrypted here and goes nowhere but the X-API-Key header.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { clientFor } from "./records";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { createExpleeClient, ExpleeError } from "./lib/outbound/explee";
import { syncHotLeads, type HotLeadSync } from "./lib/outbound/hotLeads";

type Caller = { orgId: Id<"organizations">; userId: Id<"users">; role: string };

async function requireMember(ctx: ActionCtx): Promise<Caller> {
  const caller = await ctx.runQuery(internal.audiences.caller, {});
  if (!caller) throw new ConvexError("Not authenticated");
  return caller;
}

/** Explee's refusal as a message for the user; anything else is ours to raise. */
async function viaExplee<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof ExpleeError) throw new ConvexError(cause.message);
    throw cause;
  }
}

/** Connect Explee: the key is checked against the live API, then stored encrypted. */
export const connect = action({
  args: { apiKey: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await requireMember(ctx);
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new ConvexError("Paste your Explee API key.");
    await viaExplee(() => createExpleeClient({ apiKey }).projects());
    await ctx.runMutation(internal.explee.storeKey, { orgId: caller.orgId, userId: caller.userId, apiKey });
    await ctx.scheduler.runAfter(0, internal.expleeActions.syncOrg, { orgId: caller.orgId });
    return { ok: true };
  },
});

type SyncSummary = Pick<HotLeadSync, "imported" | "already"> & { skipped: number };

/** A poll's summary, or why there was none. A failure is also recorded on the integration for the card. */
async function runSync(ctx: ActionCtx, orgId: Id<"organizations">): Promise<SyncSummary | { error: string }> {
  const state = await ctx.runQuery(internal.explee.syncState, { orgId });
  if (!state) return { error: "Explee is not connected. Add your API key in Integrations." };
  try {
    const client = createExpleeClient({ apiKey: await decryptFromStorage(state.apiKey) });
    const records = clientFor(ctx);
    const ws = orgId as string;
    const r = await syncHotLeads({
      client,
      since: state.since,
      now: Date.now(),
      ports: {
        upsert: async (key, account, contact) => {
          await records.upsertAccounts(ws, { records: [account], source: "explee", idempotencyKey: `${key}:a`, fill: "missing" });
          const out = await records.upsertContacts(ws, { records: [contact], source: "explee", idempotencyKey: `${key}:c`, fill: "missing" });
          return out.ids[0] ?? null;
        },
        log: (contactId, o) =>
          ctx.runMutation(internal.explee.logHotLead, { orgId, contactId, body: o.body, observedAt: o.observedAt, ...(o.occurredAt === undefined ? {} : { occurredAt: o.occurredAt }) }),
      },
    });
    for (const s of r.skipped) console.log(`explee hot lead ${s.personId} skipped: ${s.reason}`);
    await ctx.runMutation(internal.explee.finishSync, { orgId, ok: true, cursor: r.cursor, imported: r.imported, recent: r.recent });
    return { imported: r.imported, already: r.already, skipped: r.skipped.length };
  } catch (cause) {
    const message = cause instanceof ExpleeError ? cause.message : "The hot-lead sync failed. It retries in 10 minutes.";
    console.error(`explee sync for ${orgId} failed`, cause instanceof Error ? cause.message : cause);
    await ctx.runMutation(internal.explee.finishSync, { orgId, ok: false, error: message });
    return { error: message };
  }
}

export const syncOrg = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await runSync(ctx, args.orgId);
  },
});

/** Every connected org's poll, each in its own action so one slow or failing account holds up no other. */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.runQuery(internal.explee.connectedOrgs, {});
    for (const orgId of orgs) await ctx.scheduler.runAfter(0, internal.expleeActions.syncOrg, { orgId });
  },
});

/** "Check now" on the integration card. */
export const syncNow = action({
  args: {},
  handler: async (ctx): Promise<SyncSummary> => {
    const caller = await requireMember(ctx);
    const r = await runSync(ctx, caller.orgId);
    if ("error" in r) throw new ConvexError(r.error);
    return r;
  },
});
