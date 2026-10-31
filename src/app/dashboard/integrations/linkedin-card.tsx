"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Linkedin, Loader2, RefreshCw, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LABELS, LIMIT_KEYS, RAMP_STEPS, ceilingFor, type LimitKey } from "../../../../convex/lib/linkedin/limits";
import { RISK_TEXT, RISK_TEXT_VERSION } from "../../../../convex/lib/linkedin/risk";
import { ReadMyMessages } from "./intake-settings";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const USED = { invitesPerDay: "invitesToday", invitesPerWeek: "invitesWeek", messagesPerDay: "messagesToday", lookupsPerDay: "lookupsToday" } as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_LABEL = { ok: "Connected", credentials: "Needs login", paused: "Paused", disconnected: "Disconnected" } as const;
const TIERS = { free: "Free", premium: "Premium", sales_navigator: "Sales Navigator" } as const;

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minuteOf = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** LinkedIn: the user's own account, connected through Unipile's hosted login, with Canon's sending limits. */
export function LinkedinControls() {
  const mine = useQuery(api.linkedin.mine);
  const startConnect = useAction(api.linkedinActions.startConnect);
  const disconnect = useMutation(api.linkedin.disconnect);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run(async () => {
      const { url } = await startConnect({ acceptRisk: true, riskTextVersion: RISK_TEXT_VERSION, timezone: browserTimezone() });
      if (url) window.location.assign(url);
    });

  if (mine === undefined) return null;
  const account = mine?.account ?? null;

  return (
    <div data-testid="linkedin-card">
      {!mine?.configured ? (
        <p className="text-sm text-muted-foreground">LinkedIn isn&apos;t set up on this deployment yet.</p>
      ) : !account ? (
        <div className="space-y-3">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {RISK_TEXT.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="linkedin-accept-risk" />
            I accept the risk to my LinkedIn profile
          </label>
          <button
            type="button"
            disabled={busy || !accepted}
            onClick={() => void connect()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Linkedin className="h-4 w-4" />} Connect LinkedIn
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            {STATUS_LABEL[account.status]} ·{" "}
            {account.profileName ?? "Your account"} · {TIERS[account.tier]} ·{" "}
            {account.rampStep >= RAMP_STEPS ? "Warmed up" : `Warming up, week ${account.rampStep + 1} of ${RAMP_STEPS}`}
          </p>
          {account.statusReason && <p className="text-sm text-amber-600 dark:text-amber-400">{account.statusReason}</p>}
          <Link href="/dashboard/linkedin" className="inline-block text-sm underline">Manage cadences, limits and sending hours</Link>
          <div className="flex flex-wrap gap-2">
            {account.status === "credentials" && (
              <button type="button" disabled={busy} onClick={() => void connect()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" /> Log in again
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => { await disconnect({ accountId: account._id }); void toast.success("LinkedIn disconnected"); })}
              className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="h-4 w-4" /> Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type Account = NonNullable<NonNullable<FunctionReturnType<typeof api.linkedin.mine>>["account"]>;

export function AccountSettings({ account, isAdmin }: { account: Account; isAdmin: boolean }) {
  const save = useMutation(api.linkedin.updateSettings);
  const [timezone, setTimezone] = useState(account.timezone);
  const [days, setDays] = useState<number[]>(account.window.days);
  const [start, setStart] = useState(hhmm(account.window.startMinute));
  const [end, setEnd] = useState(hhmm(account.window.endMinute));
  const [limits, setLimits] = useState<Partial<Record<LimitKey, string>>>(
    Object.fromEntries(LIMIT_KEYS.map((k) => [k, account.overrides[k]?.toString() ?? ""])),
  );
  const [salesNav, setSalesNav] = useState(account.salesNavHighVolume);
  const [saving, setSaving] = useState(false);
  // The ceiling follows the opt-in as it is ticked, so the two can be saved together.
  const ceiling = ceilingFor(account.tier, salesNav);

  useEffect(() => {
    setTimezone(account.timezone);
    setDays(account.window.days);
    setStart(hhmm(account.window.startMinute));
    setEnd(hhmm(account.window.endMinute));
    setSalesNav(account.salesNavHighVolume);
  }, [account.timezone, account.window, account.salesNavHighVolume]);

  async function submit() {
    setSaving(true);
    try {
      const overrides = Object.fromEntries(
        LIMIT_KEYS.flatMap((k) => (limits[k]?.trim() ? [[k, Number(limits[k])]] : [])),
      ) as Partial<Record<LimitKey, number>>;
      await save({ accountId: account._id, timezone, window: { days, startMinute: minuteOf(start), endMinute: minuteOf(end) }, overrides, salesNavHighVolume: salesNav });
      void toast.success("LinkedIn limits saved");
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-1 font-medium">Limit</th><th className="font-medium">Today</th><th className="font-medium">Your cap</th><th className="font-medium">Recommended</th><th className="font-medium">Ceiling</th></tr>
          </thead>
          <tbody>
            {LIMIT_KEYS.map((k) => (
              <tr key={k} className="border-t border-border/60">
                <td className="py-1.5">{LABELS[k]}</td>
                <td className="tabular-nums">{account.usage[USED[k]]} / {account.today[k]}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={isAdmin ? ceiling[k] : account.recommended[k]}
                    aria-label={`${LABELS[k]} cap`}
                    placeholder={String(account.recommended[k])}
                    value={limits[k] ?? ""}
                    onChange={(e) => setLimits((cur) => ({ ...cur, [k]: e.target.value }))}
                    className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                  />
                </td>
                <td className="tabular-nums text-muted-foreground">{account.recommended[k]}</td>
                <td className="tabular-nums text-muted-foreground">{ceiling[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-muted-foreground">
          Leave a cap blank to use Canon&apos;s recommendation. New accounts start lower and warm up over {RAMP_STEPS} weeks while invites keep getting accepted.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">Send on</span>
        {DAYS.map((label, d) => (
          <label key={label} className="flex items-center gap-1">
            <input type="checkbox" checked={days.includes(d)} onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Between</span>
        <input type="time" aria-label="Start time" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1" />
        <span className="text-muted-foreground">and</span>
        <input type="time" aria-label="End time" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1" />
        <span className="text-muted-foreground">in</span>
        <input aria-label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-48 rounded-md border border-input bg-background px-2 py-1" />
      </div>
      {account.tier === "sales_navigator" && isAdmin && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={salesNav} onChange={(e) => setSalesNav(e.target.checked)} />
          Allow up to 200 invites a week (Sales Navigator accounts in good standing only)
        </label>
      )}
      <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save limits
      </button>
    </form>
  );
}

/** "Read my messages" for the linked LinkedIn account (shared with Gmail: intake-settings.tsx). */
export function IntakeSettings({ account }: { account: Account }) {
  return <ReadMyMessages accountId={account._id} intake={account.intake} channel="linkedin" subject={account.profileName} />;
}
