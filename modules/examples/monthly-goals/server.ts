/**
 * Monthly goals' server code (docs/modules.md, "Server code"): each goal against the deals its rep won in its month,
 * counted from Canon's deals closing in the last 400 days, as the person who opens the page sees them.
 */
import type { CallFunctions, ReadDoc } from "../../kernel/calls.ts";

type Deal = { amount?: number | null; closeDate?: string | null; isWon?: boolean | null; ownerId?: string | null };
const DAY_MS = 86_400_000;

export const calls: CallFunctions = {
  progress(ctx, reads) {
    const goals = reads.goals as ReadDoc[];
    const byMonthAndRep = new Map<string, { won: number; amount: number }>();
    for (const d of reads.deals as Deal[]) {
      if (!d.isWon || !d.ownerId || typeof d.closeDate !== "string") continue;
      const key = `${d.closeDate.slice(0, 7)}|${d.ownerId}`;
      const tally = byMonthAndRep.get(key) ?? { won: 0, amount: 0 };
      byMonthAndRep.set(key, { won: tally.won + 1, amount: tally.amount + (d.amount ?? 0) });
    }
    // The months the read covers in full: a goal before them, or after this month, isn't counted, never 0.
    const first = new Date(ctx.now - 399 * DAY_MS).toISOString().slice(0, 7);
    const last = new Date(ctx.now).toISOString().slice(0, 7);
    const rows = goals.map((g) => {
      const month = String(g.data.month);
      const goal = Number(g.data.won);
      const counted = month > first && month <= last;
      const tally = counted ? byMonthAndRep.get(`${month}|${g.data.rep}`) ?? { won: 0, amount: 0 } : undefined;
      return {
        month, rep: g.data.rep, goal,
        won: tally === undefined ? "Not counted" : String(tally.won),
        amount: tally === undefined ? "Not counted" : tally.amount,
        status: tally === undefined ? (month > last ? "Not started" : "More than a year ago") : tally.won >= goal ? "Met" : `${goal - tally.won} to go`,
      };
    });
    return { value: { rows, message: "No goals yet." } };
  },
};
