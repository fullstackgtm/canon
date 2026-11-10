"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { INTAKE_CONSENT } from "../../../../convex/lib/conversations/consent";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { Panel } from "@/components/salesforce-sync/ui";
import { formatRelativeTime } from "./call-provider-card";
import { granolaReadState, readStateOf, StatusDot, statusTextClass, type ReadState, type Tone } from "./integration-ui";
import { useGranolaDisconnect } from "./granola-card";

type Channel = keyof typeof INTAKE_CONSENT;
type AccountId = Id<"linkedinAccounts"> | Id<"emailAccounts">;
type Intake = {
  on: boolean;
  consentAt: number | null;
  backfilledAt: number | null;
  syncedAt: number | null;
  hasRead: boolean;
  conversations: number;
  conversationsMore: boolean;
  progress: { failed: boolean; detail: string | null } | null;
};

const WHAT = {
  linkedin: { agree: "Let Canon read my LinkedIn messages", what: "LinkedIn message", place: "LinkedIn account" },
  email: { agree: "Let Canon read the email in this inbox", what: "email", place: "inbox" },
} as const;
const STATE: Record<ReadState, { tone: Tone; label: string }> = {
  off: { tone: "off", label: "Off" },
  reading: { tone: "syncing", label: "Reading the last 90 days…" },
  on: { tone: "connected", label: "On" },
  stopped: { tone: "attention", label: "Stopped" },
};
const button = "inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50";
const day = (at: number | null) => new Date(at ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** A sentence ending in a full stop, unless it already ends in one or an ellipsis. */
const sentence = (s: string) => (/[.…]$/.test(s) ? s : `${s}.`);
const conversations = (n: number, more: boolean) => `${n.toLocaleString()}${more ? "+" : ""} ${n === 1 && !more ? "conversation" : "conversations"}`;

/**
 * The one shape "Read my messages" (Gmail, per inbox, and LinkedIn) and "Read my meetings" (Granola) take: the title
 * with what is read, its state, one status line, what Canon reads, then the controls. Each sits at the top of its
 * integration's page, right after the account is linked.
 */
export function ReadingPanel({ title, subject, state, stateLabel, status, what, children, testId }: {
  title: string;
  subject?: string | null;
  state: ReadState;
  stateLabel?: string;
  status: ReactNode;
  what: readonly string[];
  children?: ReactNode;
  testId: string;
}) {
  const { tone, label } = STATE[state];
  return (
    <section data-testid={testId} data-state={state} className="mb-6 border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">
          {title}
          {subject && <span className="font-normal text-muted-foreground"> · {subject}</span>}
        </h3>
        <span className={`inline-flex items-center gap-2 text-xs ${statusTextClass(tone)}`} data-testid={`${testId}-state`}>
          <StatusDot tone={tone} />
          {stateLabel ?? label}
        </span>
      </div>
      <p className="text-sm">{status}</p>
      <p className="mt-4 text-xs font-medium text-muted-foreground">What Canon reads</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {what.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {children && <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>}
    </section>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      void toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** "Read my messages": conversation intake for one linked account (docs/conversation-intake.md), off until its owner agrees. */
export function ReadMyMessages({ accountId, intake, channel, subject }: { accountId: AccountId; intake: Intake; channel: Channel; subject?: string | null }) {
  const setIntake = useMutation(api.conversations.setIntake);
  const [agreed, setAgreed] = useState(false);
  const { busy, run } = useRun();
  const consent = INTAKE_CONSENT[channel];
  const state = readStateOf(intake);
  const kept = conversations(intake.conversations, intake.conversationsMore);
  const status = {
    off: `Canon reads nothing from this ${WHAT[channel].place}.${intake.hasRead ? ` It keeps ${kept} read before, until you delete them.` : ""}`,
    reading: `On since ${day(intake.consentAt)}. ${sentence(intake.progress?.detail ?? "Starting…")} This takes an hour or two; the background tray, lower right, shows how far it got.`,
    stopped: `On since ${day(intake.consentAt)}. ${intake.progress?.detail ?? ""}`,
    on: `On since ${day(intake.consentAt)} · last read ${formatRelativeTime(intake.syncedAt ?? intake.backfilledAt ?? undefined)} · ${kept} read.`,
  }[state];

  return (
    <ReadingPanel title="Read my messages" subject={subject} state={state} status={status} what={consent.text} testId={`${channel}-intake`}>
      {intake.on ? (
        <button type="button" disabled={busy} className={button} onClick={() => void run(() => setIntake({ accountId, on: false }), "Canon stopped reading your messages")}>
          Turn off
        </button>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid={`${channel}-intake-agree`} />
            {WHAT[channel].agree}
          </label>
          <button type="button" disabled={busy || !agreed} className={button} onClick={() => void run(() => setIntake({ accountId, on: true, textVersion: consent.version }), "Canon is reading your messages")}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Turn on
          </button>
          {intake.hasRead && <DeleteRead accountId={accountId} channel={channel} />}
        </>
      )}
    </ReadingPanel>
  );
}

/**
 * "Read my meetings": what Granola already does, in the same shape. Granola has no switch of its own: Canon reads
 * while the workspace's key is connected, and disconnecting is how it stops (and deletes what was read).
 */
export function ReadMyMeetings() {
  const status = useQuery(api.granola.status);
  const disconnect = useGranolaDisconnect();
  if (!status?.connected) return null;
  const from = status.folders.length ? `from ${status.folders.map((f) => f.name).join(", ")}` : "from every meeting your Granola key reads";
  const meetings = `${status.imported >= 1000 ? "1,000+" : status.imported.toLocaleString()} ${status.imported === 1 ? "meeting" : "meetings"}`;
  const state = granolaReadState(status);
  const line = {
    reading: `${status.rescoping ? "Switching folders: the meetings read before are being deleted, then" : "Importing"} the last ${status.lookbackDays} days ${from}. ${meetings} so far; the background tray, lower right, shows how far it got.`,
    stopped: `On while Granola is connected. The last check failed: ${status.lastSyncError ?? "unknown error"}`,
    on: `On while Granola is connected · ${from} · last read ${formatRelativeTime(status.lastSyncAt ?? undefined)} · ${meetings} read.`,
    off: "",
  }[state];
  const what = [
    `Every meeting note ${status.folders.length ? "in the chosen folders and their subfolders" : "your Granola key can read"}: the last ${status.lookbackDays} days when connected, then new meetings every 15 minutes.`,
    "It keeps each meeting's transcript and summary, and logs the meeting on its people, company and deal.",
    "A meeting held in the last 7 days can update fields such as next step and close date (in Fact Review, or on their own where you allowed it). Older meetings only suggest new people, companies and deals.",
    "Granola is connected for the whole workspace, not per person.",
    "Disconnecting stops it and deletes what was read. Companies, people and deals stay.",
  ];
  return (
    <ReadingPanel title="Read my meetings" subject="Granola" state={state} stateLabel={state === "reading" ? (status.rescoping ? "Switching folders…" : `Importing the last ${status.lookbackDays} days…`) : undefined} status={line} what={what} testId="granola-intake">
      {status.canManage && (
        <button type="button" disabled={disconnect.busy} className={button} onClick={() => disconnect.run(status.imported)}>
          Turn off (disconnect)
        </button>
      )}
    </ReadingPanel>
  );
}

function DeleteRead({ accountId, channel }: { accountId: AccountId; channel: Channel }) {
  const deleteRead = useMutation(api.conversations.deleteRead);
  const { busy, run } = useRun();
  return (
    <button
      type="button"
      disabled={busy}
      className={button}
      onClick={() => {
        if (window.confirm(`Delete every ${WHAT[channel].what} Canon read from this account? Timeline entries stay, without their text.`)) void run(() => deleteRead({ accountId }), "Deleting what was read");
      }}
    >
      Delete what was read
    </button>
  );
}

/** Accounts the caller unlinked that still hold messages Canon read: deleting them stays possible after unlinking (issue #920). */
export function UnlinkedReads({ channel }: { channel: Channel }) {
  const rows = useQuery(api.conversations.unlinkedReads, { channel });
  if (!rows?.length) return null;
  return (
    <Panel title="Messages read from unlinked accounts">
      <div className="space-y-3" data-testid={`${channel}-unlinked-reads`}>
        <p className="text-sm text-muted-foreground">These accounts are unlinked, and Canon no longer reads them. What it read before is kept until you delete it.</p>
        {rows.map((r) => (
          <div key={r._id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-sm font-medium">{r.label}</span>
            <DeleteRead accountId={r._id} channel={channel} />
          </div>
        ))}
      </div>
    </Panel>
  );
}
