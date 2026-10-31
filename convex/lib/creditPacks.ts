/**
 * Credits are Canon's one unit for every GTM action (docs/credits.md). The
 * customer sees a rate card in credits; what an action really costs us (treg's
 * metered price) stays behind it. A credit is worth CREDIT_USD at the per-use
 * price, bigger packs add bonus credits, and each workspace gets
 * FREE_CREDITS_PER_MONTH each UTC month, spent before purchased credits. Users
 * and agents spend from the same workspace balance.
 *
 * Balances and ledger rows are in micro-credits (MICRO per credit).
 */
export const MICRO = 1_000_000;

/** What one credit is worth at the per-use price. */
export const CREDIT_USD = 0.01;

/** Free credits a workspace gets every UTC month, whoever (user or agent) spends them. */
export const FREE_CREDITS_PER_MONTH = 1000;

/** The rate card: credits per action, the same whatever source serves it. */
export const CREDIT_RATES = {
  tamCompany: 1,
  /** A contact kept from a people search. Paid sources may cost more (creditsPerRecord). */
  contact: 1,
  /** A verified work email, charged only when one is found. */
  verifiedEmail: 5,
  emailSend: 1,
  /** A LinkedIn invite or message. */
  linkedinAction: 1,
  /** An account or contact an AI field researched. */
  accountResearch: 1,
  /** A module's hosted AI step run on Canon's model, for a person with no ChatGPT plan connected. */
  moduleAi: 1,
} as const;

/** The multiple of our cost a credit price aims for, which also funds the free allowance and pack bonuses. */
export const TARGET_COST_MULTIPLE = 3;

/** Credits for an action that costs us `usd`: at least one, at TARGET_COST_MULTIPLE of cost. */
export const creditsForCost = (usd: number): number => Math.max(1, Math.ceil((usd * TARGET_COST_MULTIPLE) / CREDIT_USD - 1e-9));

/** Credits per kept contact from a paid source with this catalog price per record. */
export const creditsPerRecord = (usdPerRecord: number): number => Math.max(CREDIT_RATES.contact, creditsForCost(usdPerRecord));

/** The smallest cap a paid run may have: one page of the source, if every row on it were kept. */
export const minCapCredits = (provider: { usdPerRecord: number; pageSize: number }): number => creditsPerRecord(provider.usdPerRecord) * provider.pageSize;

/** Packs sold through Stripe Checkout; Checkout prices each one from here, so Stripe needs no catalog. */
export const CREDIT_PACKS = [
  { price: 25, credits: 2_500 },
  { price: 50, credits: 5_500 },
  { price: 100, credits: 12_000 },
] as const;

export type CreditPack = (typeof CREDIT_PACKS)[number];

export const packByPrice = (price: number): CreditPack | null => CREDIT_PACKS.find((p) => p.price === price) ?? null;

/**
 * The pack a paid credits Checkout Session bought: its `pack` metadata, checked
 * against what Stripe charged before tax. Sessions from before packs were priced
 * from code carry a `canoncrm_credits_<dollars>` price and grant its dollars at
 * the per-use price.
 */
export function packFromSession(s: { metadata?: Record<string, string> | null; amount_subtotal?: number | null; lookupKey?: string | null }): { price: number; credits: number } | null {
  const meta = s.metadata?.pack;
  if (meta) {
    const pack = packByPrice(Number(meta));
    return pack && s.amount_subtotal === pack.price * 100 ? pack : null;
  }
  const m = s.lookupKey?.match(/^canoncrm_credits_(25|100|500)$/);
  return m ? { price: Number(m[1]), credits: Number(m[1]) / CREDIT_USD } : null;
}

/** The UTC month a free allowance belongs to, as "YYYY-MM". */
export const creditMonth = (at: number): string => new Date(at).toISOString().slice(0, 7);

/**
 * Balances written before credits became units were dollars in millionths.
 * `creditUnit: "credits"` marks a converted workspace; anything else converts
 * at the per-use price on its next read.
 */
export const paidBalanceMicro = (org: { creditBalanceMicro?: number; creditUnit?: string }): number =>
  org.creditUnit === "credits" ? (org.creditBalanceMicro ?? 0) : Math.round((org.creditBalanceMicro ?? 0) / CREDIT_USD);

/**
 * Split a spend between the month's free allowance and purchased credits: free
 * first. `freeLeftMicro` is what the allowance has left this month.
 */
export function splitSpend(amountMicro: number, freeLeftMicro: number): { freeMicro: number; paidMicro: number } {
  const freeMicro = Math.max(0, Math.min(amountMicro, freeLeftMicro));
  return { freeMicro, paidMicro: amountMicro - freeMicro };
}
