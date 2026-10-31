"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { Crosshair } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { PlayRow } from "../../../../convex/dealPlays";
import { CHANNEL_LABEL, HEALTH_LABEL, type Health } from "../../../../convex/lib/plays/model";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { SelectField } from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/background-activity";
import { toast } from "@/lib/toast";
import { cn, formatCurrency, getErrorMessage } from "@/lib/utils";

const TONE: Record<Health, string> = {
  on_track: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  needs_attention: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  at_risk: "border-red-500/50 text-red-700 dark:text-red-400",
};

export default function PlaysPage() {
  const list = useAction(api.dealPlays.list);
  const dealPage = useQuery(api.recipes.forOrg)?.dealPage;
  const coreRoles = dealPage?.coreRoles.length ?? 0;
  // A decision window closing within the deal recipe's urgent window reads amber.
  const urgent = dealPage?.settings.settings.windowUrgentDays;
  const soonDays = typeof urgent === "number" ? urgent : null;
  const [rows, setRows] = useState<PlayRow[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [owner, setOwner] = useState("");
  const [closeFrom, setCloseFrom] = useState("");
  const [closeTo, setCloseTo] = useState("");
  const [activity, setActivity] = useState("");
  const [sort, setSort] = useState("priority");
  const [now] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    list({}).then((r) => { if (live) setRows(r); }, (cause) => { if (live) { setRows([]); void toast.error(getErrorMessage(cause)); } });
    return () => { live = false; };
  }, [list]);
  const shown = (rows ?? []).filter((r) => {
    if (!showClosed && r.isClosed) return false;
    if (owner && (owner === "unassigned" ? r.ownerId !== null : r.ownerId !== owner)) return false;
    if (closeFrom && (!r.closeDate || r.closeDate < closeFrom)) return false;
    if (closeTo && (!r.closeDate || r.closeDate > closeTo)) return false;
    if (activity === "none") return !r.stateHidden && r.lastTouch === null;
    if (activity) {
      if (!r.lastTouch) return false;
      const [direction, days] = activity.split(":");
      const recent = r.lastTouch.at >= now - Number(days) * 86_400_000;
      if (direction === "within" ? !recent : recent) return false;
    }
    return true;
  });
  if (sort !== "priority") shown.sort((a, b) => {
    const ac = a.stateSummary?.completeness;
    const bc = b.stateSummary?.completeness;
    if (!ac?.total) return bc?.total ? 1 : 0;
    if (!bc?.total) return -1;
    return (sort === "least" ? 1 : -1) * (ac.established / ac.total - bc.established / bc.total);
  });
  const owners = [...new Map((rows ?? []).flatMap((r) => r.ownerId ? [[r.ownerId, r.ownerName ?? "Unnamed owner"] as const] : [])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const stateHidden = rows?.some((r) => r.stateHidden);
  const open = (rows ?? []).filter((r) => !r.isClosed);
  const atRisk = open.filter((r) => r.health === "at_risk").length;
  const owed = open.reduce((n, r) => n + (r.summary?.repliesOwed ?? 0), 0);
  const multi = open.filter((r) => (r.summary?.engaged ?? 0) >= 2).length;

  return (
    <ViewFrame title="Plays" description="Review qualification, stage reads and open concerns across the pipeline. Open a deal to work its plan.">
      {rows === null ? <LoadingRows /> : rows.length === 0 ? (
        <EmptyState icon={Crosshair} title="No plays yet" description="A deal gets a play the first time you set its window, research its account or plan a touch on its page." />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-medium text-muted-foreground">
            <span>{open.length} open plays</span>
            <span className={cn(atRisk && "text-red-600")}>{atRisk} at risk</span>
            <span className={cn(owed && "text-red-600")}>{owed} replies owed</span>
            <span>{multi} multi-threaded</span>
            <label className="ml-auto flex items-center gap-2 normal-case tracking-normal">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed deals
            </label>
          </div>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span className="block">Owner</span>
              <SelectField value={owner} onValueChange={setOwner} options={[{ value: "", label: "All owners" }, { value: "unassigned", label: "Unassigned" }, ...owners.map(([value, label]) => ({ value, label }))]} className="w-44" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span className="block">Close date from</span>
              <input type="date" value={closeFrom} onChange={(e) => setCloseFrom(e.target.value)} className="h-7 border border-border bg-background px-2 text-xs" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span className="block">Close date through</span>
              <input type="date" value={closeTo} onChange={(e) => setCloseTo(e.target.value)} className="h-7 border border-border bg-background px-2 text-xs" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span className="block">Last activity</span>
              <SelectField value={activity} onValueChange={setActivity} disabled={stateHidden} options={[
                { value: "", label: "Any activity" },
                ...[7, 30, 90].map((days) => ({ value: `within:${days}`, label: `Within ${days} days` })),
                ...[7, 30, 90].map((days) => ({ value: `older:${days}`, label: `Older than ${days} days` })),
                { value: "none", label: "No recorded touch" },
              ]} className="w-44" />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span className="block">Sort</span>
              <SelectField value={sort} onValueChange={setSort} options={[{ value: "priority", label: "At risk / closing soon" }, { value: "least", label: "Least complete first", disabled: stateHidden }, { value: "most", label: "Most complete first", disabled: stateHidden }]} className="w-48" />
            </label>
            <button type="button" onClick={() => { setOwner(""); setCloseFrom(""); setCloseTo(""); setActivity(""); setSort("priority"); setShowClosed(false); }} className="inline-flex h-7 items-center border border-border px-2 text-xs font-medium hover:bg-muted">Reset</button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">{shown.length} shown. Qualification and concerns reflect the last state run. Last touch reflects the last keeper check.</p>
          {stateHidden && <p className="mb-3 text-xs text-muted-foreground" role="note">Deal state and last touch are hidden because your role has restricted access.</p>}
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Deal</th>
                  <th className="px-3 py-2">Qualification</th>
                  <th className="px-3 py-2">Stage read / CRM</th>
                  <th className="px-3 py-2">Top objection</th>
                  <th className="px-3 py-2">Top risk</th>
                  <th className="px-3 py-2">Main issue</th>
                  <th className="px-3 py-2">Last touch</th>
                  <th className="px-3 py-2">Health</th>
                  <th className="px-3 py-2">Window</th>
                  <th className="px-3 py-2">Coverage</th>
                  <th className="px-3 py-2">Engaged</th>
                  <th className="px-3 py-2">Replies owed</th>
                  <th className="px-3 py-2">Next touch</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Owner</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const s = r.summary;
                  const state = r.stateSummary;
                  const completeness = state?.completeness;
                  const today = new Date().toISOString().slice(0, 10);
                  return (
                    <tr key={r.streamId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link href={`/dashboard/records/deal/${r.streamId}`} className="record-name font-medium hover:underline">{r.name}</Link>
                        <div className="text-xs text-muted-foreground">{[r.stage, r.closeDate && `closes ${r.closeDate}`].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-xs" title={state ? `Generated ${new Date(state.generatedAt).toLocaleString()}` : undefined}>
                        {completeness ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span aria-hidden="true" className={cn("size-2 rounded-full", completeness.total === 0 ? "bg-muted-foreground" : completeness.established === completeness.total ? "bg-primary" : completeness.established > 0 ? "bg-warning" : "bg-destructive")} />
                          {completeness.established} / {completeness.total}
                        </span> : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {state ? <><div>{state.stage.label} / {r.stage ?? "—"}</div>{state.stage.mismatch && <span className="text-warning">Stage mismatch</span>}</> : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs"><div className="w-40 truncate" title={state?.topObjection ?? undefined}>{state?.topObjection ?? "—"}</div></td>
                      <td className="px-3 py-2 text-xs"><div className="w-40 truncate" title={state?.topRisk ?? undefined}>{state?.topRisk ?? "—"}</div></td>
                      <td className="px-3 py-2 text-xs"><div className="w-64 truncate" title={state?.mainIssue}>{state?.mainIssue || "—"}</div></td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums">{r.lastTouch ? <><div>{new Date(r.lastTouch.at).toLocaleDateString()}</div><div className="text-muted-foreground">{CHANNEL_LABEL[r.lastTouch.channel]}</div></> : "—"}</td>
                      <td className="px-3 py-2">
                        {r.health ? (
                          <span className={cn("whitespace-nowrap border px-1.5 py-0.5 text-xs font-medium", TONE[r.health])} title={r.checkedAt ? `Checked ${formatRelativeTime(r.checkedAt)}` : undefined}>{HEALTH_LABEL[r.health]}</span>
                        ) : <span className="text-xs text-muted-foreground">Checking soon</span>}
                      </td>
                      <td className="px-3 py-2">
                        {r.windowLabel || r.windowDays !== null ? (
                          <>
                            <div className="truncate">{r.windowLabel ?? "Window"}</div>
                            {r.windowDays !== null && <div className={cn("tabular-nums text-xs", r.windowDays < 0 ? "text-red-600" : soonDays !== null && r.windowDays <= soonDays ? "text-amber-600" : "text-muted-foreground")}>{r.windowDays < 0 ? `closed ${-r.windowDays} d ago` : `${r.windowDays} d left`}</div>}
                          </>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-xs">{s ? `${s.coreFilled}/${coreRoles} roles · ${s.people} people` : "—"}</td>
                      <td className={cn("px-3 py-2 tabular-nums text-xs", s && s.engaged <= 1 && s.people > 1 && "text-amber-600")}>{s ? `${s.engaged} of ${s.people}` : "—"}</td>
                      <td className={cn("px-3 py-2 tabular-nums text-xs", s?.repliesOwed && "font-semibold text-red-600")}>{s ? s.repliesOwed : "—"}</td>
                      <td className={cn("px-3 py-2 tabular-nums text-xs", s?.nextDue && s.nextDue < today && "text-red-600")}>{s?.nextDue ?? (s ? (s.openSteps ? "no date" : "nothing planned") : "—")}</td>
                      <td className="px-3 py-2 text-right">{r.amount === null ? "—" : formatCurrency(r.amount, r.currency ?? "USD")}</td>
                      <td className="px-3 py-2">{r.ownerName ?? "—"}</td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={15} className="px-3 py-6 text-center text-muted-foreground">No plays match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ViewFrame>
  );
}
