"use client";

import { SuppressionsSection } from "./suppressions-section";
import { MailboxGrantsSection } from "./mailbox-grants-section";
import { OutboundEmailPolicySection } from "./outbound-email-policy-section";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useOutboundAvailable } from "@/hooks/use-outbound-available";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { OUTBOX_STATES, type OutboxState } from "../../../../modules/kernel/outbound";
import { LoadingRows } from "@/components/dashboard";
import { OutboxTable } from "@/components/modules/module-outbox";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const CHANNEL_WORDS = { email: "Email", slack: "Slack", webhook: "Webhooks" } as const;

/**
 * Settings > Outbound (docs/modules.md, "Outbound"): each module's channels, on or off; the Slack channel names modules
 * post to and the webhook endpoints their events go to (URLs never shown again, a secret once); and every message.
 */
export function OutboundTab() {
  return <div className="max-w-5xl space-y-6"><MailboxGrantsSection /><OutboundEmailPolicySection /><SharedOutboundSettings /></div>;
}

function SharedOutboundSettings() {
  const available = useOutboundAvailable();
  const [module, setModule] = useState<string>("");
  const [state, setState] = useState<OutboxState | "">("");
  const data = useQuery(api.outbound.settings, available ? { ...(module ? { module } : {}), ...(state ? { state } : {}) } : "skip");
  const setChannel = useMutation(api.outbound.setChannel);
  const mapSlack = useMutation(api.outbound.mapSlack);
  const addWebhook = useMutation(api.outbound.addWebhook);
  const removeTarget = useMutation(api.outbound.removeTarget);
  const [slack, setSlack] = useState({ name: "", url: "" });
  const [hook, setHook] = useState({ name: "", url: "", events: "" });
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!available) return <p className="text-sm text-muted-foreground">Outbound is getting ready. Try again shortly.</p>;
  if (data === undefined) return <LoadingRows count={3} height="h-24" />;
  if (data === null) return null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); } catch (cause) { void toast.error(getErrorMessage(cause)); } finally { setBusy(false); }
  }
  const titles = new Map(data.modules.map((m) => [m.moduleId, m.title]));

  return (
    <div className="max-w-5xl space-y-6">
      {data.local && (
        <p role="status" className="border-l-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-xs">
          This is a local stack: nothing leaves it. Email goes nowhere, and Slack and webhook posts reach only loopback receivers. Every message lands sent with provider id &quot;local&quot;.
        </p>
      )}
      {!data.local && !data.emailReady && <p className="border-l-2 border-destructive px-3 py-2 text-xs">Email isn&apos;t set up on this deployment: emailed notices are refused until it is.</p>}

      <section className="space-y-2">
        <h2 className="font-medium">Modules</h2>
        {!data.modules.length && <p className="text-sm text-muted-foreground">No module that is on sends anything.</p>}
        {data.modules.map((m) => (
          <div key={m.moduleId} className="border border-border bg-card p-3">
            <p className="text-sm font-medium">{m.title}</p>
            <ul className="mt-2 space-y-1">
              {m.channels.map((c) => (
                <li key={c.channel} className="flex items-center justify-between gap-2 text-sm">
                  <span>{CHANNEL_WORDS[c.channel]} <span className="text-xs text-muted-foreground">({c.names.join(", ")})</span></span>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={c.on} disabled={busy} aria-label={`${m.title} ${CHANNEL_WORDS[c.channel]}`}
                      onChange={(e) => run(() => setChannel({ moduleId: m.moduleId, channel: c.channel, on: e.target.checked }))} />
                    {c.on ? "On" : "Off"}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Slack channels</h2>
        <p className="text-xs text-muted-foreground">A module posts to a name, like cs-alerts. Map each name to a Slack incoming webhook; modules never see the URL.</p>
        <ul className="space-y-1">
          {data.slack.map((t) => (
            <li key={t.id} className="flex items-center justify-between border border-border px-3 py-1.5 text-sm">
              <span><span className="font-medium">#{t.name}</span> <span className="text-xs text-muted-foreground">{t.hint}</span></span>
              <button type="button" className={btn} disabled={busy} onClick={() => run(() => removeTarget({ id: t.id as Id<"outboundTargets"> }))}>Remove</button>
            </li>
          ))}
        </ul>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await mapSlack(slack); setSlack({ name: "", url: "" }); }); }}>
          <input className={input} placeholder="Channel name" aria-label="Slack channel name" value={slack.name} onChange={(e) => setSlack({ ...slack, name: e.target.value })} />
          <input className={`${input} min-w-80 flex-1`} placeholder="https://hooks.slack.com/services/..." aria-label="Slack webhook URL" value={slack.url} onChange={(e) => setSlack({ ...slack, url: e.target.value })} />
          <button type="submit" className={btn} disabled={busy || !slack.name || !slack.url}>Map</button>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Webhook endpoints</h2>
        <p className="text-xs text-muted-foreground">Canon POSTs each module event an endpoint takes, signed with Canon-Signature (t=&lt;ms&gt;,v1=&lt;HMAC-SHA256 of &quot;&lt;ms&gt;.&lt;body&gt;&quot;&gt;) and named by Canon-Event-Id. Failures are tried 5 times.</p>
        {secret && (
          <div className="space-y-2 border border-primary bg-card p-3">
            <p className="text-sm font-medium">Signing secret</p>
            <p className="text-xs text-muted-foreground">Copy it now. It is not shown again.</p>
            <code data-testid="outbound-secret" className="block break-all bg-muted p-2 text-xs">{secret}</code>
            <button type="button" className={btn} onClick={() => setSecret(null)}>Done</button>
          </div>
        )}
        <ul className="space-y-1">
          {data.webhooks.map((t) => (
            <li key={t.id} className="flex items-center justify-between border border-border px-3 py-1.5 text-sm">
              <span><span className="font-medium">{t.name}</span> <span className="text-xs text-muted-foreground">{t.hint} · {t.events.join(", ")}</span></span>
              <button type="button" className={btn} disabled={busy} onClick={() => run(() => removeTarget({ id: t.id as Id<"outboundTargets"> }))}>Remove</button>
            </li>
          ))}
        </ul>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { const made = await addWebhook({ name: hook.name, url: hook.url, events: hook.events.split(/[\s,]+/) }); setSecret(made.secret); setHook({ name: "", url: "", events: "" }); }); }}>
          <input className={input} placeholder="Label" aria-label="Endpoint label" value={hook.name} onChange={(e) => setHook({ ...hook, name: e.target.value })} />
          <input className={`${input} min-w-72 flex-1`} placeholder="https://example.com/hooks/canon" aria-label="Endpoint URL" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
          <input className={input} placeholder="visit.done, ..." aria-label="Events" value={hook.events} onChange={(e) => setHook({ ...hook, events: e.target.value })} />
          <button type="submit" className={btn} disabled={busy || !hook.url || !hook.events}>Add</button>
        </form>
      </section>

      <SuppressionsSection />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Messages</h2>
          <div className="flex gap-2">
            <select className={input} aria-label="Module" value={module} onChange={(e) => setModule(e.target.value)}>
              <option value="">Every module</option>
              {data.modules.map((m) => <option key={m.moduleId} value={m.moduleId}>{m.title}</option>)}
            </select>
            <select className={input} aria-label="State" value={state} onChange={(e) => setState(e.target.value as OutboxState | "")}>
              <option value="">Every state</option>
              {OUTBOX_STATES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
            </select>
          </div>
        </div>
        <OutboxTable rows={data.rows} actions={["approve", "cancel", "sendNow"]} empty="No messages yet." showModule={(id) => (id ? titles.get(id) ?? id : "Canon")} />
      </section>
    </div>
  );
}
