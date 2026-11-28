"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAction, useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { SuggestedPrompt, useDealRecordId, usePromptSuggestions } from "./suggested-prompt";
import { useCustomizeMode } from "./customize-mode";
import { getErrorMessage } from "@/lib/utils";

export function WorkflowTray() {
  const ctx = useCustomizeMode()!;
  const inputId = useId();
  const pathname = usePathname();
  const dealId = useDealRecordId();
  const suggestions = usePromptSuggestions(ctx.suggestionCache, { target: ctx.adapter?.object ?? routeTarget(pathname) });
  const run = useAction(api.pageCustomize.workflow);
  const save = useMutation(api.workspaceRecipes.saveWorkflow);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const proposal = ctx.workflow;
  const canSubmit = !busy && !!request.trim() && !proposal?.targets.length && !ctx.adapter?.pending && !ctx.adapter?.kept;
  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setMessage("");
    try { ctx.setWorkflow(await run({ request, ...(dealId ? { dealId } : {}) })); } catch (e) { setMessage(getErrorMessage(e)); }
    finally { setBusy(false); }
  }
  async function persist() {
    if (!proposal) return;
    setBusy(true); setMessage("");
    try {
      await save({ targets: proposal.targets.map((t) => ({ object: t.target, recipeId: t.recipeId, markdown: t.markdown, baseMarkdown: t.baseMarkdown, layerRevision: t.layerRevision })) });
      ctx.setWorkflow(null); setMessage("Saved all pages just for you.");
    } catch (e) { setMessage(getErrorMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 border-t border-white/10 px-4 py-3 text-xs">
    <label htmlFor={inputId} className="block font-semibold">Describe how you work</label>
    <SuggestedPrompt id={inputId} rows={3} maxLength={2000} value={request} onValueChange={setRequest}
      onSubmit={() => void submit()} {...suggestions} disabled={busy || Boolean(proposal?.targets.length)} />
    <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="rounded-md bg-violet-600 px-3 py-1.5 disabled:opacity-50">{busy ? "Working…" : "Shape my pages"}</button>
    {proposal && <div className="max-h-[35vh] space-y-2 overflow-y-auto" role="status">
      <p>{proposal.summary}</p>
      {!proposal.dropped.length && proposal.targets.length > 0 && <ul className="space-y-1">{proposal.plan.map((p) => <li key={p.target}><strong>{p.create?.title ?? p.target}</strong> · {p.why}</li>)}</ul>}
      {proposal.targets.map((t) => <Link key={t.target} href={workflowHref(t.target)} onClick={() => ctx.setCustomizing(false)} className="block text-violet-300 underline">{t.created ? "Created" : "Changed"} {t.target}</Link>)}
      <p className="text-stone-500">{proposal.model} · {(proposal.ms / 1000).toFixed(1)}s</p>
      {proposal.targets.length > 0 && <div className="flex gap-3"><button disabled={busy} onClick={() => ctx.setWorkflow(null)}>Undo workflow</button><button disabled={busy} onClick={() => void persist()} className="rounded bg-violet-600 px-2 py-1">Save all just for me</button></div>}
      {!proposal.targets.length && <button onClick={() => ctx.setWorkflow(null)}>Try again</button>}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
function routeTarget(pathname: string): string | null {
  const [, , area, target, record] = pathname.split("/");
  if (area === "p" && target) return target;
  if (area === "records" && target && record) return target;
  if (area === "accounts" && target) return "account";
  return null;
}

export const workflowHref = (target: string) => ["deal", "account", "contact"].includes(target) ? `/dashboard/${{ deal: "deals", account: "accounts", contact: "contacts" }[target]}` : `/dashboard/p/${target}`;
