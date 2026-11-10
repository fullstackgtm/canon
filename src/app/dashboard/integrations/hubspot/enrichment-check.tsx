"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, ScanSearch } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import type { Consolidation } from "@/components/field-standards/shared";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { CheckProgress, useCoverageCheck } from "./free-fill-panel";

const button =
  "inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50";

/**
 * PDL and Crustdata are sources only after free fill's coverage check has matched them to the portal's companies. A
 * Canon field that reads them says when they have nothing yet, or newer matches than its preview, and runs the check.
 * Columns read before the latest matches are read again once, so the Values tab and its suggestions see their values.
 */
export function EnrichmentCheck({ c }: { c: Consolidation }) {
  const sources = c.columns.filter((col) => col.enrichment && (c.sources ?? []).includes(col.key));
  const freshness = useQuery(api.enrichmentMatches.freshness, sources.length ? {} : "skip");
  const { run, checking, start } = useCoverageCheck();
  const rediscover = useMutation(api.fieldConsolidations.rediscover);
  const profiledAt = c.profiles.find((p) => p.object === "companies")?.updatedAt ?? null;
  const behind = Boolean(sources.length && freshness?.newestAt && profiledAt !== null && freshness.newestAt > profiledAt);
  // The newest match a re-read was started for: a later check's matches start another, a failed one may be retried.
  const reread = useRef<number | null>(null);
  const newestAt = freshness?.newestAt ?? null;
  useEffect(() => {
    if (!behind || checking || c.stage !== "ready" || newestAt === null || reread.current === newestAt) return;
    reread.current = newestAt;
    rediscover({ id: c._id, keywords: c.keywords }).catch((error) => {
      reread.current = null;
      toast.error(getErrorMessage(error));
    });
  }, [behind, checking, newestAt, c.stage, c._id, c.keywords, rediscover]);
  if (!sources.length || !freshness) return null;
  const names = sources.map((col) => col.label).join(" and ");

  if (checking) {
    return (
      <div className="mb-3 border border-border p-3">
        <CheckProgress progress={run} note={`You can leave this page. When the check finishes, preview again to read ${names}.`} />
      </div>
    );
  }
  if (c.stage === "discovering" || c.stage === "profiling") {
    return (
      <p className="mb-3 flex items-center gap-2 border border-border p-3 text-sm" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading the columns again, with the latest {names} values. The Values tab and its suggestions use them once this finishes.
      </p>
    );
  }
  const previewedAt = c.status.state === "readyToApply" ? c.status.previewedAt : null;
  const unmatched = freshness.matched === 0;
  const message = !unmatched
    ? previewedAt !== null && freshness.newestAt !== null && freshness.newestAt > previewedAt
      ? `The coverage check matched companies after this preview. Preview again to read ${names}.`
      : null
    : run?.stage === "error"
      ? `The coverage check stopped before it matched any company to ${names}: ${run.error}`
      : run?.stage === "done"
        ? `The last coverage check matched none of your companies to ${names}, so they add nothing here.${run.lookup?.error ? " The PDL company index wasn't available during that check, so try again later." : ""}`
        : `${names} ${sources.length === 1 ? "has" : "have"} no values yet, so this field's preview can't use them. The coverage check matches your companies to them; it only reads HubSpot.`;
  if (!message) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
      <p className="min-w-0 flex-1">{message}</p>
      {unmatched && (
        <button type="button" onClick={() => void start()} className={button}>
          <ScanSearch className="h-4 w-4" />
          {run?.stage === "done" || run?.stage === "error" ? "Check again" : "Check coverage"}
        </button>
      )}
    </div>
  );
}
