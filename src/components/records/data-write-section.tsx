"use client";
import type { PageKind } from "../../../recipes/blocks";
import { useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { PageSection } from "../../../recipes/kernel";
import type { Context } from "../../../recipes/conditions";
import { offered } from "../../../recipes/actions";
import { resolveQuery, type DataQuery } from "../../../recipes/data";
import type { ListResponse } from "../../../convex/lib/objects/listSpec";
import { FieldInput, InlineField, fieldPatch, type ObjectDescription, type CellValue, type TeamMember } from "./fields";
import { BoardView, type BoardSaves } from "./board-view";
import { saveOf, saveProblem } from "./board-move";
import { createDataRecord } from "./data-create";
import { RECORDS_SAVED, RecordLink } from "./record-context";
import type { ListedObject } from "./use-object-list";
import { LookupField } from "./lookup-field";
import { recordHref } from "./record-target";
import { getErrorMessage } from "@/lib/utils";

type FormQuery = Extract<DataQuery, { fields: unknown }>;
export function DataForm({ query, desc, initial, buttons, onSubmit, team }: { team?: readonly TeamMember[]; query: FormQuery; desc: ObjectDescription; initial: Record<string, CellValue>; buttons: { id: string; label: string; disabled: boolean }[]; onSubmit: (values: Record<string, CellValue>, action: string) => Promise<void> }) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fields = query.fields.map((name) => desc.fields.find((f) => f.apiName === name)).filter((f) => f && !f.hidden);
  return <form className="grid min-w-0 gap-3" onSubmit={async (e) => {
    e.preventDefault();
    const id = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    const button = buttons.find((b) => b.id === id) ?? buttons[0];
    if (!button || button.disabled || busy) return;
    setBusy(true); setMessage("");
    try { await onSubmit(values, button.id); setValues(initial); setMessage("Saved"); } catch (e) { setMessage(getErrorMessage(e)); } finally { setBusy(false); }
  }}>
    {fields.map((f) => f && <label key={f.fieldId} className="min-w-0 text-sm">{f.label}<FieldInput team={team} field={f} value={values[f.apiName] ?? null} disabled={!desc.canCreate || desc.readOnlyFields.includes(f.apiName) || busy} onChange={(value) => setValues((v) => ({ ...v, [f.apiName]: value }))} /></label>)}
    {buttons.map((button) => <button key={button.id} type="submit" value={button.id} disabled={busy || button.disabled} className="border border-border px-2 py-1 text-sm disabled:opacity-50">{button.label}</button>)}
    {message && <p role="status" className="text-sm">{message}</p>}
  </form>;
}

export function DataWriteResult({ section, query: q, desc, rows, pageObject, context, record, pageFields, reload, externalSaves }: { section: Extract<PageSection, { component: "form" | "detail" | "board" }>; query: DataQuery; desc: ObjectDescription; rows?: ListResponse; pageObject: PageKind; context: Context; record: { id: string; values: Record<string, unknown> }; pageFields: readonly { apiName: string; fieldId: string; hidden?: boolean }[]; reload: () => void; externalSaves?: BoardSaves }) {
  const client = useConvex();
  const team = useQuery(api.users.list, {}) as TeamMember[] | undefined;
  const [error, setError] = useState("");
  const [saves, setSaves] = useState<BoardSaves>({ n: 0, saves: [] });
  const changed = (saved: BoardSaves["saves"] = []) => { reload(); window.dispatchEvent(new CustomEvent(RECORDS_SAVED, { detail: saved })); };
  const offers = offered(section.actions ?? [], section.component, ["kernel.editField", "kernel.createRecord", "kernel.logActivity"], { deleted: false, ...context, canEdit: section.component === "form" ? desc.canCreate : desc.writable }, {}, pageObject);
  const edit = offers.find((o) => o.action.runs === "kernel.editField");
  const canEdit = Boolean(edit && !edit.disabled && desc.writable);
  async function save(row: ListResponse["rows"][number], field: string, value: CellValue, version: number) {
    if (!canEdit || desc.readOnlyFields.includes(field)) return false;
    try {
      let result: { problem: string | null; saves: BoardSaves["saves"] };
      if (desc.register) {
        const fresh = await client.action(api.objects.list, { object: q.object, filter: [{ field: "id", op: "eq", value: row.id }], limit: 1 });
        if (fresh.rows[0]?.version !== version) throw new Error("Someone else changed this record; reload and try again.");
        const definition = desc.fields.find((f) => f.apiName === field)!;
        await client.action(api.records.edit, { object: q.object, id: row.id, patch: fieldPatch(q.object, definition, value), idempotencyKey: crypto.randomUUID() } as never);
        result = { problem: null, saves: [] };
      } else {
        const out = await client.action(api.objects.writeScoped, { object: q.object, streamId: row.id, values: { [field]: value }, expectedVersion: version } as never);
        result = { problem: saveProblem(out), saves: saveOf(out) };
      }
      setError(result.problem ?? "");
      setSaves((s) => ({ n: s.n + 1, saves: result.saves }));
      if (!result.problem) changed(result.saves);
      return !result.problem;
    } catch (e) { setError(getErrorMessage(e)); setSaves((s) => ({ n: s.n + 1, saves: [] })); return false; }
  }
  if (section.component === "form" && "fields" in q) {
    const initial = Object.fromEntries(Object.entries(q.defaults).map(([name, value]) => {
      if (!value || typeof value !== "object") return [name, value];
      const resolved = resolveQuery({ ...q, filter: [{ field: name, op: "eq", value }] }, record, pageFields);
      return [name, resolved.filter[0].value];
    })) as Record<string, CellValue>;
    return <DataForm team={team} query={q} desc={desc} initial={initial} buttons={offers.filter((o) => o.action.runs !== "kernel.editField").map((o) => ({ id: o.action.id, label: o.label, disabled: o.disabled || !desc.canCreate }))} onSubmit={async (values, id) => {
      const action = offers.find((o) => o.action.id === id);
      if (!action || action.disabled) return;
      let saved: BoardSaves["saves"] = [];
      if (action.action.runs === "kernel.logActivity") {
        if (!["note", "task", "call", "meeting"].includes(q.object)) throw new Error("Choose an activity object");
        const out = await client.action(api.activityTargets.logScoped, { object: q.object, values, targets: [{ object: pageObject, id: record.id }], idempotencyKey: crypto.randomUUID() } as never);
        const problem = saveProblem(out); if (problem) throw new Error(problem);
        saved = saveOf(out);
      } else saved = await createDataRecord(client, desc, values, crypto.randomUUID());
      changed(saved);
    }} />;
  }
  const chosen = "columns" in q ? desc.fields.filter((f) => !f.hidden && (q.columns.includes(f.apiName) || q.columns.includes(f.fieldId))) : [];
  if (section.component === "board" && "groupBy" in q) {
    const group = desc.fields.find((f) => (f.apiName === q.groupBy.field || f.fieldId === q.groupBy.field) && !f.hidden);
    if (!group) return <p role="alert">Grouping field unavailable</p>;
    return <>{error && <p role="alert">{error}</p>}<BoardView object={q.object as ListedObject} limit={q.limit} groupBy={group} team={team} filter={q.filter as never} sort={q.sort} watch={[]} onStale={() => setSaves((s) => ({ n: s.n + 1, saves: [] }))} cardFields={chosen} writable={canEdit && !desc.register && !desc.readOnlyFields.includes(group.apiName)} readOnly={desc.register ? "Can’t move cards here yet: this object has no compare-and-set edit path." : "Cards are read-only for you here."} hrefOf={(row) => recordHref(q.object, row.id)} onMove={async (row, value) => { await save(row, group.apiName, value, row.version); }} saves={{ n: saves.n + (externalSaves?.n ?? 0), saves: [...saves.saves, ...(externalSaves?.saves ?? [])] }} /></>;
  }
  const row = rows?.rows[0];
  if (!row) return <p>No matching record.</p>;
  return <div className="grid min-w-0 gap-2"><RecordLink object={q.object} id={row.id}>{row.title}</RecordLink>{error && <p role="alert">{error}</p>}{chosen.map((field) => <div key={`${row.id}:${field.fieldId}`} className="min-w-0 text-sm"><span className="text-muted-foreground">{field.label}</span>{field.type === "lookup" ? <LookupField field={field} value={row.values[field.fieldId] as CellValue} version={row.version} readOnly={!canEdit || desc.readOnlyFields.includes(field.apiName)} onSave={(value, version) => save(row, field.apiName, value, version)} /> : <InlineField team={team} field={field} value={row.values[field.fieldId] as CellValue} version={row.version} readOnly={!canEdit || desc.readOnlyFields.includes(field.apiName)} onSave={(value, version) => save(row, field.apiName, value, version)} />}</div>)}</div>;
}
