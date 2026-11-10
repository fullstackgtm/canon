"use client";

/**
 * A cadence's acceptance and response rates by one trait of its people, picked by the user:
 * title, company, seniority, time in role, or recent LinkedIn activity.
 */
import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SEGMENT_DIMENSIONS, SEGMENT_LABEL, type SegmentDimension, type SegmentRow } from "../../../../convex/lib/linkedin/segments";
import { SelectField } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/utils";

const pct = (n: number | null) => (n === null ? "–" : `${n}%`);
/** Below this many people a rate is shown dimmed: too few to compare. */
const SMALL = 10;

/** `revision` changes whenever the cadence's funnel does, so the table reloads as people accept and reply. */
export function SegmentBreakdown({ cadenceId, enrolled, revision }: { cadenceId: Id<"linkedinCadences">; enrolled: number; revision: string }) {
  const load = useAction(api.linkedinCadences.segments);
  const [by, setBy] = useState<SegmentDimension>("seniority");
  // The answer for one segment choice: rows, an error, or hidden (the caller may not see who is in the cadence).
  const [result, setResult] = useState<{ by: SegmentDimension; rows?: SegmentRow[]; truncated?: boolean; error?: string; hidden?: true } | null>(null);

  useEffect(() => {
    let live = true;
    load({ cadenceId, by })
      .then((out) => { if (live) setResult(out ? { by, ...out } : { by, hidden: true }); })
      .catch((e) => { if (live) setResult({ by, error: getErrorMessage(e) }); });
    return () => { live = false; };
  }, [load, cadenceId, by, revision]);

  if (result?.hidden || enrolled === 0) return null;
  const current = result?.by === by ? result : null;
  const rows = current?.rows ?? null;
  const error = current?.error ?? null;
  return (
    <section aria-label="Results by segment">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Results by</h3>
        <SelectField
          aria-label="Segment by"
          value={by}
          onValueChange={(v) => setBy(v as SegmentDimension)}
          options={SEGMENT_DIMENSIONS.map((d) => ({ value: d, label: SEGMENT_LABEL[d] }))}
        />
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      ) : !rows ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-2 overflow-x-auto border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">{SEGMENT_LABEL[by]}</th>
                <th className="px-2 py-1 text-right font-medium">People</th>
                <th className="px-2 py-1 text-right font-medium">Invited</th>
                <th className="px-2 py-1 text-right font-medium">Accepted</th>
                <th className="px-2 py-1 text-right font-medium">Response rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.segment} className={r.people < SMALL ? "border-t border-border/60 text-muted-foreground" : "border-t border-border/60"}>
                  <td className="px-2 py-1.5">{r.segment}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.people}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.invited}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" title={`${r.accepted} of ${r.invited}`}>{pct(r.acceptRate)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" title={`${r.replied} replied of ${r.connected} connected`}>{pct(r.responseRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Response rate is replies out of everyone connected. Dimmed rows have fewer than {SMALL} people.
        {by === "tenure" && " Time in role comes from enriched LinkedIn profiles."}
        {by === "activity" && " Activity is what the sender saw before inviting; people invited before the check show as not checked."}
        {current?.truncated && " Counts the newest 2,000 people."}
      </p>
    </section>
  );
}
