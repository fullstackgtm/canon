"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Loader2, Swords } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ChatgptConnect } from "@/app/dashboard/integrations/chatgpt-card";
import { useDeadlinePassed } from "@/lib/use-deadline";
import { getErrorMessage } from "@/lib/utils";

type Run = NonNullable<ReturnType<typeof useQuery<typeof api.icpChallenge.latest>>>;
type Proposal = Run["proposals"][number];

const CRM_SOURCE = "canoncrm:data";

function sizeLabel(p: Proposal): string | null {
  if (!p.size) return null;
  return `${p.size.capped ? `${p.size.accounts.toLocaleString()}+` : `~${p.size.accounts.toLocaleString()}`} accounts`;
}

function shape(p: Proposal): string {
  const size =
    p.employeeMin !== undefined || p.employeeMax !== undefined
      ? `${p.employeeMin ?? 1}${p.employeeMax !== undefined ? `–${p.employeeMax}` : "+"} employees`
      : null;
  return [p.industries.join(", "), size, p.countries.length ? p.countries.join(", ") : null].filter(Boolean).join(" · ");
}

/**
 * Challenge my ICP: an agent on your ChatGPT plan proposes adjacent markets
 * outside today's TAM. Quotes are checked against the pages it read; a claim
 * without one is labelled a hypothesis. Accepting populates the market from
 * free sources only.
 */
export function ChallengeIcpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const run = useQuery(api.icpChallenge.latest);
  const chatgpt = useQuery(api.chatgptAuth.status);
  const start = useMutation(api.icpChallenge.start);
  const accept = useMutation(api.icpChallenge.accept);
  const dismiss = useMutation(api.icpChallenge.dismiss);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  // A run killed mid-way stays "proposing" forever; once it is stale, show the start button again (start allows it).
  const stale = useDeadlinePassed(run?.status === "proposing" ? run.updatedAt + run.stallMs : null);
  const working = run?.status === "proposing" && !stale;
  const connected = chatgpt?.status === "connected";

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function decline(runId: Id<"icpChallengeRuns">, index: number) {
    await act(`dismiss:${index}`, () => dismiss({ runId, index, reason }));
    setDismissing(null);
    setReason("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-2">
          <Swords className="size-4 text-primary" /> Challenge my ICP
        </DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          An agent on your ChatGPT plan reads your ICP, what you sell and your won deals, then proposes adjacent markets
          you are not selling to. It reads public pages to check its ideas: a claim shows its quote only if the quote is
          word for word in a page it read, otherwise it is labelled a hypothesis.
        </DialogDescription>

        {chatgpt !== undefined && !connected ? (
          <div className="grid gap-2 border border-border p-3">
            <p className="text-sm text-muted-foreground">
              Challenge my ICP runs on your own ChatGPT plan, so Canon never pays for it. Connect ChatGPT to start.
            </p>
            <ChatgptConnect />
          </div>
        ) : working ? (
          <div className="flex items-center gap-2 border border-border px-3 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            {run && run.proposals.length > 0 ? "Sizing each market with a free search…" : "Reading your ICP and researching adjacent markets…"}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {stale ? "The last run stopped before it finished." : run?.status === "done" ? `Last run ${new Date(run.createdAt).toLocaleString()}${run.model ? ` · ${run.model}` : ""}` : "Takes about a minute."}
            </p>
            <button
              type="button"
              onClick={() => void act("start", () => start({}))}
              disabled={busy !== null}
              className="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
            >
              {busy === "start" && <Loader2 className="size-3 animate-spin" />}
              {stale ? "Retry" : run ? "Challenge again" : "Challenge my ICP"}
            </button>
          </div>
        )}

        {run?.status === "failed" && run.error && <p className="text-xs text-destructive">{run.error}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}

        {run && run.proposals.length > 0 && (
          <ul className="grid gap-2">
            {run.proposals.map((p) => (
              <li key={p.index} className={`border border-border p-3 ${p.state === "dismissed" ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{p.name}</span>
                      {sizeLabel(p) && (
                        <span className="border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{sizeLabel(p)}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-foreground/90">{p.rationale}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">Looks like: {shape(p)}</p>
                  </div>
                  {p.state === "open" && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        disabled={busy !== null || run.status === "proposing"}
                        onClick={() => void act(`accept:${p.index}`, () => accept({ runId: run.id, index: p.index }))}
                        className="flex items-center gap-1 border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-60"
                      >
                        {busy === `accept:${p.index}` && <Loader2 className="size-3 animate-spin" />}
                        Accept and populate
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null || run.status === "proposing"}
                        onClick={() => setDismissing(dismissing === p.index ? null : p.index)}
                        className="border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-60"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {p.state === "accepted" && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-primary"><Check className="size-3" /> Populating</span>
                  )}
                  {p.state === "dismissed" && <span className="shrink-0 text-xs text-muted-foreground">Dismissed</span>}
                </div>

                {dismissing === p.index && (
                  <form
                    className="mt-2 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void decline(run.id, p.index);
                    }}
                  >
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why not? (optional, so it isn't proposed again)"
                      className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs"
                    />
                    <button type="submit" disabled={busy !== null} className="border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-60">
                      Dismiss
                    </button>
                  </form>
                )}

                <ul className="mt-2 grid gap-1.5">
                  {p.claims.map((c, i) => (
                    <li key={i} className="text-xs">
                      <span className="text-foreground/90">{c.text}</span>{" "}
                      {c.quote && c.sourceUrl ? (
                        <span className="block text-[11px] italic text-muted-foreground">
                          “{c.quote}”{" "}
                          {c.sourceUrl === CRM_SOURCE ? (
                            <span className="not-italic">(your CRM data)</span>
                          ) : (
                            <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="not-italic underline">source</a>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-amber-600">Hypothesis</span>
                      )}
                    </li>
                  ))}
                </ul>
                {p.risks.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">Risks: {p.risks.join(" · ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
