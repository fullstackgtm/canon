"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

export function SignupMarketBanner() {
  const run = useQuery(api.tamInvestigations.signupBanner, {});
  if (!run) return null;
  const message = {
    planning: "Canon is finding sources to map your market.",
    awaiting_start: "Your market map is ready to start.",
    running: `Canon is mapping your market from ${run.sourceCount} sources.`,
    paused_at_cap: "Canon paused your market map at its credit limit.",
    done: `Canon mapped your market and kept ${run.kept} companies for review.`,
    failed: "Canon could not finish mapping your market. Your results are saved.",
  }[run.status];
  return <Link href={`/dashboard/icps/investigations/${run._id}`} className="mx-4 mt-4 block border border-border bg-muted/30 px-4 py-3 text-sm hover:bg-muted/60 md:mx-6">
    <span className="font-medium">{message}</span>{" "}
    <span className="text-muted-foreground">{run.freeOnly ? "Uses up to 500 of your free credits." : `${run.spentCredits} credits spent.`}</span>{" "}
    <span className="underline">View market map</span>
  </Link>;
}
