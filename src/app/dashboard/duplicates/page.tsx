"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { Copy, GitMerge, X } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { DuplicateCard, DuplicatesView } from "../../../../convex/duplicates";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { MergeDialog } from "@/components/records/merge-dialog";
import { toast } from "@/lib/toast";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";

type PartyObject = "account" | "contact";

const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

const REASON_LABEL: Record<string, string> = {
  email: "Same email",
  linkedin: "Same LinkedIn",
  domain: "Same domain",
  name_at_company: "Same name at the same company",
  name: "Same name",
  domain_family: "Same domain family",
};

const TABS: ReadonlyArray<{ object: PartyObject; label: string }> = [
  { object: "account", label: "Companies" },
  { object: "contact", label: "People" },
];

function DuplicatesPage() {
  const names = useObjectLabels();
  const [url, setUrl] = useUrlState({ object: "account" });
  const object: PartyObject = url.object === "contact" ? "contact" : "account";
  const list = useAction(api.duplicates.list);
  const dismiss = useAction(api.duplicates.dismiss);
  const [view, setView] = useState<DuplicatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await list({ object }));
      setError(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }, [list, object]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  async function dismissGroup(card: DuplicateCard) {
    const key = card.ids.join("|");
    setBusy(key);
    try {
      await dismiss({ object, ids: card.ids });
      void toast.success("Marked as not duplicates. It will not come back.");
      await load();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const noun = object === "account" ? "companies" : "people";
  return (
    <ViewFrame
      title="Duplicates"
      description="Records that look like the same company or person, strongest match first. Merge a group into one record, or mark it as not duplicates and it stays out of this list."
      controls={
        <div role="tablist" aria-label="Duplicates of" className="flex">
          {TABS.map((t) => (
            <button
              key={t.object}
              type="button"
              role="tab"
              aria-selected={object === t.object}
              onClick={() => setUrl({ object: t.object })}
              className={cn("px-4 py-2 text-xs font-medium", object === t.object ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {names(t.object)?.pluralLabel ?? t.label}
            </button>
          ))}
        </div>
      }
    >
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : view === null ? (
        <LoadingRows />
      ) : view.cards.length === 0 ? (
        <EmptyState icon={Copy} title={`No duplicate ${noun}`} description={`Nothing in your ${noun} looks like the same record twice. This list updates as records come in.`} />
      ) : (
        <>
          <p className="mb-4 text-xs font-medium text-muted-foreground" aria-live="polite">
            {view.count.toLocaleString()}{view.exact ? "" : "+"} {view.count === 1 ? "group" : "groups"} to review
          </p>
          <ul className="space-y-3">
            {view.cards.map((card) => {
              const key = card.ids.join("|");
              return (
                <li key={key} className="border border-border p-4" aria-label={`Duplicate group: ${card.members.map((m) => m.title).join(", ")}`}>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {card.matches.map((m) => (
                      <span key={m.reason} className="border border-border bg-muted px-2 py-0.5 text-xs font-medium" title={m.value}>
                        {REASON_LABEL[m.reason] ?? m.reason}
                        <span className="ml-1 normal-case tracking-normal text-muted-foreground">{m.value}</span>
                      </span>
                    ))}
                  </div>
                  <ul className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {card.members.map((m) => (
                      <li key={m.id} className="min-w-0">
                        <p className="truncate text-sm font-medium">{m.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{m.subtitle || "—"}</p>
                      </li>
                    ))}
                  </ul>
                  {card.size > card.members.length && (
                    <p className="mb-3 text-xs text-muted-foreground">{card.size} records match; this merge takes the first {card.members.length}.</p>
                  )}
                  {view.canAct ? (
                    <div className="flex gap-2">
                      <button type="button" className={btn} disabled={busy === key} onClick={() => setMerging(card.ids)}><GitMerge className="h-3 w-3" /> Merge</button>
                      <button type="button" className={btn} disabled={busy === key} onClick={() => void dismissGroup(card)}><X className="h-3 w-3" /> Not duplicates</button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Only admins and managers can merge or dismiss.</p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {merging && (
        <MergeDialog
          object={object}
          ids={merging}
          onClose={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            void load();
          }}
        />
      )}
    </ViewFrame>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<ViewFrame title="Duplicates"><LoadingRows /></ViewFrame>}>
      <DuplicatesPage />
    </Suspense>
  );
}
