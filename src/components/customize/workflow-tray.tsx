"use client";
import Link from "next/link";
import { useAction, useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { useCustomizeMode } from "./customize-mode";
import { getErrorMessage } from "@/lib/utils";

export function WorkflowTray() {
  const ctx = useCustomizeMode()!;
  const inputId = useId();
  const run = useAction(api.pageCustomize.workflow);
  const save = useMutation(api.workspaceRecipes.saveWorkflow);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const proposal = ctx.workflow;
  async function submit() {
    setBusy(true); setMessage("");
    try { ctx.setWorkflow(await run({ request })); } catch (e) { setMessage(getErrorMessage(e)); }
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
    <textarea id={inputId} rows={3} maxLength={2000} value={request} onChange={(e) => setRequest(e.target.value)} disabled={busy || Boolean(proposal?.targets.length)} placeholder="I run renewals: show contracts ending in 90 days, their owner and last touch…" className="w-full resize-none rounded-lg bg-white/5 p-2 text-sm ring-1 ring-white/10 focus:ring-violet-500" />
    {!proposal && <div className="flex flex-wrap gap-2 text-stone-400">{["Renewals desk", "SDR morning queue"].map((example) => <button key={example} onClick={() => setRequest(example)} className="underline">{example}</button>)}</div>}
    <button type="button" disabled={busy || !request.trim() || Boolean(proposal?.targets.length) || ctx.adapter?.pending || Boolean(ctx.adapter?.kept)} onClick={() => void submit()} className="rounded-md bg-violet-600 px-3 py-1.5 disabled:opacity-50">{busy ? "Working…" : "Shape my pages"}</button>
    {proposal && <div className="max-h-[35vh] space-y-2 overflow-y-auto" role="status">
      <p>{proposal.summary}</p>
      <ul className="space-y-1">{proposal.plan.map((p) => <li key={p.target}><strong>{p.create?.title ?? p.target}</strong> · {p.why}</li>)}</ul>
      {proposal.targets.map((t) => <Link key={t.target} href={workflowHref(t.target)} onClick={() => ctx.setCustomizing(false)} className="block text-violet-300 underline">{t.created ? "Created" : "Changed"} {t.target}</Link>)}
      <p className="text-stone-500">{proposal.model} · {(proposal.ms / 1000).toFixed(1)}s</p>
      {proposal.targets.length > 0 && <div className="flex gap-3"><button disabled={busy} onClick={() => ctx.setWorkflow(null)}>Undo workflow</button><button disabled={busy} onClick={() => void persist()} className="rounded bg-violet-600 px-2 py-1">Save all just for me</button></div>}
      {!proposal.targets.length && <button onClick={() => ctx.setWorkflow(null)}>Try again</button>}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
export const workflowHref = (target: string) => ["deal", "account", "contact"].includes(target) ? `/dashboard/${{ deal: "deals", account: "accounts", contact: "contacts" }[target]}` : `/dashboard/p/${target}`;
