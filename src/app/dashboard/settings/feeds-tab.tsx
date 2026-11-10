"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { LoadingRows } from "@/components/dashboard";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const when = (t: number | null) => (t === null ? "Never" : new Date(t).toLocaleString());
const STATUS: Record<string, { label: string; tone: string }> = {
  ok: { label: "OK", tone: "text-primary" },
  error: { label: "Error", tone: "text-destructive" },
  expired: { label: "Expired", tone: "text-warning" },
  revoked: { label: "Removed", tone: "text-muted-foreground" },
};

export function FeedsTab() {
  return <div className="space-y-6"><PersonalFeeds /><WorkspaceFeeds /></div>;
}

function PersonalFeeds() {
  const data = useQuery(api.connectors.health);
  const setGrant = useMutation(api.connectors.setFeedGrant);
  const [busy, setBusy] = useState(false);
  if (data === undefined) return <LoadingRows count={2} height="h-24" />;
  if (data === null) return null;
  const personal = data.personal ?? [];
  return (
    <section className="max-w-4xl space-y-3 border border-border bg-card p-4">
      <h2 className="font-medium">Your module access</h2>
      <p className="text-sm text-muted-foreground">Enabled modules can read the fields listed below from your connected accounts. Only you can change this access. It does not give permission to send messages, make calls or record meetings.</p>
      <p className="text-xs text-muted-foreground">Turning access off stops new imports. Existing records stay and follow the module&apos;s visibility rules, which may include your team. Restoring access imports current items within the module&apos;s backfill window.</p>
      {!personal.length && <p className="text-sm text-muted-foreground">No personal connector feeds yet. Connect your account from Integrations when its connector is available.</p>}
      {personal.map((link) => (
        <div key={link.id} className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">{link.label}</h3>
          {!link.modules.length && <p className="text-xs text-muted-foreground">No installed module requests this account&apos;s feeds.</p>}
          {link.modules.map((module) => (
            <div key={module.id} className="flex items-start justify-between gap-4 py-2">
              <div className="space-y-1 text-sm">
                <p>{module.title}{!module.enabled && <span className="ml-2 text-xs text-muted-foreground">Module off</span>}</p>
                {module.feeds.map((feed, index) => <p key={index} className="text-xs text-muted-foreground">{feed.label}: {feed.fields.join(", ")}</p>)}
              </div>
              <button type="button" className={btn} disabled={busy} aria-label={`${module.granted ? "Turn off" : "Restore"} ${module.title} read access to ${link.label}`} onClick={() => {
                setBusy(true);
                void setGrant({ linkId: link.id, moduleId: module.id, granted: !module.granted }).catch((cause) => toast.error(getErrorMessage(cause))).finally(() => setBusy(false));
              }}>{module.granted ? "Turn off access" : "Restore access"}</button>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

/** The workspace's connector health and webhook administration remain capability-gated. */
function WorkspaceFeeds() {
  const data = useQuery(api.connectors.health);
  const create = useAction(api.connectors.createWebhook);
  const rotate = useAction(api.connectors.rotateWebhook);
  const remove = useMutation(api.connectors.removeLink);
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<{ url: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Id<"connectorLinks"> | null>(null);
  if (data === undefined) return <LoadingRows count={2} height="h-24" />;
  if (data === null || data.canManage === false) return null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const missing = data.connectors.filter((c) => c.missing.length);

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Connectors write what they learn into feeds, and modules read the feeds. Canon holds every key and token; a module never sees one.
      </p>

      {missing.map((c) => (
        <p key={c.id} className="border border-warning p-3 text-sm">
          {`${c.label} needs ${c.missing.join(", ")} in Canon's environment before it can run.`}
        </p>
      ))}

      {shown && (
        <section className="space-y-2 border border-primary bg-card p-4">
          <h2 className="font-medium">Signing secret</h2>
          <p className="text-sm text-muted-foreground">Copy it now. It is not shown again.</p>
          <p className="text-xs text-muted-foreground">URL</p>
          <code data-testid="feed-webhook-url" className="block break-all bg-muted p-2 text-xs">{shown.url}</code>
          <p className="text-xs text-muted-foreground">Secret</p>
          <code data-testid="feed-webhook-secret" className="block break-all bg-muted p-2 text-xs">{shown.secret}</code>
          <button type="button" className={btn} onClick={() => setShown(null)}>Done</button>
        </section>
      )}

      <section className="border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Link</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last item</th>
              <th className="px-3 py-2 text-right">Last day</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.links.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No links yet. Add a signed webhook below, or connect an integration.</td></tr>
            )}
            {data.links.map((l) => (
              <tr key={l.id} className="border-t border-border/60 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{l.label ?? l.member ?? l.connectorLabel}</div>
                  <div className="text-xs text-muted-foreground">{l.connectorLabel}{l.member && l.label ? ` · ${l.member}` : ""}</div>
                  {l.url && <code className="mt-1 block break-all text-[11px] text-muted-foreground">{l.url}</code>}
                  {l.status === "error" && l.lastError && <p className="mt-1 text-xs text-destructive">{l.lastError} ({when(l.lastErrorAt)})</p>}
                </td>
                <td className={`px-3 py-2 ${STATUS[l.status]?.tone ?? ""}`}>{STATUS[l.status]?.label ?? l.status}</td>
                <td className="px-3 py-2 text-xs">{when(l.lastItemAt)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.items24h.toLocaleString()}{l.more ? "+" : ""}</td>
                <td className="px-3 py-2 text-right">
                  {l.connector === "webhook" && (
                    <div className="flex justify-end gap-2">
                      <button type="button" disabled={busy} className={btn} onClick={() => void run(async () => setShown({ url: l.url!, secret: (await rotate({ id: l.id as Id<"connectorLinks"> })).secret }))}>Rotate secret</button>
                      <button type="button" disabled={busy} className={btn} onClick={() => setRemoving(l.id as Id<"connectorLinks">)}>Remove</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {removing && (
        <ConfirmDialog
          title="Remove this webhook?"
          description="It stops taking events at once. What it already sent stays in its feed."
          confirmLabel="Remove"
          destructive
          onConfirm={() => run(() => remove({ id: removing }))}
          onClose={() => setRemoving(null)}
        />
      )}

      <section className="space-y-3 border border-border bg-card p-4">
        <h2 className="font-medium">Add a signed webhook</h2>
        <p className="text-sm text-muted-foreground">
          POST JSON with a <code>type</code>, an optional <code>id</code> and <code>data</code>. Sign it with headers <code>X-Canon-Timestamp</code> (unix seconds) and{" "}
          <code>X-Canon-Signature: v1=</code>HMAC-SHA256 of <code>timestamp.body</code> with the secret. The same <code>id</code> sent twice is one event.
        </p>
        <div className="flex gap-2">
          <input aria-label="Webhook name" value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="Product usage" className={`${input} flex-1`} />
          <button type="button" disabled={busy || !label.trim()} onClick={() => void run(async () => { const made = await create({ label }); setShown({ url: made.url, secret: made.secret }); setLabel(""); })} className="bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40">Add webhook</button>
        </div>
      </section>
    </div>
  );
}
