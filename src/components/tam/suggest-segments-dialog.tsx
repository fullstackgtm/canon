"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { AccountsFilter } from "../../../convex/lib/recordContract";

type Run = NonNullable<ReturnType<typeof useQuery<typeof api.tamSuggestions.latest>>>;
type Suggestion = Run["suggestions"][number];

const VERDICT: Record<string, string> = {
  splits: "Splits this view",
  "one-sided": "Nearly everyone answers the same",
  "mostly-unsure": "Mostly unsure: homepages rarely show this",
};

/**
 * Recommended AI segments: the LLM (your ChatGPT plan) proposes traits from
 * research, deals and calls; Jev measures each on a sample of this view.
 */
export function SuggestSegmentsDialog({
  open,
  onOpenChange,
  filter,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: AccountsFilter;
  onAdded: (key: string) => void;
}) {
  const run = useQuery(api.tamSuggestions.latest);
  const start = useMutation(api.tamSuggestions.start);
  const add = useMutation(api.tamSuggestions.add);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const working = run?.status === "proposing" || run?.status === "measuring";

  async function recommend() {
    setBusy("start");
    setError("");
    try {
      await start({ filter });
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function accept(runId: Id<"tamSuggestionRuns">, s: Suggestion) {
    setBusy(`add:${s.index}`);
    setError("");
    try {
      const { key } = await add({ runId, index: s.index });
      onOpenChange(false);
      onAdded(key);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> Recommended AI segments
        </DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          An LLM on your ChatGPT plan reads your research, won and lost deals, and call insights, and proposes traits
          that could separate good-fit accounts. Jev then scores each one on the best-fit accounts in your current view,
          so you can see which ones actually split the market before you score everything.
        </DialogDescription>

        {working ? (
          <div className="flex items-center gap-2 border border-border px-3 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            {run?.status === "proposing" ? "Proposing segments…" : `Measuring ${run?.suggestions.length ?? 0} segments with Jev…`}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {run?.status === "done"
                ? `Last run ${new Date(run.createdAt).toLocaleString()}${run.sampleSize ? ` · measured on ${run.sampleSize} accounts` : ""}${run.model ? ` · ${run.model}` : ""}`
                : "Uses the accounts in your current view."}
            </p>
            <button
              type="button"
              onClick={() => void recommend()}
              disabled={busy !== null}
              className="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
            >
              {busy === "start" && <Loader2 className="size-3 animate-spin" />}
              {run ? "Recommend again" : "Recommend segments"}
            </button>
          </div>
        )}

        {run?.status === "failed" && run.error && <p className="text-xs text-destructive">{run.error}</p>}
        {run?.note && <p className="text-xs text-muted-foreground">{run.note}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}

        {run && run.suggestions.length > 0 && (
          <ul className="grid gap-2">
            {run.suggestions.map((s) => (
              <li key={s.index} className="border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-xs font-medium text-muted-foreground">
                        {s.kind === "noul" ? "yes / no" : "choice"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-foreground/90">{s.criterion}</p>
                  </div>
                  <button
                    type="button"
                    disabled={s.added || busy !== null || working}
                    onClick={() => void accept(run.id, s)}
                    className="flex shrink-0 items-center gap-1 border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-60"
                  >
                    {busy === `add:${s.index}` ? <Loader2 className="size-3 animate-spin" /> : s.added ? <Check className="size-3" /> : null}
                    {s.added ? "Added" : "Add and score"}
                  </button>
                </div>
                {s.options && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.options.map((o) => (
                      <span key={o.key} className="border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{o.label}</span>
                    ))}
                  </div>
                )}
                {s.counts && <SplitBar suggestion={s} />}
                {s.rationale && <p className="mt-2 text-xs text-muted-foreground">{s.rationale}</p>}
                {s.basis.length > 0 && (
                  <ul className="mt-1 grid gap-0.5">
                    {s.basis.map((q) => (
                      <li key={q} className="truncate text-[11px] italic text-muted-foreground">“{q}”</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

const SEGMENT_COLORS = ["bg-primary", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-500"];

function SplitBar({ suggestion: s }: { suggestion: Suggestion }) {
  const counts = s.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const parts =
    s.kind === "noul"
      ? [
          { key: "yes", label: "Yes", color: "bg-primary" },
          { key: "no", label: "No", color: "bg-muted-foreground/60" },
        ]
      : [
          ...(s.options ?? []).map((o, i) => ({ key: o.key, label: o.label, color: SEGMENT_COLORS[i % SEGMENT_COLORS.length] })),
          { key: "none", label: "None", color: "bg-muted-foreground/60" },
        ];
  const all = [...parts, { key: "unsure", label: "Unsure", color: "bg-muted" }].filter((p) => counts[p.key]);
  return (
    <div className="mt-2">
      <div className="flex h-2 w-full overflow-hidden border border-border">
        {all.map((p) => (
          <div key={p.key} className={p.color} style={{ width: `${(counts[p.key] / total) * 100}%` }} title={`${p.label}: ${counts[p.key]}`} />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {all.map((p) => (
          <span key={p.key} className="flex items-center gap-1">
            <span className={cn("inline-block size-2", p.color)} /> {p.label} {Math.round((counts[p.key] / total) * 100)}%
          </span>
        ))}
        {s.verdict && <span className={cn("ml-auto", s.verdict === "splits" ? "text-primary" : "")}>{VERDICT[s.verdict] ?? s.verdict}</span>}
      </div>
    </div>
  );
}
