import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Webhook } from "svix";
import { mapClerkRole } from "./lib/clerkRoles";
import { bearerMatches, parseOrgParam, parseStreamParams, parseTailParams } from "./lib/objects/tail";
import { registerAgentWebhookRoutes } from "./lib/agents/webhookRoute";
import { registerLinkedinRoutes } from "./lib/linkedin/routes";
import { registerDialerRoutes } from "./lib/dialer/routes";
import { registerEmailLogRoutes } from "./lib/emailLog/routes";
import { registerModuleUploadRoute } from "./lib/modules/uploadRoute";
import { registerPiRoute } from "./lib/research/piRoute";
import { registerConnectorWebhookRoutes } from "./lib/connectors/webhookRoute";
import { registerUnsubscribeRoute } from "./lib/outbound/unsubscribeRoute";
import { billingFromSubscription, invoiceSubscriptionId, stripeClient, verifyWebhook } from "./lib/stripeBilling";

const http = httpRouter();
registerPiRoute(http);

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const event = await verifyClerkWebhook(request);
    if (!event) {
      return new Response("Invalid signature", { status: 401 });
    }

    switch (event.type) {
      case "user.created":
      case "user.updated": {
        // Users only exist in Convex once they have an org membership.
        // For users without a Convex row yet, organizationMembership.created handles insert.
        await ctx.runMutation(internal.users.patchFromClerk, {
          clerkUserId: event.data.id,
          email: primaryEmail(event.data),
          name: fullName(event.data),
          imageUrl: event.data.image_url ?? undefined,
        });
        break;
      }

      case "user.deleted": {
        if (!event.data.id) break;
        await ctx.runMutation(internal.users.deactivateFromClerk, {
          clerkUserId: event.data.id,
        });
        break;
      }

      case "organization.created":
      case "organization.updated": {
        await ctx.runMutation(internal.organizations.upsertFromClerk, {
          clerkOrgId: event.data.id,
          name: event.data.name,
          slug: event.data.slug ?? event.data.id,
        });
        break;
      }

      case "organizationMembership.created":
      case "organizationMembership.updated": {
        // Ensure org row exists before inserting user — orgId is required.
        await ctx.runMutation(internal.organizations.upsertFromClerk, {
          clerkOrgId: event.data.organization.id,
          name: event.data.organization.name,
          slug: event.data.organization.slug ?? event.data.organization.id,
        });

        const pud = event.data.public_user_data;
        const name =
          [pud.first_name, pud.last_name].filter(Boolean).join(" ") ||
          pud.identifier;

        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkUserId: pud.user_id,
          clerkOrgId: event.data.organization.id,
          email: pud.identifier,
          name,
          imageUrl: pud.image_url ?? undefined,
          role: mapClerkRole(event.data.role),
        });
        break;
      }

      case "organizationMembership.deleted": {
        await ctx.runMutation(internal.users.removeMembershipFromClerk, {
          clerkUserId: event.data.public_user_data.user_id,
          clerkOrgId: event.data.organization.id,
        });
        break;
      }

      default:
        break;
    }

    return new Response("OK", { status: 200 });
  }),
});

http.route({
  path: "/api/hubspot/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    const redirectBase = `${(
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
    ).replace(/\/$/, "")}/dashboard/integrations`;

    if (error) {
      return Response.redirect(
        `${redirectBase}?error=hubspot_oauth_failed&message=${encodeURIComponent(
          errorDescription || error,
        )}`,
        302,
      );
    }

    if (!code || !state) {
      return Response.redirect(`${redirectBase}?error=invalid_callback`, 302);
    }

    try {
      const result = await ctx.runAction(api.hubspotActions.exchangeCode, {
        code,
        state,
      });

      if ("error" in result) {
        return Response.redirect(`${redirectBase}?error=${result.error}`, 302);
      }

      if (result.cliLogin) {
        const siteBase = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
        return Response.redirect(`${siteBase}/oauth/hubspot?connected=1`, 302);
      }

      return Response.redirect(`${redirectBase}?connected=hubspot`, 302);
    } catch (e) {
      console.error("HubSpot OAuth callback error:", e);
      return Response.redirect(`${redirectBase}?error=hubspot_oauth_failed`, 302);
    }
  }),
});

http.route({
  path: "/api/salesforce/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    const redirectBase = `${(
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
    ).replace(/\/$/, "")}/dashboard/integrations`;

    if (error) {
      return Response.redirect(
        `${redirectBase}?error=salesforce_oauth_failed&message=${encodeURIComponent(
          errorDescription || error,
        )}`,
        302,
      );
    }

    if (!code || !state) {
      return Response.redirect(`${redirectBase}?error=invalid_callback`, 302);
    }

    try {
      const result = await ctx.runAction(api.salesforceActions.exchangeCode, {
        code,
        state,
      });

      if ("error" in result) {
        return Response.redirect(`${redirectBase}?error=${result.error}`, 302);
      }

      if (result.cliLogin) {
        const siteBase = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
        return Response.redirect(`${siteBase}/oauth/salesforce?connected=1`, 302);
      }

      return Response.redirect(`${redirectBase}?connected=salesforce`, 302);
    } catch (e) {
      console.error("Salesforce OAuth callback error:", e);
      return Response.redirect(
        `${redirectBase}?error=salesforce_oauth_failed`,
        302,
      );
    }
  }),
});

async function verifyClerkWebhook(request: Request): Promise<ClerkEvent | null> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("CLERK_WEBHOOK_SECRET not set in Convex env");
    return null;
  }

  const payload = await request.text();
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) return null;

  try {
    const wh = new Webhook(secret);
    return wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkEvent;
  } catch {
    return null;
  }
}

function primaryEmail(data: ClerkUserData): string {
  const primary =
    data.email_addresses?.find((e) => e.id === data.primary_email_address_id) ??
    data.email_addresses?.[0];
  return primary?.email_address ?? "";
}

function fullName(data: ClerkUserData): string {
  return (
    [data.first_name, data.last_name].filter(Boolean).join(" ") ||
    data.username ||
    primaryEmail(data)
  );
}

// Minimal local shapes — avoid importing @clerk/nextjs/server (Node-only).
type ClerkEvent =
  | { type: "user.created" | "user.updated"; data: ClerkUserData }
  | { type: "user.deleted"; data: { id?: string } }
  | {
      type: "organization.created" | "organization.updated";
      data: { id: string; name: string; slug?: string };
    }
  | {
      type:
        | "organizationMembership.created"
        | "organizationMembership.updated";
      data: {
        role: string;
        organization: { id: string; name: string; slug?: string };
        public_user_data: ClerkPublicUserData;
      };
    }
  | {
      type: "organizationMembership.deleted";
      data: {
        organization: { id: string; name: string; slug?: string };
        public_user_data: ClerkPublicUserData;
      };
    };

type ClerkUserData = {
  id: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
};

type ClerkPublicUserData = {
  user_id: string;
  identifier: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
};

// WS3: record-service change-feed webhook. The record service POSTs outbox
// batches ({ws, changes, lastSeq}) here. v1 authenticates with the shared
// RECORD_SERVICE_TOKEN and acknowledges; consumers (CRM write-back, alerts)
// subscribe in a later workstream.
http.route({
  path: "/record-service/changes",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    const expected = process.env.RECORD_SERVICE_TOKEN;
    if (!expected) return new Response("Record service webhook not configured", { status: 503 });
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${expected}`) return new Response("Unauthorized", { status: 401 });
    let body: { lastSeq?: unknown; changes?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const lastSeq = typeof body.lastSeq === "number" ? body.lastSeq : null;
    const received = Array.isArray(body.changes) ? body.changes.length : 0;
    return Response.json({ ok: true, received, ackSeq: lastSeq });
  }),
});

// CanonCRM's own billing (convex/billing.ts) and credit packs (convex/credits.ts). Stripe signs every delivery;
// an unverified one is refused. Subscription state is always re-read from
// Stripe, so retries and out-of-order events converge on the latest state.
// A 5xx makes Stripe retry; events that don't touch a subscription are acked.
http.route({
  path: "/stripe/billing-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const stripe = stripeClient();
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return new Response("Billing webhook not configured", { status: 503 });
    let event;
    try {
      event = await verifyWebhook(await request.text(), request.headers.get("stripe-signature") ?? "");
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }
    // The endpoint's API version can differ from the SDK's (it is fixed when the endpoint is
    // created), so read nothing from the event body but the object's id: re-fetch it pinned.
    const objectId = (event.data.object as { id?: string }).id;
    let subscriptionId: string | null = null;
    if (objectId && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")) {
      const session = await stripe.checkout.sessions.retrieve(objectId);
      if (session.mode === "payment") {
        // A credit pack: granted once paid (convex/credits.ts), keyed by the session.
        await ctx.runAction(internal.credits.fulfillCheckout, { sessionId: session.id });
        return Response.json({ received: true });
      }
      if (session.mode === "subscription" && session.payment_status !== "unpaid") {
        subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
      }
    } else if (objectId && event.type.startsWith("customer.subscription.")) {
      subscriptionId = objectId;
    } else if (objectId && (event.type === "invoice.paid" || event.type === "invoice.payment_failed")) {
      subscriptionId = invoiceSubscriptionId(await stripe.invoices.retrieve(objectId));
    }
    if (!subscriptionId) return Response.json({ received: true });
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const known = await ctx.runMutation(internal.billing.applySubscription, { stripeCustomerId: customer, ...billingFromSubscription(sub) });
    if (!known) console.warn(`stripe billing: ${event.type} for customer ${customer}, which no workspace owns`);
    return Response.json({ received: true });
  }),
});

// CP1f: the ledger feed the record service's projector pulls
// (docs/cp0-object-layer.md, migration step 6). Bearer RECORD_SERVICE_TOKEN,
// the secret Convex already shares with the service, compared in constant
// time and never logged. Every read is bounded.
type FeedResult = { ok: true; body: unknown } | { ok: false; status: number; error: string };
function ledgerFeedRoute(path: string, read: (ctx: ActionCtx, params: URLSearchParams) => Promise<FeedResult>) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const expected = process.env.RECORD_SERVICE_TOKEN;
      if (!expected) return Response.json({ error: "ledger feed not configured" }, { status: 503 });
      if (!(await bearerMatches(request.headers.get("authorization"), expected))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const out = await read(ctx, new URL(request.url).searchParams);
      return out.ok ? Response.json(out.body) : Response.json({ error: out.error }, { status: out.status });
    }),
  });
}
const found = (body: unknown): FeedResult => (body ? { ok: true, body } : { ok: false, status: 404, error: "not found" });

ledgerFeedRoute("/ledger/tail", async (ctx, params) => {
  const p = parseTailParams(params);
  return p.ok ? found(await ctx.runQuery(internal.ledgerFeed.tail, p.value)) : { ok: false, status: 400, error: p.error };
});
ledgerFeedRoute("/ledger/heads", async (ctx, params) => {
  const p = parseOrgParam(params);
  return p.ok ? found(await ctx.runQuery(internal.ledgerFeed.heads, p.value)) : { ok: false, status: 400, error: p.error };
});
ledgerFeedRoute("/ledger/stream", async (ctx, params) => {
  const p = parseStreamParams(params);
  return p.ok ? found(await ctx.runQuery(internal.ledgerFeed.stream, p.value)) : { ok: false, status: 400, error: p.error };
});

// Operator GitHub App: identity proof callbacks and BugDrop intake webhook.


// Event agents' signed webhook trigger (convex/agentTurns.ts).
registerAgentWebhookRoutes(http);

// LinkedIn connect callback and Unipile account-status webhook (docs/linkedin-cadences.md).
registerLinkedinRoutes(http);

// Telnyx's signed Call Control webhook for the dialer (docs/dialer.md).
registerDialerRoutes(http);
// Email a member logs by BCC or forward, from each inbound adapter (convex/emailLog.ts).
registerEmailLogRoutes(http);
// Module file uploads (docs/modules.md, "Files"): a person's ticket, stored and recorded in one step.
registerModuleUploadRoute(http);

// Signed webhooks that write the workspace's webhook.events feed (docs/connector-feeds.md).
registerConnectorWebhookRoutes(http);
registerUnsubscribeRoute(http);

export default http;
