"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAction, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Building2, Loader2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { AccountRow, AccountStatus } from "../../../../convex/lib/recordContract";
import { explainFit, explainGates } from "../../../../convex/lib/fitExplain";
import { ViewFrame, ReadFailure, SelectionBar, EmptyState, LoadingRows } from "@/components/dashboard";
import { useUrlState } from "@/lib/url-state";
import { GrowthBadge, HeatBadge } from "@/components/crm/signals-ui";
import { heatChunks, signalDomain } from "../../../../convex/lib/signals/heat";
import { ResearchClaimFallback } from "@/components/crm/research-claim-fallback";
import { AddRecordsDialog, useFillTick } from "@/components/crm/add-records-dialog";
import { CsvImport } from "@/components/records/csv-import";
import { ArchiveSelected, ArchivedLink, useCanArchive } from "@/components/records/archive-records";
import {
  ACCOUNT_STATUSES,
  FitBar,
  StatusSelect,
  formatEmployees,
  newIdempotencyKey,
  titleCase,
} from "@/components/crm/crm-ui";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { DEFAULT_PV, parsePivot, pivotFilter, serializePivot } from "@/lib/tam-levels";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TamExplorer } from "@/components/tam/tam-explorer";
import { CollapsibleTreemap } from "@/components/tam/collapsible-treemap";
import { formatUsd } from "@/components/tam/treemap";
import { CallSuggestions } from "@/components/crm/call-suggestions";
import { RecordLink, RecordQuickView, useRecordsSaved } from "@/components/records/record-context";
import { refreshLimit, refreshRows, useKeepSettled } from "@/components/records/live-rows";

// `line`: query lines every company must pass, separated by ";" (a module's link to a territory and the lines above it), named by `of`.
const DEFAULTS = { segment: "", status: "", icp: "", q: "", minFit: "", sort: "fit", dir: "desc", pv: DEFAULT_PV, line: "", of: "", fill: "" };
const ICP_QUERIES = { icps: { query: api.icpsInterface.list, args: {} } };
/** Radix Select reserves "" for "no value", so "any" stands in for an empty filter. */
const ANY = "any";
type SortField = "fit" | "name" | "employees" | "updatedAt";

export default function AccountsPage() {
  return (
    <Suspense fallback={<div className="p-4 sm:p-8"><LoadingRows /></div>}>
      <AccountsView />
    </Suspense>
  );
}

function AccountsView() {
  const plural = useObjectLabels()("account")!.pluralLabel;
  const [state, setState] = useUrlState(DEFAULTS);
  // Raw presence distinguishes an explicit empty key from ordinary Add records.
  const fillIcp = useSearchParams().get("fill") ?? undefined;
  const list = useAction(api.records.list);
  const edit = useAction(api.records.edit);
  const session = useQuery(api.researchSessions.forMyOrg);
  // What the workspace last scored with (icpVersions): its saved ICPs' gates, or older weights, so the explanation matches the stored fit.
  const scoredWith = useQuery(api.icpVersions.list)?.at(-1) ?? null;
  const icpResult = useQueries(ICP_QUERIES).icps as FunctionReturnType<typeof api.icpsInterface.list> | undefined | Error;
  const icps = (icpResult instanceof Error ? null : icpResult)?.icps ?? [];
  const icpName = (id: string) => icps.find((i) => i.key === id)?.name ?? "an ICP";
  const me = useQuery(api.users.me);
  const team = useQuery(api.users.list);

  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const canArchive = useCanArchive("account");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [qDraft, setQDraft] = useState(state.q ?? "");
  const requestId = useRef(0);
  const cancelRequests = useCallback(() => { requestId.current++; }, []);
  // Heat for every row loaded, in chunks the query accepts. Loading more rows adds chunks; earlier ones keep their subscriptions.
  // Keyed on the domains, not the rows: a refresh that changes no domain keeps its subscriptions.
  const heatKey = JSON.stringify(heatChunks((rows ?? []).map((r) => r.domain)));
  const heatRequests = useMemo(
    () => Object.fromEntries((JSON.parse(heatKey) as string[][]).map((domains, i) => [`c${i}`, { query: api.signals.heatByDomain, args: { domains } }])),
    [heatKey],
  );
  const heatResults = useQueries(heatRequests);
  // A chunk answers null for a role that sees only some companies: its heat comes from the action that admits them (CP14).
  const heatScoped = useAction(api.signals.heatByDomainScoped);
  const nullChunks = Object.entries(heatResults).filter(([, r]) => r === null).map(([k]) => k).join(",");
  const [scopedHeat, setScopedHeat] = useState<{ key: string; heat: Record<string, { score: number; label: string; count: number; growth: string[] }> }>();
  useEffect(() => {
    if (!nullChunks) return;
    let on = true;
    const chunks = JSON.parse(heatKey) as string[][];
    Promise.all(nullChunks.split(",").map((k) => heatScoped({ domains: chunks[Number(k.slice(1))] ?? [] })))
      .then((pages) => { if (on) setScopedHeat({ key: heatKey + nullChunks, heat: Object.assign({}, ...pages) }); })
      .catch((cause: unknown) => console.warn("Heat:", cause));
    return () => { on = false; };
  }, [nullChunks, heatKey, heatScoped]);
  const freshHeat = useMemo(() => {
    const merged: Record<string, { score: number; label: string; count: number; growth: string[] }> = {};
    let settled = true;
    for (const r of Object.values(heatResults)) {
      if (r === undefined) settled = false;
      else if (r !== null && !(r instanceof Error)) Object.assign(merged, r);
    }
    if (nullChunks) {
      if (scopedHeat?.key === heatKey + nullChunks) Object.assign(merged, scopedHeat.heat);
      else settled = false;
    }
    return { merged, settled };
  }, [heatResults, nullChunks, heatKey, scopedHeat]);
  // Re-keyed chunks are briefly undefined: keep the badges already shown until they resolve.
  const heat = useKeepSettled(freshHeat.merged, freshHeat.settled) ?? freshHeat.merged;
  const pivot = useMemo(() => parsePivot(state.pv), [state.pv]);
  const pathFilterKey = JSON.stringify(pivotFilter(pivot));

  const request = useCallback(
    (after?: string, limit = 50) => ({
      filter: {
        ...JSON.parse(pathFilterKey),
        ...(state.segment ? { segmentId: state.segment } : {}),
        ...(state.status ? { status: state.status as AccountStatus } : {}),
        ...(state.icp ? { icpId: state.icp } : {}),
        ...(state.q ? { q: state.q } : {}),
        ...(state.minFit ? { minFit: Number(state.minFit) / 100 } : {}),
      },
      sort: { field: (state.sort || "fit") as SortField, dir: (state.dir === "asc" ? "asc" : "desc") as "asc" | "desc" },
      limit,
      ...(after ? { cursor: after } : {}),
      ...(state.line ? { lines: state.line.split(";").map((l) => l.trim()).filter(Boolean) } : {}),
    }),
    [pathFilterKey, state.segment, state.status, state.icp, state.q, state.minFit, state.sort, state.dir, state.line],
  );

  const importStatus = session?.importStatus;
  const fillTick = useFillTick();
  const [added, setAdded] = useState(0);
  const [adding, setAdding] = useState(false);
  // A filter change loads the first page; anything else that adds accounts refreshes the loaded rows in place.
  const loaded = useRef<AccountRow[] | null>(null);
  loaded.current = rows;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // The request the loaded rows answer: a refresh merges only into rows of the same filters.
  const loadedFor = useRef<unknown>(null);
  const load = useCallback((refresh: boolean) => {
    const id = ++requestId.current;
    const inPlace = refresh && loadedFor.current === request;
    setPending(true);
    setError("");
    list(request(undefined, inPlace ? refreshLimit(loaded.current?.length ?? 0) : 50))
      .then((page) => {
        if (id !== requestId.current) return;
        loadedFor.current = request;
        const next = inPlace
          ? refreshRows(loaded.current, page.rows, { current: cursorRef.current, fresh: page.nextCursor })
          : { rows: page.rows, cursor: page.nextCursor };
        setRows(next.rows);
        setTotal(page.total);
        setCursor(next.cursor);
        setError("");
      })
      .catch((cause) => {
        if (id === requestId.current) setError(getErrorMessage(cause));
      }).finally(() => { if (id === requestId.current) setPending(false); });
  }, [list, request]);

  useEffect(() => { load(false); return cancelRequests; }, [load, cancelRequests]);
  useRecordsSaved(() => load(true));

  // Fill progress, the TAM import and a hand-added record; the first value of each is not a change.
  const progress = fillTick === undefined || session === undefined ? undefined : JSON.stringify([fillTick, importStatus, session?.importedAccounts, added]);
  const seenProgress = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (progress === undefined || progress === seenProgress.current) return;
    const first = seenProgress.current === undefined;
    seenProgress.current = progress;
    if (!first) load(true);
  }, [progress, load]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if ((state.q ?? "") !== qDraft) setState({ q: qDraft });
    }, 300);
    return () => clearTimeout(handle);
  }, [qDraft, state.q, setState]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    const id = requestId.current;
    try {
      const page = await list(request(cursor));
      if (id !== requestId.current) return;
      setRows((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  // Optimistic triage: update the row immediately, roll back on failure.
  async function triage(row: AccountRow, patch: { status?: AccountStatus; ownerId?: string | null }) {
    const previous = row;
    setRows((current) =>
      current?.map((r) => (r.id === row.id ? { ...r, ...patch, ownerId: patch.ownerId === null ? undefined : patch.ownerId ?? r.ownerId } : r)) ?? null,
    );
    try {
      await edit({ object: "account", id: row.id, patch, idempotencyKey: newIdempotencyKey() });
    } catch (cause) {
      setRows((current) => current?.map((r) => (r.id === row.id ? previous : r)) ?? null);
      toast.error(`Could not update ${row.name}: ${getErrorMessage(cause)}`);
    }
  }

  const segments = session?.segments ?? [];
  const importing = importStatus === "pending" || importStatus === "running";
  const ownerName = (id?: string) => team?.find((u) => u._id === id)?.name;

  return (
    <ViewFrame title={plural} actions={[
      { id: "accounts-refresh", label: "Refresh", onClick: () => load(true), disabled: pending },
      { id: "accounts-add", label: "Add records", onClick: () => setAdding(true), primary: true },
    ]} secondaryActions={<CsvImport object="account" label={plural.toLowerCase()} className="view-action" />} filterReset={{ onClick: () => { setQDraft(""); setState({ ...DEFAULTS }); setSelected(new Set()); }, disabled: !state.q && !state.segment && !state.status && !state.icp && !state.minFit && !state.line && state.pv === DEFAULT_PV }} controls={<div className="flex flex-wrap items-end gap-3">

        <FilterSelect
          label="Segment"
          value={state.segment || ANY}
          onChange={(segment) => setState({ segment: segment === ANY ? "" : segment })}
          className="min-w-56"
          options={[
            { value: ANY, label: "All segments" },
            ...segments.map((segment) => ({ value: segment.id, label: `${segment.name} (${segment.count})` })),
            ...(state.segment && !segments.some((s) => s.id === state.segment) ? [{ value: state.segment, label: state.segment }] : []),
          ]}
        />
        {icps.some((i) => i.active) && (
          <FilterSelect
            label="ICP"
            value={state.icp || ANY}
            onChange={(icp) => setState({ icp: icp === ANY ? "" : icp })}
            className="min-w-44"
            options={[{ value: ANY, label: "Any ICP" }, ...icps.filter((i) => i.active || i.key === state.icp).map((i) => ({ value: i.key, label: i.name }))]}
          />
        )}
        <FilterSelect
          label="Status"
          value={state.status || ANY}
          onChange={(status) => setState({ status: status === ANY ? "" : status })}
          className="min-w-32"
          options={[{ value: ANY, label: "Any status" }, ...ACCOUNT_STATUSES.map((status) => ({ value: status, label: titleCase(status) }))]}
        />
        <FilterSelect
          label="Min fit"
          value={state.minFit || ANY}
          onChange={(minFit) => setState({ minFit: minFit === ANY ? "" : minFit })}
          className="min-w-20"
          options={[{ value: ANY, label: "Any" }, ...["50", "70", "90"].map((v) => ({ value: v, label: `${v}+` }))]}
        />
        <FilterSelect
          label="Sort"
          value={`${state.sort}:${state.dir}`}
          onChange={(value) => {
            const [sort, dir] = value.split(":");
            setState({ sort, dir });
          }}
          className="min-w-40"
          options={[
            { value: "fit:desc", label: "Best fit" },
            { value: "employees:desc", label: "Largest" },
            { value: "name:asc", label: "Name A–Z" },
            { value: "updatedAt:desc", label: "Recently updated" },
          ]}
        />
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Search
          <input
            aria-label="Search accounts"
            value={qDraft}
            onChange={(event) => setQDraft(event.target.value)}
            placeholder="Name or domain"
            className="h-8 min-w-48 border border-border bg-background px-2.5 text-sm text-foreground outline-none hover:border-foreground/30 focus:border-primary"
          />
        </label>
        <ArchivedLink object="account" />
      </div>}>
      <CallSuggestions kind="account" className="mb-4" />
      <AddRecordsDialog open={adding || fillIcp !== undefined} onOpenChange={(open) => {
        setAdding(open);
        if (!open && fillIcp !== undefined) setState({ fill: "" });
      }} icpId={fillIcp} object="account" onAdded={() => setAdded((n) => n + 1)} />

      {state.line && (
        <div className="mb-4 flex flex-wrap items-center gap-2 border border-border bg-card px-4 py-2 text-sm" role="status">
          <span className="text-muted-foreground">{state.of ? `${state.of}:` : "On the line"}</span>
          <code className="break-all font-mono text-xs">{state.line}</code>
          <button type="button" className="ml-auto text-xs underline underline-offset-2 hover:text-foreground" onClick={() => setState({ line: "", of: "" })}>Clear</button>
        </div>
      )}
      <ResearchClaimFallback hasClaimedSession={session === undefined ? undefined : session !== null} />
      {importing && (
        <div role="status" className="mb-4 flex items-center gap-2 border border-border bg-card px-4 py-3 text-sm">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> Adding your researched accounts for {session?.domain}… {(session?.importedAccounts ?? 0).toLocaleString()} ready.
        </div>
      )}
      {session?.importStatus === "failed" && (
        <div className="mb-4 border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          TAM import failed: {session.importError}
        </div>
      )}
      {session?.icpSource === "heuristic" && (
        <div className="mb-4 border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
          This TAM uses a heuristic starter ICP. {session.icpNote}{" "}
          <Link href="/dashboard/icps" className="underline underline-offset-2 hover:text-foreground">Derive or edit your ICPs</Link>
        </div>
      )}

      <CollapsibleTreemap>
        <TamExplorer
          pivot={pivot}
          onPivot={(next) => setState({ pv: serializePivot(next) })}
          starterSegments={segments}
        />
      </CollapsibleTreemap>


      {/* Only before the first rows: once the table shows, a refresh reports in its summary bar, so the table never shifts. */}
      {pending && rows === null && <p role="status" className="mb-2 text-xs text-muted-foreground">Loading accounts…</p>}
      {error && <ReadFailure message={error} retry={() => load(true)} retained={rows !== null} />}

      {rows === null ? (
        error ? null : <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={importing ? "Your TAM is importing" : state.q || state.segment || state.status || state.icp || state.minFit ? "No accounts match" : "No accounts yet"}
          description={importing ? "Accounts will appear here in a few seconds." : "Clear a filter, or start a new research session from the homepage."}
        />
      ) : (
        <>
          <SelectionBar count={rows.filter((row) => selected.has(row.id)).length} summary={<>{rows.length} of {total.toLocaleString()} accounts<span role="status">{pending ? " · Updating…" : ""}</span></>} onClear={() => setSelected(new Set())}>
            <ArchiveSelected
              object="account"
              ids={rows.filter((r) => selected.has(r.id)).map((r) => r.id)}
              onDone={() => { setSelected(new Set()); load(true); }}
            />
          </SelectionBar>
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  {canArchive && (
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all accounts"
                        checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Industry</th>
                  <th className="px-3 py-2">Employees</th>
                  <th className="px-3 py-2">Country</th>
                  <th className="px-3 py-2">Revenue</th>
                  <th className="px-3 py-2">Fit</th>
                  <th className="px-3 py-2">Heat</th>
                  <th className="px-3 py-2" title="Growth signals: hiring, site updated, blogging, social">Growth</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-border hover:bg-muted/30"
                  >
                    {canArchive && (
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.name}`}
                          checked={selected.has(row.id)}
                          onChange={() => setSelected((cur) => {
                            const next = new Set(cur);
                            if (!next.delete(row.id)) next.add(row.id);
                            return next;
                          })}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-1">
                        <RecordLink object="account" id={row.id} className="record-name min-w-0 hover:underline">
                          {row.name}
                        </RecordLink>
                        <RecordQuickView object="account" id={row.id} label={row.name} />
                      </div>
                      <div className="text-xs text-muted-foreground">{row.domain}</div>
                    </td>
                    <td className="px-3 py-2">{titleCase(row.industry)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatEmployees(row.employees)}</td>
                    <td className="px-3 py-2">{titleCase(row.country)}</td>
                    <td className="px-3 py-2 tabular-nums" title={row.revenueSource === "estimate" ? `Jev estimate${row.revenueConfidence !== undefined ? `, ${Math.round(row.revenueConfidence * 100)}% confidence` : ""}` : row.revenueSource === "crm" ? "From your CRM" : undefined}>
                      {row.revenue === undefined ? <span className="text-muted-foreground">—</span> : formatUsd(row.revenue)}
                      {row.revenueSource === "estimate" && <span className="ml-1 text-xs font-medium text-muted-foreground">est.</span>}
                    </td>
                    <td className="px-3 py-2"><FitBar fit={row.fit} explanation={scoredWith ? (scoredWith.gates ? explainGates(row, scoredWith.gates, row.fit, icpName) : explainFit(row, scoredWith.weights, row.fit)) : null} /></td>
                    <td className="px-3 py-2"><HeatBadge heat={heat[signalDomain(row.domain)]} /></td>
                    <td className="px-3 py-2"><GrowthBadge growth={heat[signalDomain(row.domain)]?.growth} /></td>
                    <td className="px-3 py-2">
                      <StatusSelect value={row.status} onChange={(status) => triage(row, { status })} />
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Select value={row.ownerId ?? ANY} onValueChange={(value) => triage(row, { ownerId: value === ANY ? null : value })}>
                        <SelectTrigger size="sm" aria-label="Owner" className="max-w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ANY}>Unassigned</SelectItem>
                          {me && <SelectItem value={me._id}>Me ({me.name})</SelectItem>}
                          {team?.filter((u) => u._id !== me?._id && u.isActive).map((u) => (
                            <SelectItem key={u._id} value={u._id}>{u.name}</SelectItem>
                          ))}
                          {row.ownerId && row.ownerId !== me?._id && !team?.some((u) => u._id === row.ownerId && u.isActive) && (
                            <SelectItem value={row.ownerId}>{ownerName(row.ownerId) ?? row.ownerId}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-4 border border-border px-4 py-2 text-xs font-medium hover:bg-muted"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </ViewFrame>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className={className}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
