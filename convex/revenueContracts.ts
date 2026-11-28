import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireUnrestricted } from "./permissions";

/**
 * Revenue contracts mirrored from Stripe (docs/revenue-contracts.md): one
 * contract per subscription, each invoice attached to its contract. Written
 * only by the read-only Stripe import (stripeActions.importRevenue); keyed by
 * Stripe ids so re-importing is an idempotent upsert. Deals are never created
 * here; bookings go through the governed backfill plan.
 */

const line = v.object({
  priceId: v.optional(v.string()),
  product: v.optional(v.string()),
  quantity: v.number(),
  unitAmount: v.optional(v.number()),
  interval: v.optional(v.string()),
  intervalCount: v.optional(v.number()),
});

const contractArg = v.object({
  stripeSubscriptionId: v.string(),
  stripeCustomerId: v.optional(v.string()),
  customerName: v.optional(v.string()),
  customerEmail: v.optional(v.string()),
  customerDomain: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("canceled"), v.literal("ended"), v.literal("pending")),
  stripeStatus: v.string(),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
  currency: v.optional(v.string()),
  mrr: v.optional(v.number()),
  arr: v.optional(v.number()),
  billingInterval: v.optional(v.string()),
  lines: v.array(line),
  billed: v.number(),
  collected: v.number(),
  outstanding: v.number(),
  invoiceCount: v.number(),
  firstInvoiceAt: v.optional(v.string()),
  lastInvoiceAt: v.optional(v.string()),
});

const invoiceArg = v.object({
  stripeInvoiceId: v.string(),
  stripeSubscriptionId: v.optional(v.string()),
  stripeCustomerId: v.optional(v.string()),
  customerName: v.optional(v.string()),
  customerDomain: v.optional(v.string()),
  number: v.optional(v.string()),
  status: v.optional(v.string()),
  amountDue: v.number(),
  amountPaid: v.number(),
  amountRemaining: v.number(),
  currency: v.optional(v.string()),
  periodStart: v.optional(v.string()),
  periodEnd: v.optional(v.string()),
  dueDate: v.optional(v.string()),
  paidAt: v.optional(v.string()),
  createdDate: v.optional(v.string()),
  hostedInvoiceUrl: v.optional(v.string()),
});

/** Upsert one batch of contracts (call before their invoices). */
export const upsertContractsInternal = internalMutation({
  args: { orgId: v.id("organizations"), contracts: v.array(contractArg), importedAt: v.number() },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    for (const contract of args.contracts) {
      const existing = await ctx.db
        .query("revenueContracts")
        .withIndex("by_orgId_and_stripeSubscriptionId", (q) =>
          q.eq("orgId", args.orgId).eq("stripeSubscriptionId", contract.stripeSubscriptionId),
        )
        .unique();
      const row = { ...contract, orgId: args.orgId, source: "stripe" as const, importedAt: args.importedAt };
      if (existing) {
        await ctx.db.replace("revenueContracts", existing._id, row);
        updated += 1;
      } else {
        await ctx.db.insert("revenueContracts", row);
        inserted += 1;
      }
    }
    return { inserted, updated };
  },
});

/** Upsert one batch of invoices, attaching each to its subscription's contract. */
export const upsertInvoicesInternal = internalMutation({
  args: { orgId: v.id("organizations"), invoices: v.array(invoiceArg), importedAt: v.number() },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    for (const invoice of args.invoices) {
      const contract = invoice.stripeSubscriptionId
        ? await ctx.db
            .query("revenueContracts")
            .withIndex("by_orgId_and_stripeSubscriptionId", (q) =>
              q.eq("orgId", args.orgId).eq("stripeSubscriptionId", invoice.stripeSubscriptionId!),
            )
            .unique()
        : null;
      const existing = await ctx.db
        .query("revenueInvoices")
        .withIndex("by_orgId_and_stripeInvoiceId", (q) =>
          q.eq("orgId", args.orgId).eq("stripeInvoiceId", invoice.stripeInvoiceId),
        )
        .unique();
      const row = {
        ...invoice,
        orgId: args.orgId,
        source: "stripe" as const,
        importedAt: args.importedAt,
        ...(contract ? { contractId: contract._id } : {}),
      };
      if (existing) {
        await ctx.db.replace("revenueInvoices", existing._id, row);
        updated += 1;
      } else {
        await ctx.db.insert("revenueInvoices", row);
        inserted += 1;
      }
    }
    return { inserted, updated };
  },
});

/** Contracts for the workspace, newest start first, with totals. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUnrestricted(ctx, "revenue contracts");
    const contracts = await ctx.db
      .query("revenueContracts")
      .withIndex("by_orgId_and_stripeSubscriptionId", (q) => q.eq("orgId", user.orgId))
      .take(500);
    const unattached = await ctx.db
      .query("revenueInvoices")
      .withIndex("by_orgId_and_stripeInvoiceId", (q) => q.eq("orgId", user.orgId))
      .take(2000);
    return {
      contracts: contracts.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "")),
      unattachedInvoices: unattached.filter((invoice) => !invoice.contractId),
    };
  },
});

/** One contract's invoices, newest first. */
export const invoices = query({
  args: { contractId: v.id("revenueContracts") },
  handler: async (ctx, args) => {
    const user = await requireUnrestricted(ctx, "revenue contracts");
    const contract = await ctx.db.get("revenueContracts", args.contractId);
    if (!contract || contract.orgId !== user.orgId) return [];
    const rows = await ctx.db
      .query("revenueInvoices")
      .withIndex("by_contractId", (q) => q.eq("contractId", args.contractId))
      .take(500);
    return rows.sort((a, b) => (b.periodStart ?? b.createdDate ?? "").localeCompare(a.periodStart ?? a.createdDate ?? ""));
  },
});
