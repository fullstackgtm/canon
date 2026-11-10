"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, Pencil, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DISCOVERY_VERSION } from "../../../convex/lib/consolidate";
import { LoadingRows } from "@/components/dashboard";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";
import { LineageView, type Tab } from "./lineage-view";
import { fieldsHref, type Consolidation } from "./shared";
import { SourcesView } from "./sources-view";
import { ValuesView } from "./values-view";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "lineage", label: "Lineage" },
  { id: "sources", label: "Sources" },
  { id: "values", label: "Values" },
];

function FieldStandard({ notice }: { notice?: (c: Consolidation) => ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const c = useQuery(api.fieldConsolidations.get, { id: id as Id<"fieldConsolidations"> });
  const [url, setUrl] = useUrlState({ tab: "lineage" });
  const rediscover = useMutation(api.fieldConsolidations.rediscover);
  // Columns an older discovery read miss the kinds it skipped (number columns before version 2): read them again once.
  const reread = useRef<string | null>(null);
  const outdated = c && c.stage === "ready" && (c.discoveryVersion ?? 1) < DISCOVERY_VERSION;
  useEffect(() => {
    if (!c || !outdated || reread.current === c._id) return;
    reread.current = c._id;
    rediscover({ id: c._id, keywords: c.keywords }).catch((error) => toast.error(getErrorMessage(error)));
  }, [c, outdated, rediscover]);

  if (c === undefined) return <LoadingRows count={4} />;
  if (c === null) {
    return (
      <div className="text-sm">
        <p className="mb-2">This consolidation doesn&apos;t exist, or you can&apos;t see it.</p>
        <Link href={fieldsHref()} className="text-primary underline-offset-4 hover:underline">
          Back to fields
        </Link>
      </div>
    );
  }
  // Sources and values describe what fills the field, so it must be defined first.
  const ready = (t: Tab) => t === "lineage" || Boolean(c.field);
  const tab = TABS.some((t) => t.id === url.tab) && ready(url.tab as Tab) ? (url.tab as Tab) : "lineage";
  const show = (next: Tab) => setUrl({ tab: next });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border">
        <Link href={fieldsHref()} className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Fields
        </Link>
        <FieldName c={c} onDeleted={() => router.replace(fieldsHref())} />
        <nav aria-label="Consolidation views" className="ml-auto flex" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              disabled={!ready(t.id)}
              aria-selected={tab === t.id}
              title={ready(t.id) ? undefined : "Define the field first"}
              onClick={() => show(t.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium disabled:opacity-40",
                tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      {c.stage === "error" && <p className="mb-3 border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{c.error}</p>}
      {notice?.(c)}
      {tab === "lineage" && <LineageView c={c} onTab={show} />}
      {tab === "sources" && <SourcesView c={c} onPreview={() => show("lineage")} />}
      {tab === "values" && <ValuesView c={c} />}
    </>
  );
}

/** The field's name with rename and delete. Deleting removes Canon's setup and runs, never anything in the CRM. */
function FieldName({ c, onDeleted }: { c: Consolidation; onDeleted: () => void }) {
  const rename = useMutation(api.fieldConsolidations.rename);
  const remove = useMutation(api.fieldConsolidations.remove);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const icon = "mb-1.5 inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground";

  async function save() {
    if (draft === null) return;
    if (draft.trim() && draft.trim() !== c.concept) {
      try {
        await rename({ id: c._id, concept: draft });
      } catch (error) {
        toast.error(getErrorMessage(error));
        return;
      }
    }
    setDraft(null);
  }

  if (draft !== null) {
    return (
      <form
        className="mb-1 flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && setDraft(null)}
          aria-label="Field name"
          maxLength={80}
          className="h-7 w-56 border border-input bg-background px-2 text-sm outline-none focus:border-primary"
        />
        <button type="submit" aria-label="Save name" className={cn(icon, "mb-0")}>
          <Check className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Cancel" onClick={() => setDraft(null)} className={cn(icon, "mb-0")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
    );
  }
  const writing = c.run?.status === "applying" || c.run?.status === "undoing";
  return (
    <div className="flex items-end gap-1">
      <h2 className="mb-1.5 text-base font-semibold capitalize">{c.concept}</h2>
      <button type="button" aria-label="Rename field" title="Rename" onClick={() => setDraft(c.concept)} className={icon}>
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Delete field"
        title={writing ? "A run is writing to your CRM; delete it when that finishes" : "Delete"}
        disabled={writing}
        onClick={() => setConfirming(true)}
        className={cn(icon, "hover:text-destructive disabled:opacity-40")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Delete ${c.concept}?`}
          description="Removes this Canon field, its value map, previews and run history from Canon. Nothing in your CRM changes: values a run wrote stay, and they can no longer be undone from here."
          confirmLabel="Delete field"
          destructive
          onConfirm={async () => {
            await remove({ id: c._id });
            onDeleted();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** One Canon field: Lineage, Sources and Values. `notice` adds a note above them (enrichment matches, for one). */
export function FieldStandardPage({ notice }: { notice?: (c: Consolidation) => ReactNode }) {
  return (
    <Suspense fallback={<LoadingRows count={4} />}>
      <FieldStandard notice={notice} />
    </Suspense>
  );
}
