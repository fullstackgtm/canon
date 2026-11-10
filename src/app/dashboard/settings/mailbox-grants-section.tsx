"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";
import { useMailboxGrantsAvailable } from "@/hooks/use-outbound-available";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type Options = NonNullable<FunctionReturnType<typeof api.mailboxGrants.mine>>;
type Template = Options["modules"][number]["templates"][number];
type Account = Options["accounts"][number];
const button = "border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40";
const input = "w-full border border-border bg-background px-2 py-1.5 text-sm";
const DAY = 86_400_000;
const dateInput = (ms: number) => {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function TemplatePreview({ subject, body }: { subject: string; body: string }) {
  return <div className="space-y-2 border border-border bg-muted/30 p-3 text-sm">
    <p className="whitespace-pre-wrap font-medium">{subject}</p>
    <p className="whitespace-pre-wrap break-words">{body}</p>
  </div>;
}

function GrantConsent({ account, moduleId, title, template, ready, maxDays, maxPerDay, onCreated }: {
  account: Account; moduleId: string; title: string; template: Template; ready: boolean; maxDays: number; maxPerDay: number; onCreated(): void;
}) {
  const create = useMutation(api.mailboxGrants.createManifest);
  const [cap, setCap] = useState(10);
  const [expires, setExpires] = useState(() => dateInput(Date.now() + 30 * DAY));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const expiresAt = new Date(expires).getTime();
  const valid = Number.isInteger(cap) && cap >= 1 && cap <= maxPerDay && Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + maxDays * DAY;
  return <form className="space-y-3" onSubmit={async (event) => {
    event.preventDefault();
    if (!ready || !consent || !valid || busy) return;
    setBusy(true);
    try {
      await create({ senderId: account.id, moduleId, template: template.name, expectTemplateHash: template.hash, expectMailboxLinkHash: account.mailboxLinkHash, maxPerDay: cap, expiresAt });
      setConsent(false); onCreated(); void toast.success("Mailbox grant created");
    } catch (cause) { void toast.error(getErrorMessage(cause)); } finally { setBusy(false); }
  }}>
    <TemplatePreview subject={template.subject} body={template.body} />
    <p className="text-xs text-muted-foreground">Only recipient placeholders change: name, first name and email from Canon. The remaining text is fixed.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs">Daily email cap
        <input className={input} type="number" min={1} max={maxPerDay} value={Number.isNaN(cap) ? "" : cap} onChange={(e) => { setCap(e.target.valueAsNumber); setConsent(false); }} required />
      </label>
      <label className="space-y-1 text-xs">Consent expires
        <input className={input} type="datetime-local" value={expires} max={dateInput(Date.now() + maxDays * DAY)} onChange={(e) => { setExpires(e.target.value); setConsent(false); }} required />
      </label>
    </div>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy || !valid || !ready} />
      <span>I allow {title} to send this template from {account.address}, up to {Number.isNaN(cap) ? "the chosen number of" : cap} emails per day until {expires.replace("T", " ")}.</span>
    </label>
    <button className={button} type="submit" disabled={!ready || !valid || !consent || busy}>{busy ? "Creating grant…" : "Create mailbox grant"}</button>
  </form>;
}

export function MailboxGrantsSection() {
  const available = useMailboxGrantsAvailable();
  const user = useQuery(api.users.me, available ? {} : "skip");
  if (!available) return null;
  if (user === undefined) return <LoadingRows count={2} height="h-24" />;
  if (user === null) return <p className="text-sm text-muted-foreground">Sign in as yourself to manage your mailbox grants.</p>;
  return <OwnerMailboxGrants key={`${user.orgId}:${user._id}`} scope={{ orgId: user.orgId, userId: user._id }} />;
}

function OwnerMailboxGrants({ scope }: { scope: FunctionArgs<typeof api.mailboxGrants.mine>["scope"] }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const data = useQuery(api.mailboxGrants.mine, { scope, ...(cursor ? { cursor } : {}) });
  const revoke = useMutation(api.mailboxGrants.revoke);
  const [senderId, setSender] = useState("");
  const [moduleId, setModule] = useState("");
  const [templateName, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  if (data === undefined) return <LoadingRows count={2} height="h-24" />;
  if (data === null) return <p className="text-sm text-muted-foreground">Sign in as yourself and exit any preview to manage your mailbox grants.</p>;
  const selectedModule = data.modules.find((m) => m.moduleId === moduleId);
  const template = selectedModule?.templates.find((t) => t.name === templateName);
  const account = data.accounts.find((a) => a.id === senderId);
  return <section className="space-y-4 border border-border bg-card p-4" aria-label="My mailbox grants">
    <div>
      <h2 className="font-medium">My mailbox grants</h2>
      <p className="mt-1 text-sm text-muted-foreground">Only you can grant consent for your mailbox. A grant records consent; it does not turn on email delivery or give a module access to contacts.</p>
    </div>
    {!data.signingReady && <p role="status" className="text-sm text-muted-foreground">New mailbox grants are unavailable on this deployment. You can still revoke existing grants.</p>}
    {!data.accounts.length ? <p className="text-sm text-muted-foreground">Connect your Gmail account on Integrations to create a grant.</p>
      : !data.modules.length ? <p className="text-sm text-muted-foreground">No enabled module has an eligible fixed email template for your mailbox.</p>
        : <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">My mailbox
              <select className={input} value={senderId} onChange={(e) => setSender(e.target.value)}><option value="">Choose a mailbox</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.address}</option>)}</select>
            </label>
            <label className="space-y-1 text-xs">Module
              <select className={input} value={moduleId} onChange={(e) => { setModule(e.target.value); setTemplate(""); }}><option value="">Choose a module</option>{data.modules.map((m) => <option key={m.moduleId} value={m.moduleId}>{m.title}</option>)}</select>
            </label>
            <label className="space-y-1 text-xs">Exact template
              <select className={input} value={templateName} onChange={(e) => setTemplate(e.target.value)} disabled={!selectedModule}><option value="">Choose a template</option>{selectedModule?.templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select>
            </label>
          </div>
          {account && selectedModule && template && <GrantConsent key={`${account.id}:${account.mailboxLinkHash}:${selectedModule.moduleId}:${template.hash}`} account={account} moduleId={selectedModule.moduleId} title={selectedModule.title} template={template} ready={data.signingReady} maxDays={data.maxDays} maxPerDay={data.maxPerDay} onCreated={() => setCursor(undefined)} />}
        </div>}
    <ul className="space-y-3">
      {data.grants.map((g) => <li key={g.grantId} className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{g.address ?? "Mailbox unavailable"} · {data.modules.find((m) => m.moduleId === g.moduleId)?.title ?? g.moduleId} · {g.template.kind === "manifest" ? g.template.name : "Sequence template set"}</span>
          <button type="button" className={button} disabled={busy || !g.canRevoke} onClick={async () => {
            setBusy(true);
            try { await revoke({ grantId: g.grantId }); void toast.success("Mailbox grant revoked"); }
            catch (cause) { void toast.error(getErrorMessage(cause)); } finally { setBusy(false); }
          }}>{g.revokedAt !== null ? "Revoked" : "Revoke"}</button>
        </div>
        <p className="text-xs text-muted-foreground">{g.state.replace(/_/g, " ")} · {g.maxPerDay} per day · expires {new Date(g.expiresAt).toLocaleString()}</p>
        {g.preview && <TemplatePreview {...g.preview} />}
        {"templates" in g && g.templates.map((t) => <TemplatePreview key={`${t.stepKey}:${t.variant}`} subject={t.subject} body={t.body} />)}
      </li>)}
    </ul>
    {!data.grants.length && <p className="text-sm text-muted-foreground">You have no mailbox grants.</p>}
    <div className="flex gap-2">
      {cursor && <button type="button" className={button} onClick={() => setCursor(undefined)}>Newest grants</button>}
      {data.nextCursor && <button type="button" className={button} onClick={() => setCursor(data.nextCursor ?? undefined)}>Older grants</button>}
    </div>
  </section>;
}
