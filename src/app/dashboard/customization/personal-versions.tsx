"use client";
import { useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

export function VersionPromotion({ id, diff, buttonClass, actions }: { id: Id<"pageLayers">; diff: string; buttonClass: string; actions?: ReactNode }) {
  const promote = useAction(api.pageCustomize.promote);
  const [draft, setDraft] = useState<{ markdown: string; baseRevision: number | null; layerRevision: number } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(markdown?: string, acceptFailingEvals = false) {
    setBusy(true);
    try {
      const result = await promote({ layerId: id, markdown, ...(markdown !== undefined && draft ? { baseRevision: draft.baseRevision, layerRevision: draft.layerRevision } : {}), acceptFailingEvals });
      if (result.conflict || result.blocked) {
        setDraft({ markdown: result.markdown, baseRevision: result.baseRevision, layerRevision: result.layerRevision });
        setMessage(result.conflict ? "Resolve the conflict markers, then promote." : "Workspace evals failed. Review before saving anyway.");
      } else {
        setDraft(null);
        setMessage("");
        toast.success("Promoted to workspace");
      }
    } catch (e) { setMessage(getErrorMessage(e)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="col-span-full flex flex-wrap gap-1.5 sm:col-span-1 sm:justify-end">
      {actions}
      <button type="button" className={buttonClass} aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide diff" : "Show diff"}</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void run()}>Promote</button>
    </div>
    {showDiff && <pre className="col-span-full max-h-48 overflow-auto whitespace-pre-wrap text-xs">{diff}</pre>}
    {draft && <div className="col-span-full">
      <textarea aria-label="Review promotion markdown" className="h-64 w-full border bg-background font-mono text-xs" value={draft.markdown} onChange={(e) => setDraft({ ...draft, markdown: e.target.value })} />
      <button type="button" disabled={busy || draft.markdown.includes("<<<<<<< yours")} onClick={() => void run(draft.markdown)} className={buttonClass}>Promote reviewed version</button>
      {message.includes("evals failed") && <button type="button" disabled={busy} onClick={() => void run(draft.markdown, true)} className={buttonClass}>Save anyway</button>}
    </div>}
    {message && <p role="status" className="col-span-full text-xs">{message}</p>}
  </>;
}
