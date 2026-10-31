"use client";

import { JEV_CONFIDENT, type JevSummary, type ProbeVerdict } from "../../../convex/lib/research/probe";
import { cn } from "@/lib/utils";

type Value = string | number | boolean;

/**
 * What a probe (a field tried on a random sample) says about the question, in one line. A question
 * pages rarely state outright isn't a failure when Jev can read it, so that case stays neutral.
 */
export function ProbeVerdictLine({ verdict, show = String, className }: { verdict: ProbeVerdict; show?: (v: Value) => string; className?: string }) {
  const { kind, settled, answered, top, jev } = verdict;
  const of = `${answered} of ${settled}`;
  const [tone, text] =
    kind === "pending" ? ["muted", "Trying it on a sample…"]
    : kind === "too_few" ? ["muted", `Too few records finished to judge (${settled}).`]
    : kind === "ready" ? ["good", `Ready: answered ${of} with a quote.`]
    : kind === "mixed" ? ["warn", `Mixed: answered ${of} with a quote. Read the misses before a full run.`]
    : kind === "undecidable"
      ? jev ? ["muted", `Few pages state this outright (${of} with a quote), so Jev's read below is inferred from title, company and what was read.`]
      : ["warn", `Few pages state this outright: answered ${of} with a quote.`]
    : ["warn", `Doesn't split: ${Math.round((top?.share ?? 0) * 100)}% of answers are “${top ? show(top.value) : ""}”, so on this scope the field adds little.`];
  return (
    <p className={cn("text-xs", tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-warning" : "text-muted-foreground", className)}>
      {text}
    </p>
  );
}

/** Jev's picks across a probe's sample, as bars, with how confident the reads were. */
export function JevDistribution({ jev, show = (c) => c.replace(/-/g, " "), className }: { jev: JevSummary; show?: (v: string) => string; className?: string }) {
  const max = Math.max(...jev.picks.map((p) => p.count));
  return (
    <div className={cn("grid gap-1.5 text-xs", className)}>
      <p className="text-muted-foreground">Jev&apos;s read of {jev.read} record{jev.read === 1 ? "" : "s"}:</p>
      <ul className="grid gap-1">
        {jev.picks.map((p) => (
          <li key={p.choice} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-2">
            <span className="truncate text-foreground">{show(p.choice)}</span>
            <span className="h-2 bg-muted">
              <span className="block h-full bg-primary/40" style={{ width: `${(p.count / max) * 100}%` }}>
                <span className="block h-full bg-primary" style={{ width: `${(p.confident / p.count) * 100}%` }} />
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground">{p.count}{p.confident ? ` (${p.confident} confident)` : ""}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Confidence: {jev.bands.high} at {JEV_CONFIDENT.toFixed(2)}+ · {jev.bands.mid} at 0.60–{JEV_CONFIDENT.toFixed(2)} · {jev.bands.low} below 0.60.
        Solid bars are the confident reads.
      </p>
    </div>
  );
}
