"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Headphones, Loader2, Mic, MicOff, Phone, PhoneForwarded, PhoneOff, SkipForward } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { OUTCOMES, type Outcome } from "../../../convex/lib/dialer/bridge";
import { EmptyState, LoadingRows } from "@/components/dashboard";
import { OUTCOME_LABEL, STATE_LABEL, clock, useTick } from "@/components/crm/call-contact";
import { useBrowserPhone } from "@/components/crm/browser-phone";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = "inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
const input = "w-full border border-input bg-background px-2 py-1.5 text-sm";
const card = "border border-border bg-card p-4";
const heading = "mb-2 text-xs font-medium text-muted-foreground";

const contactHref = (id: string) => `/dashboard/records/contact/${encodeURIComponent(id)}`;

/** Who the next call dials first, as a list being worked names them. */
export type NextUp = { contactId: string; name: string; detail?: string };

/**
 * The dialer's console (docs/dialer.md): the session on the rep's phone or this browser, the live call, the outcome,
 * and the rep's lines and voicemail settings. The list being worked is the caller's: `next` is who it dials first,
 * `remaining` how many are left, and `dial` places the next call (one, or a race of the rep's lines).
 */
function DialerConsoleEnabled({ next, remaining, dialCount, dial, skip, nextActions, idle, aside }: {
  next: NextUp | null;
  remaining: number;
  dialCount?: number;
  dial: () => Promise<{ callId: string | null }>;
  skip?: () => Promise<unknown>;
  /** Actions beside the next call, drawn by the list's owner (a module page's skip). */
  nextActions?: ReactNode;
  idle: string;
  aside?: ReactNode;
}) {
  const overview = useQuery(api.dialer.overview);
  const settings = useQuery(api.dialer.profile);
  const startSession = useMutation(api.dialer.startSession);
  const endSession = useMutation(api.dialer.endSession);
  const hangupCall = useMutation(api.dialer.hangupCall);
  const setOutcome = useMutation(api.dialer.setOutcome);

  const [agentPhone, setAgentPhone] = useState<string | null>(null);
  const [audioChoice, setAudio] = useState<"phone" | "browser" | null>(null);
  const [outcome, setChoice] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState("");
  const [dnc, setDnc] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = overview?.currentCall ?? null;
  const browserSession = overview?.session?.audio === "browser";
  const phone = useBrowserPhone(browserSession);
  const now = useTick(live?.state === "answered");

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

  if (overview === undefined) return <LoadingRows />;
  if (!overview?.configured || overview.numbers.length === 0) {
    return (
      <EmptyState
        icon={Phone}
        title={overview?.configured ? "Add a dialer number first" : "Calling isn't set up yet"}
        description="Reps call out from the workspace's Telnyx numbers. An admin adds them in Integrations → Dialer."
        action={{ label: "Open dialer settings", href: "/dashboard/integrations/dialer" }}
      />
    );
  }

  const session = overview.session;
  const awaiting = overview.awaitingOutcome;
  const picked = outcome ?? awaiting?.outcome ?? null;
  const phoneValue = agentPhone ?? overview.lastAgentPhone ?? "";
  const audio = audioChoice ?? overview.lastAudio;
  // With browser audio, leaving this page hangs up: contact links open in a new tab instead.
  const linkProps = browserSession ? { target: "_blank", rel: "noreferrer" } : {};
  const start = () => run(async () => {
    if (audio === "browser") {
      if (await phone.prepare()) await startSession({ audio: "browser" });
      return;
    }
    await startSession({ agentPhone: phoneValue });
  });
  // With parallel lines, the next call dials this many contacts at once.
  const batch = dialCount ?? (settings?.linesPaused ? 1 : Math.min(settings?.parallelLines ?? 1, remaining || 1));
  const nextLabel = batch > 1 ? `the next ${batch}` : next?.name ?? "next";

  const callNext = () => run(async () => {
    const { callId } = await dial();
    if (!callId) void toast.success("That's the end of the queue.");
  });

  const log = (thenNext: boolean) => run(async () => {
    if (!awaiting || !picked) return;
    await setOutcome({ callId: awaiting._id, outcome: picked, ...(notes.trim() ? { notes } : {}), ...(dnc ? { doNotCall: true } : {}) });
    setChoice(null);
    setNotes("");
    setDnc(false);
    if (thenNext && next) {
      const { callId } = await dial();
      if (!callId) void toast.success("That's the end of the queue.");
    }
  });

  return (
    <>
      {overview.simulated && <p className="text-xs text-amber-600 dark:text-amber-400">Local stack: calls are simulated and never ring a real phone. Numbers ending in 0 don&apos;t answer.</p>}

      <div className={`${overview.simulated ? "mt-4 " : ""}grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]`}>
        <div className="grid content-start gap-6">
          <section className={card} data-testid="dialer-session">
            <div className="flex items-center justify-between gap-2">
              <h2 className={heading}>Session</h2>
              {session && (
                <button type="button" className="text-xs text-muted-foreground underline" disabled={busy} onClick={() => void run(() => endSession({}))} data-testid="dialer-end-session">
                  End session
                </button>
              )}
            </div>
            {!session ? (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void start(); }}>
                <p className="text-sm text-muted-foreground">Canon rings you once, and every contact you dial is connected onto that one call.</p>
                {overview.lastError && <p className="text-xs text-red-600 dark:text-red-400">{overview.lastError}</p>}
                {phone.error && <p className="text-xs text-red-600 dark:text-red-400">{phone.error}</p>}
                <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Audio">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="audio" checked={audio === "phone"} onChange={() => setAudio("phone")} data-testid="dialer-audio-phone" /> <Phone className="h-3.5 w-3.5" /> My phone
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="audio" checked={audio === "browser"} onChange={() => setAudio("browser")} data-testid="dialer-audio-browser" /> <Headphones className="h-3.5 w-3.5" /> This browser
                  </label>
                </div>
                <div className="flex max-w-md gap-2">
                  {audio === "phone" ? (
                    <input className={input} placeholder="Your phone, like +14155550123" value={phoneValue} onChange={(e) => setAgentPhone(e.target.value)} aria-label="Your phone" data-testid="dialer-agent-phone" />
                  ) : (
                    <span className="flex-1 text-xs text-muted-foreground">Use a headset. Keep this tab open while you dial; closing it ends the session.</span>
                  )}
                  <button type="submit" className={btn} disabled={busy || (audio === "phone" && !phoneValue.trim())} data-testid="dialer-start">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />} Start
                  </button>
                </div>
              </form>
            ) : session.status === "calling_agent" ? (
              <p className="flex items-center gap-2 text-sm" data-testid="dialer-ringing-agent">
                <Loader2 className="h-4 w-4 animate-spin" />
                {browserSession ? "Connecting this browser…" : `Ringing your phone at ${session.agentPhone}. Answer it to start dialing.`}
              </p>
            ) : browserSession ? (
              <div className="flex flex-wrap items-center justify-between gap-2" data-testid="dialer-browser-audio">
                <p className="text-sm text-muted-foreground">
                  Connected in this browser{phone.state === "simulated" ? " (simulated)" : ""}. Calling from {session.from}. Keep this tab open.
                </p>
                {phone.state === "on_call" && (
                  <button type="button" className={btn} onClick={phone.toggleMute} data-testid="dialer-mute">
                    {phone.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />} {phone.muted ? "Unmute" : "Mute"}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Connected. Calling from {session.from}; your phone {session.agentPhone} stays on the line between calls.</p>
            )}
            <audio ref={phone.audioRef} autoPlay className="hidden" />
          </section>

          {session?.status === "ready" && (
            <section className={card} data-testid="dialer-current">
              <h2 className={heading}>Now</h2>
              {live ? (
                <div className="flex flex-wrap items-center justify-between gap-3" data-testid="dialer-live">
                  <div>
                    <Link href={contactHref(live.contactId)} {...linkProps} className="text-lg font-medium underline-offset-2 hover:underline">{live.contactName}</Link>
                    <div className="text-sm text-muted-foreground">
                      {live.machine ? "Voicemail: leaving your message" : live.screening ? "Answered, checking for voicemail…" : STATE_LABEL[live.state]} {live.to}
                      {live.state === "answered" && live.answeredAt && <span className="ml-2 font-mono">{clock(Math.max(0, Math.round((now - live.answeredAt) / 1000)))}</span>}
                    </div>
                  </div>
                  <button type="button" className={btn} disabled={busy} onClick={() => void run(() => hangupCall({}))} data-testid="dialer-hangup">
                    <PhoneOff className="h-3.5 w-3.5" /> Hang up
                  </button>
                </div>
              ) : awaiting ? (
                <form className="space-y-3" data-testid="dialer-outcome" onSubmit={(e) => { e.preventDefault(); void log(true); }}>
                  <div className="text-sm">
                    How did the call with <Link href={contactHref(awaiting.contactId)} {...linkProps} className="font-medium underline">{awaiting.contactName}</Link> go?
                    {awaiting.durationSeconds ? <span className="ml-2 font-mono text-xs text-muted-foreground">{clock(awaiting.durationSeconds)}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {OUTCOMES.map((o) => (
                      <button key={o} type="button" className={`${btn} ${picked === o ? "bg-muted" : ""}`} onClick={() => setChoice(o)} data-testid={`dialer-outcome-${o}`}>
                        {OUTCOME_LABEL[o]}
                      </button>
                    ))}
                  </div>
                  <textarea className={`${input} min-h-16`} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Call notes" />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} data-testid="dialer-dnc-check" /> They asked not to be called: never call this number again
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {next && (
                      <button type="submit" className={primary} disabled={busy || !picked} data-testid="dialer-log-next">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneForwarded className="h-4 w-4" />} Log and call {nextLabel}
                      </button>
                    )}
                    <button type="button" className={btn} disabled={busy || !picked} onClick={() => void log(false)} data-testid="dialer-log">
                      Log call
                    </button>
                  </div>
                </form>
              ) : overview.racing.length > 0 ? (
                <div className="flex flex-wrap items-start justify-between gap-3" data-testid="dialer-racing">
                  <div className="space-y-1 text-sm">
                    <div className="font-medium">Dialing {overview.racing.length} lines. The first person to answer is yours.</div>
                    {overview.racing.map((r) => (
                      <div key={r._id} className="text-muted-foreground">{r.contactName} · {STATE_LABEL[r.state]} {r.to}</div>
                    ))}
                  </div>
                  <button type="button" className={btn} disabled={busy} onClick={() => void run(() => hangupCall({}))} data-testid="dialer-hangup-all">
                    <PhoneOff className="h-3.5 w-3.5" /> Hang up all
                  </button>
                </div>
              ) : next ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Link href={contactHref(next.contactId)} {...linkProps} className="text-lg font-medium underline-offset-2 hover:underline">{next.name}</Link>
                    {next.detail && <div className="text-sm text-muted-foreground">{next.detail}</div>}
                  </div>
                  <div className="flex gap-2">
                    {nextActions}
                    {skip && (
                      <button type="button" className={btn} disabled={busy} onClick={() => void run(skip)} data-testid="dialer-skip">
                        <SkipForward className="h-3.5 w-3.5" /> Skip
                      </button>
                    )}
                    <button type="button" className={primary} disabled={busy} onClick={() => void callNext()} data-testid="dialer-call-next">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />} Call {nextLabel}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{idle}</p>
              )}
            </section>
          )}
        </div>

        <div className="grid content-start gap-6">
          {aside}
          <LinesSetting />
          <VoicemailSettings />
        </div>
      </div>
    </>
  );
}

/** The rep's voicemail detection and drop (docs/dialer.md). Applies from the next call placed. */
function VoicemailSettings() {
  const profile = useQuery(api.dialer.profile);
  const save = useMutation(api.dialer.saveProfile);
  const [detect, setDetect] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!profile) return null;
  const on = detect ?? profile.detectVoicemail;
  const text = message ?? profile.voicemailMessage;
  const dirty = on !== profile.detectVoicemail || text.trim() !== profile.voicemailMessage;
  return (
    <section className={card} data-testid="dialer-voicemail">
      <h2 className={heading}>Voicemail</h2>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={on} onChange={(e) => setDetect(e.target.checked)} data-testid="dialer-voicemail-detect" />
        <span>Detect voicemail. You&apos;re connected only when a person answers; a machine gets your message after the beep.</span>
      </label>
      {on && (
        <textarea
          className={`${input} mt-2 min-h-24`}
          placeholder="Your voicemail, read after the beep. Leave it empty to hang up on machines."
          value={text}
          maxLength={1000}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="Voicemail message"
          data-testid="dialer-voicemail-message"
        />
      )}
      <button
        type="button"
        className={`${btn} mt-2`}
        disabled={saving || !dirty}
        data-testid="dialer-voicemail-save"
        onClick={() => {
          setSaving(true);
          save({ detectVoicemail: on, voicemailMessage: text, parallelLines: profile.parallelLines })
            .then(() => {
              setDetect(null);
              setMessage(null);
              void toast.success("Voicemail settings saved");
            })
            .catch((cause) => void toast.error(getErrorMessage(cause)))
            .finally(() => setSaving(false));
        }}
      >
        Save
      </button>
    </section>
  );
}

/**
 * Parallel lines (docs/dialer.md): dial up to three queued contacts at once.
 * A person who answers after another line has the rep is an abandoned call;
 * the telemarketing rules cap those at 3% of people reached over 30 days.
 */
function LinesSetting() {
  const profile = useQuery(api.dialer.profile);
  const save = useMutation(api.dialer.saveProfile);
  const [saving, setSaving] = useState(false);
  if (!profile) return null;
  const { calls, reached } = profile.abandoned;
  const rate = reached ? calls / reached : 0;
  const setLines = (parallelLines: number) => {
    setSaving(true);
    save({ detectVoicemail: profile.detectVoicemail, voicemailMessage: profile.voicemailMessage, parallelLines })
      .catch((cause) => void toast.error(getErrorMessage(cause)))
      .finally(() => setSaving(false));
  };
  return (
    <section className={card} data-testid="dialer-lines">
      <h2 className={heading}>Lines</h2>
      <div className="flex gap-1" role="radiogroup" aria-label="Lines at once">
        {Array.from({ length: profile.maxLines }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" role="radio" aria-checked={profile.parallelLines === n} disabled={saving}
            className={`${btn} ${profile.parallelLines === n ? "bg-muted" : ""}`} onClick={() => setLines(n)} data-testid={`dialer-lines-${n}`}>
            {n}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {profile.parallelLines === 1
          ? "One contact at a time."
          : `Queue calls dial ${profile.parallelLines} contacts at once. The first person to answer is connected; anyone who answers after hears who called and is hung up.`}
      </p>
      {profile.linesPaused && profile.parallelLines > 1 && (
        <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400" data-testid="dialer-lines-paused">
          Parallel lines are paused: queue calls dial one contact at a time until the abandonment rate (yours, or this queue&apos;s) is back under 3%.
        </p>
      )}
      {profile.campaign && profile.campaign.reached > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="dialer-campaign-rate">
          {profile.campaign.name}: abandoned {profile.campaign.calls} of {profile.campaign.reached} people reached in 30 days ({((profile.campaign.calls / profile.campaign.reached) * 100).toFixed(1)}%).
        </p>
      )}
      {reached > 0 && (
        <p className={`mt-1 text-xs ${rate > 0.03 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`} data-testid="dialer-abandon-rate">
          Abandoned {calls} of {reached} people reached in 30 days ({(rate * 100).toFixed(1)}%){rate > 0.03 ? ". That's over the 3% the telemarketing rules allow: dial fewer lines." : "."}
        </p>
      )}
    </section>
  );
}

export function DialerConsole(props: React.ComponentProps<typeof DialerConsoleEnabled>) {
  return <IntegrationGate feature="dialer"><DialerConsoleEnabled {...props} /></IntegrationGate>;
}
