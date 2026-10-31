"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowUpLeft, Loader2, Sparkles, Target } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { FacetsResponse } from "../../../convex/lib/recordContract";
import { NONE } from "../../../services/record-service/src/dimensions";
import type { Rect } from "@/lib/squarify";
import {
  OTHER_KEY,
  currentRow,
  dimensionLabel,
  drill,
  isNeutralKey,
  pivotFilter,
  levelsFor,
  setGroup,
  valueLabel,
  zoomOut,
  type Dimension,
  type Pivot,
  type SegmentMeta,
} from "@/lib/tam-levels";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { AiSegmentDialog } from "./ai-segment-dialog";
import { ViewControls } from "./view-controls";
import { SuggestSegmentsDialog } from "./suggest-segments-dialog";
import { ChallengeIcpDialog } from "./challenge-icp-dialog";
import { ResearchMenu } from "../research/research-menu";
import { Treemap, formatUsd, type TreemapGroup } from "./treemap";
import { SaveIcpDialog } from "./save-icp-dialog";
import { FillPocketDialog } from "./fill-pocket-dialog";
import { coverage } from "./treemap";
import { SelectField } from "@/components/ui/select";

/** Per-run cap (convex/tam.ts RUN_CAP) and rough Jev cost per account (lib/tam/jevSegments.ts). */
const RUN_CAP = 500;
const USD_PER_ACCOUNT = (2000 * 0.042) / 1_000_000;
const MAX_TILES = 18;
const MIN_SHARE = 0.015;

type Job = NonNullable<ReturnType<typeof useQuery<typeof api.tam.jobs>>>[number];

export function TamExplorer({
  pivot,
  onPivot,
  starterSegments,
}: {
  pivot: Pivot;
  onPivot: (pivot: Pivot) => void;
  starterSegments: Array<{ id: string; name: string }>;
}) {
  const facets = useAction(api.tam.facets);
  const segData = useQuery(api.tam.segments);
  const jobs = useQuery(api.tam.jobs);
  const startJob = useMutation(api.tam.startJob);
  const cancelJob = useMutation(api.tam.cancelJob);
  const ensureJtbd = useMutation(api.tam.ensureJtbd);
  const settings = useQuery(api.tamSettings.get);
  const seatPrice = settings?.seatPriceUsd ?? 0;
  // ICP overlay: one saved ICP drawn over the treemap (docs/tam-and-icps.md, step 1). Defaults to the default active ICP.
  const icpData = useQuery(api.icpsInterface.list);
  const activeIcps = useMemo(() => (icpData?.icps ?? []).filter((i) => i.active), [icpData]);
  const [overlayPick, setOverlayPick] = useState<string | null | undefined>(undefined);
  const overlayId = overlayPick === undefined ? (activeIcps.find((i) => i.isDefault) ?? activeIcps[0])?.key ?? null : overlayPick;
  const overlayIcp = activeIcps.find((i) => i.key === overlayId) ?? null;
  const [inIcp, setInIcp] = useState<{ key: string; counts: Map<string, number>; total: number } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  // The market behind the view (docs/tam-and-icps.md, step 2): companies that exist per tile, cached across customers.
  const marketFacets = useAction(api.marketSize.facets);
  // Keyed by the view, so "loading" (another key) and "no market" (this key, null) differ.
  const [market, setMarket] = useState<{ key: string; view: { counts: Map<string, number>; total: number } | null } | null>(null);
  const [fillPocket, setFillPocket] = useState<{ key: string; label: string; market: number } | null>(null);

  // AI fields with choice or yes/no answers are levels too (record service 1.21.0), after the Jev segments.
  const aiFields = useQuery(api.researchAgents.list)?.agents;
  const segments: SegmentMeta[] = useMemo(() => [
    ...(segData?.segments ?? []),
    ...(aiFields ?? [])
      .filter((f) => f.entityType === "account" && (f.kind === "classify" || f.answerType === "boolean"))
      .map((f): SegmentMeta => ({
        key: f.slug, kind: "choice", label: f.label, field: true,
        options: f.kind === "classify" ? (f.options ?? []).map((o) => ({ key: o.key, label: o.label })) : [{ key: "true", label: "Yes" }, { key: "false", label: "No" }],
      })),
  ], [segData, aiFields]);
  const levels = useMemo(() => levelsFor(segments, segData?.jtbdAvailable ?? false), [segments, segData]);
  const dim = currentRow(pivot, levels);
  const metric = pivot.values[0];
  const filter = useMemo(() => pivotFilter(pivot), [pivot]);
  const filterKey = JSON.stringify(filter);
  const traitKey = dim?.startsWith("trait:") ? dim.slice(6) : null;
  const segment = traitKey ? segments.find((s) => !s.field && s.key === traitKey) : undefined;
  const needsJtbdSetup = traitKey === "jtbd" && segData !== undefined && !segment;
  const missingSegment = traitKey !== null && traitKey !== "jtbd" && segData !== undefined && !segment;

  const [data, setData] = useState<FacetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [enterFrom, setEnterFrom] = useState<Rect | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const pivotRef = useRef(pivot);
  pivotRef.current = pivot;
  const loadOptions = useCallback(
    (d: Dimension) =>
      facets({ filter: pivotFilter(pivotRef.current, d), groupBy: d, limit: 1000 }).then((r) => ({
        options: r.groups.map((g) => ({ key: g.key, count: g.count })),
        truncated: r.truncated,
      })),
    [facets],
  );

  // Refetch when the view changes, and as runs make progress.
  const runningJobs = (jobs ?? []).filter((j) => j.status === "running");
  const progressKey = (jobs ?? []).map((j) => `${j.id}:${j.status}:${j.done}`).join(",");
  useEffect(() => {
    if (!dim || needsJtbdSetup || missingSegment) {
      setData(null);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    setError("");
    facets({ filter: JSON.parse(filterKey), groupBy: dim, limit: 500 })
      .then((r) => id === request.current && setData(r))
      .catch((e) => id === request.current && setError(getErrorMessage(e)))
      .finally(() => id === request.current && setLoading(false));
  }, [facets, dim, filterKey, needsJtbdSetup, missingSegment, progressKey]);

  useEffect(() => setOtherOpen(false), [dim, filterKey]);

  // The same breakdown, counted inside the overlay ICP only. Membership changes when a rescore lands: a new
  // score version refetches, and an ICP changed in the last few seconds is read again while its rescore runs.
  const scoreVersion = useQuery(api.icpVersions.list)?.at(-1)?.version ?? 0;
  const overlayKey = overlayIcp && dim ? `${overlayIcp.key}|${dim}|${filterKey}|${progressKey}|${scoreVersion}` : null;
  useEffect(() => {
    if (!overlayKey || !overlayIcp || !dim) return;
    let live = true;
    const load = () =>
      facets({ filter: { ...JSON.parse(filterKey), icpId: overlayIcp.key }, groupBy: dim, limit: 500 })
        .then((r) => live && setInIcp({ key: overlayKey, counts: new Map(r.groups.map((g) => [g.key, g.count])), total: r.total }))
        .catch(() => live && setInIcp(null));
    void load();
    const fresh = Date.now() - overlayIcp.updatedAt < 15_000;
    const retries = fresh ? [2_500, 6_000, 12_000].map((ms) => setTimeout(() => void load(), ms)) : [];
    return () => {
      live = false;
      retries.forEach(clearTimeout);
    };
  }, [facets, overlayKey, overlayIcp, dim, filterKey]);
  const icpCounts = overlayKey && inIcp?.key === overlayKey ? inIcp : null;

  const marketKey = dim ? `${dim}|${filterKey}` : null;
  useEffect(() => {
    if (!marketKey || !dim) return;
    let live = true;
    marketFacets({ filter: JSON.parse(filterKey), groupBy: dim })
      .then((r) => live && setMarket({ key: marketKey, view: r ? { counts: new Map(r.groups.map((g) => [g.key, g.count])), total: r.total } : null }))
      .catch(() => live && setMarket({ key: marketKey, view: null }));
    return () => {
      live = false;
    };
  }, [marketFacets, marketKey, dim, filterKey]);
  const marketCounts = marketKey && market?.key === marketKey ? market.view : null;
  // Sized by market on a view with no market size (an AI dimension, a segment, no index): size by accounts instead.
  const noMarket = pivot.values[0] === "market" && (marketKey === null || (market?.key === marketKey && market.view === null));
  const sizeBy = noMarket ? "count" : metric;

  const ctx = { segments, starterSegments };
  const groups: TreemapGroup[] = useMemo(() => {
    if (!data || !dim) return [];
    // Sized by the market, the market's pockets with no accounts here join as ghost tiles.
    const ghosts = sizeBy === "market" && marketCounts
      ? [...marketCounts.counts.keys()].filter((k) => k !== NONE && !data.groups.some((g) => g.key === k)).map((key) => ({ key, count: 0, revenue: 0, employees: 0 }))
      : [];
    const all = [...data.groups, ...ghosts]
      .map((g) => {
        const opportunity = (g.employees ?? 0) * seatPrice;
        const mkt = marketCounts ? marketCounts.counts.get(g.key) ?? 0 : undefined;
        const ghost = sizeBy === "market" && g.count === 0;
        return {
          key: g.key,
          label: valueLabel(dim, g.key, ctx),
          value: sizeBy === "revenue" ? g.revenue : sizeBy === "opportunity" ? opportunity : sizeBy === "market" ? mkt ?? 0 : g.count,
          count: g.count,
          revenue: g.revenue,
          opportunity,
          neutral: isNeutralKey(dim, g.key),
          inIcp: icpCounts?.counts.get(g.key) ?? (icpCounts ? 0 : undefined),
          market: mkt,
          ghost,
          ...(ghost ? { hint: "Click to fill this pocket" } : {}),
        };
      })
      .filter((g) => g.value > 0)
      .sort((a, b) => b.value - a.value);
    const total = all.reduce((a, g) => a + g.value, 0);
    const keep = all.filter((g, i) => i < MAX_TILES && (i < 6 || g.value / total >= MIN_SHARE));
    const folded = all.slice(keep.length);
    if (otherOpen) return folded;
    if (folded.length < 3) return all;
    return [
      ...keep,
      {
        key: OTHER_KEY,
        label: `${folded.length} smaller groups`,
        value: folded.reduce((a, g) => a + g.value, 0),
        count: folded.reduce((a, g) => a + g.count, 0),
        revenue: folded.reduce((a, g) => a + g.revenue, 0),
        opportunity: folded.reduce((a, g) => a + g.opportunity, 0),
        inIcp: icpCounts ? folded.reduce((a, g) => a + (g.inIcp ?? 0), 0) : undefined,
        market: marketCounts ? folded.reduce((a, g) => a + (g.market ?? 0), 0) : undefined,
        neutral: true,
        hint: "Click to see these groups",
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dim, sizeBy, otherOpen, segments, starterSegments, seatPrice, icpCounts, marketCounts]);

  function zoom(group: TreemapGroup, rect: Rect) {
    if (group.key === OTHER_KEY) {
      setEnterFrom(rect);
      setOtherOpen(true);
      return;
    }
    if (!dim) return;
    if (group.ghost) {
      setFillPocket({ key: group.key, label: group.label, market: group.market ?? 0 });
      return;
    }
    setEnterFrom(rect);
    onPivot(drill(pivot, dim, group.key));
  }

  async function score(segmentKey: string) {
    setBusy(true);
    try {
      await startJob({ kind: "segment", segmentKey, filter });
      toast.success("Scoring with Jev…");
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function setUpJtbd() {
    setBusy(true);
    try {
      await ensureJtbd({});
      await startJob({ kind: "segment", segmentKey: "jtbd", filter });
      toast.success("Classifying jobs to be done with Jev…");
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const unscored = traitKey ? data?.groups.find((g) => g.key === NONE)?.count ?? 0 : 0;
  const scopeTotal = data?.total ?? 0;
  const segmentJob = runningJobs.find((j) => j.kind === "segment" && j.segmentKey === traitKey);
  const revenueJob = runningJobs.find((j) => j.kind === "revenue");
  const canZoomOut = zoomOut(pivot, levels) !== pivot;
  /** Leave a level that can't be shown yet: back up a drill, or start from the top. */
  const back = () => onPivot(canZoomOut ? zoomOut(pivot, levels) : setGroup(pivot, levels[0]));
  const wantsRevenue = pivot.values.includes("revenue");
  const wantsOpportunity = pivot.values.includes("opportunity");

  return (
    <section aria-label="TAM explorer" className="mb-8">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <ViewControls
          pivot={pivot}
          levels={levels}
          current={dim}
          onPivot={onPivot}
          segments={segments}
          starterSegments={starterSegments}
          jtbdAvailable={segData?.jtbdAvailable ?? false}
          loadOptions={loadOptions}
          onNewSegment={() => setDialogOpen(true)}
          onSuggest={() => setSuggestOpen(true)}
          onChallenge={() => setChallengeOpen(true)}
        />
        <div className="flex items-center gap-2">
          {activeIcps.length > 0 && (
            <label className="flex h-8 items-center gap-1.5 border border-border px-2 text-xs font-medium text-muted-foreground">
              <Target className="size-3" />
              <SelectField
                value={overlayId ?? ""}
                onValueChange={(v) => setOverlayPick(v || null)}
                aria-label="ICP overlay"
                className="max-w-44 border-0 bg-transparent normal-case tracking-normal"
                options={[{ value: "", label: "No ICP overlay" }, ...activeIcps.map((i) => ({ value: i.key, label: i.name }))]}
              />
            </label>
          )}
          {icpData?.canEdit && pivot.filters.length > 0 && (
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="flex h-8 items-center gap-1.5 border border-border px-2.5 text-xs font-medium text-muted-foreground hover:border-primary/60 hover:text-foreground"
            >
              <Target className="size-3" /> Save as ICP
            </button>
          )}
          {canZoomOut && (
            <button
              type="button"
              onClick={() => onPivot(zoomOut(pivot, levels))}
              className="flex h-8 items-center gap-1.5 border border-border px-2.5 text-xs font-medium text-muted-foreground hover:border-primary/60 hover:text-foreground"
            >
              <ArrowUpLeft className="size-3" /> Zoom out
            </button>
          )}
          <ResearchMenu filter={filter} scopeCount={scopeTotal} />
        </div>
      </div>


      <div className="mb-3">
        <div className="text-sm text-muted-foreground">
          {dim && data ? (
            <>
              <span className="text-foreground">{scopeTotal.toLocaleString()}</span> accounts
              {marketCounts && (
                <> of <span className="text-foreground">~{marketCounts.total.toLocaleString()}</span> in the market ({coverage(scopeTotal, marketCounts.total)})</>
              )}
              {noMarket && <> (no market size for this view; sized by accounts)</>}
              {overlayIcp && icpCounts && (
                <> · <span className="text-foreground">{icpCounts.total.toLocaleString()}</span> in {overlayIcp.name}{scopeTotal ? ` (${Math.round((icpCounts.total / scopeTotal) * 100)}%)` : ""}</>
              )}
              {wantsOpportunity && seatPrice > 0 && (data.employees ?? 0) > 0 && (
                <> · <span className="text-foreground">{formatUsd((data.employees ?? 0) * seatPrice)}</span> opportunity</>
              )}
              {(wantsRevenue || !wantsOpportunity) && data.revenue > 0 && <> · <span className="text-foreground">{formatUsd(data.revenue)}</span> known revenue</>}
              {" "}by <span className="text-foreground">{dimensionLabel(dim, segments)}</span>
              {otherOpen && (
                <button type="button" onClick={() => setOtherOpen(false)} className="ml-2 underline underline-offset-2 hover:text-foreground">
                  back to all groups
                </button>
              )}
            </>
          ) : dim ? (
            <>Grouping by <span className="text-foreground">{dimensionLabel(dim, segments)}</span></>
          ) : (
            "You've drilled to the last level. Clear a filter to zoom back out."
          )}
        </div>
      </div>

      {/* Run status and the actions that spend Jev. */}
      {[segmentJob, wantsRevenue ? revenueJob : undefined].filter(Boolean).map((job) => (
        <JobBar key={job!.id} job={job!} label={job!.kind === "revenue" ? "Estimating revenue" : `Scoring ${dimensionLabel(dim!, segments)}`} onCancel={() => cancelJob({ jobId: job!.id as Id<"tamJobs"> })} />
      ))}
      {traitKey && !segmentJob && unscored > 0 && (
        <Notice>
          <Sparkles className="size-4 shrink-0 text-primary" />
          <span className="flex-1">
            {unscored.toLocaleString()} account{unscored === 1 ? "" : "s"} here {unscored === 1 ? "isn't" : "aren't"} scored for <b className="font-medium text-foreground">{dimensionLabel(dim!, segments)}</b> yet.
            Jev reads each homepage and answers {segment?.kind === "noul" ? <>“{segment.criterion}”</> : "the question"} per account
            (~${(Math.min(unscored, RUN_CAP) * USD_PER_ACCOUNT).toFixed(2)}{unscored > RUN_CAP ? `, top ${RUN_CAP} by fit` : ""}).
          </span>
          <IntegrationGate feature="jev" note><ActionButton busy={busy} onClick={() => score(traitKey)}>Score {Math.min(unscored, RUN_CAP).toLocaleString()}</ActionButton></IntegrationGate>
        </Notice>
      )}
      {wantsOpportunity && settings && <SeatPriceNotice seatPrice={settings.seatPriceUsd} isDefault={settings.isDefault} />}

      <div className="relative h-[340px] border border-border bg-background p-[2px] md:h-[480px]">
        {needsJtbdSetup ? (
          <SetupCard
            title="Jobs to be done"
            body={
              segData?.jtbdAvailable
                ? "Jev sorts each account in this view by the job your product does that matters most to it, from the jobs your homepage research found, or “none of these”. It reads each account's homepage and firmographics."
                : "This level groups accounts by the jobs your product does, found when your company's homepage was researched. That research hasn't run for this workspace yet, so pick another level for now."
            }
            action={segData?.jtbdAvailable ? <IntegrationGate feature="jev" note><ActionButton busy={busy} onClick={setUpJtbd}>Classify with Jev</ActionButton></IntegrationGate> : null}
            onSkip={back}
          />
        ) : missingSegment ? (
          <SetupCard title="Segment not found" body="This AI segment was deleted." onSkip={back} />
        ) : error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : !dim ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            The accounts below match every filter.
          </div>
        ) : data === null ? (
          <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : groups.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {metric === "revenue"
              ? "No revenue is known for these accounts yet."
              : metric === "opportunity"
                ? "No employee counts are known for these accounts."
                : "No accounts here."}
          </div>
        ) : (
          <Treemap
            key={`${dim}|${filterKey}|${metric}|${otherOpen}`}
            className="h-full"
            groups={groups}
            values={noMarket ? ["count", ...pivot.values.filter((m) => m !== "market" && m !== "count")] : pivot.values}
            onSelect={zoom}
            enterFrom={enterFrom}
            overlay={overlayIcp && icpCounts ? { name: overlayIcp.name } : null}
          />
        )}
        {loading && data && (
          <Loader2 className="absolute right-3 top-3 size-4 animate-spin text-muted-foreground" aria-label="Updating" />
        )}
      </div>
      {data?.truncated && <p className="mt-2 text-xs text-muted-foreground">Showing the 500 largest groups.</p>}

      <SuggestSegmentsDialog
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
        filter={filter}
        onAdded={(key) => {
          onPivot(setGroup(pivot, `trait:${key}`));
          void startJob({ kind: "segment", segmentKey: key, filter }).catch((e) => toast.error(getErrorMessage(e)));
        }}
      />
      <ChallengeIcpDialog open={challengeOpen} onOpenChange={setChallengeOpen} />
      {fillPocket && dim && (
        <FillPocketDialog
          open
          onOpenChange={(o) => !o && setFillPocket(null)}
          pivot={drill(pivot, dim, fillPocket.key)}
          labelOf={(d) => dimensionLabel(d as Dimension, segments)}
          pocketLabel={fillPocket.label}
          market={fillPocket.market}
        />
      )}
      {saveOpen && (
        <SaveIcpDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          pivot={pivot}
          labelOf={(d) => dimensionLabel(d as Dimension, segments)}
          valueLabel={(d, v) => valueLabel(d as Dimension, v, ctx)}
          pocketCount={scopeTotal}
          hasActive={activeIcps.length > 0}
          isFirst={(icpData?.icps.length ?? 0) === 0}
          onSaved={(icpId, active) => active && setOverlayPick(icpId)}
        />
      )}
      <AiSegmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scopeCount={scopeTotal}
        onCreated={(key) => {
          onPivot(setGroup(pivot, `trait:${key}`));
          void startJob({ kind: "segment", segmentKey: key, filter }).catch((e) => toast.error(getErrorMessage(e)));
        }}
      />
    </section>
  );
}

function JobBar({ job, label, onCancel }: { job: Job; label: string; onCancel: () => void }) {
  const pct = job.planned ? Math.round(((job.done + job.errors) / job.planned) * 100) : 0;
  return (
    <div className="mb-3 border border-border bg-card px-4 py-2 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin text-primary" />
        <span className="flex-1 text-foreground">
          {label}: {job.done.toLocaleString()} of {job.planned.toLocaleString()}
          {job.crmMatched ? ` · ${job.crmMatched.toLocaleString()} from CRM` : ""}
          {job.errors ? ` · ${job.errors} failed` : ""}
        </span>
        <span className="font-mono text-muted-foreground">{job.tokens.toLocaleString()} tokens</span>
        <button type="button" onClick={onCancel} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">Stop</button>
      </div>
      <div className="h-1 bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-3 border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">{children}</div>;
}

function ActionButton({ busy, onClick, children }: { busy: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      {children}
    </button>
  );
}

function SetupCard({ title, body, action, onSkip }: { title: string; body: string; action?: React.ReactNode; onSkip: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="font-display text-lg text-foreground">{title}</div>
      <p className="max-w-lg text-sm text-muted-foreground">{body}</p>
      <div className="flex items-center gap-3">
        {action}
        <button type="button" onClick={onSkip} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Go back
        </button>
      </div>
    </div>
  );
}

/** The opportunity metric's assumption, editable in place. */
function SeatPriceNotice({ seatPrice, isDefault }: { seatPrice: number; isDefault: boolean }) {
  const setSeatPrice = useMutation(api.tamSettings.setSeatPrice);
  const [draft, setDraft] = useState(String(seatPrice));
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(String(seatPrice)), [seatPrice]);
  const parsed = Number(draft.replace(/[$,\s]/g, ""));
  const dirty = Number.isFinite(parsed) && parsed > 0 && parsed !== seatPrice;

  async function save() {
    setSaving(true);
    try {
      await setSeatPrice({ seatPriceUsd: parsed });
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Notice>
      <span className="flex-1">
        Opportunity is each account&apos;s employees × an annual price per employee{isDefault ? " (a placeholder; set your own)" : ""}.
        Accounts with no employee count add nothing.
      </span>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save();
        }}
      >
        <label className="flex items-center gap-1 text-xs">
          $
          <input
            aria-label="Annual price per employee (USD)"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-20 border border-border bg-background px-2 py-1 text-sm tabular-nums"
          />
          / employee / yr
        </label>
        {dirty && <ActionButton busy={saving} onClick={save}>Save</ActionButton>}
      </form>
    </Notice>
  );
}
