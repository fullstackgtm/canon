"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { SUPPRESSION_KINDS, SUPPRESSION_SOURCES, type SuppressionKind, type SuppressionSource } from "../../../../convex/lib/suppressions/domain";
import { useSuppressionsAvailable } from "@/hooks/use-suppressions-available";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

const input = "border border-input bg-background px-2 py-1.5 text-sm";

export function SuppressionsSection() {
  const available = useSuppressionsAvailable();
  const access = useQuery(api.permissions.mine);
  const [cursor, setCursor] = useState<string | null>(null);
  const rows = useQuery(api.suppressions.list, available && access?.role === "admin" && !access.preview ? { paginationOpts: { cursor, numItems: 50 } } : "skip");
  const add = useMutation(api.suppressions.add);
  const lift = useMutation(api.suppressions.lift);
  const [kind, setKind] = useState<SuppressionKind>("email");
  const [source, setSource] = useState<SuppressionSource>("manual");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!available || access?.role !== "admin" || access.preview) return null;
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    work().catch((cause) => toast.error(getErrorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-label="Do not contact">
      <h2 className="text-sm font-medium">Do not contact</h2>
      <p className="text-sm text-muted-foreground">Rules apply across email, LinkedIn and voice. Unsubscribes and replies stop automated outreach. Manual rules, bounces and do-not-call rules also stop personal outreach. Lifting one cause leaves other causes in effect.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); run(async () => { await add({ kind, value, source, ...(reason.trim() ? { reason: reason.trim() } : {}) }); setValue(""); setReason(""); setCursor(null); }); }}>
        <label className="grid gap-1 text-xs">Channel identifier<select className={input} value={kind} onChange={(e) => setKind(e.target.value as SuppressionKind)}>{SUPPRESSION_KINDS.map((k) => <option key={k} value={k}>{k === "phone" ? "Phone" : k === "linkedin" ? "LinkedIn" : k === "domain" ? "Email domain" : "Email"}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Value<input className={input} required maxLength={512} value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <label className="grid gap-1 text-xs">Cause<select className={input} value={source} onChange={(e) => setSource(e.target.value as SuppressionSource)}>{SUPPRESSION_SOURCES.map((s) => <option key={s} value={s}>{s === "dnc" ? "Do not call" : s}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Note<input className={input} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="submit" className={input} disabled={busy || !value.trim()}>Add rule</button>
      </form>
      {rows === undefined ? <p className="text-sm text-muted-foreground">Loading rules…</p> : <>
        {!rows.page.length && <p className="text-sm text-muted-foreground">No rules on this page.</p>}
        {rows.page.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Identifier</th><th className="p-2">Cause</th><th className="p-2">Status</th><th className="p-2">Note</th><th className="p-2"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {rows.page.map((r) => <tr key={r._id} className="border-t border-border"><td className="p-2">{r.value}<span className="ml-2 text-xs text-muted-foreground">{r.kind}</span></td><td className="p-2">{r.source === "dnc" ? "Do not call" : r.source}</td><td className="p-2">{r.state === "active" ? "Active" : "Lifted"}</td><td className="p-2">{r.reason ?? ""}</td><td className="p-2">{r.state === "active" && <button type="button" className="underline disabled:opacity-50" disabled={busy} onClick={() => run(() => lift({ id: r._id }))} aria-label={`Lift ${r.source} rule for ${r.value}`}>Lift this cause</button>}</td></tr>)}
        </tbody></table></div>}
        <div className="flex gap-2"><button type="button" className={input} disabled={cursor === null} onClick={() => setCursor(null)}>Newest</button><button type="button" className={input} disabled={rows.isDone} onClick={() => setCursor(rows.continueCursor)}>Older</button></div>
      </>}
    </section>
  );
}
