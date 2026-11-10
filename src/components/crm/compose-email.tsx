"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { FileText, Loader2, Mail, Send } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BODY_MAX, SUBJECT_MAX } from "../../../convex/lib/email/compose";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { offered, type Context, type PageAction } from "../../../recipes";

const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "w-full border border-input bg-background px-2 py-1.5 text-sm";

/**
 * Write one email to the contact and send it from one of the user's linked Gmail accounts (emailActions.sendToContact), or
 * save it to that Gmail's drafts to finish there (emailActions.draftToContact), as the page offers each. A sent email
 * shows on the timeline.
 */
function ComposeEmailEnabled({ contactId, email, actions, ctx, title = "Email" }: { contactId: string; email: string | null; actions: readonly PageAction[]; ctx: Context; title?: string }) {
  const mine = useQuery(api.emailAccounts.mine);
  const send = useAction(api.emailActions.sendToContact);
  const saveDraft = useAction(api.emailActions.draftToContact);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<Id<"emailAccounts"> | "">("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  if (!mine?.configured || !email) return null;
  const accounts = mine.accounts.filter((a) => a.status === "ok");
  const sender = accounts.find((a) => a._id === from) ?? accounts[0];
  const offers = offered(actions, "composeEmail", ["kernel.saveGmailDraft", "kernel.sendEmail"], { ...ctx, "gmail.linked": Boolean(sender) }, {}, "contact");
  if (!offers.length) return null;
  const sendOffer = offers.find((o) => o.action.runs === "kernel.sendEmail");

  if (!open) {
    return (
      <section className="border border-border bg-card p-4">
        <button type="button" className={btn} onClick={() => setOpen(true)} data-testid="compose-email-open">
          <Mail className="h-3.5 w-3.5" /> Email {email}
        </button>
      </section>
    );
  }

  async function submit(asDraft = false) {
    if (!sender) return;
    setSending(true);
    try {
      if (asDraft) await saveDraft({ accountId: sender._id, contactId, subject, body });
      else await send({ accountId: sender._id, contactId, subject, body });
      void toast.success(asDraft ? `Saved to ${sender.address} drafts. Send it from Gmail.` : `Sent to ${email} from ${sender.address}`);
      setSubject("");
      setBody("");
      setOpen(false);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="border border-border bg-card p-4" data-testid="compose-email">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {!sender ? (
        <p className="text-sm text-muted-foreground">
          Link a Gmail account to email this contact. <Link href="/dashboard/integrations/gmail" className="underline">Link Gmail</Link>
        </p>
      ) : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (sendOffer && !sendOffer.disabled) void submit(); }}>
          <div className="grid grid-cols-[4rem_1fr] items-center gap-2 text-sm">
            <span className="text-muted-foreground">From</span>
            {accounts.length > 1 ? (
              <SelectField aria-label="Send from" className="w-full" value={sender._id} onValueChange={(v) => setFrom(v as Id<"emailAccounts">)}
                options={accounts.map((a) => ({ value: a._id, label: a.address }))} />
            ) : (
              <span>{sender.address}</span>
            )}
            <span className="text-muted-foreground">To</span>
            <span>{email}</span>
          </div>
          <input className={input} placeholder="Subject" value={subject} maxLength={SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
          <textarea className={`${input} min-h-40`} placeholder="Message" value={body} maxLength={BODY_MAX} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{sender.sentLastDay} of {mine.dailyCap} sent from {sender.address} in the last 24 hours</span>
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={() => setOpen(false)} disabled={sending}>Cancel</button>
              {offers.map((o) => o.action.runs === "kernel.saveGmailDraft" ? (
                <button key={o.action.id} type="button" className={btn} disabled={sending || o.disabled || !subject.trim() || !body.trim()} onClick={() => void submit(true)} data-testid="compose-email-draft">
                  <FileText className="h-3.5 w-3.5" /> {o.label}
                </button>
              ) : (
                <button key={o.action.id} type="submit" className={btn} disabled={sending || o.disabled || !subject.trim() || !body.trim()} data-testid="compose-email-send">
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} {o.label}
                </button>
              ))}
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

export function ComposeEmail(props: React.ComponentProps<typeof ComposeEmailEnabled>) {
  return <IntegrationGate feature="unipile"><ComposeEmailEnabled {...props} /></IntegrationGate>;
}
