"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { AccountsFilter } from "../../../convex/lib/recordContract";
import { RECORD_CREDITS, type RunEstimate } from "../../../convex/lib/research/runPlan";
import { PROBE_SIZE } from "../../../convex/lib/research/probe";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { JevDistribution, ProbeVerdictLine } from "@/components/research/probe-verdict";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { SelectField } from "@/components/ui/select";

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function formatUsd(usd: number): string {
  return usd === 0 ? "$0" : usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;
}

/** Which contacts a contact field's run covers (convex/researchAgents.ts contactScopeValidator). */
export type ContactScopeArg = { kind: "all" } | { kind: "view"; viewId: Id<"savedViews"> } | { kind: "ids"; ids: string[] };
export type RunTarget = { slug: string; label: string; entityType: "account" | "contact" };

/** What a run touches and costs, as lines of text. Ceilings from the loop's limits, not measurements. */
export function EstimateLines({ e, who, noun = "account", billed }: { e: RunEstimate; who: string; noun?: "account" | "contact"; billed: boolean }) {
  return (
    <ul className="grid gap-1.5 text-sm">
      <li>
        <b className="font-medium">Up to {e.records.toLocaleString()} {noun}{e.records === 1 ? "" : "s"}</b>{noun === "account" ? ", best fit first" : ""}. {noun === "account" ? "Accounts" : "Contacts"} that
        already have an answer are skipped and cost nothing.
      </li>
      <li>
        <b className="font-medium">Time:</b> {e.records ? `research takes at most about ${formatDuration(e.secondsMax)}` : "none"}. This is a ceiling ({e.concurrency} {noun}s at a
        time, each cut off after {e.accountSeconds} seconds), not a forecast.
      </li>
      <li>
        <b className="font-medium">{billed ? "Canon's research model" : `${who} ChatGPT plan`}:</b> up to {e.modelCallsMax.toLocaleString()} model calls and {e.pagesMax.toLocaleString()} page{" "}
        reads. {billed ? "The credits below pay for it." : "Canon doesn't bill this."}
      </li>
      <li>
        <b className="font-medium">Credits:</b>{" "}
        {billed ? `up to ${e.creditsMax.toLocaleString()}, ${RECORD_CREDITS} per answer found. A ${noun} without an answer costs nothing.` : "none. Research on a ChatGPT plan is free."}
      </li>
      <li>
        <b className="font-medium">Cost to Canon:</b>{" "}
        {e.jevCallsMax
          ? `Jev ${e.extractionCallsMax > 0 ? "checks proposed answers" : "reads what no page answers and checks proposed answers"}: up to ${e.jevCallsMax.toLocaleString()} requests, costing ${formatUsd(e.jevUsdMax)}.`
          : "No Jev calls. Auto-accept is off and Jev doesn't read this field type."}
      </li>
      {e.extractionCallsMax > 0 && <li>
        Clairic extraction: up to {e.extractionCallsMax.toLocaleString()} requests. Conservative estimated cost to Canon: {formatUsd(e.extractionUsdMax)}. Credits stay the same.
      </li>}
    </ul>
  );
}

/** For a contact field: all contacts, a saved view, or the rows selected on the contacts list. */
function ContactScopePicker({ selected, mode, onMode, viewId, onView }: {
  selected: number;
  mode: "all" | "view" | "ids";
  onMode: (m: "all" | "view" | "ids") => void;
  viewId: string;
  onView: (id: string) => void;
}) {
  const views = useQuery(api.savedViews.list, { object: "contact" });
  const radio = (m: "all" | "view" | "ids", text: string) => (
    <label className="flex items-center gap-2">
      <input type="radio" name="contact-scope" checked={mode === m} onChange={() => onMode(m)} /> {text}
    </label>
  );
  return (
    <fieldset className="grid gap-1.5 text-sm" role="radiogroup">
      <legend className="mb-1 text-xs text-muted-foreground">Which contacts</legend>
      {radio("all", "All contacts")}
      <div className="flex items-center gap-2">
        {radio("view", "A saved view")}
        <SelectField aria-label="Saved view" disabled={mode !== "view"} value={viewId} onValueChange={onView}
          options={[
            { value: "", label: views?.length === 0 ? "No saved contact views" : "Choose a view" },
            ...(views ?? []).map((v) => ({ value: v._id, label: `${v.name}${v.shared ? " (shared)" : ""}` })),
          ]} />
      </div>
      {selected > 0 && radio("ids", `The ${selected.toLocaleString()} selected row${selected === 1 ? "" : "s"}`)}
    </fieldset>
  );
}

/** Shows a run's scope, time and cost before it starts, then starts it on confirm, or first tries it on a sample. */
export function RunPreviewDialog({
  target, filter, selectedIds, onClose, onStart,
}: {
  target: RunTarget | null;
  filter: AccountsFilter;
  /** Contacts selected on the list this was opened from. */
  selectedIds?: string[];
  onClose: () => void;
  /** `capCredits`: set only for a run that spends credits (one not on the caller's ChatGPT plan). */
  onStart: (slug: string, contacts: ContactScopeArg | undefined, capCredits: number | undefined) => Promise<void>;
}) {
  const preview = useAction(api.researchAgentActions.previewRun);
  const startProbe = useMutation(api.researchAgents.startProbe);
  const [data, setData] = useState<Awaited<ReturnType<typeof preview>> | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const slug = target?.slug;
  const contacts = target?.entityType === "contact";
  const selected = selectedIds?.length ?? 0;
  const [mode, setMode] = useState<"all" | "view" | "ids">("all");
  const [viewId, setViewId] = useState("");
  // Opening on a selection starts from it.
  useEffect(() => { if (slug) setMode(selected > 0 ? "ids" : "all"); }, [slug, selected > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const scope = useMemo<ContactScopeArg | null>(
    () => (!contacts ? null : mode === "ids" && selectedIds?.length ? { kind: "ids", ids: selectedIds } : mode === "view" ? (viewId ? { kind: "view", viewId: viewId as Id<"savedViews"> } : null) : { kind: "all" }),
    [contacts, mode, viewId, selectedIds],
  );
  const noun = contacts ? "contact" : "account";
  // The cap: by default the whole run, or as much of it as the workspace's credits pay for, in whole records.
  const [cap, setCap] = useState("");
  const fullCap = data ? Math.min(data.estimate.creditsMax, Math.floor(data.spendable / RECORD_CREDITS) * RECORD_CREDITS) : 0;
  useEffect(() => { if (data) setCap(String(fullCap)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const capCredits = Number(cap);
  const capOk = Number.isFinite(capCredits) && capCredits >= RECORD_CREDITS;
  // Research on a ChatGPT plan is free: it needs no cap, however few credits the workspace has.
  const billed = !!data && !data.chatgptConnected;
  // Without a ChatGPT plan a run still goes, on Canon's research model and credits, where the deployment has one.
  const canRun = !!data && (data.chatgptConnected || data.canonModel);

  useEffect(() => {
    if (!slug || (contacts && !scope)) return setData(null);
    let live = true;
    setData(null);
    setError("");
    preview(contacts ? { slug, contacts: scope! } : { slug, filter }).then((d) => live && setData(d), (e) => live && setError(getErrorMessage(e)));
    return () => { live = false; };
    // The filter object is rebuilt each render; its contents only change when the target does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, JSON.stringify(filter), JSON.stringify(scope)]);

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Run “{target?.label}”?</DialogTitle>
        <DialogDescription>Estimates for this run. Nothing starts until you confirm.</DialogDescription>
        {contacts && <ContactScopePicker selected={selected} mode={mode} onMode={setMode} viewId={viewId} onView={setViewId} />}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : contacts && !scope ? (
          <p className="text-sm text-muted-foreground">Choose a saved view to see the estimate.</p>
        ) : !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Counting {noun}s…</p>
        ) : (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              {data.inScope.toLocaleString()} {noun}{data.inScope === 1 ? "" : "s"} in scope
              {data.inScope > data.estimate.cap ? `; one run does at most ${data.estimate.cap}, run again to continue` : ""}.
            </p>
            <EstimateLines e={data.estimate} who="Your" noun={noun} billed={!data.chatgptConnected} />
            {contacts && <p className="text-xs text-muted-foreground">Each contact is answered from a web search for them, their company&apos;s website, and their profile page when the record has one. An answer needs a quote that names the person.</p>}
            {data.latestProbe && (
              <div className="border-l-2 border-border pl-2">
                <p className="text-xs text-muted-foreground">Last sample, {new Date(data.latestProbe.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}:</p>
                <ProbeVerdictLine verdict={data.latestProbe.verdict} />
                {data.latestProbe.verdict.jev && <JevDistribution jev={data.latestProbe.verdict.jev} className="mt-1.5" />}
              </div>
            )}
            {/* Only research on a model Canon pays for spends credits, so only that has a cap to set. */}
            {!data.chatgptConnected && <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Cap this run at</span>
              <input
                type="number" inputMode="numeric" min={RECORD_CREDITS} step={RECORD_CREDITS} value={cap} onChange={(e) => setCap(e.target.value)}
                aria-label="Credit cap" className="w-24 border border-border bg-background px-2 py-1 text-sm"
              />
              <span>credits</span>
              <span className="text-xs text-muted-foreground">
                {capOk ? `about ${Math.floor(capCredits / RECORD_CREDITS).toLocaleString()} ${noun}s. ` : `At least ${RECORD_CREDITS}. `}
                The workspace has {Math.floor(data.spendable).toLocaleString()} left.
              </span>
            </label>}
            {!data.chatgptConnected && capOk && capCredits > data.spendable && (
              <p className="text-xs text-muted-foreground">That is more than the workspace has: the run stops when its credits run out.</p>
            )}
            {!data.chatgptConnected && (data.canonModel ? (
              <p className="text-xs text-muted-foreground">You haven&apos;t connected ChatGPT, so this run uses Canon&apos;s research model and spends credits. Sign in under Integrations → ChatGPT to research for free.</p>
            ) : (
              <p className="text-sm text-destructive">Your ChatGPT sign-in is missing or expired, so this run would fail. Sign in under Integrations → ChatGPT first.</p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          {/* A run no bigger than a probe would just be the probe. */}
          {data && data.estimate.records > PROBE_SIZE && <button
            type="button"
            title={`Research a random ${PROBE_SIZE} of the ${noun}s this run would, and see whether the question works before spending the rest. Their answers count toward the run.`}
            disabled={!canRun || data.estimate.records === 0 || starting}
            onClick={() => {
              setStarting(true);
              startProbe(contacts ? { slug: slug!, contacts: scope! } : { slug: slug!, filter })
                .then((res) => (res.refused ? toast.error(res.refused) : toast.success(`Trying “${target?.label}” on ${PROBE_SIZE} ${noun}s. The verdict shows on AI fields.`)))
                .catch((e) => toast.error(getErrorMessage(e)))
                .finally(() => { setStarting(false); onClose(); });
            }}
            className="border border-border px-3 py-1.5 text-xs font-medium hover:border-primary disabled:opacity-60"
          >
            Try on {PROBE_SIZE} first
          </button>}
          <button
            type="button"
            disabled={!canRun || data.estimate.records === 0 || (billed && !capOk) || starting}
            onClick={() => {
              setStarting(true);
              void onStart(slug!, scope ?? undefined, billed ? capCredits : undefined).finally(() => { setStarting(false); onClose(); });
            }}
            className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
          >
            {starting && <Loader2 className="size-3 animate-spin" />} Start run
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
