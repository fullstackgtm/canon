"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { RecordingPolicy } from "../../../../convex/lib/recordingPolicy";
import { LoadingRows } from "@/components/dashboard";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const input = "w-full border border-border bg-background px-2 py-1.5 text-sm";
const button = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50";
const section = "space-y-3 border border-border bg-card p-4";

export function RecordingTab() {
  const policy = useQuery(api.recordingPolicy.get);
  if (policy === undefined) return <LoadingRows count={3} height="h-24" />;
  if (policy === null) return <p className="text-sm text-muted-foreground">Only admins manage recording.</p>;
  return <RecordingForm key={JSON.stringify(policy)} initial={policy} />;
}

function RecordingForm({ initial }: { initial: RecordingPolicy }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = useMutation(api.recordingPolicy.save);
  const update = (patch: Partial<RecordingPolicy>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <form className="max-w-3xl space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true);
      try {
        await save(draft);
        toast.success("Recording settings saved");
      } catch (cause) {
        toast.error(getErrorMessage(cause));
      } finally {
        setBusy(false);
      }
    }}>
      <p className="border border-border bg-muted p-3 text-sm">Meeting recording is not available yet. These settings prepare its policy. Dialer call recording below is active.</p>
      <fieldset disabled={busy} className="space-y-4">
        <section className={section}>
          <h2 className="font-medium">Consent</h2>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Consent mode
            <SelectField aria-label="Consent mode" value={draft.consent} onValueChange={(value) => { if (value === "notice" || value === "explicit") update({ consent: value }); }} options={[{ value: "notice", label: "Notice" }, { value: "explicit", label: "Explicit consent" }]} />
          </label>
          <p className="text-xs text-muted-foreground">Choose notice or explicit consent for future meeting recordings. A recording notice is always required.</p>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Recording notice
            <textarea className={input} rows={3} required maxLength={4000} value={draft.noticeText} onChange={(event) => update({ noticeText: event.target.value })} />
          </label>
        </section>

        <section className={section}>
          <h2 className="font-medium">Internal meetings</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.internalRecording} onChange={(event) => update({ internalRecording: event.target.checked })} />Record internal meetings</label>
          <p className="text-xs text-muted-foreground">Off by default. A meeting is internal when every attendee belongs to an internal domain.</p>
          <AddressList label="Internal domains" values={draft.internalDomains} onChange={(internalDomains) => update({ internalDomains })} />
        </section>

        <section className={section}>
          <h2 className="font-medium">Never record</h2>
          <p className="text-xs text-muted-foreground">Exclude meetings with participants from these domains or with these email addresses.</p>
          <AddressList label="Never record domains" values={draft.neverRecordDomains} onChange={(neverRecordDomains) => update({ neverRecordDomains })} />
          <AddressList label="Never record emails" values={draft.neverRecordEmails} onChange={(neverRecordEmails) => update({ neverRecordEmails })} email />
        </section>

        <section className={section}>
          <h2 className="font-medium">Retention</h2>
          <label className="grid max-w-48 gap-1 text-xs text-muted-foreground">
            Retention days
            <input className={input} type="number" required min={7} max={3650} step={1} value={draft.retentionDays} onChange={(event) => update({ retentionDays: event.target.valueAsNumber })} />
          </label>
          <p className="text-xs text-muted-foreground">Save a meeting retention policy from 7 to 3650 days. The default is 365 days. Meeting retention enforcement is not available yet.</p>
        </section>

        <section className={section}>
          <h2 className="font-medium">Region</h2>
          <SelectField aria-label="Recording region" value={draft.region} onValueChange={(value) => {
            if (value === "us" || value === "eu") update({ region: value, consent: value === "eu" ? "explicit" : "notice" });
          }} options={[{ value: "us", label: "US" }, { value: "eu", label: "EU" }]} />
          <p className="text-xs text-muted-foreground">Preferred region for future meeting recording. Choosing EU defaults consent to explicit.</p>
        </section>

        <section className={section}>
          <h2 className="font-medium">Dialer call recording</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.callRecording} onChange={(event) => update({ callRecording: event.target.checked })} />Record dialer calls</label>
          <p className="text-xs text-muted-foreground">Recorded calls play the dialer&apos;s spoken notice. Integrations &gt; Dialer changes this same setting.</p>
        </section>
      </fieldset>
      <button type="submit" disabled={busy || !draft.noticeText.trim()} className="border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Saving..." : "Save recording settings"}</button>
    </form>
  );
}

function AddressList({ label, values, onChange, email = false }: { label: string; values: string[]; onChange: (values: string[]) => void; email?: boolean }) {
  const [entry, setEntry] = useState("");
  const add = () => {
    const value = entry.trim().toLowerCase();
    if (value && !values.includes(value)) onChange([...values, value]);
    setEntry("");
  };
  return (
    <div className="space-y-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        {label}
        <input className={input} type={email ? "email" : "text"} value={entry} onChange={(event) => setEntry(event.target.value)} placeholder={email ? "person@example.com" : "example.com"} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      </label>
      <button type="button" disabled={!entry.trim() || values.length >= 200} className={button} onClick={add}>Add to {label.toLowerCase()}</button>
      {values.length > 0 && <ul className="space-y-1 text-sm">{values.map((value) => <li key={value} className="flex items-center justify-between gap-2"><span>{value}</span><button type="button" className={button} aria-label={`Remove ${value} from ${label.toLowerCase()}`} onClick={() => onChange(values.filter((item) => item !== value))}>Remove</button></li>)}</ul>}
    </div>
  );
}
