"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const when = (t: number) => new Date(t).toLocaleString();

function toggle(list: string[], value: string) {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** Record webhooks: URLs told when a record changes (docs/record-api.md "Webhooks"). Admins only. */
export function WebhooksTab() {
  const data = useQuery(api.recordWebhooks.list);
  const create = useAction(api.recordWebhooks.create);
  const update = useMutation(api.recordWebhooks.update);
  const remove = useMutation(api.recordWebhooks.remove);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [objects, setObjects] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>(["record.created", "record.updated", "record.deleted", "record.restored"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<Id<"recordWebhookEndpoints"> | null>(null);
  const [busy, setBusy] = useState(false);
  if (data === undefined) return <LoadingRows count={2} height="h-24" />;
  if (data === null) return <p className="text-sm text-muted-foreground">Only admins manage webhooks.</p>;

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

  const add = () =>
    run(async () => {
      const made = await create({ url, objects, events, ...(description ? { description } : {}) });
      setSecret(made.secret);
      setUrl("");
      setDescription("");
    });

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Canon sends a signed POST to your URL when a record is created, updated, deleted or restored. Failed deliveries retry for about 10 hours.
      </p>

      {secret && (
        <section className="space-y-2 border border-primary bg-card p-4">
          <h2 className="font-medium">Signing secret</h2>
          <p className="text-sm text-muted-foreground">Copy it now. It is not shown again.</p>
          <code data-testid="webhook-secret" className="block break-all bg-muted p-2 text-xs">{secret}</code>
          <button type="button" className={btn} onClick={() => setSecret(null)}>Done</button>
        </section>
      )}

      {data.endpoints.map((e) => (
        <section key={e.id} className="border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate font-medium">{e.url}</h2>
              <p className="text-xs text-muted-foreground">
                {e.description ? `${e.description} · ` : ""}
                {e.objects.length ? e.objects.join(", ") : "all objects"} · {e.events.map((x) => x.replace("record.", "")).join(", ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {!e.enabled ? "Disabled" : e.lastDelivery ? `Last: ${e.lastDelivery.status}` : "No deliveries yet"}
              </span>
              <button type="button" className={btn} onClick={() => setOpen(open === e.id ? null : e.id)}>Deliveries</button>
              <button type="button" disabled={busy} className={btn} onClick={() => void run(() => update({ id: e.id, enabled: !e.enabled }))}>
                {e.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" disabled={busy} className={btn} onClick={() => { if (window.confirm("Delete this webhook?")) void run(() => remove({ id: e.id })); }}>Delete</button>
            </div>
          </div>
          {open === e.id && <Deliveries endpointId={e.id} />}
        </section>
      ))}

      <section className="space-y-3 border border-border bg-card p-4">
        <h2 className="font-medium">Add a webhook</h2>
        <input aria-label="Webhook URL" value={url} onChange={(ev) => setUrl(ev.target.value)} placeholder={data.local ? "http://127.0.0.1:9000/hook" : "https://example.com/hooks/canon"} className={`${input} w-full`} />
        <input aria-label="Description" value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="Description (optional)" className={`${input} w-full`} />
        <fieldset className="text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">Objects (none checked means all)</legend>
          <div className="flex flex-wrap gap-3">
            {data.objects.map((o) => (
              <label key={o.apiName} className="flex items-center gap-1"><input type="checkbox" checked={objects.includes(o.apiName)} onChange={() => setObjects(toggle(objects, o.apiName))} />{o.label}</label>
            ))}
          </div>
        </fieldset>
        <fieldset className="text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">Events</legend>
          <div className="flex flex-wrap gap-3">
            {data.events.map((ev) => (
              <label key={ev} className="flex items-center gap-1"><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(toggle(events, ev))} />{ev}</label>
            ))}
          </div>
        </fieldset>
        <button type="button" disabled={busy || !url.trim() || !events.length} onClick={() => void add()} className="bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40">Add webhook</button>
      </section>
    </div>
  );
}

function Deliveries({ endpointId }: { endpointId: Id<"recordWebhookEndpoints"> }) {
  const rows = useQuery(api.recordWebhooks.deliveries, { endpointId });
  if (rows === undefined) return <LoadingRows count={1} height="h-8" />;
  if (!rows.length) return <p className="mt-3 text-xs text-muted-foreground">Nothing sent yet. Deliveries appear when a record changes.</p>;
  return (
    <table className="mt-3 w-full text-xs">
      <thead className="text-left text-muted-foreground">
        <tr><th className="py-1 pr-3">Event</th><th className="pr-3">Object</th><th className="pr-3">Status</th><th className="pr-3">Tries</th><th>When</th></tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id} className="border-t border-border/60" title={d.error ?? undefined}>
            <td className="py-1 pr-3">{d.event}</td>
            <td className="pr-3">{d.object}</td>
            <td className="pr-3">{d.status}{d.statusCode ? ` (${d.statusCode})` : ""}{d.nextAttemptAt ? `, retry ${when(d.nextAttemptAt)}` : ""}{d.error && d.status !== "delivered" ? `: ${d.error}` : ""}</td>
            <td className="pr-3">{d.attempts}</td>
            <td>{when(d.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
