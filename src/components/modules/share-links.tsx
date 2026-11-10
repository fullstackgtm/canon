"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Copy, ExternalLink, Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

const button = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "mt-1 w-full border border-border bg-background px-3 py-2 text-sm";
const date = (at: number | null) => at === null ? "Never" : new Date(at).toLocaleString();

export function ShareLinks({ module, share, recordKey, disabled }: { module: string; share: string; recordKey: string; disabled: boolean }) {
  const args = { module, share, key: recordKey };
  const result = useQuery(api.modules.links, args);
  const issue = useAction(api.modules.issueLink), revoke = useMutation(api.modules.revokeLink), extend = useMutation(api.modules.extendLink);
  const [dialog, setDialog] = useState<{ kind: "issue" } | { kind: "extend" | "revoke"; publicId: string } | null>(null);
  const [name, setName] = useState(""), [email, setEmail] = useState("");
  const [extraEmails, setExtraEmails] = useState("");
  const [days, setDays] = useState(""), [identity, setIdentity] = useState<"link" | "email" | null>(null);
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!result) return <p className="text-sm text-muted-foreground">Loading customer links...</p>;
  if (!result.enabled) return <p className="text-sm text-muted-foreground">Customer links aren&apos;t on in this workspace yet</p>;
  const open = (next: NonNullable<typeof dialog>) => { setDialog(next); setUrl(null); setError(null); setName(""); setEmail(""); setExtraEmails(""); setDays(String(result.expiresDays?.default ?? 30)); setIdentity(result.identity?.default ?? "link"); };
  const submit = async () => {
    if (!dialog) return;
    setBusy(true); setError(null);
    try {
      if (dialog.kind === "issue") {
        const issued = await issue({ ...args, to: { ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) }, ...(identity === "email" ? { emails: extraEmails.split(/[\s,;]+/).filter(Boolean) } : {}), expiresDays: Number(days), identity: identity ?? undefined });
        setUrl(issued.url);
      } else {
        if (dialog.kind === "extend") await extend({ ...args, publicId: dialog.publicId, days: Number(days) });
        else await revoke({ ...args, publicId: dialog.publicId });
        setDialog(null);
      }
    } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  };
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Customer links</h2><p className="mt-1 text-xs text-muted-foreground">Issue a link for each recipient. You can revoke it at any time.</p></div><div className="flex gap-2"><Link className={button} target="_blank" rel="noopener noreferrer" href={`/module-preview/${encodeURIComponent(module)}/${encodeURIComponent(share)}/${encodeURIComponent(recordKey)}`}><ExternalLink className="size-3.5" />Preview as customer</Link><button className={button} disabled={disabled} onClick={() => open({ kind: "issue" })}><Plus className="size-3.5" />Issue link</button></div></div>
    {result.links.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["Recipient", "Identity", "Opened", "Last opened", "Expires", "Revoked", "Actions"].map((label) => <th key={label} className="border-b border-border px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{result.links.map((link) => <tr key={link.publicId}>
      <td className="border-b border-border p-2"><p>{link.issuedTo.name || link.issuedTo.email || "Recipient"}</p>{link.issuedTo.name && link.issuedTo.email && <p className="mt-1 text-muted-foreground">{link.issuedTo.email}</p>}</td><td className="border-b border-border p-2">{link.identity === "email" ? "Email verification" : "Link holder"}</td><td className="border-b border-border p-2 tabular-nums">{link.opens}</td><td className="border-b border-border p-2">{date(link.lastOpenedAt)}</td><td className="border-b border-border p-2">{date(link.expiresAt)}</td><td className="border-b border-border p-2">{link.revokedAt === null ? "No" : date(link.revokedAt)}</td><td className="border-b border-border p-2"><div className="flex gap-2"><button className={button} disabled={disabled || link.revokedAt !== null} onClick={() => open({ kind: "extend", publicId: link.publicId })}>Extend</button><button className={button} disabled={disabled || link.revokedAt !== null} onClick={() => open({ kind: "revoke", publicId: link.publicId })}>Revoke</button></div></td>
    </tr>)}</tbody></table></div> : <p className="border border-border p-5 text-sm text-muted-foreground">No links issued yet.</p>}
    <Dialog open={dialog !== null} onOpenChange={(opened) => { if (!opened && !busy) { setDialog(null); setUrl(null); } }}><DialogContent><DialogTitle>{url ? "Copy this link now" : dialog?.kind === "issue" ? "Issue customer link" : dialog?.kind === "extend" ? "Extend customer link" : "Revoke customer link"}</DialogTitle><DialogDescription>{url ? "This URL is shown once. Canon stores only its hash." : dialog?.kind === "revoke" ? "The recipient will no longer be able to use this link." : identity === "email" ? "Customers verify an allowed email in each browser before opening this page." : "Anyone holding a link can do what the share allows. Forwarding the link gives that access to someone else."}</DialogDescription>
      {url ? <div className="space-y-4"><input className={input} aria-label="Customer link" readOnly value={url} /><button className={button} onClick={async () => { try { await navigator.clipboard.writeText(url); toast.success("Link copied"); } catch { setError("Copy the link from the field above."); } }}><Copy className="size-3.5" />Copy link</button></div> : <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {dialog?.kind === "issue" && identity === "email" && <label className="block text-xs">Additional allowed emails<textarea className={input} autoComplete="off" maxLength={8025} value={extraEmails} onChange={(e) => setExtraEmails(e.target.value)} /><span className="mt-1 block text-muted-foreground">Separate emails with commas or spaces. Up to 25 recipients total. The share&apos;s allowed domains also apply, or its linked company domain when available.</span></label>}
        {dialog?.kind === "issue" && <><label className="block text-xs">Recipient name<input className={input} autoComplete="off" maxLength={320} value={name} onChange={(e) => setName(e.target.value)} /></label><label className="block text-xs">Recipient email<input className={input} type="email" autoComplete="off" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} /></label>{result.identity && result.identity.allow.length > 1 && <label className="block text-xs">Identity<select className={input} value={identity ?? result.identity.default} onChange={(e) => setIdentity(e.target.value as "link" | "email")}>{result.identity.allow.map((value) => <option key={value} value={value}>{value === "link" ? "Link holder" : "Email verification"}</option>)}</select></label>}</>}
        {dialog?.kind !== "revoke" && <label className="block text-xs">{dialog?.kind === "extend" ? "Additional days" : "Expires in days"}<input className={input} type="number" required min={1} max={result.expiresDays?.max ?? 120} value={days} onChange={(e) => setDays(e.target.value)} /></label>}
        <button className={button} type="submit" disabled={busy || (dialog?.kind === "issue" && !name.trim() && !email.trim())}>{busy ? "Saving..." : dialog?.kind === "issue" ? "Issue link" : dialog?.kind === "extend" ? "Extend link" : "Revoke link"}</button>
      </form>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </DialogContent></Dialog>
  </section>;
}
