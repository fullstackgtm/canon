/**
 * Monthly goals' server code (docs/modules.md, "Reading another module"): each goal against the tally Field visits
 * publishes as `tallies.v1`, read as the person who opens the page reads it there.
 */
import type { CallFunctions, MissingRead, ReadDoc } from "../../kernel/calls.ts";

const WHY: Record<MissingRead["missing"], string> = {
  not_installed: "Field visits isn't installed, so there are no tallies to compare with.",
  off: "Field visits is turned off, so its tallies can't be read.",
  not_provided: "This version of Field visits doesn't publish its tallies.",
};

export const calls: CallFunctions = {
  progress(_ctx, reads) {
    const goals = reads.goals as ReadDoc[];
    const tallies = reads.tallies as ReadDoc[] | MissingRead;
    if (!Array.isArray(tallies)) return { value: { rows: [], message: WHY[tallies.missing] } };
    const byMonthAndRep = new Map(tallies.map((t) => [`${t.data.month}|${t.data.rep}`, t.data]));
    const rows = goals.map((g) => {
      const tally = byMonthAndRep.get(`${g.data.month}|${g.data.rep}`);
      const done = tally === undefined ? undefined : Number(tally.won);
      const goal = Number(g.data.won);
      return {
        month: g.data.month, rep: g.data.rep, goal,
        // A month the reader can't see there (a rep's month before it closes) reads as not counted yet, never as 0.
        won: done === undefined ? "Not counted yet" : String(done),
        amount: tally === undefined ? "Not counted yet" : tally.amount,
        status: done === undefined ? "Waiting for the tally" : done >= goal ? "Met" : `${goal - done} to go`,
      };
    });
    return { value: { rows, message: "No goals yet." } };
  },
};
