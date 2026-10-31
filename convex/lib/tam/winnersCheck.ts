export type WinnersCheck =
  | { status: "needs-ten"; wonAccounts: number; required: 10 }
  | { status: "ready"; wonAccounts: number; totalAccounts: number; medianPercentile: number; topQuarter: number; below60: boolean };

/** Won fits come from distinct visible accounts. Ties share their rank range's midpoint. */
export function winnersCheck(histogram: readonly { fit: number; count: number }[], wonFits: readonly number[]): WinnersCheck {
  const bins = histogram.filter((bin) => Number.isFinite(bin.fit) && Number.isFinite(bin.count) && bin.count > 0);
  const totalAccounts = bins.reduce((total, bin) => total + bin.count, 0);
  const won = totalAccounts ? wonFits.filter(Number.isFinite) : [];
  if (won.length < 10) return { status: "needs-ten", wonAccounts: won.length, required: 10 };
  const ranks = won.map((fit) => 100 * bins.reduce((rank, bin) =>
    rank + (bin.fit < fit ? bin.count : bin.fit === fit ? bin.count / 2 : 0), 0) / totalAccounts).sort((a, b) => a - b);
  const middle = Math.floor(ranks.length / 2);
  const medianPercentile = ranks.length % 2 ? ranks[middle] : (ranks[middle - 1] + ranks[middle]) / 2;
  return { status: "ready", wonAccounts: won.length, totalAccounts, medianPercentile,
    topQuarter: ranks.filter((rank) => rank >= 75).length, below60: medianPercentile < 60 };
}
