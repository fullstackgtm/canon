"use client";
import { useState } from "react";
import { DATA_QUERIES, type DataComponent, type DataQuery } from "../../../../recipes/data";
import { FILTER_OPS, REPORT_BUCKETS } from "../../../../modules/kernel/reportLanguage";
import { SelectField } from "@/components/ui/select";

const input = "mt-1 w-full min-w-0 border border-border bg-background px-2 py-1 text-xs";
export function QuerySettings({ kind, query, disabled, onSave }: { kind: DataComponent; query: DataQuery; disabled: boolean; onSave: (query: DataQuery) => unknown }) {
  const [draft, setDraft] = useState(query);
  const [error, setError] = useState("");
  const update = (patch: Partial<DataQuery>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => {
    const checked = DATA_QUERIES[kind].safeParse(draft);
    if (!checked.success) { setError(checked.error.issues.map((i) => i.message).join("; ")); return; }
    if (onSave(checked.data) !== false) setError("");
  };
  return <fieldset disabled={disabled} className="min-w-0 space-y-2"><legend className="text-xs font-medium">Query</legend>
    <label className="block text-xs">Object<input className={input} value={draft.object} onChange={(e) => update({ object: e.target.value })} /></label>
    <div className="space-y-2 text-xs">Filters{draft.filter.map((f, i) => {
      const change = (patch: Partial<typeof f>) => update({ filter: draft.filter.map((old, n) => n === i ? { ...old, ...patch } : old) });
      return <div key={i} className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-3">
        <input aria-label={`Filter ${i + 1} field`} className={input} value={f.field} onChange={(e) => change({ field: e.target.value })} />
        <SelectField value={f.op} options={FILTER_OPS.map((value) => ({ value, label: value }))} onValueChange={(op) => change({ op: op as typeof f.op, ...(["empty", "notEmpty"].includes(op) ? { value: undefined } : {}) })} />
        {!["empty", "notEmpty"].includes(f.op) && <input aria-label={`Filter ${i + 1} value`} className={input} defaultValue={JSON.stringify(f.value) ?? ""} placeholder='"text", false, or {"record":"id"}' onBlur={(e) => { try { change({ value: JSON.parse(e.target.value) }); setError(""); } catch { setError("Filter value must be JSON: quoted text, a number, boolean, array or record reference"); } }} />}
        <button type="button" className="text-left text-xs underline" onClick={() => update({ filter: draft.filter.filter((_, n) => n !== i) })}>Remove filter</button>
      </div>;
    })}<button type="button" className="block border border-border px-2 py-1" onClick={() => update({ filter: [...draft.filter, { field: "", op: "eq", value: "" }] })}>Add filter</button></div>
    <label className="block text-xs">Sort field<input className={input} value={draft.sort?.field ?? ""} onChange={(e) => update({ sort: e.target.value ? { field: e.target.value, dir: draft.sort?.dir ?? "asc" } : undefined })} /></label>
    {draft.sort && <SelectField value={draft.sort.dir} options={[{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }]} onValueChange={(dir) => update({ sort: { field: draft.sort!.field, dir: dir as "asc" | "desc" } })} />}
    {"columns" in draft && <label className="block text-xs">Columns (comma separated)<input className={input} defaultValue={draft.columns.join(", ")} onBlur={(e) => update({ columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>}
    {"fields" in draft && <><label className="block text-xs">Fields<input className={input} defaultValue={draft.fields.join(", ")} onBlur={(e) => update({ fields: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></label><label className="block text-xs">Defaults (JSON)<textarea className={input} defaultValue={JSON.stringify(draft.defaults)} onBlur={(e) => { try { update({ defaults: JSON.parse(e.target.value) }); } catch { setError("Defaults must be JSON"); } }} /></label></>}
    <label className="block text-xs">Limit<input className={input} type="number" min={1} max={200} value={draft.limit} onChange={(e) => update({ limit: Number(e.target.value) })} /></label>
    {"aggregate" in draft && <div className="space-y-1"><SelectField value={draft.aggregate.fn} options={["count", "sum", "avg"].map((value) => ({ value, label: value }))} onValueChange={(fn) => update({ aggregate: fn === "count" ? { fn } : { fn: fn as "sum" | "avg", field: "amount" } })} />{draft.aggregate.fn !== "count" && <label className="block text-xs">Numeric field<input className={input} value={draft.aggregate.field} onChange={(e) => update({ aggregate: { fn: draft.aggregate.fn as "sum" | "avg", field: e.target.value } })} /></label>}</div>}
    {"groupBy" in draft && <div className="space-y-1"><label className="block text-xs">Group field<input className={input} value={draft.groupBy.field} onChange={(e) => update({ groupBy: { ...draft.groupBy, field: e.target.value } })} /></label><SelectField value={("bucket" in draft.groupBy ? draft.groupBy.bucket : undefined) ?? ""} options={[{ value: "", label: "Field value" }, ...REPORT_BUCKETS.map((value) => ({ value, label: value }))]} onValueChange={(bucket) => update({ groupBy: { field: draft.groupBy.field, ...(bucket ? { bucket: bucket as typeof REPORT_BUCKETS[number] } : {}) } })} /></div>}
    {error && <p role="alert" className="text-xs text-muted-foreground">{error}</p>}
    <button type="button" className="border border-border px-2 py-1 text-xs" onClick={save}>Apply query</button>
  </fieldset>;
}
