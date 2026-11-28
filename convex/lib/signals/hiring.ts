/**
 * "Hiring sales reps" answered from the job boards Canon already reads daily (convex/signals.ts), with no model
 * (docs/signal-automations.md, S3). Pure: no Convex imports.
 */
import type { Finding } from "../research/agentLoop";

/** Open roles at or above this count, posted in the window, answer yes. Matches the starter's question. */
export const SALES_ROLES_MIN = 3;
export const SALES_WINDOW_MS = 30 * 86_400_000;

const SALES = /\b(sdr|bdr|account executive|account manager|sales|business development|ae)\b/i;
const NOT_SALES = /\b(sales ?ops|sales operations|revenue operations|revops|salesforce (developer|admin|administrator|engineer)|engineer|developer|marketing)\b/i;

/** The role title of a job signal's trigger (`hiring: <title>` or `reposted: <title>`). */
export const roleTitle = (trigger: string): string => trigger.replace(/^(hiring|reposted):\s*/i, "").trim();

/** A selling role: SDR, BDR, account executive or manager, business development, or sales leadership. */
export const isSalesRole = (title: string): boolean => SALES.test(title) && !NOT_SALES.test(title);

/** One title on the board; `openings`: its postings from the last 30 days (signals.ts keeps one row per title). */
export type JobRow = { trigger: string; quote: string; sourceUrl: string; observedAt: number; openings?: number };
export type BoardRead = { source?: string; token?: string; checkedAt: number } | null;

const BOARD_URL: Record<string, (token: string) => string> = {
  greenhouse: (t) => `https://boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
};

/**
 * The answer for one account. A board Canon read answers yes (with each role as a cite) or no (with the board as
 * its source). An account with no board Canon could read stays unknown: absence there says nothing.
 */
export function hiringSalesFinding(board: BoardRead, rows: readonly JobRow[], now: number): Finding {
  if (!board?.source) return { status: "unknown", reason: "Canon found no public job board for this account (Greenhouse, Lever or Ashby)." };
  const recent = rows.filter((r) => r.observedAt >= now - SALES_WINDOW_MS && isSalesRole(roleTitle(r.trigger)))
    .sort((a, b) => b.observedAt - a.observedAt);
  const count = recent.reduce((n, r) => n + (r.openings ?? 1), 0);
  if (count >= SALES_ROLES_MIN) {
    const cites = recent.slice(0, 5).map((r) => ({ quote: r.quote.slice(0, 300), url: r.sourceUrl }));
    return { status: "answered", value: true, quote: cites[0].quote, sourceUrl: cites[0].url, confidence: 0.95, cites };
  }
  const day = new Date(board.checkedAt).toISOString().slice(0, 10);
  const shown = recent.map((r) => roleTitle(r.trigger)).join("; ");
  return {
    status: "answered", value: false, confidence: 0.9, sourceUrl: recent[0]?.sourceUrl ?? (board.token && BOARD_URL[board.source] ? BOARD_URL[board.source](board.token) : `${board.source} job board`),
    quote: `The account's ${board.source} board, read ${day}, lists ${count} open sales role${count === 1 ? "" : "s"} posted in the last 30 days${shown ? `: ${shown}` : ""}.`,
  };
}
