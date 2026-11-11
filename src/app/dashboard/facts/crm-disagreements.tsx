"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Scale } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PERSON_HELD_FIELDS, groupOf } from "../../../../convex/lib/canon/personHold";
import { EmptyState, LoadingRows, SelectionBar } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { CRM_NAME } from "@/components/records/crm-note";
import { formatValue, type CellValue, type FieldDescription } from "@/components/records/fields";
import { LookupLink } from "@/components/records/lookup-field";
import { useWorkspaceMoney } from "@/components/records/money";
import { recordHref } from "@/components/records/record-target";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type HeldObject = "deal" | "account" | "contact";
const OBJECTS: ReadonlyArray<{ object: HeldObject; label: string; noun: string }> = [
  { object: "deal", label: "Deals", noun: "deal" }, { object: "account", label: "Companies", noun: "company" }, { object: "contact", label: "People", noun: "person" },
];
/** The fields a disagreement can be about, by object: each held field, a group under its lead field. */
const FIELDS = (object: HeldObject) => [...new Set(PERSON_HELD_FIELDS[object]!.map((f) => groupOf(object, f)))];
const SELECTION_MAX = 50;

/**
 * What Salesforce and HubSpot say about deal, company and person fields people hold in Canon
 * (convex/crmDisagreements.ts), for an admin: filter by CRM, record type and field, then use the CRM's values for a
 * selection or for everything the filter shows.
 */
export function CrmDisagreementsTab() {
  const [provider, setProvider] = useState<"" | "salesforce" | "hubspot">("");
  const [object, setObject] = useState<"" | HeldObject>("");
  const [field, setField] = useState("");
  const filter = { ...(provider ? { provider } : {}), ...(object ? { object } : {}), ...(object && field ? { field } : {}) };
  const rows = usePaginatedQuery(api.crmDisagreements.list, filter, { initialNumItems: 25 });
  const job = useQuery(api.crmDisagreements.status, {})?.job;
  const descs = {
    deal: useQuery(api.objects.describe, { object: "deal" }),
    account: useQuery(api.objects.describe, { object: "account" }),
    contact: useQuery(api.objects.describe, { object: "contact" }),
  };
  const team = useQuery(api.users.list) as Array<{ _id: string; name: string }> | undefined;
  const money = useWorkspaceMoney();
  const take = useMutation(api.crmDisagreements.useCrmValues);
  const startAll = useMutation(api.crmDisagreements.startUseAll);
  const cancel = useMutation(api.crmDisagreements.cancelJob);
  const follows = useQuery(api.crmDisagreements.follows, {});
  const setFollow = useMutation(api.crmDisagreements.setFollow);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const fieldOf = (o: HeldObject, id: string) => ((descs[o]?.fields ?? []) as FieldDescription[]).find((f) => f.fieldId === id);
  const labelOf = (o: HeldObject, id: string) => (id === "ownerId" ? "Owner" : id === "companyId" ? "Company" : fieldOf(o, id)?.label ?? id);
  const shown = (o: HeldObject, id: string, value: unknown, currency?: unknown) => {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-muted-foreground">empty</span>;
    if (id === "ownerId") return team?.find((u) => u._id === value)?.name ?? "a former member";
    if (id === "companyId" && typeof value === "string") return <LookupLink object="account" id={value} className="underline" />;
    const f = fieldOf(o, id);
    return f ? formatValue(f, value as CellValue, team, typeof currency === "string" && currency ? { ...money, currency } : money) : String(value);
  };
  const running = job?.status === "running";
  const visible = rows.results.filter((r) => !("hidden" in r));
  const hiddenCount = rows.results.length - visible.length;

  async function run(p: Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await p;
      if (done) toast.success(done);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function takeSelected() {
    const ids = [...selected];
    await run(take({ ids }).then((r) => {
      setSelected(new Set());
      if (r.failed.length) toast.error(`${r.failed.length} could not be used: ${r.failed[0]!.message}`);
      toast.success(`${r.taken} now follow${r.taken === 1 ? "s" : ""} the CRM`);
    }));
  }
  const objectOf = (o: HeldObject) => OBJECTS.find((x) => x.object === o)!;
  const filterName = [provider ? CRM_NAME[provider] : "every CRM", object ? objectOf(object).label.toLowerCase() : "every record", object && field ? labelOf(object, field).toLowerCase() : "every field"].join(", ");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A deal, company or person field a person set in Canon keeps their value when Salesforce or HubSpot says something else. Using the CRM&apos;s value hands the field back to that CRM, so its later changes land again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SelectField aria-label="CRM" value={provider} onValueChange={(v) => { setProvider(v as typeof provider); setSelected(new Set()); }}
          options={[{ value: "", label: "Every CRM" }, { value: "salesforce", label: "Salesforce" }, { value: "hubspot", label: "HubSpot" }]} />
        <SelectField aria-label="Record type" value={object} onValueChange={(v) => { setObject(v as typeof object); setField(""); setSelected(new Set()); }}
          options={[{ value: "", label: "Every record" }, ...OBJECTS.map((o) => ({ value: o.object, label: o.label }))]} />
        <SelectField aria-label="Field" value={object ? field : ""} disabled={!object} onValueChange={(v) => { setField(v); setSelected(new Set()); }}
          options={[{ value: "", label: "Every field" }, ...(object ? FIELDS(object).map((f) => ({ value: f, label: labelOf(object, f) })) : [])]} />
        <Button size="sm" variant="outline" className="ml-auto" disabled={busy || running || !visible.length}
          onClick={() => setConfirming(true)}>
          Use the CRM&apos;s values for all of these
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use the CRM&apos;s values?</DialogTitle>
            <DialogDescription>Every disagreement under this filter ({filterName}) takes its CRM&apos;s value, and each field follows that CRM again. The values people set on those fields are replaced.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => { setConfirming(false); void run(startAll(filter), "Canon is using the CRM's values"); }}>Use the CRM&apos;s values</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {job && (job.status === "running" || (job.finishedAt && Date.now() - job.finishedAt < 10 * 60_000)) && (
        <p className="text-sm" role="status">
          {job.status === "running" ? "Using the CRM's values" : job.status === "done" ? "Used the CRM's values" : "Stopped"}
          {`: ${job.taken.toLocaleString()} taken`}{job.failed ? `, ${job.failed.toLocaleString()} could not be (${job.lastError ?? "refused"})` : ""}.
          {job.status === "running" && <button type="button" className="ml-2 underline" onClick={() => void run(cancel({ jobId: job.id as Id<"crmDisagreementJobs"> }))}>Stop</button>}
        </p>
      )}
      {selected.size > 0 && (
        <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button size="sm" disabled={busy || running || selected.size > SELECTION_MAX} onClick={() => void takeSelected()}>Use the CRM&apos;s values</Button>
          {selected.size > SELECTION_MAX && <span className="text-muted-foreground">Select at most {SELECTION_MAX}, or use all of these.</span>}
        </SelectionBar>
      )}
      {rows.status === "LoadingFirstPage" ? <LoadingRows /> : !visible.length && rows.status === "Exhausted" ? (
        <EmptyState icon={Scale} title="No disagreements" description={hiddenCount ? `${hiddenCount} on records you can't see.` : "Every field a person set agrees with the CRM, or follows it."} />
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="w-8 p-2"><input type="checkbox" aria-label="Select all shown" checked={visible.length > 0 && visible.every((r) => selected.has(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((r) => r.id)) : new Set())} /></th>
                <th className="p-2">Record</th><th className="p-2">Field</th><th className="p-2">In Canon</th><th className="p-2">CRM says</th><th className="p-2">Since</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                if ("hidden" in r) return null;
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="p-2"><input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.id)}
                      onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(r.id); else next.delete(r.id); setSelected(next); }} /></td>
                    <td className="p-2">
                      {r.pageId ? <Link className="record-name underline" href={recordHref(r.object, r.pageId)}>{r.title}</Link> : <span className="record-name">{r.title}</span>}
                      <span className="block text-xs text-muted-foreground">{objectOf(r.object).noun}</span>
                    </td>
                    <td className="p-2">{labelOf(r.object, r.field)}</td>
                    <td className="p-2">{r.values.map((x) => <div key={x.field}>{r.values.length > 1 && <span className="text-muted-foreground">{labelOf(r.object, x.field)}: </span>}{shown(r.object, x.field, x.canon, r.currency?.canon)}</div>)}</td>
                    <td className="p-2">{CRM_NAME[r.provider]}: {r.values.map((x) => <div key={x.field}>{r.values.length > 1 && <span className="text-muted-foreground">{labelOf(r.object, x.field)}: </span>}{shown(r.object, x.field, x.crm, r.currency?.crm)}</div>)}</td>
                    <td className="p-2 text-xs text-muted-foreground">{new Date(r.seenAt).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hiddenCount > 0 && visible.length > 0 && <p className="text-xs text-muted-foreground">{hiddenCount} more on records you can&apos;t see.</p>}
      {rows.status === "CanLoadMore" && <Button size="sm" variant="outline" onClick={() => rows.loadMore(25)}>Show more</Button>}
      <section className="space-y-2 pt-4">
        <h3 className="font-medium">Fields that always follow a CRM</h3>
        <p className="text-sm text-muted-foreground">
          For a field set here, the CRM&apos;s next import or sync always replaces what a person set in Canon, and the record&apos;s page says their edit lasts until then.
        </p>
        <div className="flex flex-wrap items-start gap-4">
          {OBJECTS.map(({ object: o, label }) => (
            <div key={o} className="overflow-x-auto border border-border">
              <table className="text-sm">
                <thead className="text-left text-xs font-medium text-muted-foreground"><tr><th className="p-2">{label}</th><th className="p-2">Salesforce</th><th className="p-2">HubSpot</th></tr></thead>
                <tbody>
                  {FIELDS(o).map((f) => (
                    <tr key={f} className="border-t border-border">
                      <td className="p-2">{labelOf(o, f)}</td>
                      {(["salesforce", "hubspot"] as const).map((p) => (
                        <td key={p} className="p-2 text-center">
                          <input type="checkbox" aria-label={`${label}: ${labelOf(o, f)} always follows ${CRM_NAME[p]}`} disabled={follows === undefined}
                            checked={Boolean(follows?.some((x) => x.object === o && x.field === f && x.provider === p))}
                            onChange={(e) => void run(setFollow({ provider: p, object: o, field: f, follow: e.target.checked }))} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
