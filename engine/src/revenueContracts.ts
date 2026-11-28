/**
 * Revenue contracts from Stripe (docs/revenue-contracts.md).
 *
 * The rule this module encodes: ONE booking per commitment, never one per
 * invoice. Each Stripe subscription becomes one contract (start date, monthly
 * amount, open-ended until it is canceled or ends). Every invoice attaches to
 * the contract of its subscription. Invoices with no subscription are listed
 * for review and never become a booking on their own.
 *
 * Pure: no I/O, no Node-only imports. Amounts are major units.
 */

/** One recurring or one-off price on a subscription. */
export type StripeRevenueLine = {
  priceId?: string;
  product?: string;
  quantity: number;
  /** Major units per interval; undefined for metered or tiered prices. */
  unitAmount?: number;
  /** "day" | "week" | "month" | "year"; undefined for one-off prices. */
  interval?: string;
  intervalCount?: number;
};

export type StripeRevenueCustomer = {
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  /** Lowercased domain of the billing email. */
  customerDomain?: string;
};

export type StripeRevenueSubscription = StripeRevenueCustomer & {
  id: string;
  /** Stripe status: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused. */
  status: string;
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD: ended_at, else cancel_at. Absent = open ended. */
  endDate?: string;
  currency?: string;
  lines: StripeRevenueLine[];
};

export type StripeRevenueInvoice = StripeRevenueCustomer & {
  id: string;
  number?: string;
  subscriptionId?: string;
  /** draft, open, paid, void, uncollectible */
  status?: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  currency?: string;
  /** YYYY-MM-DD */
  periodStart?: string;
  periodEnd?: string;
  dueDate?: string;
  paidAt?: string;
  createdAt?: string;
  hostedInvoiceUrl?: string;
  description?: string;
};

export type RevenueContractStatus = "active" | "canceled" | "ended" | "pending";

export type RevenueContract = StripeRevenueCustomer & {
  /** The Stripe subscription id: the contract's identity. */
  stripeSubscriptionId: string;
  status: RevenueContractStatus;
  stripeStatus: string;
  startDate?: string;
  /** Absent = open ended. */
  endDate?: string;
  currency?: string;
  /** Monthly booking amount; undefined when any recurring line is metered or tiered. */
  mrr?: number;
  arr?: number;
  /** The billing interval of the first recurring line, e.g. "month", "3 month", "year". */
  billingInterval?: string;
  lines: StripeRevenueLine[];
  invoiceIds: string[];
  billed: number;
  collected: number;
  outstanding: number;
  firstInvoiceAt?: string;
  lastInvoiceAt?: string;
};

export type RevenueImport = {
  contracts: RevenueContract[];
  /** Every invoice, with the contract it attaches to (by subscription id) or none. */
  invoices: Array<StripeRevenueInvoice & { contractSubscriptionId?: string }>;
  /** Invoices with no subscription: listed for review, never booked. */
  unattached: StripeRevenueInvoice[];
};

const MONTHS_PER: Record<string, number> = {
  day: 12 / 365,
  week: 12 / 52,
  month: 1,
  year: 12,
};

/** A recurring line's amount per month, or undefined when it can't be known. */
export function monthlyAmount(line: StripeRevenueLine): number | undefined {
  if (!line.interval) return 0;
  const months = MONTHS_PER[line.interval];
  if (months === undefined || line.unitAmount === undefined) return undefined;
  const count = line.intervalCount && line.intervalCount > 0 ? line.intervalCount : 1;
  return (line.unitAmount * line.quantity) / (months * count);
}

/** Cents-safe rounding for money in major units. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function contractStatus(subscription: StripeRevenueSubscription): RevenueContractStatus {
  switch (subscription.status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "paused":
      return "active";
    case "canceled":
      return subscription.endDate ? "ended" : "canceled";
    case "incomplete_expired":
      return "canceled";
    default:
      return "pending";
  }
}

/**
 * Group subscriptions and invoices into contracts. Deterministic: the result
 * depends only on the sets of subscriptions and invoices, not their order.
 */
export function buildRevenueContracts(
  subscriptions: StripeRevenueSubscription[],
  invoices: StripeRevenueInvoice[],
): RevenueImport {
  const sortedSubscriptions = [...new Map(subscriptions.map((s) => [s.id, s])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const sortedInvoices = [...new Map(invoices.map((i) => [i.id, i])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const bySubscription = new Map<string, StripeRevenueInvoice[]>();
  for (const invoice of sortedInvoices) {
    if (!invoice.subscriptionId) continue;
    const list = bySubscription.get(invoice.subscriptionId) ?? [];
    list.push(invoice);
    bySubscription.set(invoice.subscriptionId, list);
  }
  const known = new Set(sortedSubscriptions.map((s) => s.id));

  const contracts: RevenueContract[] = sortedSubscriptions.map((subscription) => {
    const recurring = subscription.lines.filter((line) => line.interval);
    const monthly = recurring.map(monthlyAmount);
    const mrr = monthly.some((value) => value === undefined)
      ? undefined
      : money(monthly.reduce<number>((sum, value) => sum + (value ?? 0), 0));
    const first = recurring[0];
    const billingInterval = first?.interval
      ? `${first.intervalCount && first.intervalCount > 1 ? `${first.intervalCount} ` : ""}${first.interval}`
      : undefined;
    const attached = (bySubscription.get(subscription.id) ?? []).filter((i) => i.status !== "void" && i.status !== "draft");
    const dates = attached
      .map((i) => i.periodStart ?? i.createdAt)
      .filter((d): d is string => Boolean(d))
      .sort();
    return {
      customerId: subscription.customerId,
      customerName: subscription.customerName,
      customerEmail: subscription.customerEmail,
      customerDomain: subscription.customerDomain,
      stripeSubscriptionId: subscription.id,
      status: contractStatus(subscription),
      stripeStatus: subscription.status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      currency: subscription.currency,
      mrr,
      arr: mrr === undefined ? undefined : money(mrr * 12),
      billingInterval,
      lines: subscription.lines,
      invoiceIds: (bySubscription.get(subscription.id) ?? []).map((i) => i.id),
      billed: money(attached.reduce((sum, i) => sum + i.amountDue, 0)),
      collected: money(attached.reduce((sum, i) => sum + i.amountPaid, 0)),
      outstanding: money(attached.reduce((sum, i) => sum + i.amountRemaining, 0)),
      firstInvoiceAt: dates[0],
      lastInvoiceAt: dates.at(-1),
    };
  });

  return {
    contracts,
    invoices: sortedInvoices.map((invoice) => ({
      ...invoice,
      ...(invoice.subscriptionId && known.has(invoice.subscriptionId)
        ? { contractSubscriptionId: invoice.subscriptionId }
        : {}),
    })),
    unattached: sortedInvoices.filter((invoice) => !invoice.subscriptionId || !known.has(invoice.subscriptionId)),
  };
}

/** Contracts that are a real booking: they started (not incomplete) or collected money. */
export function bookableContracts(contracts: RevenueContract[]): RevenueContract[] {
  return contracts.filter(
    (contract) =>
      contract.collected > 0 || contract.stripeStatus === "active" || contract.stripeStatus === "trialing" || contract.stripeStatus === "past_due",
  );
}
