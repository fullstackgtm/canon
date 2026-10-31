"use client";

import { useState, type FormEvent } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ACTIVITY_OBJECTS, type ActivityObject, type TargetObject } from "../../../convex/lib/activities";
import { STANDARD_OBJECTS, type PicklistOption } from "../../../convex/lib/objects/registry";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
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

export const KIND_LABEL: Record<ActivityObject, string> = { note: "Note", task: "Task", call: "Call", meeting: "Meeting" };
const input = "w-full border border-border bg-background px-2 py-1 text-sm";

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Log a note, task, call or meeting about `targets` (this record and the ones it implies, such as its company), and optionally one of `contacts`. */
export function LogActivity({ targets, contacts = [], onLogged, label = (kind) => KIND_LABEL[kind] }: {
  targets: ReadonlyArray<{ object: TargetObject; id: string }>;
  /** Each kind's button, as the page names it. */
  label?: (kind: ActivityObject) => string;
  contacts?: ReadonlyArray<{ id: string; fullName: string }>;
  onLogged: (save: Save) => void;
}) {
  // Through the action, which admits the companies and people for a role that sees only some (CP14).
  const log = useAction(api.activityTargets.logScoped);
  const me = useQuery(api.users.me);
  const permissions = useQuery(api.permissions.mine);
  const available = ACTIVITY_OBJECTS.filter((object) => !permissions?.preview && permissions?.objects[object]?.create);
  const [kind, setKind] = useRecordDraft<ActivityObject | null>("activity-kind", null);
  const [text, setText] = useRecordDraft("activity-text", "");
  const [date, setDate] = useRecordDraft("activity-date", "");
  const [when, setWhen] = useRecordDraft("activity-when", nowLocal());
  const [outcome, setOutcome] = useRecordDraft("activity-outcome", "");
  const [contactId, setContactId] = useRecordDraft("activity-contact", "");
  const [saving, setSaving] = useState(false);

  function open(next: ActivityObject) {
    if (saving || !available.includes(next)) return;
    if (next !== kind && text.trim() && !window.confirm("Discard the activity draft and start another?")) return;
    setKind(next === kind ? null : next);
    if (next !== kind) {
      setText(""); setDate(""); setWhen(nowLocal()); setOutcome("");
    }
  }

  useCommands(available.map((object) => ({ id: `activity-${object}`, label: label(object), run: () => open(object), disabled: saving, group: "This record" })), "record");

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
    if (!kind || !available.includes(kind) || saving) return;
    setSaving(true);
    try {
      const values = { ...valuesFor(kind), ownerId: me?._id ?? null };
      const about = contactId ? [...targets, { object: "contact" as const, id: contactId }] : [...targets];
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
    <div className="mb-3">
      <div className="flex gap-1">
        {available.map((o) => (
          <Button key={o} type="button" size="xs" variant={kind === o ? "secondary" : "outline"} disabled={saving} onClick={() => open(o)}>{label(o)}</Button>
        ))}
      </div>
      {kind && available.includes(kind) && (
        <form onSubmit={submit} className="mt-2 grid gap-2 border border-border p-2">
          {kind === "note" ? (
            <textarea aria-label="Note" required autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} className={input} />
          ) : (
            <input aria-label={kind === "meeting" ? "Title" : "Subject"} placeholder={kind === "meeting" ? "Title" : "Subject"} required={kind !== "call"} autoFocus value={text} onChange={(e) => setText(e.target.value)} className={input} />
          )}
          <div className="flex flex-wrap gap-2">
            {kind === "task" && <input type="date" aria-label="Due date" value={date} onChange={(e) => setDate(e.target.value)} className={input + " w-auto"} />}
            {kind === "call" && (
              <SelectField aria-label="Outcome" value={outcome} onValueChange={setOutcome}
                options={[{ value: "", label: "Outcome" }, ...optionsOf("call", "outcome").map((o) => ({ value: o.value, label: o.label }))]} />
            )}
            {(kind === "call" || kind === "meeting") && (
              <input type="datetime-local" aria-label={kind === "call" ? "Call time" : "Start time"} required value={when} onChange={(e) => setWhen(e.target.value)} className={input + " w-auto"} />
            )}
            {contacts.length > 0 && (
              <SelectField aria-label="Contact" value={contactId} onValueChange={setContactId}
                options={[{ value: "", label: "No contact" }, ...contacts.map((c) => ({ value: c.id, label: c.fullName }))]} />
            )}
            <Button type="submit" size="xs" disabled={saving} className="ml-auto self-center">Save</Button>
          </div>
        </form>
      )}
    </div>
  );
}
