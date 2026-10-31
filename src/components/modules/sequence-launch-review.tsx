"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import type { SequencePreflight } from "../../../convex/lib/sequences/preflight";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";

const button = "border border-border px-3 py-1.5 text-sm disabled:opacity-50";
export function SequenceLaunchReview({ module, sequenceKey, onClose, onApprove }: { module: string; sequenceKey: string; onClose: () => void; onApprove: (token: string) => Promise<void> }) {
  const read = useAction(api.sequenceVariables.review);
  const [review, setReview] = useState<SequencePreflight | null>(null);
  useEffect(() => { let active = true; void read({ module, key: sequenceKey }).then((result) => { if (active) setReview(result); }).catch((cause) => { if (active) setError(getErrorMessage(cause)); }); return () => { active = false; }; }, [read, module, sequenceKey]);
  const transition = useMutation(api.modules.transition);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(getErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
    <DialogTitle>Review sequence variables</DialogTitle>
    <p className="text-sm text-muted-foreground">Review the values recipients will see before approving this sequence. Only emails with Canon status valid can receive email steps.</p>
    {!review ? <p>Checking recipients...</p> : <>
      <p className="text-sm">{review.recipients} recipients. Samples for the first {review.samples.length} recipients, across every active template and selected sender.</p>
      <div className="space-y-3" data-testid="sequence-variable-samples">{review.samples.map((sample) => <section key={sample.key} className="border border-border p-3">
        <h3 className="font-medium">{sample.name}</h3>
        {sample.messages.map((message, i) => <div key={i} className="mt-2 space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">Step {message.step}, variant {message.variant}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3">{Object.entries(message.values).map(([name, value]) => <div className="contents" key={name}><dt className="text-muted-foreground">{name}</dt><dd>{value || "Missing"}</dd></div>)}</dl>
          <p className="font-medium">{message.subject}</p><p className="whitespace-pre-wrap">{message.body}</p>
        </div>)}
      </section>)}</div>
      {review.failures.length > 0 && <section className="space-y-2 border border-destructive p-3" data-testid="sequence-variable-refusal">
        <h3 className="font-medium">Approval refused for {review.failures.length} {review.failures.length === 1 ? "recipient" : "recipients"}</h3>
        <p className="text-sm">Fix these recipients or exclude them from this sequence to approve.</p>
        {review.failures.map((failure) => <div key={failure.key} className="flex items-start justify-between gap-3 text-sm"><div><p className="font-medium">{failure.name}</p><ul>{failure.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
          <button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await transition({ module, machine: "enrollment", name: "finish", key: failure.key, expect: failure.version }); setReview(await read({ module, key: sequenceKey })); })}>Exclude {failure.name}</button>
        </div>)}
      </section>}
      {review.ready && <p className="text-sm" data-testid="sequence-variable-ready">All recipient variables pass. Ready to approve.</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><button className={button} disabled={busy} onClick={onClose}>Cancel</button><button className={button} disabled={busy || !review?.ready} onClick={() => void run(async () => { const current = await read({ module, key: sequenceKey }); setReview(current); if (current.ready && current.token) await onApprove(current.token); })}>Approve launch</button></div>
  </DialogContent></Dialog>;
}
