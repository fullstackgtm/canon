var WHY = {
  not_installed: "Field visits isn't installed, so there are no tallies to compare with.",
  off: "Field visits is turned off, so its tallies can't be read.",
  not_provided: "This version of Field visits doesn't publish its tallies."
};
var calls = {
  progress(_ctx, reads) {
    const goals = reads.goals;
    const tallies = reads.tallies;
    if (!Array.isArray(tallies)) return { value: { rows: [], message: WHY[tallies.missing] } };
    const byMonthAndRep = new Map(tallies.map((t) => [`${t.data.month}|${t.data.rep}`, t.data]));
    const rows = goals.map((g) => {
      const tally = byMonthAndRep.get(`${g.data.month}|${g.data.rep}`);
      const done = tally === void 0 ? void 0 : Number(tally.won);
      const goal = Number(g.data.won);
      return {
        month: g.data.month,
        rep: g.data.rep,
        goal,
        // A month the reader can't see there (a rep's month before it closes) reads as not counted yet, never as 0.
        won: done === void 0 ? "Not counted yet" : String(done),
        amount: tally === void 0 ? "Not counted yet" : tally.amount,
        status: done === void 0 ? "Waiting for the tally" : done >= goal ? "Met" : `${goal - done} to go`
      };
    });
    return { value: { rows, message: "No goals yet." } };
  }
};
export {
  calls
};
