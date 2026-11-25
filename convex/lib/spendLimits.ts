import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { TREG_EMAIL_ENDPOINT } from "./emailFinder";
import { TREG_PHONE_ENDPOINT } from "./phoneFinder";
import { PAID_EMAIL_HITS_PER_MONTH, PAID_PHONE_HITS_PER_MONTH, PHONE_LOOKUPS_PER_DAY } from "./providers/registry";
import { utcMonthWindow } from "./usage";
import type { MutationCtx } from "../_generated/server";

export const ICP_DERIVATIONS_PER_DAY = 20;
export const WEBSITE_EXTRACTIONS_PER_DAY = 100;
export const DIALER_SESSIONS_PER_USER_DAY = 20;
export const DIALER_SESSIONS_PER_WORKSPACE_DAY = 100;
export const DIALER_CALLS_PER_USER_DAY = 300;
export const DIALER_CALLS_PER_WORKSPACE_DAY = 1500;
export const DAY_MS = 86_400_000;

/** Called inside the transaction that authorizes the provider work. */
export async function reserveDaily(ctx: MutationCtx, key: string, cap: number, amount = 1, now = Date.now()): Promise<boolean> {
  const windowStart = Math.floor(now / DAY_MS) * DAY_MS;
  const row = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const count = row?.windowStart === windowStart ? row.count : 0;
  if (count + amount > cap) return false;
  const values = { windowStart, count: count + amount, expiresAt: windowStart + DAY_MS };
  if (row) await ctx.db.patch(row._id, values);
  else await ctx.db.insert("moduleRateLimits", { key, ...values });
  return true;
}

export type PaidLookupReservationId = Id<"moduleRateLimits">;
export const paidLookupReservationId = v.id("moduleRateLimits");
export type PhoneLookupReservation = { limit: "daily" | "monthly" } | { reservationId: PaidLookupReservationId };

export async function reservePhoneLookupSpend(ctx: MutationCtx, orgId: string): Promise<PhoneLookupReservation> {
  const now = Date.now(), month = utcMonthWindow(now);
  const day = new Date(now).toISOString().slice(0, 10);
  const dailyKey = `phone:day:${orgId}:${day}`;
  const bucket = (key: string) => ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const daily = await bucket(dailyKey);
  const calls = !daily ? await ctx.db.query("providerCalls").withIndex("by_orgId_and_at", (q) => q.eq("orgId", orgId).gte("at", month.start)).collect() : [];
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const today = daily?.count ?? calls.filter((c) => c.endpoint === TREG_PHONE_ENDPOINT && c.at >= dayStart).length;
  if (today >= PHONE_LOOKUPS_PER_DAY) return { limit: "daily" };
  const reservationId = await reserveMonthlyLookup(ctx, orgId, TREG_PHONE_ENDPOINT, PAID_PHONE_HITS_PER_MONTH);
  if (!reservationId) return { limit: "monthly" };
  if (daily) await ctx.db.patch(daily._id, { count: today + 1 });
  else await ctx.db.insert("moduleRateLimits", { key: dailyKey, windowStart: dayStart, count: today + 1, expiresAt: month.resetsAt });
  return { reservationId };
}

async function reserveMonthlyLookup(ctx: MutationCtx, orgId: string, endpoint: string, cap: number): Promise<PaidLookupReservationId | null> {
  const month = utcMonthWindow(Date.now());
  const key = `lookup:month:${endpoint}:${orgId}:${month.start}`;
  const bucket = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const calls = bucket ? [] : await ctx.db.query("providerCalls").withIndex("by_orgId_and_at", (q) => q.eq("orgId", orgId).gte("at", month.start)).collect();
  const count = bucket?.count ?? calls.filter((c) => c.endpoint === endpoint && c.outcome === "hit").length;
  if (count >= cap) return null;
  if (bucket) await ctx.db.patch(bucket._id, { count: count + 1 });
  else await ctx.db.insert("moduleRateLimits", { key, windowStart: month.start, count: count + 1, expiresAt: month.resetsAt });
  return ctx.db.insert("moduleRateLimits", { key: `${key}:reservation:${crypto.randomUUID()}`, windowStart: month.start, count: 1, expiresAt: month.resetsAt });
}

export function reservePaidEmailLookupSpend(ctx: MutationCtx, orgId: string): Promise<PaidLookupReservationId | null> {
  return reserveMonthlyLookup(ctx, orgId, TREG_EMAIL_ENDPOINT, PAID_EMAIL_HITS_PER_MONTH);
}

export async function settlePaidLookupSpend(ctx: MutationCtx, reservationId: PaidLookupReservationId, hit: boolean): Promise<void> {
  const reservation = await ctx.db.get(reservationId);
  if (!reservation || reservation.count !== 1 || !reservation.key.startsWith("lookup:month:") || !reservation.key.includes(":reservation:")) return;
  if (!hit) {
    const key = reservation.key.split(":reservation:")[0];
    const monthly = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (monthly) await ctx.db.patch(monthly._id, { count: Math.max(0, monthly.count - 1) });
  }
  await ctx.db.patch(reservationId, { count: 0 });
}
