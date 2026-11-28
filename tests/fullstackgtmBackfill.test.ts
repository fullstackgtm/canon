import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStripeBackfillPlan } from "../engine/src/backfill.ts";
import type { RevenueContract, StripeRevenueInvoice } from "../engine/src/revenueContracts.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload } from "../engine/src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures

function contract(overrides: Partial<RevenueContract> = {}): RevenueContract {
  return {
    stripeSubscriptionId: "sub_1",
    customerId: "cus_1",
    customerName: "Globex Billing",
    customerEmail: "hank@globex.com",
    customerDomain: "globex.com",
    status: "active",
    stripeStatus: "active",
    startDate: "2026-01-01",
    currency: "USD",
    mrr: 1500,
    arr: 18000,
    billingInterval: "month",
    lines: [{ priceId: "price_1", product: "Pro", quantity: 1, unitAmount: 1500, interval: "month" }],
    invoiceIds: ["in_1", "in_2", "in_3"],
    billed: 4500,
    collected: 4500,
    outstanding: 0,
    ...overrides,
  };
}

function crmSnapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    provider: "hubspot",
    users: [],
    accounts: [
      {
        id: "a1",
        provider: "hubspot",
        crmId: "a1",
        identities: [{ provider: "hubspot", externalId: "a1" }],
        name: "Globex",
        // The snapshot's domain is messier than Stripe's — normalizeDomain
        // must collapse both sides before comparing.
        domain: "https://www.globex.com/",
      },
      {
        id: "a2",
        provider: "hubspot",
        crmId: "a2",
        identities: [{ provider: "hubspot", externalId: "a2" }],
        name: "Initech",
        // No domain — reachable only by exact name match.
      },
    ],
    contacts: [],
    deals: [
      {
        id: "d1",
        provider: "hubspot",
        crmId: "d1",
        identities: [{ provider: "hubspot", externalId: "d1" }],
        name: "Globex Billing — Pro (sub_7)",
        isClosed: true,
        isWon: true,
      },
    ],
    activities: [],
  };
}

const NOW = () => new Date("2026-07-02T00:00:00.000Z");

// ---------------------------------------------------------------------------
// buildStripeBackfillPlan: one booking per subscription

test("backfill: a subscription becomes ONE closed-won booking (start date, monthly amount, open ended)", () => {
  const result = buildStripeBackfillPlan([contract()], crmSnapshot(), { now: NOW });

  assert.equal(result.counts.planned, 1);
  assert.equal(result.counts.invoicesCovered, 3);
  assert.equal(result.plan.operations.length, 1, "three invoices, one deal");
  assert.match(result.plan.id, /^patch_plan_backfill_[0-9a-f]{8}$/);
  assert.equal(result.plan.status, "needs_approval");
  assert.equal(result.plan.dryRun, true);

  const op = result.plan.operations[0];
  assert.equal(op.operation, "create_record");
  assert.equal(op.objectType, "deal");
  assert.equal(op.objectId, "create:stripe:subscription:sub_1");
  assert.equal(op.approvalRequired, true);
  assert.equal(op.sourceRuleOrPolicy, "backfill:stripe:subscriptions");
  assert.match(op.reason, /1500 USD per month from 2026-01-01, open ended/);
  assert.match(op.reason, /3 invoice\(s\)/);

  const payload = op.afterValue as CreateRecordPayload;
  assert.equal(payload.matchKey, "stripe_subscription_id");
  assert.equal(payload.matchValue, "sub_1");
  assert.equal(payload.dealStage, "closed_won");
  assert.equal(payload.properties.dealname, "Globex Billing — Pro (sub_1)");
  assert.equal(payload.properties.amount, "1500");
  assert.equal(payload.properties.closedate, "2026-01-01");
  assert.match(payload.properties.description, /not separate deals/);
  assert.equal(payload.associateCompanyName, "Globex");
  assert.equal(payload.associateCompanyDomain, "globex.com");

  const evidence = result.plan.evidence![0];
  assert.deepEqual(op.evidenceIds, [evidence.id]);
  assert.equal(evidence.sourceObjectId, "sub_1");
  assert.deepEqual(evidence.metadata?.invoiceIds, ["in_1", "in_2", "in_3"]);
});

test("backfill: an ended contract carries its end date; a metered one leaves the amount blank", () => {
  const ended = buildStripeBackfillPlan([contract({ endDate: "2026-06-30", stripeStatus: "canceled", status: "ended" })], crmSnapshot(), { now: NOW });
  assert.match(ended.plan.operations[0].reason, /from 2026-01-01 to 2026-06-30/);
  const metered = buildStripeBackfillPlan([contract({ mrr: undefined, arr: undefined })], crmSnapshot(), { now: NOW });
  const payload = metered.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal("amount" in payload.properties, false);
  assert.match(metered.plan.operations[0].reason, /unknown \(metered\)/);
});

test("backfill: invoices with no subscription are listed for review, never booked", () => {
  const loose: StripeRevenueInvoice = { id: "in_x", customerName: "Globex Billing", amountDue: 900, amountPaid: 900, amountRemaining: 0, status: "paid" };
  const result = buildStripeBackfillPlan([], crmSnapshot(), { now: NOW, unattachedInvoices: [loose] });
  assert.equal(result.plan.operations.length, 0);
  assert.equal(result.counts.unattachedInvoices, 1);
  assert.deepEqual(result.unattachedInvoices.map((i) => i.id), ["in_x"]);
  assert.match(result.plan.summary, /1 invoice\(s\) with no subscription listed for review, not booked/);
});

test("backfill: customer with no email domain falls back to exact case-insensitive name match", () => {
  const result = buildStripeBackfillPlan(
    [contract({ stripeSubscriptionId: "sub_9", customerName: "  INITECH ", customerDomain: undefined, customerEmail: undefined })],
    crmSnapshot(),
    { now: NOW },
  );
  const payload = result.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal(payload.associateCompanyName, "Initech");
  assert.equal(payload.associateCompanyDomain, undefined);
});

test("backfill: unmatched customer gets ONE proposed account op, however many subscriptions", () => {
  const stranger = { customerId: "cus_2", customerName: "Stranger LLC", customerDomain: "stranger.io" };
  const result = buildStripeBackfillPlan(
    [contract(), contract({ ...stranger, stripeSubscriptionId: "sub_2" }), contract({ ...stranger, stripeSubscriptionId: "sub_3" })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.planned, 3);
  assert.equal(result.counts.accountsProposed, 1);
  assert.deepEqual(result.proposedAccounts, [{ name: "Stranger LLC", domain: "stranger.io", contractCount: 2 }]);
  const accountOp = result.plan.operations.find((op) => op.objectType === "account")!;
  assert.equal(accountOp.objectId, "create:stripe:customer:cus_2");
  const dealOp = result.plan.operations.find((op) => (op.afterValue as CreateRecordPayload).matchValue === "sub_2")!;
  assert.match(dealOp.reason, /NEW account "Stranger LLC" \(created by this plan\)/);
});

test("backfill: freemail billing domains are never used as a company domain", () => {
  const result = buildStripeBackfillPlan(
    [contract({ stripeSubscriptionId: "sub_4", customerId: "cus_9", customerName: "Jane Consulting", customerEmail: "jane@gmail.com", customerDomain: "gmail.com" })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.deepEqual(result.proposedAccounts, [{ name: "Jane Consulting", contractCount: 1 }]);
  const dealPayload = result.plan.operations.find((op) => op.objectType === "deal")!.afterValue as CreateRecordPayload;
  assert.equal(dealPayload.associateCompanyDomain, undefined);
});

test("backfill: no usable identity stays report-only; createMissingAccounts=false reports unmatched", () => {
  const anonymous = buildStripeBackfillPlan(
    [contract({ stripeSubscriptionId: "sub_5", customerName: undefined, customerEmail: "x@gmail.com", customerDomain: "gmail.com" })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(anonymous.plan.operations.length, 0);
  assert.equal(anonymous.counts.unmatched, 1);

  const conservative = buildStripeBackfillPlan(
    [contract(), contract({ stripeSubscriptionId: "sub_2", customerName: "Stranger LLC", customerDomain: "stranger.io", mrr: 42, currency: "EUR", startDate: "2026-03-01" })],
    crmSnapshot(),
    { now: NOW, createMissingAccounts: false },
  );
  assert.equal(conservative.plan.operations.length, 1);
  assert.deepEqual(conservative.unmatched[0], {
    subscriptionId: "sub_2",
    customerName: "Stranger LLC",
    customerDomain: "stranger.io",
    mrr: 42,
    currency: "EUR",
    startDate: "2026-03-01",
  });
  assert.match(conservative.plan.summary, /account creation disabled/);
});

test("backfill: plan-time prefilter skips a subscription whose deal already exists", () => {
  const result = buildStripeBackfillPlan([contract({ stripeSubscriptionId: "sub_7" })], crmSnapshot(), { now: NOW });
  assert.equal(result.counts.alreadyInCrm, 1);
  assert.equal(result.plan.operations.length, 0);
  assert.equal(result.plan.status, "draft");
});

test("backfill: pipeline and matchProperty flow into the payload; op ids are stable per subscription", () => {
  const result = buildStripeBackfillPlan([contract()], crmSnapshot(), { now: NOW, pipeline: "Renewals", matchProperty: "billing_ref" });
  const payload = result.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal(payload.dealPipeline, "Renewals");
  assert.equal(payload.matchKey, "billing_ref");
  const later = buildStripeBackfillPlan([contract({ invoiceIds: ["in_1", "in_2", "in_3", "in_4"] })], crmSnapshot(), { now: () => new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(result.plan.operations[0].id, later.plan.operations[0].id, "a new invoice does not change the booking op");
});

// ---------------------------------------------------------------------------
// CLI: `backfill stripe` end to end (stubbed Stripe, snapshot from --input)

const MONTH = 2678400;
function stripeRevenueFetchStub(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (data: unknown[]) =>
      new Response(JSON.stringify({ data, has_more: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/v1/subscriptions")) {
      return json([
        {
          id: "sub_1",
          status: "active",
          start_date: 1767225600, // 2026-01-01
          currency: "usd",
          customer: { id: "cus_1", name: "Globex Billing", email: "hank@globex.com" },
          items: { data: [{ quantity: 1, price: { id: "price_1", unit_amount: 150000, nickname: "Pro", recurring: { interval: "month", interval_count: 1 } } }] },
        },
        {
          id: "sub_2",
          status: "active",
          start_date: 1769904000, // 2026-02-01
          currency: "usd",
          customer: { id: "cus_2", name: "Stranger LLC", email: "sam@stranger.io" },
          items: { data: [{ quantity: 2, price: { id: "price_2", unit_amount: 1200000, nickname: "Annual", recurring: { interval: "year", interval_count: 1 } } }] },
        },
      ]);
    }
    if (url.includes("/v1/invoices")) {
      const monthly = [0, 1, 2].map((n) => ({
        id: `in_${n + 1}`,
        number: `INV-00${n + 1}`,
        subscription: "sub_1",
        status: "paid",
        amount_due: 150000,
        amount_paid: 150000,
        amount_remaining: 0,
        currency: "usd",
        created: 1767225600 + n * MONTH,
        customer: { id: "cus_1", name: "Globex Billing", email: "hank@globex.com" },
        status_transitions: { paid_at: 1767225600 + n * MONTH },
      }));
      return json([
        ...monthly,
        { id: "in_9", number: "INV-0099", status: "paid", amount_due: 5000, amount_paid: 5000, amount_remaining: 0, currency: "usd", created: 1767225600, customer: { id: "cus_1", name: "Globex Billing", email: "hank@globex.com" } },
      ]);
    }
    return new Response("no stub", { status: 404 });
  }) as typeof fetch;
}

async function withBackfillCliEnv<T>(run: (home: string, snapPath: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-backfill-"));
  const snapPath = join(home, "snapshot.json");
  writeFileSync(snapPath, JSON.stringify(crmSnapshot()));
  const prevHome = process.env.FSGTM_HOME;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const origFetch = globalThis.fetch;
  process.env.FSGTM_HOME = home;
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  globalThis.fetch = stripeRevenueFetchStub();
  try {
    return await run(home, snapPath);
  } finally {
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
}

async function captureCli(argv: string[]): Promise<{ out: string; err: string }> {
  const { runCli } = await import("../engine/src/cli.ts");
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("backfill stripe CLI: --json books one deal per subscription, never per invoice", async () => {
  await withBackfillCliEnv(async (home, snapPath) => {
    const { out } = await captureCli(["backfill", "stripe", "--input", snapPath, "--json"]);
    const payload = JSON.parse(out) as {
      plan: { id: string; operations: Array<{ objectType: string; afterValue: CreateRecordPayload }> };
      counts: { planned: number; accountsProposed: number; invoicesCovered: number; unattachedInvoices: number };
      unattachedInvoices: Array<{ id: string }>;
      proposedAccounts: Array<{ name: string; contractCount: number }>;
    };
    assert.equal(payload.counts.planned, 2, "two subscriptions, four invoices, two bookings");
    assert.equal(payload.counts.invoicesCovered, 3);
    assert.equal(payload.counts.accountsProposed, 1);
    assert.deepEqual(payload.unattachedInvoices.map((i) => i.id), ["in_9"]);
    const deals = payload.plan.operations.filter((op) => op.objectType === "deal");
    assert.deepEqual(deals.map((op) => [op.afterValue.matchValue, op.afterValue.properties.amount, op.afterValue.properties.closedate]), [
      ["sub_1", "1500", "2026-01-01"],
      ["sub_2", "2000", "2026-02-01"],
    ]);
    assert.equal(existsSync(join(home, "plans", `${payload.plan.id}.json`)), false);
  });
});

test("backfill stripe CLI: --verbose lists proposed accounts and loose invoices; --skip-unmatched reports", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    const { out, err } = await captureCli(["backfill", "stripe", "--input", snapPath, "--verbose"]);
    assert.match(out, /Proposed new accounts \(1\)/);
    assert.match(out, /Invoices with no subscription \(1\)/);
    assert.match(out, /INV-0099/);
    assert.match(err, /Dry run — nothing written/);
    const skipped = await captureCli(["backfill", "stripe", "--input", snapPath, "--skip-unmatched", "--verbose"]);
    assert.match(skipped.out, /Unmatched subscriptions \(1\)/);
    assert.match(skipped.out, /sub_2/);
  });
});

test("backfill stripe CLI: --save persists the plan; --since keeps contracts started on/after it", async () => {
  await withBackfillCliEnv(async (home, snapPath) => {
    const { err } = await captureCli(["backfill", "stripe", "--input", snapPath, "--save"]);
    const match = err.match(/Saved plan (patch_plan_backfill_[0-9a-f]{8})/);
    assert.ok(match, `expected a saved-plan line, got: ${err}`);
    const stored = JSON.parse(readFileSync(join(home, "plans", `${match![1]}.json`), "utf8")) as { plan: { status: string; operations: unknown[] } };
    assert.equal(stored.plan.status, "needs_approval");
    assert.equal(stored.plan.operations.length, 3);

    const { out } = await captureCli(["backfill", "stripe", "--input", snapPath, "--since", "2026-01-15", "--json"]);
    const since = JSON.parse(out) as { counts: { planned: number } };
    assert.equal(since.counts.planned, 1);
  });
});

test("backfill CLI: unknown subcommand and missing Stripe key fail with actionable errors", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    await assert.rejects(captureCli(["backfill", "shopify"]), /Unknown backfill subcommand: shopify/);
    const prevKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await assert.rejects(
        captureCli(["backfill", "stripe", "--input", snapPath]),
        /No Stripe credentials/,
      );
    } finally {
      process.env.STRIPE_SECRET_KEY = prevKey;
    }
  });
});

test("backfill is wired into help and the capabilities contract as write-shaped", async () => {
  const { out } = await captureCli(["help", "backfill"]);
  assert.match(out, /fullstackgtm backfill — /);
  assert.match(out, /Lifecycle phase: Remediate/);

  const { out: caps } = await captureCli(["capabilities"]);
  const payload = JSON.parse(caps) as { commands: Array<{ name: string; access: string }> };
  const entry = payload.commands.find((command) => command.name === "backfill");
  assert.ok(entry, "capabilities lists backfill");
  assert.equal(entry!.access, "write-shaped");
});
