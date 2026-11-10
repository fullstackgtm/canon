"use client";

import type { ReactNode } from "react";
import type { AccountStatus } from "../../../convex/lib/recordContract";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FitExplanation, FitReason } from "../../../convex/lib/fitExplain";

export const ACCOUNT_STATUSES: AccountStatus[] = ["new", "working", "qualified", "disqualified"];

const STATUS_TONE: Record<AccountStatus, string> = {
  new: "text-muted-foreground",
  working: "text-primary",
  qualified: "text-emerald-600 dark:text-emerald-400",
  disqualified: "text-destructive",
};

const pointsLabel = (points: number) => (points > 0 ? `+${points}` : String(points));

/** The fit score bar. With an explanation, hovering it lists the terms behind the score. */
export function FitBar({ fit, explanation }: { fit: number; explanation?: FitExplanation | null }) {
  const pct = Math.round(fit * 100);
  const bar = (
    <div className="flex items-center gap-2" title={explanation ? undefined : `ICP fit ${pct}%`}>
      <span className="w-9 text-right text-xs tabular-nums">{pct}</span>
      <span className="h-1.5 w-16 overflow-hidden bg-muted">
        <span
          className={cn("block h-full", pct >= 80 ? "bg-primary" : pct >= 50 ? "bg-amber-500" : "bg-muted-foreground/40")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
  if (!explanation) return bar;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{bar}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <p className="mb-1 font-medium">ICP fit {pct}</p>
        <ul className="space-y-0.5">
          {explanation.reasons.map((reason, i) => (
            <li key={i} className={cn("flex gap-2", !reason.matched && "opacity-70")}>
              <span className="w-7 shrink-0 text-right tabular-nums">{pointsLabel(reason.points)}</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export type FitCitation = {
  attribute: string;
  value: string | number | boolean | null;
  sourceKind: string;
  quote: string;
  sourceUrl: string;
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The record page's "Why this fit" panel: each term of the score, with the cited fact it rests on when there is one. */
export function WhyThisFit({
  explanation,
  citations,
  values,
  children,
  title = "Why this fit",
}: {
  title?: string;
  explanation: FitExplanation | null;
  citations: FitCitation[];
  /** The row's current industry, country and employees: a citation shows only while it still states that value. */
  values: Record<string, string | number | undefined>;
  children?: ReactNode;
}) {
  const citationFor = (reason: FitReason) => {
    if (!reason.matched) return undefined;
    const found = citations.find((c) => c.attribute === reason.dimension);
    const current = values[reason.dimension];
    return found && current !== undefined && String(found.value).toLowerCase() === String(current).toLowerCase() ? found : undefined;
  };
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {!explanation ? (
        <p className="text-sm text-muted-foreground">
          No breakdown for this score. It needs the workspace ICP that scored this account, which is not on file here.
        </p>
      ) : (
        <>
          <ul className="space-y-3 text-sm">
            {explanation.reasons.map((reason, i) => {
              const cited = citationFor(reason);
              return (
                <li key={i} className="flex gap-3">
                  <span className={cn("w-9 shrink-0 text-right text-xs tabular-nums", reason.matched ? "text-foreground" : "text-muted-foreground")}>
                    {pointsLabel(reason.points)}
                  </span>
                  <div className={cn(!reason.matched && "text-muted-foreground")}>
                    {reason.text}
                    {cited && (
                      <blockquote className="mt-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                        &ldquo;{cited.quote}&rdquo;{" "}
                        <a href={cited.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline">
                          {hostOf(cited.sourceUrl)}
                        </a>
                      </blockquote>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Fit {Math.round(explanation.total)} out of 100
            {explanation.capped === "high" ? ", capped at 100" : explanation.capped === "low" ? ", floored at 0" : ""}.
          </p>
        </>
      )}
      {children}
    </section>
  );
}

export function StatusSelect({
  value,
  onChange,
  disabled,
  label = "Status",
}: {
  value: AccountStatus;
  onChange: (next: AccountStatus) => void;
  disabled?: boolean;
  label?: string;
}) {
  // A span stops clicks (including ones in the portalled menu) from reaching a clickable table row.
  return (
    <span className="inline-block" onClick={(event) => event.stopPropagation()}>
      <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as AccountStatus)}>
        <SelectTrigger size="sm" aria-label={label} className={cn(" ", STATUS_TONE[value])}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ACCOUNT_STATUSES.map((status) => (
            <SelectItem key={status} value={status} className={cn("text-xs font-medium", STATUS_TONE[status])}>
              {titleCase(status)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

export function formatEmployees(n: number | undefined) {
  if (n === undefined) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function titleCase(value: string | undefined) {
  if (!value) return "—";
  return value.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, "and");
}

export function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
