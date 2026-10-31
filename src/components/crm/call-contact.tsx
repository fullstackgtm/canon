"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2, Phone, PhoneOff, Save } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { OUTCOMES, type Outcome } from "../../../convex/lib/dialer/bridge";
import { callingHoursProblem } from "../../../convex/lib/dialer/hours";
import { toE164 } from "../../../convex/lib/dialer/telnyx";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { offered, type Context, type PageAction } from "../../../recipes";

const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "w-full border border-input bg-background px-2 py-1.5 text-sm";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  connected: "Connected", no_answer: "No answer", left_voicemail: "Left voicemail", busy: "Busy", wrong_number: "Wrong number",
};
export const STATE_LABEL = { dialing: "Dialing…", ringing: "Ringing…", answered: "Connected", ended: "Ended", failed: "Failed" } as const;

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Call the contact through the dialer (docs/dialer.md): start a session that
 * rings the rep's phone, dial the contact onto it, hang up, log the outcome,
 * as the page offers each. Below, the contact's recent calls with their
 * recording, transcript and insights.
 */
export function CallContact({ contactId, phone, actions, ctx, title = "Calls", embedded = false }: { contactId: string; phone: string | null; actions?: readonly PageAction[]; ctx?: Context; title?: string; embedded?: boolean }) {
  const overview = useQuery(api.dialer.overview);
  // A role that sees only some people reads the calls through the action twin, again whenever the live call changes (CP14).
  const calls = useScopedQuery(api.dialer.contactCalls, api.dialer.contactCallsScoped, { contactId }, JSON.stringify(overview?.currentCall ?? null));
  const status = useQuery(api.dialer.numberStatus, phone ? { phone } : "skip");
  const startSession = useMutation(api.dialer.startSession);
  const endSession = useMutation(api.dialer.endSession);
  const callContact = useAction(api.dialerActions.callContact);
  const hangupCall = useMutation(api.dialer.hangupCall);
  const [agentPhone, setAgentPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = overview?.currentCall ?? null;
  const now = useTick(live?.state === "answered");

  if (!overview?.configured || (!phone && !calls?.length)) return null;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const session = overview.session;
  const phoneValue = agentPhone ?? overview.lastAgentPhone ?? "";
  const here = live?.contactId === contactId ? live : null;
  const e164 = toE164(phone);
  // Why Call is off right now: the do-not-call list, or the contact's calling hours (checked again on the server).
  const blocked = status?.doNotCall ? "This number is on your workspace's do-not-call list." : e164 ? callingHoursProblem(e164, Date.now()) : null;
  const latest = calls?.[0];
  const pending = latest && latest.mine && latest.state === "ended" && !latest.confirmed ? latest : null;
  const offer = (runs: "kernel.callContact" | "kernel.hangup" | "kernel.setCallOutcome") =>
    actions ? offered(actions, "callPanel", [runs], { ...ctx, "call.blocked": Boolean(blocked) }, { phone }, "contact")[0] ?? null
      : { label: runs === "kernel.callContact" ? `Call ${phone}` : runs === "kernel.hangup" ? "Hang up" : "Log call", disabled: runs === "kernel.callContact" && Boolean(blocked) };
  const call = offer("kernel.callContact"), hangup = offer("kernel.hangup"), logCall = offer("kernel.setCallOutcome");

  return (
    <section className={embedded ? "" : "border border-border bg-card p-4"} data-testid="call-contact">
      <div className="mb-2 flex items-center justify-between gap-2">
        {!embedded && <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>}
        {session && (
          <button type="button" className="text-xs text-muted-foreground underline" disabled={busy} onClick={() => void run(() => endSession({}))} data-testid="dialer-end-session">
            End session
          </button>
        )}
      </div>
      {overview.simulated && <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">Local stack: calls are simulated.</p>}

      {!phone || !call ? null : overview.numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Your workspace has no dialer numbers yet. <Link href="/dashboard/integrations/dialer" className="underline">Integrations → Dialer</Link>
        </p>
      ) : !session ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run(() => startSession({ agentPhone: phoneValue })); }}>
          <p className="text-sm text-muted-foreground">Canon rings your phone first, then connects {phone} onto that call. Keep the call open to dial more contacts.</p>
          {overview.lastError && <p className="text-xs text-red-600 dark:text-red-400">{overview.lastError}</p>}
          <div className="flex gap-2">
            <input className={input} placeholder="Your phone, like +14155550123" value={phoneValue} onChange={(e) => setAgentPhone(e.target.value)} aria-label="Your phone" data-testid="dialer-agent-phone" />
            <button type="submit" className={btn} disabled={busy || !phoneValue.trim()} data-testid="dialer-start">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />} Start
            </button>
          </div>
        </form>
      ) : session.status === "calling_agent" ? (
        <p className="flex items-center gap-2 text-sm" data-testid="dialer-ringing-agent">
          <Loader2 className="h-4 w-4 animate-spin" /> Ringing your phone at {session.agentPhone}. Answer it to start dialing.
        </p>
      ) : here ? (
        <div className="flex items-center justify-between gap-2" data-testid="dialer-live">
          <div className="text-sm">
            <div className="font-medium">{STATE_LABEL[here.state]} {here.to}</div>
            {here.state === "answered" && here.answeredAt && <div className="font-mono text-xs text-muted-foreground">{clock(Math.max(0, Math.round((now - here.answeredAt) / 1000)))}</div>}
          </div>
          {hangup && (
            <button type="button" className={btn} disabled={busy || hangup.disabled} onClick={() => void run(() => hangupCall({}))} data-testid="dialer-hangup">
              <PhoneOff className="h-3.5 w-3.5" /> {hangup.label}
            </button>
          )}
        </div>
      ) : live ? (
        <p className="text-sm text-muted-foreground">
          On a call with <Link href={`/dashboard/records/contact/${encodeURIComponent(live.contactId)}`} className="underline">{live.contactName}</Link>.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            From {session.from} · {session.audio === "browser" ? <>audio in your <Link href="/dashboard/dialer" className="underline">Dialer</Link> tab</> : <>your phone {session.agentPhone}</>}
          </span>
          <button type="button" className={btn} disabled={busy || call.disabled} title={blocked ?? undefined} onClick={() => void run(() => callContact({ contactId }))} data-testid="dialer-call">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />} {call.label}
          </button>
        </div>
      )}

      {blocked && !here && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="dialer-blocked">{blocked}</p>}
      {pending && logCall && <OutcomeForm key={pending._id} callId={pending._id} initial={pending.outcome} label={logCall.label} disabled={logCall.disabled} />}

      {calls && calls.length > 0 && (
        <ul className="mt-3 space-y-3 border-t border-border pt-3">
          {calls.map((c) => (
            <li key={c._id} className="text-sm" data-testid="dialer-call-row">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {c.outcome ? OUTCOME_LABEL[c.outcome] : STATE_LABEL[c.state]}
                  {c.durationSeconds ? <span className="ml-2 font-mono text-xs text-muted-foreground">{clock(c.durationSeconds)}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">{new Date(c.startedAt).toLocaleString()}</span>
              </div>
              {c.error && <div className="text-xs text-red-600 dark:text-red-400">{c.error}</div>}
              {c.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{c.notes}</p>}
              {c.recordingUrl && <audio controls preload="none" src={c.recordingUrl} className="mt-2 h-8 w-full" />}
              {c.transcriptStatus === "pending" && <div className="mt-1 text-xs text-muted-foreground">Transcribing…</div>}
              {c.insights.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {c.insights.map((i) => (
                    <li key={i._id} className="text-xs" data-testid="dialer-insight">
                      <span className="text-muted-foreground">{i.type.replace(/_/g, " ")}</span>{" "}
                      <span>{i.title}</span>
                      {i.evidence && <blockquote className="mt-0.5 border-l-2 border-border pl-2 text-muted-foreground">{i.evidence}</blockquote>}
                    </li>
                  ))}
                </ul>
              )}
              {c.transcript && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Transcript</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-sans">{c.transcript}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OutcomeForm({ callId, initial, label, disabled }: { callId: Id<"dialerCalls">; initial: Outcome | null; label: string; disabled: boolean }) {
  const setOutcome = useMutation(api.dialer.setOutcome);
  const [outcome, setChoice] = useState<Outcome | "">(initial ?? "");
  const [notes, setNotes] = useState("");
  const [dnc, setDnc] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="mt-3 space-y-2 border-t border-border pt-3"
      data-testid="dialer-outcome"
      onSubmit={(e) => {
        e.preventDefault();
        if (!outcome) return;
        setSaving(true);
        setOutcome({ callId, outcome, ...(notes.trim() ? { notes } : {}), ...(dnc ? { doNotCall: true } : {}) })
          .then(() => void toast.success("Call logged"))
          .catch((cause) => void toast.error(getErrorMessage(cause)))
          .finally(() => setSaving(false));
      }}
    >
      <div className="text-xs text-muted-foreground">How did it go?</div>
      <div className="flex flex-wrap gap-1">
        {OUTCOMES.map((o) => (
          <button key={o} type="button" className={`${btn} ${outcome === o ? "bg-muted" : ""}`} onClick={() => setChoice(o)} data-testid={`dialer-outcome-${o}`}>
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>
      <textarea className={`${input} min-h-16`} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Call notes" />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} /> They asked not to be called: never call this number again
      </label>
      <button type="submit" className={btn} disabled={saving || disabled || !outcome} data-testid="dialer-outcome-save">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {label}
      </button>
    </form>
  );
}
