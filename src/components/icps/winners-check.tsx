"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { IcpWinnersRead } from "../../../convex/icpWinners";

export function WinnersCheck() {
  const read = useAction(api.icpWinners.read);
  const [data, setData] = useState<IcpWinnersRead | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void read({}).then((result) => { if (live) setData(result); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [read]);
  const check = data?.check;
  return <section className="mt-8 border-t border-border pt-5" aria-labelledby="winners-check-title">
    <h2 id="winners-check-title" className="font-display text-lg font-semibold">Do your ICPs find your winners?</h2>
    <div className="mt-2 text-sm" aria-live="polite">
      {failed ? <p className="text-muted-foreground">We couldn&apos;t check the won accounts. Reopen this page to try again.</p>
        : data === undefined ? <p className="text-muted-foreground">Checking won accounts…</p>
        : data === null ? <p className="text-muted-foreground">Turn on your ICPs to check their fit against won accounts.</p>
        : check?.status === "needs-ten" ? <p className="text-muted-foreground">This check needs ten won accounts with visible linked companies.</p>
        : check?.status === "ready" ? <>
          <p className="text-muted-foreground">Each account uses its best stored fit across your ICPs. Compared with all {check.totalAccounts.toLocaleString()} accounts you can see, using won deals you can see.</p>
          <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-3">
            <div><dt className="text-muted-foreground">Median fit percentile of won accounts</dt><dd className="mt-1 text-xl font-semibold">{Math.round(check.medianPercentile)}th percentile</dd></div>
            <div><dt className="text-muted-foreground">Won accounts in the top quarter</dt><dd className="mt-1 text-xl font-semibold">{check.topQuarter} of {check.wonAccounts}</dd></div>
          </dl>
          {check.below60 && <p className="mt-3 border-l-2 border-warning pl-3">Your ICPs are not ranking your real winners near the top yet. Review their criteria against the companies you&apos;ve won.</p>}
          <p className="mt-3 text-xs text-muted-foreground">Each company counts once. Equal fit scores share the middle percentile of their rank range.</p>
        </> : null}
      {data?.sampled && <p className="mt-3 text-xs text-muted-foreground">This check used the first 500 won accounts linked to deals you can see. Only visible linked companies contribute to the statistics.</p>}
    </div>
  </section>;
}
