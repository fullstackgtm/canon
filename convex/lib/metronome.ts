import { integrationEnabled } from "./integrationsAvailable.ts";
/**
 * Metronome, the billing record for prepaid credits ("Metronome with Stripe
 * Subscriptions": Stripe keeps the Starter subscription and takes the pack
 * payments; Metronome holds each workspace's commits and rates its usage).
 * Our own ledger (convex/credits.ts) enforces spend in real time; Metronome's
 * balance lags by about 30 s and is reconciled against it.
 *
 * The catalog (metric, products, rate card) is looked up by name; it must
 * exist before any usage is sent, or Metronome silently drops the events.
 * Amounts are USD cents, fractional allowed (12.3456 rates exactly).
 */
export const CATALOG = {
  metric: "CanonCRM provider charge",
  usageProduct: "Paid data calls",
  creditProduct: "CanonCRM credits",
  rateCard: "CanonCRM credits",
  rateCardAlias: "canoncrm-credits",
  eventType: "provider_charge",
} as const;

/** Credits stay usable this long after purchase (Metronome requires an end to every commit segment). */
const CREDIT_YEARS = 10;

export class MetronomeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Metronome = {
  call: <T = unknown>(path: string, body?: unknown) => Promise<T>;
};

/** A client, or null when the deployment has no key. */
export function metronome(fetchImpl: typeof fetch = fetch): Metronome | null {
  const key = process.env.METRONOME_API_KEY;
  if (!integrationEnabled("metronome")) return null;
  return {
    async call<T>(path: string, body?: unknown): Promise<T> {
      const res = await fetchImpl(`https://api.metronome.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      // Status and Metronome's own message only: never echo request details tied to a key.
      if (!res.ok) throw new MetronomeError(res.status, `Metronome ${path} answered ${res.status}: ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

type Listed<T> = { data: T[] };

/** The credit product's id (commits are written against it). */
export async function creditProductId(m: Metronome): Promise<string> {
  const products = await m.call<Listed<{ id: string; current?: { name?: string } }>>("/v1/contract-pricing/products/list", {});
  const product = products.data.find((p) => p.current?.name === CATALOG.creditProduct);
  if (!product) throw new Error(`Metronome has no "${CATALOG.creditProduct}" product: run credits:ensureMetronomeCatalog first.`);
  return product.id;
}

/** Create the metric, products and rate card if missing; safe to run again. */
export async function ensureCatalog(m: Metronome): Promise<{ metricId: string; usageProductId: string; creditProductId: string; rateCardId: string }> {
  const metrics = await m.call<Listed<{ id: string; name: string }>>("/v1/billable-metrics?limit=100");
  const metricId = metrics.data.find((x) => x.name === CATALOG.metric)?.id ?? (await m.call<{ data: { id: string } }>("/v1/billable-metrics/create", {
    name: CATALOG.metric,
    event_type_filter: { in_values: [CATALOG.eventType] },
    property_filters: [{ name: "charge_cents", exists: true }],
    aggregation_type: "SUM",
    aggregation_key: "charge_cents",
  })).data.id;
  const products = (await m.call<Listed<{ id: string; current?: { name?: string } }>>("/v1/contract-pricing/products/list", {})).data;
  const find = (name: string) => products.find((p) => p.current?.name === name)?.id;
  const usageProductId = find(CATALOG.usageProduct)
    ?? (await m.call<{ data: { id: string } }>("/v1/contract-pricing/products/create", { name: CATALOG.usageProduct, type: "USAGE", billable_metric_id: metricId })).data.id;
  const creditId = find(CATALOG.creditProduct)
    ?? (await m.call<{ data: { id: string } }>("/v1/contract-pricing/products/create", { name: CATALOG.creditProduct, type: "FIXED" })).data.id;
  const cards = (await m.call<Listed<{ id: string; name: string }>>("/v1/contract-pricing/rate-cards/list", {})).data;
  const rateCardId = cards.find((c) => c.name === CATALOG.rateCard)?.id
    ?? (await m.call<{ data: { id: string } }>("/v1/contract-pricing/rate-cards/create", { name: CATALOG.rateCard, aliases: [{ name: CATALOG.rateCardAlias }] })).data.id;
  // Checked on its own, so a run that created the card but failed to add the rate is repaired.
  const rates = await m.call<Listed<{ product_id: string }>>("/v1/contract-pricing/rate-cards/getRates", { rate_card_id: rateCardId, at: new Date().toISOString() });
  if (!rates.data.some((r) => r.product_id === usageProductId)) {
    // One unit of charge_cents bills one cent: the charge we compute is the price.
    await m.call("/v1/contract-pricing/rate-cards/addRate", {
      rate_card_id: rateCardId, product_id: usageProductId, starting_at: "2026-10-01T00:00:00Z", entitled: true, rate_type: "FLAT", price: 1,
    });
  }
  return { metricId, usageProductId, creditProductId: creditId, rateCardId };
}

/** The workspace's Metronome customer (ingest alias = org id) and contract, created once. */
export async function ensureAccount(m: Metronome, org: { orgId: string; name: string }): Promise<{ customerId: string; contractId: string }> {
  const found = await m.call<Listed<{ id: string }>>(`/v1/customers?ingest_alias=${encodeURIComponent(org.orgId)}`);
  const customerId = found.data[0]?.id
    ?? (await m.call<{ data: { id: string } }>("/v1/customers", { name: org.name, ingest_aliases: [org.orgId] })).data.id;
  const contracts = await m.call<Listed<{ id: string }>>("/v2/contracts/list", { customer_id: customerId });
  let contractId = contracts.data[0]?.id;
  if (!contractId) {
    // No end and no recurring fee: the contract only rates provider charges against commits.
    contractId = (await m.call<{ data: { id: string } }>("/v1/contracts/create", {
      customer_id: customerId, rate_card_alias: CATALOG.rateCardAlias, starting_at: startOfDay(Date.now()), uniqueness_key: `canoncrm-contract-${org.orgId}`,
    })).data.id;
  }
  return { customerId, contractId };
}

/** Add paid-for credits as a prepaid commit Metronome won't invoice (Stripe already took the payment). */
export async function addCredits(m: Metronome, a: { customerId: string; contractId: string; productId: string; cents: number; key: string; name: string; at: number }) {
  try {
    await m.call("/v2/contracts/edit", {
      customer_id: a.customerId,
      contract_id: a.contractId,
      uniqueness_key: a.key,
      add_commits: [{
        type: "PREPAID",
        product_id: a.productId,
        name: a.name,
        priority: 1,
        access_schedule: { schedule_items: [{ amount: a.cents, starting_at: startOfDay(a.at), ending_before: startOfDay(a.at + CREDIT_YEARS * 365.25 * 86_400_000) }] },
      }],
    });
  } catch (error) {
    // A retried purchase reuses its uniqueness key: the commit already exists.
    if (error instanceof MetronomeError && error.status === 409) return;
    throw error;
  }
}

/** The customer's spendable balance in cents (includes usage on draft invoices). */
export async function netBalanceCents(m: Metronome, customerId: string): Promise<number> {
  return (await m.call<{ data: { balance: number } }>("/v1/contracts/customerBalances/getNetBalance", { customer_id: customerId })).data.balance;
}

/** Commits and contracts start on a UTC day boundary. */
function startOfDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export type ChargeEvent = { ref: string; orgId: string; chargeCents: number; at: number; provider: string; jobId: string };

/** Report settled charges (up to 100 a call). `ref` is the idempotency key: a resend is ignored for 34 days. */
export async function ingestCharges(m: Metronome, events: ChargeEvent[]): Promise<void> {
  if (!events.length) return;
  await m.call("/v1/ingest", events.map((e) => ({
    transaction_id: e.ref,
    customer_id: e.orgId,
    event_type: CATALOG.eventType,
    timestamp: new Date(e.at).toISOString(),
    properties: { charge_cents: e.chargeCents, provider: e.provider, job_id: e.jobId },
  })));
}
