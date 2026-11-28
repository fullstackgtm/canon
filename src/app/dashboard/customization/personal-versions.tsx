"use client";
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/utils";

export function PersonalVersions({ target }: { target: { point: string; key: string } }) {
  const pageName = target.point === "workspace.pages" ? target.key.replace(/-/g, " ") : `${target.point.split(".")[0]} page`;
  const versions = useQuery(api.workspaceRecipes.personalVersions, { target });
  const promote = useAction(api.pageCustomize.promote);
  const [draft, setDraft] = useState<{ id: Id<"pageLayers">; markdown: string; baseRevision: number | null; layerRevision: number } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(id: Id<"pageLayers">, markdown?: string, acceptFailingEvals = false) {
    setBusy(true);
    try {
      const result = await promote({ layerId: id, markdown, ...(markdown !== undefined && draft ? { baseRevision: draft.baseRevision, layerRevision: draft.layerRevision } : {}), acceptFailingEvals });
      if (result.conflict || result.blocked) {
        setDraft({ id, markdown: result.markdown, baseRevision: result.baseRevision, layerRevision: result.layerRevision });
        setMessage(result.conflict ? "Resolve the conflict markers, then promote." : "Workspace evals failed. Review before saving anyway.");
      } else { setDraft(null); setMessage("Promoted to workspace."); }
    } catch (e) { setMessage(getErrorMessage(e)); }
    finally { setBusy(false); }
  }
  return <details className="my-3 border border-border p-3"><summary>Personal versions · {pageName} ({versions?.length ?? 0})</summary>
    {versions?.map((v) => <div key={v._id} className="my-3"><p>{v.name} · {new Date(v.updatedAt).toLocaleString()}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{v.diff.text}</pre>
      <button type="button" disabled={busy} onClick={() => void run(v._id)} className="underline">Promote to workspace</button></div>)}
    {draft && <><textarea aria-label="Resolve promotion conflicts" className="h-64 w-full border bg-background font-mono text-xs" value={draft.markdown} onChange={(e) => setDraft({ ...draft, markdown: e.target.value })} />
      <button type="button" disabled={busy || draft.markdown.includes("<<<<<<< yours")} onClick={() => void run(draft.id, draft.markdown)} className="underline">Promote reviewed version</button>
      {message.includes("evals failed") && <button type="button" disabled={busy} onClick={() => void run(draft.id, draft.markdown, true)} className="ml-3 underline">Save anyway</button>}</>}
    {message && <p role="status">{message}</p>}
  </details>;
}
