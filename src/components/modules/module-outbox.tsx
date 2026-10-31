"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useOutboundAvailable } from "@/hooks/use-outbound-available";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { OutboxAction, OutboxState } from "../../../modules/kernel/outbound";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

export type OutboxRowView = NonNullable<FunctionReturnType<typeof api.outbound.outbox>>[number];
type OwnerReviewSnapshot = Pick<OutboxRowView, "id" | "subject" | "text"> & { ownerReview: NonNullable<OutboxRowView["ownerReview"]> };

const btn = "inline-flex items-center gap-1 whitespace-nowrap border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const STATE_WORDS: Record<OutboxState, string> = {
  awaiting_approval: "Waiting for approval", queued: "Queued", held: "Held", sending: "Sending", sent: "Sent", failed: "Failed",
  unknown: "Unknown", suppressed: "Suppressed", refused: "Refused", cancelled: "Cancelled",
};
const STATE_TONE: Partial<Record<OutboxState, string>> = {
  sent: "border-emerald-600 text-emerald-700", failed: "border-destructive text-destructive", refused: "border-destructive text-destructive",
  unknown: "border-amber-600 text-amber-700", held: "border-amber-600 text-amber-700", awaiting_approval: "border-primary text-primary",
};
const CHANNEL_WORDS = { email: "Email", slack: "Slack", webhook: "Webhook" } as const;
const ACTION_WORDS: Record<OutboxAction, string> = { approve: "Approve", cancel: "Cancel", sendNow: "Send now" };

/**
 * Outbox rows (docs/modules.md, "Outbound"): when, where to, the exact message, where it stands and why, and the
 * actions `actions` offers that the reader may take on each.
 */
export function OutboxTable({ rows, actions, empty, showModule }: { rows: readonly OutboxRowView[]; actions: readonly OutboxAction[]; empty?: string; showModule?: (moduleId: string | null) => string }) {
  const act = useMutation(api.outbound.act);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<OwnerReviewSnapshot | null>(null);
  const run = async (id: OutboxRowView["id"], action: OutboxAction, expectedBindingHash?: string) => {
    setBusy(`${id}:${action}`);
    try { await act({ id, action, ...(expectedBindingHash ? { expectedBindingHash } : {}) }); setReview(null); toast.success(`${ACTION_WORDS[action]}: done`); }
    catch (e) { toast.error(getErrorMessage(e)); }
    finally { setBusy(null); }
  };
  return (
    <>
    <Dialog open={review !== null} onOpenChange={(open) => { if (!open && busy === null) setReview(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{review?.ownerReview?.purpose === "manual_action" ? "Send this exact email personally" : "Approve this exact automated email"}</DialogTitle>
          <DialogDescription>Review the full message below. Approval applies only to this frozen email. A changed or expired email will be refused.</DialogDescription>
        </DialogHeader>
        {review?.ownerReview && <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words text-sm">
            <dt className="text-muted-foreground">From</dt><dd>{review.ownerReview.senderName} &lt;{review.ownerReview.senderAddress}&gt;</dd>
            <dt className="text-muted-foreground">To</dt><dd>{review.ownerReview.recipientAddress}</dd>
            <dt className="text-muted-foreground">Subject</dt><dd>{review.subject}</dd>
          </dl>
          <pre className="whitespace-pre-wrap break-words border border-border bg-muted p-3 font-sans text-sm">{review.text}</pre>
          <DialogFooter>
            <button type="button" className={btn} disabled={busy !== null} onClick={() => setReview(null)}>Back</button>
            <button type="button" className={btn} disabled={busy !== null} onClick={() => run(review.id, "approve", review.ownerReview.bindingHash)}>
              {review.ownerReview.purpose === "manual_action" ? "Send personally" : "Approve automated email"}
            </button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
    {!rows.length ? <p className="text-sm text-muted-foreground">{empty ?? "Nothing sent yet."}</p> : <div className="overflow-x-auto border border-border">
      <table className="w-full text-sm" data-testid="outbox">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            {showModule && <th className="px-3 py-2 font-medium">Module</th>}
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 font-medium">Message</th>
            <th className="px-3 py-2 font-medium">State</th>
            {actions.length > 0 && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top" data-state={r.state}>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</td>
              {showModule && <td className="px-3 py-2 text-xs">{showModule(r.module)}</td>}
              <td className="px-3 py-2 text-xs"><span className="font-medium">{CHANNEL_WORDS[r.channel]}</span> · {r.to}</td>
              <td className="max-w-md px-3 py-2">
                <details>
                  <summary className="cursor-pointer truncate text-xs">{r.subject ?? (r.text.split("\n")[0] || "(nothing rendered)")}</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words bg-muted p-2 font-sans text-xs">{r.subject ? `${r.subject}\n\n${r.text}` : r.text}</pre>
                </details>
              </td>
              <td className="px-3 py-2 text-xs">
                <span className={cn("inline-block border px-1.5 py-0.5 font-medium", STATE_TONE[r.state] ?? "border-border")}>{STATE_WORDS[r.state]}</span>
                {r.state === "held" && <span className="ml-1 text-muted-foreground">until {new Date(r.notBefore).toLocaleString()}</span>}
                {(r.reason || r.error) && <p className="mt-0.5 text-muted-foreground">{r.error ?? r.reason}</p>}
                {r.providerId && <p className="mt-0.5 text-muted-foreground">Provider id: {r.providerId}</p>}
              </td>
              {actions.length > 0 && (
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {actions.filter((a) => r.actions[a]).map((a) => (
                    <button key={a} type="button" className={cn(btn, "ml-1")} disabled={busy !== null} onClick={() => {
                      if (a === "approve" && r.ownerReview) setReview({ id: r.id, subject: r.subject, text: r.text, ownerReview: { ...r.ownerReview } });
                      else void run(r.id, a);
                    }}>{a === "approve" && r.ownerReview ? "Review exact email" : ACTION_WORDS[a]}</button>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>}
    </>
  );
}

/** A module page's `outbox` component: its rows the reader sees, every one or those one doc caused. */
export function ModuleOutbox({ module, about, states, actions, empty }: { module: string; about?: string; states?: readonly OutboxState[]; actions?: readonly OutboxAction[]; empty?: string }) {
  const available = useOutboundAvailable();
  const rows = useQuery(api.outbound.outbox, available ? { module, ...(about ? { about } : {}), ...(states ? { states: [...states] } : {}) } : "skip");
  if (!available) return null;
  if (rows === undefined) return <p className="text-sm text-muted-foreground">Loading the outbox…</p>;
  if (rows === null) return null;
  return <OutboxTable rows={rows} actions={actions ?? []} empty={empty} />;
}

/** What a transition's sends would send, rendered by the server on the doc as the move would leave it (docs/modules.md, "Outbound"). */
export function SendPreview({ module, machine, transition, docKey, args }: { module: string; machine: string; transition: string; docKey: string; args: Record<string, unknown> }) {
  const available = useOutboundAvailable();
  const sends = useQuery(api.modules.sendPreview, available ? { module, machine, transition, key: docKey, args } : "skip");
  if (!sends?.length) return null;
  return (
    <section className="space-y-2" aria-label="What this sends">
      {sends.map((s, i) => (
        <div key={i} className="border-l-2 border-provenance bg-muted/50 px-3 py-2 text-xs">
          <p className="font-medium">{s.approval ? "Asks a person to approve, then sends" : "Sends"} {s.channel === "email" ? "an email" : s.channel === "slack" ? "a Slack post" : "a webhook"} to {s.to}</p>
          {s.sender && <p className="mt-1 font-medium">From {s.sender}</p>}
          {s.informational && <p className="mt-1 text-muted-foreground">Current source preview only. Canon prepares the saved document afterward; this preview gives no approval.</p>}
          {s.refused ? <p className="mt-1 text-destructive">{s.refused}</p> : s.missing ? <p className="mt-1 text-destructive">Won&apos;t send: it leaves {s.missing.join(", ")} empty.</p>
            : <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{s.subject ? `${s.subject}\n\n${s.text}` : s.text}</pre>}
        </div>
      ))}
    </section>
  );
}
