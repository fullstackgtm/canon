"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState, type Dispatch } from "react";
import { useAction, useQuery } from "convex/react";
import { AlertCircle, Check, CheckCircle2, Loader2, Sparkles, X } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { ChatgptConnect } from "@/app/dashboard/integrations/chatgpt-card";
import { cn, getErrorMessage } from "@/lib/utils";
import type { DraftAction, DraftState } from "./editor-draft";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const REQUEST_MAX = 2_000;
const LOG_SHOWN = 3;
/** Requests the stand-in and a real model both handle, offered before the first one. */
const EXAMPLES = ["Move Activity above Next action", "Fold Deal health by default"];

/**
 * Ask Canon in the recipe editor (docs/recipes.md, "Editing with an agent"): a request in words goes to
 * recipeAgent.proposeEdit with the draft as it is now, unsaved edits included. The proposal shows its summary, diff,
 * problems and evals; Accept puts it in the draft and Discard drops it. Saving stays the editor's Save.
 */
function RecipeAgentPaneEnabled({ recipeId, state, dispatch, standIn }: { recipeId: string; state: DraftState; dispatch: Dispatch<DraftAction>; standIn: boolean }) {
  const propose = useAction(api.recipeAgent.proposeEdit);
  const chatgpt = useQuery(api.chatgptAuth.status);
  const [request, setRequest] = useState("");
  const onPlan = chatgpt?.status === "connected";
  const canAsk = standIn || onPlan;
  const { asking, proposal, log } = state;

  async function ask() {
    const text = request.trim();
    if (!text || asking) return;
    dispatch({ kind: "ask", request: text });
    try {
      const result = await propose({ recipeId, baseMarkdown: state.draft, request: text });
      dispatch({ kind: "proposed", result });
      setRequest("");
    } catch (error) {
      dispatch({ kind: "failed", message: getErrorMessage(error) });
    }
  }

  const r = proposal?.result;
  const stale = proposal && proposal.from !== state.draft;
  const who = standIn ? "Stand-in model on this local stack" : onPlan ? `On your ChatGPT plan${chatgpt.email ? ` (${chatgpt.email})` : ""}, no credits` : "Needs your ChatGPT plan";
  // The last few requests: the outline above keeps the column, so older ones scroll off.
  const shownLog = log.slice(-LOG_SHOWN);

  const thread = (shownLog.length > 0 || r || asking) && (
    <div className="max-h-[45vh] space-y-3 overflow-auto border-b border-border p-3">
      {shownLog.map((e, i) => (
        <div key={i} className="space-y-1 text-xs">
          <p className="ml-auto w-fit max-w-[90%] bg-muted px-2 py-1">{e.request}</p>
          <p className={cn(e.outcome === "failed" ? "text-destructive" : "text-muted-foreground")}>{e.outcome === "accepted" ? "✓ Applied to the draft" : e.outcome === "discarded" ? "Discarded" : "Failed"}{e.note ? `: ${e.note}` : ""}</p>
        </div>
      ))}
      {(asking || proposal) && <p className="ml-auto w-fit max-w-[90%] bg-muted px-2 py-1 text-xs">{asking?.request ?? proposal?.request}</p>}
      {asking && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Writing a change…</p>}
      {r && (
        <div className="space-y-2" aria-label="Proposal">
          <p className="text-sm">{r.summary || "The model gave no summary."}</p>
          {r.problems.length > 0 && (
            <div className="text-xs text-destructive">
              <p className="flex items-center gap-1 font-semibold"><AlertCircle className="h-3.5 w-3.5" />Canon can't read it yet: {r.problems.length} problem{r.problems.length === 1 ? "" : "s"}</p>
              <ul className="mt-1 space-y-0.5">{r.problems.map((p, i) => <li key={i}><span className="font-mono">{p.line ? `Line ${p.line}` : "File"}</span> {p.message}</li>)}</ul>
            </div>
          )}
          <EvalList evals={r.evals} notRun={r.evalsNotRun} />
          {r.diff ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">See the change to customization.md</summary><div className="mt-1"><DiffView text={r.diff} /></div></details> : <p className="text-xs text-muted-foreground">No change to customization.md.</p>}
          {stale && <p className="text-xs text-warning">You edited the draft after asking. Applying replaces those edits.</p>}
          <div className="flex items-center gap-2">
            <button type="button" className={cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90")} disabled={!r.diff} onClick={() => dispatch({ kind: "accept" })}>
              <Check className="h-3.5 w-3.5" />Apply to draft
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ kind: "discard" })}><X className="h-3.5 w-3.5" />Discard</button>
            <span className="text-[11px] text-muted-foreground">{r.model}</span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <section aria-label="Ask Canon" className="flex flex-col">
      {!log.length && !r && !asking && canAsk && (
        <div className="flex flex-wrap gap-1.5 border-b border-border p-2">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setRequest(x)}>{x}</button>
          ))}
        </div>
      )}
      {thread}
      {!canAsk && chatgpt !== undefined && <div className="p-3"><ChatgptConnect /></div>}
      {!r && (
        <form className="flex items-end gap-2 p-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <Sparkles className="mb-2 ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
          <label htmlFor="recipe-agent-request" className="sr-only">Ask Canon to change the layout</label>
          <textarea id="recipe-agent-request" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={REQUEST_MAX} rows={2} disabled={!canAsk || !!asking}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }}
            placeholder={log.some((e) => e.outcome === "accepted") ? "A follow-up…" : "Ask Canon to change the layout…"}
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none disabled:opacity-60" />
          <button type="submit" className={btn} disabled={!canAsk || !!asking || !request.trim()} title={who}>
            {asking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Ask"}
          </button>
        </form>
      )}
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">{who}</p>
    </section>
  );
}

function EvalList({ evals, notRun }: { evals: readonly { name: string; ok: boolean; detail: string | null }[]; notRun: string | null }) {
  if (notRun) return <p className="text-xs text-muted-foreground">Evals not run: {notRun}.</p>;
  if (!evals.length) return null;
  const failing = evals.filter((e) => !e.ok).length;
  return (
    <details className="text-xs" open={failing > 0}>
      <summary className={cn("cursor-pointer font-medium", failing ? "text-destructive" : "text-primary")}>
        {failing ? `${failing} of ${evals.length} evals fail` : `All ${evals.length} evals pass`}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {evals.map((e) => (
          <li key={e.name} className="flex gap-1">
            {e.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-primary" /> : <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />}
            <span>{e.name}{e.detail && <span className="block text-muted-foreground">{e.detail}</span>}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A unified diff, added lines green and removed lines red. */
export function DiffView({ text }: { text: string }) {
  return (
    <pre aria-label="Diff" className="max-h-72 overflow-auto border border-border bg-muted/30 p-2 text-[11px] leading-4">
      {text.split("\n").map((l, i) => (
        <div key={i} className={cn(/^(\+\+\+|---) /.test(l) || l.startsWith("@@") ? "text-muted-foreground" : l.startsWith("+") ? "bg-primary/10 text-primary" : l.startsWith("-") && "bg-destructive/10 text-destructive")}>{l || " "}</div>
      ))}
    </pre>
  );
}

export function RecipeAgentPane(props: React.ComponentProps<typeof RecipeAgentPaneEnabled>) {
  return <IntegrationGate feature="chatgpt" note><RecipeAgentPaneEnabled {...props} /></IntegrationGate>;
}
