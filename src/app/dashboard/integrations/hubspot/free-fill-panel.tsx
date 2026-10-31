"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { Loader2, ScanSearch, Sparkles } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Panel } from "@/components/salesforce-sync/ui";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type Run = NonNullable<FunctionReturnType<typeof api.enrichFreeFillRuns.progress>>;

const primary =
  "inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50";

const RUN_KEY_STORAGE = "canon.freeFill.runKey";
const SOURCE_LABEL = { pdl: "People Data Labs", crustdata: "Crustdata", sec: "SEC filing", estimate: "Estimate", name: "Name lookup" } as const;
const VIA_LABEL = { domain: "domain", name: "domain + name check", root: "root domain", crustdata: "Crustdata", lookup: "name lookup (domain only, for review)" } as const;
const GAP_LABEL = { noDomain: "no domain and no name match", notFound: "not in any free source", namesDisagree: "domain found, but under another company's name" } as const;
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const num = (n: number) => n.toLocaleString();

/**
 * Free fill, step by step: read the portal's companies, show how complete each field is and how far free sources
 * take it, then hand the fills to a patch plan for review. Nothing is written until that plan is approved.
 */
export function FreeFillPanel() {
  const coverage = useAction(api.enrichFreeFill.coverage);
  const createPlan = useAction(api.enrichFreeFill.createPlan);
  const [busy, setBusy] = useState<"check" | "plan" | null>(null);
  const [includeEstimates, setIncludeEstimates] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);
  // The last check's key survives a reload, so a long check (and its report) is still there when you come back.
  useEffect(() => setRunKey(window.localStorage.getItem(RUN_KEY_STORAGE)), []);
  const run = useQuery(api.enrichFreeFillRuns.progress, runKey ? { runKey } : "skip") ?? null;
  const checking = busy === "check" || (run !== null && (run.stage === "counting" || run.stage === "reading" || run.stage === "matching"));
  // The report builds as chunks are matched; it is shown live and final once the run is done.
  const lookup = run?.lookup ?? { mode: "http", version: null, domains: 0, rows: 0, error: null };
  const report = run?.report ? { ...run.report, truncated: run.truncated, lookup, indexError: lookup.error } : null;

  async function check() {
    setBusy("check");
    setPlanId(null);
    const key = crypto.randomUUID();
    setRunKey(key);
    window.localStorage.setItem(RUN_KEY_STORAGE, key);
    try {
      await coverage({ runKey: key });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function plan() {
    setBusy("plan");
    try {
      const result = await createPlan({ includeEstimates });
      if (result.status === "nothing_to_fill") return void toast.info("Nothing left to fill. A recent change may already have filled these fields.");
      setPlanId(result.patchPlanId);
      toast.success(`Plan ready: ${num(result.operations)} fills to review${result.more ? "; run it again after approving for the next batch" : ""}.`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const estimates = report?.fields.find((f) => f.property === "annualrevenue")?.bySource.estimate ?? 0;
  const toWrite = report ? report.fillableCells - (includeEstimates ? 0 : estimates) : 0;

  return (
    <Panel title="Free fill" testId="hubspot-free-fill">
      {checking && <CheckProgress progress={run} />}
      {run?.stage === "error" && (
        <p className="mb-4 border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">The check stopped: {run.error}</p>
      )}
      {!report ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[62ch] text-sm text-muted-foreground">
            See how complete your companies are (industry, size, revenue, location, LinkedIn page, year founded) and how many blanks we can fill
            for free. Checking only reads HubSpot.
          </p>
          <button onClick={() => void check()} disabled={busy !== null || checking} className={primary}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            Check my coverage
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <p className="text-lg font-medium">
              {num(report.companies)} companies have {num(report.emptyCells)} empty fields.{" "}
              {report.fillableCells > 0 ? (
                <span className="text-primary">We can fill {num(report.fillableCells)} of them for free.</span>
              ) : (
                <span className="text-muted-foreground">We found nothing we can fill yet.</span>
              )}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              We matched {num(report.matched)} of {num(report.companies)} companies
              {report.withoutDomain > 0 && <> ({num(report.withoutDomain)} {report.withoutDomain === 1 ? "has" : "have"} no domain in HubSpot)</>}.
              {report.truncated && " This portal was checked on its first 1,000,000 companies."}
            </p>
            {(report.indexError || (report.lookup.domains > 0 && report.lookup.rows === 0)) && (
              <p className="mt-2 border border-warning/40 bg-warning/15 p-2 text-sm text-warning">
                {report.indexError
                  ? "The company index isn't available right now, so only SEC revenue is shown."
                  : `The company index found none of your ${num(report.lookup.domains)} domains, which points to an index problem rather than your data.`}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Company index: {report.lookup.mode === "http" ? `record service ${report.lookup.version ?? "version unknown"}` : "not connected on this deployment"}; looked up{" "}
              {num(report.lookup.domains)} domains, found {num(report.lookup.rows)}.
              {report.lookup.error && <> Error: {report.lookup.error.slice(0, 160)}</>}
            </p>
          </div>

          <MatchBreakdown report={report} />

          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-normal">Field</th>
                <th className="w-[45%] py-1.5 pr-3 font-normal">Coverage now → after free fill</th>
                <th className="py-1.5 pr-3 text-right font-normal">Filled</th>
                <th className="py-1.5 text-right font-normal">We add</th>
              </tr>
            </thead>
            <tbody>
              {report.fields.map((f) => {
                const now = pct(f.filled, report.companies);
                const add = pct(f.fillable, report.companies);
                return (
                  <tr key={f.property} className="border-t border-border/60">
                    <td className="py-2 pr-3">{f.label}</td>
                    <td className="py-2 pr-3">
                      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" title={`${now}% now, ${now + add}% after`}>
                        <div className="h-full bg-foreground/40" style={{ width: `${now}%` }} />
                        <div className="h-full bg-primary" style={{ width: `${add}%` }} />
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{now}%</td>
                    <td className="py-2 text-right tabular-nums">
                      {f.fillable > 0 ? (
                        <span className="font-medium text-primary" title={[...Object.entries(f.bySource).map(([s, n]) => `${SOURCE_LABEL[s as keyof typeof SOURCE_LABEL]}: ${num(n as number)}`), f.sourceEmpty ? `${num(f.sourceEmpty)} matched companies have no value for this in any free source` : ""].filter(Boolean).join("; ")}>
                          +{num(f.fillable)} <span className="text-xs font-normal text-muted-foreground">→ {now + add}%</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {report.samples.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">What the writes look like</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Company</th>
                    <th className="py-1 pr-3 font-normal">Field</th>
                    <th className="py-1 pr-3 font-normal">Value</th>
                    <th className="py-1 font-normal">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {report.samples.slice(0, 12).map((s) => (
                    <tr key={`${s.companyId}:${s.property}`} className="border-t border-border/60">
                      <td className="py-1.5 pr-3">{s.companyName}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{report.fields.find((f) => f.property === s.property)?.label}</td>
                      <td className="max-w-[24ch] truncate py-1.5 pr-3">{s.display}</td>
                      <td className="py-1.5 text-muted-foreground">{SOURCE_LABEL[s.source]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.fillableCells > 0 && (
            <div className="space-y-3 border-t border-border/60 pt-4">
              {estimates > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={includeEstimates} onChange={(e) => setIncludeEstimates(e.target.checked)} />
                  <span>
                    Include {num(estimates)} revenue estimates
                    <span className="block text-xs text-muted-foreground">
                      Based on industry and company size. They landed within one revenue band for {Math.round(report.calibration.withinOneBand * 100)}% of{" "}
                      {num(report.calibration.companies)} public companies we tested. SEC-reported revenue is always included.
                    </span>
                  </span>
                </label>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void plan()} disabled={busy !== null || checking || toWrite === 0} className={primary}>
                  {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Review {num(toWrite)} fills
                </button>
                <button onClick={() => void check()} disabled={busy !== null || checking} className={secondary}>
                  {checking && <Loader2 className="h-4 w-4 animate-spin" />}
                  Check again
                </button>
                {planId && (
                  <Link href={`/dashboard/patch-plans?plan=${planId}`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                    Open the plan to approve →
                  </Link>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                We only fill empty fields and never overwrite a value. Nothing is written to HubSpot until you approve the plan, and each write checks
                that the field is still empty.
              </p>
            </div>
          )}
          {report.fillableCells === 0 && (
            <button onClick={() => void check()} disabled={busy !== null || checking} className={secondary}>
              {checking && <Loader2 className="h-4 w-4 animate-spin" />}
              Check again
            </button>
          )}
          <p className="text-xs text-muted-foreground">{report.attribution} (CC BY 4.0). Revenue from SEC EDGAR filings.</p>
        </div>
      )}
    </Panel>
  );
}

const STAGES = [
  { key: "counting", label: "Count companies" },
  { key: "reading", label: "Read from HubSpot" },
  { key: "matching", label: "Match free sources" },
] as const;
/** Companies per chunk, as convex/enrichFreeFill.ts reads them. */
const CHUNK = 2_000;

/** The check's live progress: reading and matching run side by side, so the bar is half each. */
function CheckProgress({ progress }: { progress: Run | null }) {
  const stage = progress?.stage ?? "counting";
  const at = Math.max(0, STAGES.findIndex((s) => s.key === stage));
  const read = progress?.read ?? 0;
  const total = progress?.total ?? null;
  const readFrac = stage === "matching" ? 1 : total ? Math.min(1, read / total) : 0;
  const expectedChunks = stage === "matching" ? (progress?.chunks ?? 0) : total ? Math.ceil(total / CHUNK) : Math.max(1, progress?.chunks ?? 1);
  const matchFrac = expectedChunks ? Math.min(1, (progress?.matchedChunks ?? 0) / expectedChunks) : 0;
  const pctDone = stage === "counting" ? 2 : 2 + 98 * (readFrac + matchFrac) / 2;
  const matched = progress?.report?.companies ?? 0;
  const label =
    stage === "counting" ? "Counting your companies…"
      : `Read ${num(read)}${total ? ` of ${num(total)}` : ""} companies · matched ${num(matched)}`;
  return (
    <div className="mb-6 space-y-2" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-sm">
        <span className="inline-flex items-center gap-2 font-medium"><Loader2 className="h-4 w-4 animate-spin" />{label}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(pctDone)}%</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pctDone}%` }} />
      </div>
      <ol className="flex gap-4 text-xs text-muted-foreground">
        {STAGES.map((s, i) => (
          <li key={s.key} className={i < at ? "text-foreground" : i === at ? "font-medium text-primary" : undefined}>
            {i < at ? "✓ " : ""}{s.label}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">You can leave this page; the check keeps running and the report below fills in as it goes.</p>
    </div>
  );
}

/** How companies were matched and why the rest weren't: where the remaining blanks come from. */
function MatchBreakdown({ report }: { report: Run["report"] & object }) {
  const via = Object.entries(report.matchedVia ?? {}).filter(([, n]) => n) as Array<[keyof typeof VIA_LABEL, number]>;
  const gaps = Object.entries(report.gaps ?? {}).filter(([, n]) => n) as Array<[keyof typeof GAP_LABEL, number]>;
  if (!via.length && !gaps.length) return null;
  return (
    <div className="grid gap-4 text-sm sm:grid-cols-2">
      {via.length > 0 && <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Matched {num(report.matched)} companies by</h3>
        <ul className="space-y-0.5">
          {via.map(([k, n]) => <li key={k} className="flex justify-between gap-4"><span>{VIA_LABEL[k]}</span><span className="tabular-nums">{num(n)}</span></li>)}
        </ul>
      </div>}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Still unmatched</h3>
        <ul className="space-y-0.5">
          {gaps.map(([k, n]) => <li key={k} className="flex justify-between gap-4"><span>{GAP_LABEL[k]}</span><span className="tabular-nums">{num(n)}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
