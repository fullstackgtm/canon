import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { billingFromSubscription, invoiceSubscriptionId, verifyWebhook } from "../convex/lib/stripeBilling.ts";

const sub = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: "sub_1", status, cancel_at_period_end: false, cancel_at: null, items: { data: [{ price: { id: "price_1" }, current_period_end: 1_800_000_000 }] }, ...extra }) as unknown as Stripe.Subscription;

test("a subscription's status decides the plan; its period end and cancellation come along", () => {
  assert.deepEqual(billingFromSubscription(sub("active")), {
    stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePriceId: "price_1",
    stripeCurrentPeriodEnd: 1_800_000_000_000, stripeCancelAtPeriodEnd: false, planTier: "starter",
  });
  assert.equal(billingFromSubscription(sub("past_due")).planTier, "starter", "Stripe is still retrying the card");
  for (const ended of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) assert.equal(billingFromSubscription(sub(ended)).planTier, "free", ended);
  assert.equal(billingFromSubscription(sub("active", { cancel_at: 1_800_000_000 })).stripeCancelAtPeriodEnd, true);
  assert.equal(invoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_9" } } } as unknown as Stripe.Invoice), "sub_9");
});

test("only a delivery signed with the webhook secret is accepted", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: {} } });
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_test_secret" });
  assert.equal((await verifyWebhook(payload, header)).type, "invoice.paid");
  const forged = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_other" });
  await assert.rejects(verifyWebhook(payload, forged));
});
