"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { RelatedCondition } from "../../../convex/lib/objects/validators";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { listColumns } from "../../../convex/lib/objects/listSpec";
import { FilterBar, isComplete } from "./filter-bar";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

function Condition({ value, onChange }: { value: RelatedCondition; onChange: (next: RelatedCondition) => void }) {
  const desc = useQuery(api.objects.describe, { object: value.path === "company" ? "account" : "deal" });
  return <div className="flex flex-col gap-2">
    <SelectField aria-label="Related record condition" value={value.path === "company" ? "company" : value.has} options={[
      { value: "company", label: "Company matches" }, { value: "some", label: "Company has a matching deal" }, { value: "none", label: "No matching deal" },
    ]} onValueChange={(path) => onChange(path === "company" ? { path, filter: [] } : { path: "company.deals", has: path as "some" | "none", filter: value.path === "company.deals" ? value.filter : [] })} />
    {desc && <FilterBar filters={value.filter} columns={listColumns(indexObjectDef(desc as unknown as ObjectDef))} dayColumns={new Set()} fields={desc.fields} canAdd={value.filter.length < 19} resetKey={0} onChange={(filter) => onChange({ ...value, filter })} />}
  </div>;
}

export function AudienceRelated({ id, related, canEdit }: { id: Id<"audiences">; related: RelatedCondition[]; canEdit: boolean }) {
  const update = useMutation(api.audiences.update);
  const [draft, setDraft] = useState<RelatedCondition[] | null>(null);
  const [busy, setBusy] = useState(false);
  return <div className="mt-5 border-t border-border pt-4">
    <h3 className="text-xs font-medium text-muted-foreground">Related records</h3>
    <p className="mt-1 text-xs text-muted-foreground">People must match every condition. Counts deals linked to the company in Canon or synced from its CRM accounts.</p>
    {draft === null ? <>
      {related.length ? <ul className="my-2 flex flex-wrap gap-2">{related.map((c, i) => <li key={i} className="border border-border px-2 py-1 text-xs">{c.path === "company" ? "Company matches" : c.has === "some" ? "Company has a matching deal" : "No matching deal"}{c.filter.map((f) => ` · ${f.field} ${f.op} ${f.value === undefined ? "" : String(f.value)}`).join("")}</li>)}</ul> : <p className="my-2 text-sm text-muted-foreground">No related conditions.</p>}
      {canEdit && <button className={btn} onClick={() => setDraft(related)}>Edit related records</button>}
    </> : <div className="mt-2 flex flex-col gap-3">
      {draft.map((c, i) => <div key={i} className="border border-border p-2"><Condition value={c} onChange={(next) => setDraft(draft.map((v, j) => j === i ? next : v))} /><button className="mt-2 text-xs text-muted-foreground" onClick={() => setDraft(draft.filter((_, j) => i !== j))}>Remove condition</button></div>)}
      <div className="flex gap-2">
        <button className={btn} disabled={draft.length >= 3 || busy} onClick={() => setDraft([...draft, { path: "company", filter: [] }])}>Add condition</button>
        <button className={btn} disabled={busy || draft.some((c) => c.filter.some((f) => !isComplete(f)))} onClick={async () => {
          setBusy(true);
          try { await update({ audienceId: id, related: draft }); setDraft(null); } catch (cause) { void toast.error(getErrorMessage(cause)); } finally { setBusy(false); }
        }}>Save conditions</button>
        <button className={btn} disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>}
  </div>;
}
