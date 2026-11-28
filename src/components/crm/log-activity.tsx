"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ACTIVITY_OBJECTS, type ActivityComposerKind, type ActivityObject } from "../../../convex/lib/activities";
import { ACTIVITY_LABELS } from "../../../recipes/recordActivity";
import { STANDARD_OBJECTS, type PicklistOption } from "../../../convex/lib/objects/registry";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { btn } from "@/components/records/record-parts";
import { RECORDS_SAVED, useRecordDraft } from "@/components/records/record-context";
import { useCommands } from "@/components/shell/command-palette";
import { TASKS_CHANGED } from "@/components/tasks/due-count";
import { SelectField } from "@/components/ui/select";
export type Save = { shard: number; seq: number };

export function optionsOf(object: ActivityObject, field: string): readonly PicklistOption[] {
  const fields: ReadonlyArray<{ apiName: string; options?: readonly PicklistOption[] }> = STANDARD_OBJECTS[object].fields;
  return fields.find((f) => f.apiName === field)?.options ?? [];
}

/** A picklist value's label from the standard options, else the value. */
export const optionLabel = (object: ActivityObject, field: string, value: string) => optionsOf(object, field).find((o) => o.value === value)?.label ?? value;

export const KIND_LABEL: Record<ActivityObject, string> = ACTIVITY_LABELS;
const input = "w-full border border-border bg-background px-2 py-1 text-sm";

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Log a note, task, call or meeting about `targets` (this record and the ones it implies, such as its company), and optionally one of `contacts`. */
export function LogActivity({ targets, contacts = [], onLogged, label = (kind) => KIND_LABEL[kind], composer }: {
  targets: ReadonlyArray<{ object: string; id: string }>;
  /** Each kind's button, as the page names it. */
  label?: (kind: ActivityObject) => string;
  contacts?: ReadonlyArray<{ id: string; fullName: string }>;
  onLogged: (save: Save) => void;
  composer?: {
    draftKey: string;
    controls: ReadonlyArray<{ kind: ActivityComposerKind; label: string; disabled: boolean }>;
    email?: ReactNode;
  };
}) {
  // Through the action, which admits the companies and people for a role that sees only some (CP14).
  const log = useAction(api.activityTargets.logScoped);
  const me = useQuery(api.users.me);
  const permissions = useQuery(api.permissions.mine);
  const available = ACTIVITY_OBJECTS.filter((object) => !permissions?.preview && permissions?.objects[object]?.create);
  const prefix = composer?.draftKey ?? "activity";
  const [kind, setKind] = useRecordDraft<ActivityComposerKind | null>(`${prefix}-kind`, null);
  const [text, setText] = useRecordDraft(`${prefix}-text`, "");
  const [date, setDate] = useRecordDraft(`${prefix}-date`, "");
  const [when, setWhen] = useRecordDraft(`${prefix}-when`, nowLocal());
  const [outcome, setOutcome] = useRecordDraft(`${prefix}-outcome`, "");
  const [contactId, setContactId] = useRecordDraft(`${prefix}-contact`, "");
  const [saving, setSaving] = useState(false);
  const controls = composer?.controls ?? available.map((kind) => ({ kind, label: label(kind), disabled: false }));
  const enabled = (kind: ActivityComposerKind) => controls.some((control) => control.kind === kind && !control.disabled) &&
    (kind === "email" ? Boolean(composer?.email) : available.includes(kind));
  const active = kind !== null && enabled(kind) ? kind : null;
  const fieldClass = composer ? "w-full min-w-0 max-w-full border border-border bg-background px-2 record-field-row record-value" : input;

  function open(next: ActivityComposerKind) {
    if (saving || !enabled(next)) return;
    if (next !== kind && text.trim() && !window.confirm("Discard the activity draft and start another?")) return;
    setKind(next === kind ? null : next);
    if (next !== kind) {
      setText(""); setDate(""); setWhen(nowLocal()); setOutcome("");
    }
  }

  useCommands(composer ? [] : available.map((object) => ({ id: `activity-${object}`, label: label(object), run: () => open(object), disabled: saving, group: "This record" })), "record");

  function valuesFor(object: ActivityObject): Record<string, string | number | null> {
    const at = new Date(when).getTime();
    switch (object) {
      case "note": return { body: text };
      case "task": return { subject: text, dueDate: date || null, status: "not_started" };
      case "call": return { subject: text || null, outcome: outcome || null, callAt: at };
      case "meeting": return { title: text, startAt: at };
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!kind || kind === "email" || !enabled(kind) || saving) return;
    setSaving(true);
    try {
      const values = { ...valuesFor(kind), ownerId: me?._id ?? null };
      const about = contactId && (!composer || contacts.some((contact) => contact.id === contactId))
        ? [...targets, { object: "contact" as const, id: contactId }]
        : [...targets];
      const r = await log({ object: kind, values, targets: about });
      if (r.status === "applied" || r.status === "proposed") {
        setKind(null);
        setText("");
        const save = { shard: r.shard, seq: r.seq };
        if (r.status === "proposed") toast.success(`${KIND_LABEL[kind]} proposed for review`);
        else {
          toast.success(`${KIND_LABEL[kind]} saved`);
          window.dispatchEvent(new CustomEvent(RECORDS_SAVED, { detail: [save] }));
          if (kind === "task") window.dispatchEvent(new CustomEvent(TASKS_CHANGED, { detail: save }));
        }
        onLogged(save);
      } else if (r.status === "invalid") {
        toast.error(r.errors.map((e) => e.message).join("; "));
      }
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={composer ? "grid record-field-grid" : "mb-3"}>
      <div className={composer ? "flex flex-wrap record-field-grid" : "flex gap-1"} role={composer ? "group" : undefined} aria-label={composer ? "Log an activity" : undefined}>
        {controls.map(({ kind, label }) => composer
          ? <button key={kind} type="button" aria-pressed={active === kind} className={cn(btn, active === kind && "bg-muted")} disabled={saving || !enabled(kind)} onClick={() => open(kind)}>{label}</button>
          : <Button key={kind} type="button" size="xs" variant={active === kind ? "secondary" : "outline"} disabled={saving} onClick={() => open(kind)}>{label}</Button>)}
      </div>
      {active === "email" && composer?.email}
      {active && active !== "email" && (
        <form onSubmit={submit} className={composer ? "grid record-field-grid border border-border record-panel-pad" : "mt-2 grid gap-2 border border-border p-2"}>
          {kind === "note" ? (
            <textarea aria-label="Note" required autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} />
          ) : (
            <input aria-label={kind === "meeting" ? "Title" : "Subject"} placeholder={kind === "meeting" ? "Title" : "Subject"} required={kind !== "call"} autoFocus value={text} onChange={(e) => setText(e.target.value)} className={fieldClass} />
          )}
          <div className="flex flex-wrap gap-2">
            {kind === "task" && <input type="date" aria-label="Due date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(fieldClass, "w-auto")} />}
            {kind === "call" && (
              <SelectField aria-label="Outcome" className={composer ? "record-value" : undefined} value={outcome} onValueChange={setOutcome}
                options={[{ value: "", label: "Outcome" }, ...optionsOf("call", "outcome").map((o) => ({ value: o.value, label: o.label }))]} />
            )}
            {(kind === "call" || kind === "meeting") && (
              <input type="datetime-local" aria-label={kind === "call" ? "Call time" : "Start time"} required value={when} onChange={(e) => setWhen(e.target.value)} className={cn(fieldClass, "w-auto")} />
            )}
            {contacts.length > 0 && (
              <SelectField aria-label="Contact" className={composer ? "record-value" : undefined} value={contactId} onValueChange={setContactId}
                options={[{ value: "", label: "No contact" }, ...contacts.map((c) => ({ value: c.id, label: c.fullName }))]} />
            )}
            {composer ? <button type="submit" disabled={saving} className={cn(btn, "ml-auto self-center")}>Save</button> : <Button type="submit" size="xs" disabled={saving} className="ml-auto self-center">Save</Button>}
          </div>
        </form>
      )}
    </div>
  );
}
