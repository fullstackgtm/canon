/**
 * What an AI-field run will touch and cost, worked out before it starts, and
 * how long a scheduled refresh waits. Pure. Every number is a ceiling derived
 * from the loop's own limits (agentLoop.ts), not a measurement.
 */
import { ACCOUNT_MS, MAX_PER_READ, MAX_READS, MAX_SEARCHES, RESEARCH_CONCURRENCY, RESEARCH_PAGE, RUN_CAP, SEARCH_READS } from "./agentLoop.ts";
import { EXTRACT_STATE_MAX } from "../../../services/recipe-runtime/src/extractionProtocol.ts";
import { CREDIT_RATES, MICRO } from "../creditPacks.ts";

/**
 * Credits one researched record costs (CR4, docs/credits.md), account or contact. A record that errors, or
 * is skipped because it already has an answer, costs nothing.
 */
export const RECORD_CREDITS = CREDIT_RATES.accountResearch;
export const RECORD_MICRO = RECORD_CREDITS * MICRO;

/** Records a cap pays for: what is left of it, in whole records. */
export const recordsAffordable = (capMicro: number, spentMicro: number): number => Math.max(0, Math.floor((capMicro - spentMicro) / RECORD_MICRO));

export const REFRESH_CADENCES = ["weekly", "monthly"] as const;
export type RefreshCadence = (typeof REFRESH_CADENCES)[number];
export const CADENCE_DAYS: Record<RefreshCadence, number> = { weekly: 7, monthly: 30 };

export const cadenceMs = (c: RefreshCadence) => CADENCE_DAYS[c] * 24 * 60 * 60_000;

/**
 * Canon pays Jev to verify each proposed fact: ~1.5k tokens at $0.042 per
 * million tokens (docs/pricing.md, a code estimate).
 */
export const JEV_USD_PER_FACT = 0.00006;
const CLAIRIC_FIELDS = 2;
const MAX_UTF8_BYTES_PER_CODE_POINT = 4;
const CLAIRIC_OVERHEAD_TOKENS = 24_000;
const CLAIRIC_USD_PER_INPUT_TOKEN = 0.10 / 1_000_000;

export type RunEstimate = {
  /** Accounts the run may research: the scope, capped at `cap`. Accounts that already have an answer are skipped and cost nothing. */
  records: number;
  cap: number;
  /** Model calls and page reads on the user's plan, at most. */
  modelCallsMax: number;
  pagesMax: number;
  /** Ceiling on research time (record lookups and scheduling not included): workers in parallel, each account cut off after ACCOUNT_MS. */
  secondsMax: number;
  concurrency: number;
  accountSeconds: number;
  extractionCallsMax: number;
  extractionUsdMax: number;
  /**
   * Jev calls Canon pays for and their cost in USD: one read per record of a classify or yes/no field
   * (for records no page answers), and one check per proposed fact when auto-accept is on.
   */
  jevCallsMax: number;
  jevUsdMax: number;
  /** Credits the run spends if it researches every record (RECORD_CREDITS each). */
  creditsMax: number;
};

/**
 * `seedPages`: pages read per record before the model asks for more (a contact's profile page).
 * `jevReads`: the field is classify or yes/no, so Jev reads records no page answers.
 */
export function estimateRun(args: { inScope: number; autoAccept: boolean; seedPages?: number; jevReads?: boolean; factual?: boolean }): RunEstimate {
  const records = Math.max(0, Math.min(args.inScope, RUN_CAP));
  const jevCallsMax = (args.autoAccept ? records : 0) + (args.jevReads ? records : 0);
  const extractionCallsMax = args.factual ? records * (MAX_READS + 1) : 0;
  const extractionUsdMax = extractionCallsMax * (CLAIRIC_FIELDS * EXTRACT_STATE_MAX * MAX_UTF8_BYTES_PER_CODE_POINT + CLAIRIC_OVERHEAD_TOKENS) * CLAIRIC_USD_PER_INPUT_TOKEN;
  return {
    extractionCallsMax, extractionUsdMax,
    records,
    cap: RUN_CAP,
    // Each web search is one more model call and reads up to SEARCH_READS of its results.
    modelCallsMax: records * (MAX_READS + (args.factual ? 0 : 1) + MAX_SEARCHES),
    pagesMax: records * (1 + (args.seedPages ?? 0) + MAX_READS * MAX_PER_READ + MAX_SEARCHES * SEARCH_READS),
    // Pages run one after another, each in waves of RESEARCH_CONCURRENCY accounts.
    secondsMax: (Math.floor(records / RESEARCH_PAGE) * Math.ceil(RESEARCH_PAGE / RESEARCH_CONCURRENCY) + Math.ceil((records % RESEARCH_PAGE) / RESEARCH_CONCURRENCY)) * (ACCOUNT_MS / 1000),
    concurrency: RESEARCH_CONCURRENCY,
    accountSeconds: ACCOUNT_MS / 1000,
    jevCallsMax,
    jevUsdMax: jevCallsMax * JEV_USD_PER_FACT,
    creditsMax: records * RECORD_CREDITS,
  };
}
