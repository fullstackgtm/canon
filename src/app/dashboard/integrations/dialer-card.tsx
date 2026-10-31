"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Ban, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

/** Dialer: the workspace's Telnyx numbers reps call out from (docs/dialer.md). Admins add and remove them. */
export function DialerControls() {
  const overview = useQuery(api.dialer.overview);
  const addNumber = useMutation(api.dialer.addNumber);
  const removeNumber = useMutation(api.dialer.removeNumber);
  const saveSettings = useMutation(api.dialer.saveSettings);
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
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

  if (!overview) return null;

  return (
    <div data-testid="dialer-card">
      {!overview.configured ? (
        <p className="text-sm text-muted-foreground">Calling isn&apos;t set up on this deployment yet.</p>
      ) : (
        <div className="space-y-3">
          {overview.simulated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Local stack: calls are simulated and never ring a real phone.</p>
          )}
          {overview.numbers.map((n) => (
            <div key={n._id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3" data-testid="dialer-number">
              <div className="text-sm">
                <div className="font-medium">{n.number}</div>
                <div className="text-xs text-muted-foreground">{n.label ? `${n.label} · ` : ""}{n.free ? "Free" : "In a live session"}</div>
              </div>
              {overview.canManage && (
                <button
                  type="button"
                  disabled={busy || !n.free}
                  onClick={() => void run(() => removeNumber({ numberId: n._id as Id<"dialerNumbers"> }), `${n.number} removed`)}
                  className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" /> Remove
                </button>
              )}
            </div>
          ))}
          <label className="flex items-start gap-2 border-t border-border pt-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={overview.record}
              disabled={!overview.canManageRecording || busy}
              onChange={(e) => void run(() => saveSettings({ record: e.target.checked }), e.target.checked ? "Calls are recorded" : "Recording is off")}
              data-testid="dialer-record"
            />
            <span>
              Record calls. Each person hears &ldquo;This call is recorded&rdquo; as they&apos;re connected, as some US states require.
              Off: calls aren&apos;t recorded or transcribed, and call insights get nothing from them.
            </span>
          </label>
          {overview.canManage ? (
            <form
              className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await addNumber({ number, ...(label.trim() ? { label } : {}) });
                  setNumber("");
                  setLabel("");
                }, "Number added");
              }}
            >
              <label className="grid gap-1 text-xs text-muted-foreground">
                Telnyx number
                <input className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground" placeholder="+14155550123" value={number} onChange={(e) => setNumber(e.target.value)} data-testid="dialer-number-input" />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Label (optional)
                <input className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground" placeholder="Sales line" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <button
                type="submit"
                disabled={busy || !number.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="dialer-number-add"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add number
              </button>
              <p className="w-full text-xs text-muted-foreground">Buy the number in Telnyx and assign it to Canon&apos;s Call Control application first.</p>
            </form>
          ) : (
            overview.numbers.length === 0 && <p className="text-sm text-muted-foreground">Ask an admin to add a dialer number.</p>
          )}
          <DoNotCallList />
        </div>
      )}
    </div>
  );
}

/** The workspace's do-not-call list. Anyone adds a number; only an admin takes one off. */
function DoNotCallList() {
  const access = useQuery(api.permissions.mine);
  const canLift = access?.role === "admin" && !access.preview;
  const list = useQuery(api.dialer.doNotCallList);
  const add = useMutation(api.dialer.addDoNotCall);
  const remove = useMutation(api.dialer.removeDoNotCall);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  if (!list) return null;
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    work().catch((cause) => void toast.error(getErrorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <div className="border-t border-border pt-3" data-testid="dialer-dnc">
      <div className="flex items-center gap-2 text-sm font-medium"><Ban className="h-4 w-4" /> Do not call</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Canon never dials these numbers, and they never enter a queue. Reps add a contact here when logging a call. Calls are also held to 8 AM to 9 PM in the contact&apos;s time zone.
      </p>
      {list.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-sm">
          {list.map((r) => (
            <li key={r._id} className="flex items-center justify-between gap-2" data-testid="dialer-dnc-row">
              <span>{r.number} <span className="text-xs text-muted-foreground">{r.reason ?? ""}</span></span>
              {canLift && (
                <button type="button" className="text-xs text-muted-foreground underline" disabled={busy} onClick={() => run(() => remove({ id: r._id }))}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await add({ number }); setNumber(""); }); }}>
        <input className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm" placeholder="+14155550123" value={number} onChange={(e) => setNumber(e.target.value)} aria-label="Number not to call" data-testid="dialer-dnc-input" />
        <button type="submit" className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" disabled={busy || !number.trim()} data-testid="dialer-dnc-add">Add</button>
      </form>
    </div>
  );
}
