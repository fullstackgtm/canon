/**
 * Credits (Settings -> Billing -> Credits, docs/credits.md). Each workspace gets
 * a free monthly allowance, spent first; an admin buys packs through a
 * one-time Stripe Checkout payment, which the signed webhook (convex/http.ts)
 * grants here once paid. Our ledger is what spend runs against, in real time;
 * Metronome holds purchased credits as a prepaid commit (one credit to the
 * cent) and records what was spent from them, as the billing record.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { customerFor, origin } from "./billing";
import { integrationIdentifier, stripeClient } from "./lib/stripeBilling";
import { addCredits, creditProductId, ensureAccount, ensureCatalog, ingestCharges, metronome, netBalanceCents } from "./lib/metronome";
import { CREDIT_PACKS, CREDIT_USD, FREE_CREDITS_PER_MONTH, MICRO, creditMonth, packByPrice, packFromSession, paidBalanceMicro, splitSpend } from "./lib/creditPacks";
import { dailyUsage, monthOf } from "./lib/creditUsage";

/** A ledger row's amount in micro-credits: rows from before credits became units are dollars. */
const ledgerMicro = (r: { amountMicro: number; unit?: string }) => (r.unit === "credits" ? r.amountMicro : Math.round(r.amountMicro / CREDIT_USD));

/** The workspace's purchased balance and this month's free allowance, all in micro-credits. */
export function creditState(org: Doc<"organizations">, now: number) {
  const month = creditMonth(now);
  const allowanceMicro = FREE_CREDITS_PER_MONTH * MICRO;
  const usedMicro = org.freeCreditsMonth === month ? (org.freeCreditsUsedMicro ?? 0) : 0;
  return { month, allowanceMicro, usedMicro, freeLeftMicro: Math.max(0, allowanceMicro - usedMicro), paidMicro: paidBalanceMicro(org) };
}

/** What a hold pays for: a paid run (its cap in the job's counters) or an AI-field research run (its own cap, if any). */
export const spenderValidator = v.union(v.object({ jobId: v.id("backgroundJobs") }), v.object({ researchRunId: v.id("researchRuns") }));
export type Spender = typeof spenderValidator.type;

/**
 * A spender's cap and what it has spent, in micro-credits. A paid run without a cap may spend nothing;
 * a research run without one (a scheduled refresh) is bounded by the workspace's balance alone.
 */
async function budgetOf(ctx: MutationCtx, s: Spender): Promise<{ capMicro: number | null; spentMicro: number; spend: (deltaMicro: number) => Promise<void> } | null> {
  if ("jobId" in s) {
    const job = await ctx.db.get(s.jobId);
    if (!job) return null;
    const c = job.counters ?? {};
    return {
      capMicro: c.cap_micro ?? 0, spentMicro: c.spent_micro ?? 0,
      spend: (d) => ctx.db.patch(s.jobId, { counters: { ...c, spent_micro: (c.spent_micro ?? 0) + d } }),
    };
  }
  const run = await ctx.db.get(s.researchRunId);
  if (!run) return null;
  return { capMicro: run.capMicro ?? null, spentMicro: run.spentMicro ?? 0, spend: (d) => ctx.db.patch(s.researchRunId, { spentMicro: (run.spentMicro ?? 0) + d }) };
}

/** The ledger fields that tie a row to its spender. */
const spenderFields = (s: Spender) => ("jobId" in s ? { jobId: s.jobId } : { researchRunId: s.researchRunId });

/** The workspace's balance and the packs it can buy. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const org = await ctx.db.get(user.orgId);
    if (!org) return null;
    const state = creditState(org, Date.now());
    return {
      canBuy: can(user, "billing.manage"),
      configured: integrationEnabled("billing") && integrationEnabled("metronome"),
      balance: state.paidMicro / MICRO,
      free: { allowance: state.allowanceMicro / MICRO, left: state.freeLeftMicro / MICRO },
      spendable: (state.paidMicro + state.freeLeftMicro) / MICRO,
      packs: CREDIT_PACKS,
    };
  },
});

/** Ledger rows `usage` reads for one month; a busier month shows no chart rather than a wrong one. */
const USAGE_ROWS = 8000;

/** This month's credit activity by day (Settings -> Billing): the chart and the daily table. */
export const usage = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const org = await ctx.db.get(user.orgId);
    if (!org) return null;
    const now = Date.now();
    const { start, days } = monthOf(now);
    const rows = await ctx.db.query("creditLedger")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId).gte("at", start).lte("at", now))
      .take(USAGE_ROWS + 1);
    if (rows.length > USAGE_ROWS) return { now, monthDays: days, complete: false as const, days: [] };
    const state = creditState(org, now);
    const usageRows = rows.map((r) => ({ at: r.at, kind: r.kind, amount: ledgerMicro(r) / MICRO, free: (r.freeMicro ?? 0) / MICRO }));
    return { now, monthDays: days, complete: true as const, days: dailyUsage(usageRows, now, state.paidMicro / MICRO, state.allowanceMicro / MICRO) };
  },
});

/** Ledger rows `dayActivity` lists for one day. */
const DAY_ROWS = 200;

/** One day's credit changes, newest first, for a row of the daily table. */
export const dayActivity = query({
  args: { day: v.number() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const rows = await ctx.db.query("creditLedger")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId).gte("at", args.day).lt("at", args.day + 86_400_000))
      .order("desc")
      .take(DAY_ROWS + 1);
    return {
      more: rows.length > DAY_ROWS,
      entries: rows.slice(0, DAY_ROWS).map((r) => ({ id: r._id, at: r.at, kind: r.kind, amount: ledgerMicro(r) / MICRO, note: r.note ?? null, pending: r.pending ?? false })),
    };
  },
});

/** A Checkout Session for one credit pack. The caller redirects to `url`. */
export const buy = action({
  args: { pack: v.number() },
  handler: async (ctx, args): Promise<{ url: string | null }> => {
    if (!integrationEnabled("billing") || !integrationEnabled("metronome")) return { url: null };
    const stripe = stripeClient();
    if (!stripe || !process.env.METRONOME_API_KEY) throw new ConvexError("Credits aren't configured on this deployment.");
    const pack = packByPrice(args.pack);
    if (!pack) throw new ConvexError("Pick one of the credit packs.");
    const org = await ctx.runQuery(internal.billing.adminOrg, {});
    const customer = await customerFor(ctx, stripe, org);
    const base = origin();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer,
      client_reference_id: org.orgId,
      line_items: [{
        quantity: 1,
        price_data: { currency: "usd", unit_amount: pack.price * 100, product_data: { name: `${pack.credits} CanonCRM credits` } },
      }],
      metadata: { pack: String(pack.price) },
      success_url: `${base}/dashboard/settings/billing?credits=success`,
      cancel_url: `${base}/dashboard/settings/billing`,
      // Each purchase gets a Stripe invoice the admin can download for their books.
      invoice_creation: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { name: "auto", address: "auto" },
      ...(process.env.STRIPE_AUTOMATIC_TAX === "on" ? { automatic_tax: { enabled: true } } : {}),
      integration_identifier: integrationIdentifier("canoncrm_credits"),
    });
    if (!session.url) throw new ConvexError("Stripe didn't return a checkout page.");
    return { url: session.url };
  },
});

export const orgByStripeCustomer = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db.query("organizations").withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", args.stripeCustomerId)).unique();
    return org ? { orgId: org._id, name: org.name, metronomeCustomerId: org.metronomeCustomerId ?? null, metronomeContractId: org.metronomeContractId ?? null } : null;
  },
});

/** Apply one credit change once (by `ref`) and keep the org's balance with it. False when `ref` was already applied. */
export const record = internalMutation({
  args: {
    orgId: v.id("organizations"),
    kind: v.union(v.literal("purchase"), v.literal("spend"), v.literal("refund"), v.literal("adjust")),
    amountMicro: v.number(),
    ref: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<boolean> => {
    const seen = await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first();
    if (seen) return false;
    const org = await ctx.db.get(a.orgId);
    if (!org) throw new Error("workspace not found");
    const balanceAfterMicro = paidBalanceMicro(org) + a.amountMicro;
    const at = Date.now();
    await ctx.db.insert("creditLedger", { ...a, unit: "credits", balanceAfterMicro, at });
    await ctx.db.patch(a.orgId, { creditBalanceMicro: balanceAfterMicro, creditUnit: "credits", updatedAt: at });
    return true;
  },
});

export const setMetronome = internalMutation({
  args: { orgId: v.id("organizations"), metronomeCustomerId: v.string(), metronomeContractId: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.orgId, { metronomeCustomerId: a.metronomeCustomerId, metronomeContractId: a.metronomeContractId, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Grant a paid pack: our ledger first (what spend runs against), then the same
 * credits as a Metronome commit. Both are keyed by `ref`, so a webhook retry
 * after a partial failure finishes the job without granting twice.
 */
export const grantPurchase = internalAction({
  args: { orgId: v.id("organizations"), name: v.string(), credits: v.number(), ref: v.string() },
  handler: async (ctx, a): Promise<null> => {
    await ctx.runMutation(internal.credits.record, { orgId: a.orgId, kind: "purchase", amountMicro: a.credits * MICRO, ref: a.ref, note: `Bought ${a.credits.toLocaleString("en-US")} credits` });
    const m = metronome();
    if (!m) throw new Error("METRONOME_API_KEY is not set");
    const account = await ensureAccount(m, { orgId: a.orgId, name: a.name });
    await ctx.runMutation(internal.credits.setMetronome, { orgId: a.orgId, metronomeCustomerId: account.customerId, metronomeContractId: account.contractId });
    await addCredits(m, { ...account, productId: await creditProductId(m), cents: a.credits, key: a.ref, name: `${a.credits} credits`, at: Date.now() });
    return null;
  },
});

/** Fulfill a paid credits Checkout Session (called by the webhook). False when it isn't one. */
export const fulfillCheckout = internalAction({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const stripe = stripeClient();
    if (!stripe) throw new Error("STRIPE_BILLING_KEY is not set");
    const session = await stripe.checkout.sessions.retrieve(args.sessionId, { expand: ["line_items.data.price"] });
    if (session.mode !== "payment" || session.payment_status !== "paid") return false;
    const pack = packFromSession({ metadata: session.metadata, amount_subtotal: session.amount_subtotal, lookupKey: session.line_items?.data[0]?.price?.lookup_key });
    const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!pack || !customer) return false;
    const org = await ctx.runQuery(internal.credits.orgByStripeCustomer, { stripeCustomerId: customer });
    if (!org) {
      console.warn(`credits: paid session ${session.id} for customer ${customer}, which no workspace owns`);
      return false;
    }
    await ctx.runAction(internal.credits.grantPurchase, { orgId: org.orgId as Id<"organizations">, name: org.name, credits: pack.credits, ref: session.id });
    return true;
  },
});

/** Ops: create Metronome's metric, products and rate card for this deployment's Metronome environment. */
export const ensureMetronomeCatalog = internalAction({
  args: {},
  handler: async () => {
    const m = metronome();
    if (!m) throw new Error("METRONOME_API_KEY is not set");
    return ensureCatalog(m);
  },
});

/** Ops: compare our balance with Metronome's (Metronome lags by about 30 s). */
export const reconcile = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ ledgerCredits: number; metronomeCredits: number | null }> => {
    const org = await ctx.runQuery(internal.credits.balanceOf, { orgId: args.orgId });
    const m = metronome();
    // Metronome holds a credit as one cent.
    return { ledgerCredits: org.paidMicro / MICRO, metronomeCredits: m && org.metronomeCustomerId ? await netBalanceCents(m, org.metronomeCustomerId) : null };
  },
});

export const balanceOf = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) return { paidMicro: 0, spendableMicro: 0, metronomeCustomerId: null };
    const state = creditState(org, Date.now());
    return { paidMicro: state.paidMicro, spendableMicro: state.paidMicro + state.freeLeftMicro, metronomeCustomerId: org.metronomeCustomerId ?? null };
  },
});

/**
 * Hold credits for one paid call or one page of research, if both the workspace's
 * balance and the spender's cap cover it. Standalone steps omit the spender and expire after 15 minutes. Retrying `ref` holds once.
 */
export const hold = internalMutation({
  args: { orgId: v.id("organizations"), spender: v.optional(spenderValidator), ref: v.string(), amountMicro: v.number(), note: v.string(), freeOnly: v.optional(v.boolean()) },
  handler: holdCredits,
});

export async function holdCredits(ctx: MutationCtx, a: { orgId: Id<"organizations">; spender?: Spender; ref: string; amountMicro: number; note: string; freeOnly?: boolean }): Promise<{ ok: true } | { ok: false; reason: "balance" | "cap" }> {
  if (await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first()) return { ok: true };
  const [org, budget] = await Promise.all([ctx.db.get(a.orgId), a.spender ? budgetOf(ctx, a.spender) : null]);
  if (!org || (a.spender && !budget)) throw new Error("workspace or run not found");
  if (budget && budget.capMicro !== null && budget.capMicro - budget.spentMicro < a.amountMicro) return { ok: false, reason: "cap" };
  if (a.freeOnly && creditState(org, Date.now()).freeLeftMicro < a.amountMicro) return { ok: false, reason: "balance" };
  if (!(await take(ctx, org, a, { ...(a.spender ? spenderFields(a.spender) : {}), pending: true }))) return { ok: false, reason: "balance" };
  await budget?.spend(a.amountMicro);
  if (!a.spender) await ctx.scheduler.runAfter(STALE_HOLD_MS, internal.credits.settle, { ref: a.ref, chargeMicro: 0 });
  return { ok: true };
}

/** Spend `amountMicro` from the workspace, free allowance first, as one ledger row; false when it can't pay. */
async function take(ctx: MutationCtx, org: Doc<"organizations">, a: { ref: string; amountMicro: number; note: string }, row: Partial<Doc<"creditLedger">>): Promise<boolean> {
  const at = Date.now();
  const state = creditState(org, at);
  if (state.freeLeftMicro + state.paidMicro < a.amountMicro) return false;
  const { freeMicro, paidMicro } = splitSpend(a.amountMicro, state.freeLeftMicro);
  const balance = state.paidMicro - paidMicro;
  await ctx.db.insert("creditLedger", {
    orgId: org._id, kind: "spend", amountMicro: -a.amountMicro, freeMicro, unit: "credits", balanceAfterMicro: balance, ref: a.ref, note: a.note, at, ...row,
  });
  await ctx.db.patch(org._id, {
    creditBalanceMicro: balance, creditUnit: "credits", freeCreditsMonth: state.month, freeCreditsUsedMicro: state.usedMicro + freeMicro, updatedAt: at,
  });
  return true;
}

/**
 * Charge a research run's answers when they land, as one settled ledger row (no hold beforehand, so a balance
 * never drops for research that finds nothing). Never more than what is left of the run's cap or the workspace's
 * balance, in whole `unitMicro`s. Returns what it charged.
 */
export async function chargeLanded(ctx: MutationCtx, run: Doc<"researchRuns">, a: { ref: string; amountMicro: number; unitMicro: number; note: string }): Promise<number> {
  if (a.amountMicro <= 0 || await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first()) return 0;
  const org = await ctx.db.get(run.orgId);
  if (!org) throw new Error("workspace not found");
  const state = creditState(org, Date.now());
  const spent = run.spentMicro ?? 0;
  const room = Math.min(a.amountMicro, run.capMicro === undefined ? Infinity : run.capMicro - spent, state.freeLeftMicro + state.paidMicro);
  const charge = Math.floor(room / a.unitMicro) * a.unitMicro;
  if (charge <= 0 || !(await take(ctx, org, { ref: a.ref, amountMicro: charge, note: a.note }, { researchRunId: run._id }))) return 0;
  await ctx.db.patch(run._id, { spentMicro: spent + charge });
  return charge;
}

/**
 * Charge one action that isn't part of a run (a deal's account research on Canon's model) once it has
 * succeeded: settled at once, no hold. Repeating a `ref` charges once; false when the workspace can't pay.
 */
export const charge = internalMutation({
  args: { orgId: v.id("organizations"), ref: v.string(), amountMicro: v.number(), note: v.string() },
  handler: async (ctx, a): Promise<boolean> => {
    if (await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first()) return true;
    const org = await ctx.db.get(a.orgId);
    if (!org) throw new Error("workspace not found");
    return take(ctx, org, a, {});
  },
});

/** Move reserved credits to a provider receipt without taking the workspace's balance again. */
export const chargeHeld = internalMutation({
  args: { holdRef: v.string(), ref: v.string(), amountMicro: v.number(), note: v.string(), releaseRemainder: v.optional(v.boolean()) },
  handler: chargeHeldCredits,
});

export async function chargeHeldCredits(ctx: MutationCtx, a: { holdRef: string; ref: string; amountMicro: number; note: string; releaseRemainder?: boolean }): Promise<null> {
  if (await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first()) {
    if (a.releaseRemainder) await settleHold(ctx, { ref: a.holdRef, chargeMicro: 0 });
    return null;
  }
  const held = await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.holdRef)).first();
  if (!held || !Number.isSafeInteger(a.amountMicro) || a.amountMicro < 0) throw new Error("Invalid paid receipt or missing credit reservation.");
  const amountMicro = Math.min(a.amountMicro, held.pending ? -ledgerMicro(held) : 0);
  const shortfall = a.amountMicro - amountMicro;
  const freeMicro = Math.min(amountMicro, held.freeMicro ?? 0);
  await ctx.db.insert("creditLedger", {
    orgId: held.orgId, kind: "spend", amountMicro: -amountMicro, freeMicro, unit: "credits",
    balanceAfterMicro: held.balanceAfterMicro, ref: a.ref, note: shortfall ? `${a.note}; credit shortfall ${shortfall} micro-credits` : a.note, at: Date.now(),
  });
  if (held.pending) await ctx.db.patch(held._id, { amountMicro: ledgerMicro(held) + amountMicro, freeMicro: (held.freeMicro ?? 0) - freeMicro });
  await ctx.scheduler.runAfter(0, internal.credits.meterCharge, { ref: a.ref, provider: "treg" });
  if (a.releaseRemainder) await settleHold(ctx, { ref: a.holdRef, chargeMicro: 0 });
  return null;
}

/** Report one settled charge (credits.charge) to Metronome; safe to repeat. */
export const meterCharge = internalAction({
  args: { ref: v.string(), provider: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, a): Promise<null> => {
    const m = metronome();
    try {
      const row = await ctx.runQuery(internal.credits.chargeOf, { ref: a.ref });
      if (!m || !row || row.meteredAt !== null) return null;
      if (row.chargeCents > 0) await ingestCharges(m, [{ ref: a.ref, orgId: row.orgId, chargeCents: row.chargeCents, at: row.at, provider: a.provider, jobId: a.ref }]);
      await ctx.runMutation(internal.credits.markMetered, { refs: [a.ref] });
    } catch (error) {
      const attempt = a.attempt ?? 0;
      if (attempt < 5) await ctx.scheduler.runAfter(60_000 * 2 ** attempt, internal.credits.meterCharge, { ...a, attempt: attempt + 1 });
      throw error;
    }
    return null;
  },
});

export const chargeOf = internalQuery({
  args: { ref: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first();
    return r && !r.pending ? { orgId: r.orgId as string, chargeCents: (-ledgerMicro(r) - (r.freeMicro ?? 0)) / MICRO, at: r.at, meteredAt: r.meteredAt ?? null } : null;
  },
});

/** Turn a hold into the metered charge, returning the difference. A settled hold is left alone. */
export const settle = internalMutation({
  args: { ref: v.string(), chargeMicro: v.number() },
  handler: (ctx, a): Promise<null> => settleHold(ctx, a),
});

/** settle, inside another mutation: a research run's page is charged in the transaction that records it. */
export async function settleHold(ctx: MutationCtx, a: { ref: string; chargeMicro: number }): Promise<null> {
  const row = await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", a.ref)).first();
  if (!row?.pending) return null;
  const org = await ctx.db.get(row.orgId);
  if (!org) throw new Error("workspace not found");
  const holdMicro = -ledgerMicro(row);
  const delta = holdMicro - a.chargeMicro; // a smaller charge gives credits back
  // The hold took free credits first, so what comes back returns bought credits first, then free ones.
  // Free credits from a month that has ended expire instead of coming back.
  const held = row.freeMicro ?? 0;
  const heldPaid = holdMicro - held;
  const toPaid = delta <= 0 ? delta : Math.min(delta, heldPaid);
  const freeBack = delta <= 0 ? 0 : Math.min(delta - toPaid, held);
  const toFree = org.freeCreditsMonth === creditMonth(row.at) ? freeBack : 0;
  const balance = paidBalanceMicro(org) + toPaid;
  await ctx.db.patch(row._id, { amountMicro: -a.chargeMicro, freeMicro: held - freeBack, unit: "credits", balanceAfterMicro: balance, pending: false });
  await ctx.db.patch(row.orgId, {
    creditBalanceMicro: balance, creditUnit: "credits", ...(toFree ? { freeCreditsUsedMicro: Math.max(0, (org.freeCreditsUsedMicro ?? 0) - toFree) } : {}), updatedAt: Date.now(),
  });
  const spender: Spender | null = row.jobId ? { jobId: row.jobId } : row.researchRunId ? { researchRunId: row.researchRunId } : null;
  const budget = spender && await budgetOf(ctx, spender);
  if (budget) await budget.spend(-delta);
  return null;
}

/** A paid call's hold still pending this long after it was made died with its call: give it back. */
const STALE_HOLD_MS = 15 * 60 * 1000;

/** A spender's ledger rows that are still holds (`pending`), or settled but not yet reported to Metronome. */
function ledgerOf(ctx: QueryCtx, s: Spender, by: { pending: true } | { meteredAt: undefined }) {
  const q = ctx.db.query("creditLedger");
  if ("pending" in by) {
    return "jobId" in s
      ? q.withIndex("by_jobId_and_pending", (i) => i.eq("jobId", s.jobId).eq("pending", true))
      : q.withIndex("by_researchRunId_and_pending", (i) => i.eq("researchRunId", s.researchRunId).eq("pending", true));
  }
  return "jobId" in s
    ? q.withIndex("by_jobId_and_meteredAt", (i) => i.eq("jobId", s.jobId).eq("meteredAt", undefined))
    : q.withIndex("by_researchRunId_and_meteredAt", (i) => i.eq("researchRunId", s.researchRunId).eq("meteredAt", undefined));
}

export const staleHolds = internalQuery({
  args: { spender: spenderValidator, olderThanMs: v.optional(v.number()) },
  handler: async (ctx, a) => {
    // Only this run's outstanding holds, however long the run: a run holds a page or two at a time.
    const rows = await ledgerOf(ctx, a.spender, { pending: true }).take(200);
    return rows.filter((r) => Date.now() - r.at > (a.olderThanMs ?? STALE_HOLD_MS)).map((r) => r.ref);
  },
});

export const unmetered = internalQuery({
  args: { spender: spenderValidator },
  handler: async (ctx, a) => {
    // Only rows not yet reported: each report marks its rows, so the next read starts after them.
    const rows = await ledgerOf(ctx, a.spender, { meteredAt: undefined }).take(500);
    return rows.filter((r) => !r.pending && r.amountMicro < 0).slice(0, 100)
      .map((r) => ({ ref: r.ref, orgId: r.orgId as string, chargeCents: (-ledgerMicro(r) - (r.freeMicro ?? 0)) / MICRO, at: r.at, note: r.note ?? "" }));
  },
});

export const markMetered = internalMutation({
  args: { refs: v.array(v.string()) },
  handler: async (ctx, a) => {
    const now = Date.now();
    for (const ref of a.refs) {
      const row = await ctx.db.query("creditLedger").withIndex("by_ref", (q) => q.eq("ref", ref)).first();
      if (row) await ctx.db.patch(row._id, { meteredAt: now });
    }
    return null;
  },
});

/**
 * Report a run's settled charges to Metronome; safe to repeat (each charge's ref is its idempotency key).
 * `releaseAll`: the run has ended, so every hold still pending is given back, however recent.
 */
export const meterRun = internalAction({
  args: { spender: spenderValidator, provider: v.string(), releaseAll: v.optional(v.boolean()) },
  handler: async (ctx, a): Promise<number> => {
    // A call that never settled (its action died) is released in the workspace's favor.
    for (const ref of await ctx.runQuery(internal.credits.staleHolds, { spender: a.spender, ...(a.releaseAll ? { olderThanMs: -1 } : {}) })) {
      await ctx.runMutation(internal.credits.settle, { ref, chargeMicro: 0 });
    }
    const m = metronome();
    if (!m) return 0;
    let reported = 0;
    for (;;) {
      const batch = await ctx.runQuery(internal.credits.unmetered, { spender: a.spender });
      if (!batch.length) return reported;
      // Spend the free allowance covered isn't billing: it is marked but not reported.
      const paid = batch.filter((r) => r.chargeCents > 0);
      const runId = "jobId" in a.spender ? a.spender.jobId : a.spender.researchRunId;
      if (paid.length) await ingestCharges(m, paid.map((r) => ({ ...r, provider: a.provider, jobId: runId })));
      await ctx.runMutation(internal.credits.markMetered, { refs: batch.map((r) => r.ref) });
      reported += batch.length;
    }
  },
});

/** The old name of meterRun for a paid run: calls scheduled before the rename still arrive here. Delete once none can be pending. */
export const meterJob = internalAction({
  args: { jobId: v.id("backgroundJobs"), provider: v.string() },
  handler: (ctx, a): Promise<number> => ctx.runAction(internal.credits.meterRun, { spender: { jobId: a.jobId }, provider: a.provider }),
});
