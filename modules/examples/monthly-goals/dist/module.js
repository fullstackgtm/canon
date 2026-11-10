var DAY_MS = 864e5;
var calls = {
  progress(ctx, reads) {
    const goals = reads.goals;
    const byMonthAndRep = /* @__PURE__ */ new Map();
    for (const d of reads.deals) {
      if (!d.isWon || !d.ownerId || typeof d.closeDate !== "string") continue;
      const key = `${d.closeDate.slice(0, 7)}|${d.ownerId}`;
      const tally = byMonthAndRep.get(key) ?? { won: 0, amount: 0 };
      byMonthAndRep.set(key, { won: tally.won + 1, amount: tally.amount + (d.amount ?? 0) });
    }
    const first = new Date(ctx.now - 399 * DAY_MS).toISOString().slice(0, 7);
    const last = new Date(ctx.now).toISOString().slice(0, 7);
    const rows = goals.map((g) => {
      const month = String(g.data.month);
      const goal = Number(g.data.won);
      const counted = month > first && month <= last;
      const tally = counted ? byMonthAndRep.get(`${month}|${g.data.rep}`) ?? { won: 0, amount: 0 } : void 0;
      return {
        month,
        rep: g.data.rep,
        goal,
        won: tally === void 0 ? "Not counted" : String(tally.won),
        amount: tally === void 0 ? "Not counted" : tally.amount,
        status: tally === void 0 ? month > last ? "Not started" : "More than a year ago" : tally.won >= goal ? "Met" : `${goal - tally.won} to go`
      };
    });
    return { value: { rows, message: "No goals yet." } };
  }
};
export {
  calls
};
