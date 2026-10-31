/**
 * CanonCRM's own billing on Stripe (not a customer's Stripe: that is
 * convex/stripeActions.ts). One Stripe Customer per organization, which buys
 * credit packs through Checkout and sees its invoices in the Customer Portal.
 * State reaches the org only through the signed webhook (convex/http.ts),
 * never from a Checkout return page. The retired Starter subscription's
 * events are still applied so an existing one ends cleanly.
 */
import { integrationEnabled } from "./integrationsAvailable.ts";

import Stripe from "stripe";

export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/** A client on fetch, so it runs in Convex's default runtime. Null when the deployment has no key. */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_BILLING_KEY;
  if (!integrationEnabled("billing")) return null;
  return new Stripe(key!, { apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
}

/** Verify a webhook delivery's signature and parse it; throws on a bad signature or missing secret. */
export async function verifyWebhook(payload: string, signature: string): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return Stripe.webhooks.constructEventAsync(payload, signature, secret, undefined, Stripe.createSubtleCryptoProvider());
}

export type PlanTier = "free" | "starter" | "growth" | "enterprise";

/** What the org stores from a subscription. */
export type OrgBilling = {
  stripeSubscriptionId: string;
  stripeSubscriptionStatus: string;
  stripePriceId?: string;
  stripeCurrentPeriodEnd?: number;
  stripeCancelAtPeriodEnd: boolean;
  planTier: PlanTier;
};

/**
 * The plan a subscription grants. Active, trialing and past_due (Stripe is
 * still retrying the card) keep Starter; anything ended or never paid is free.
 */
export function billingFromSubscription(sub: Pick<Stripe.Subscription, "id" | "status" | "items" | "cancel_at_period_end" | "cancel_at">): OrgBilling {
  const item = sub.items.data[0];
  const paying = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  return {
    stripeSubscriptionId: sub.id,
    stripeSubscriptionStatus: sub.status,
    ...(item?.price?.id ? { stripePriceId: item.price.id } : {}),
    // Since the 2025 "basil" API versions the billing period lives on the item.
    ...(item?.current_period_end ? { stripeCurrentPeriodEnd: item.current_period_end * 1000 } : {}),
    // The portal cancels "at period end"; newer API versions express that as cancel_at.
    stripeCancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    // Starter is the only self-serve plan; growth and enterprise are set by hand.
    planTier: paying ? "starter" : "free",
  };
}

/** The subscription an invoice bills, on API versions where it moved under `parent`. */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  return typeof sub === "string" ? sub : sub?.id ?? null;
}

/** A Checkout integration label: the flow's name plus 8 random letters, as Stripe recommends. */
export function integrationIdentifier(flow: string): string {
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  return `${flow}_${letters}`;
}
