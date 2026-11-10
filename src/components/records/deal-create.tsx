"use client";

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, getErrorMessage } from "@/lib/utils";
import { FieldInput, type CellValue, type ObjectDescription, type TeamMember } from "./fields";
import { RecordPicker, type PickedRecord } from "./lookup-field";
import { SelectField } from "@/components/ui/select";

const FIELDS = ["name", "amount", "currency", "closeDate", "dealType", "ownerId"];
const REQUIRED = new Set(["name", "currency", "closeDate"]);
const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const label = "text-xs font-medium text-muted-foreground";

export type DealCreated = FunctionReturnType<typeof api.deals.create>;
type Pipelines = NonNullable<FunctionReturnType<typeof api.pipelines.list>>;

const firstStage = (pipelines: Pipelines | undefined, index: number) => pipelines?.[index]?.stages.find((s) => s.active)?.value ?? "";
const scalar = (value: CellValue | undefined) => (Array.isArray(value) ? null : value ?? null);
const text = (value: CellValue | undefined) => (typeof value === "string" ? value : undefined);

/** New deal: its required fields, a pipeline, one of that pipeline's stages, and optionally its company (`company` prefills it). */
export function DealCreateDialog({ desc, open, company: prefill, onClose, onCreated }: {
  desc: ObjectDescription;
  open: boolean;
  company?: PickedRecord;
  onClose: () => void;
  onCreated: (created: DealCreated) => void;
}) {
  const [company, setCompany] = useState<PickedRecord | null>(prefill ?? null);
  const prefillId = prefill?.id;
  const prefillTitle = prefill?.title ?? "";
  useEffect(() => {
    if (open) setCompany(prefillId ? { id: prefillId, title: prefillTitle } : null);
  }, [open, prefillId, prefillTitle]);
  // Through the action, which admits the company for a role that sees only some (CP14).
  const create = useAction(api.deals.createScoped);
  const pipelines = useQuery(api.pipelines.list, open ? {} : "skip") ?? undefined;
  const team = useQuery(api.users.list, open ? {} : "skip") as TeamMember[] | undefined;
  const me = useQuery(api.users.me, open ? {} : "skip");
  const [values, setValues] = useState<Record<string, CellValue>>({ currency: "USD", dealType: "new_business" });
  const [pipeline, setPipeline] = useState(0);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A required custom field (CP7b) must be filled to create a deal; optional custom fields are edited on the deal.
  const requiredCustom = desc.fields.filter((f) => f.required && f.apiName.startsWith("custom.") && f.archivedAt === undefined && f.type !== "formula");
  const fields = [...FIELDS.flatMap((name) => desc.fields.filter((f) => f.apiName === name)), ...requiredCustom];
  const chosenStage = stage ?? firstStage(pipelines, pipeline);

  async function submit() {
    const chosen = pipelines?.[pipeline];
    if (!chosen) return;
    // An amount the field could not read as a number is refused rather than dropped, so a deal never loses it silently.
    const amount = values.amount;
    if (amount !== undefined && amount !== null && amount !== "" && typeof amount !== "number") {
      setError("Amount must be a number, for example 42000");
      return;
    }
    setBusy(true);
    try {
      const created = await create({
        name: text(values.name) ?? "",
        ...(typeof values.amount === "number" ? { amount: values.amount } : {}),
        currency: text(values.currency),
        closeDate: text(values.closeDate) ?? "",
        dealType: text(values.dealType),
        // Left blank, the deal is the caller's.
        ...(text(values.ownerId) ? { primaryRepId: text(values.ownerId) as Id<"users"> } : {}),
        pipelineId: chosen.id,
        stage: chosenStage,
        ...(company ? { companyId: company.id } : {}),
        ...(requiredCustom.length ? { custom: Object.fromEntries(requiredCustom.map((f) => [f.apiName, scalar(values[f.apiName])])) } : {}),
      });
      setValues({ currency: "USD", dealType: "new_business" });
      setStage(null);
      setError(null);
      onCreated(created);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>Fields marked * are required.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3">
          {fields.map((f) => (
            <label key={f.fieldId} className="flex flex-col gap-1">
              <span className={label}>{f.label}{REQUIRED.has(f.apiName) || f.required ? " *" : ""}</span>
              <FieldInput field={f} value={values[f.apiName] ?? (f.apiName === "ownerId" ? me?._id ?? null : null)} team={team} onChange={(next) => setValues((cur) => ({ ...cur, [f.apiName]: next }))} />
            </label>
          ))}
          <div className="flex flex-col gap-1">
            <span className={label}>Company</span>
            {company ? (
              <div className="flex items-center gap-3 text-sm">
                <span>{company.title || company.id}</span>
                <button type="button" onClick={() => setCompany(null)} className="text-xs text-muted-foreground underline hover:text-foreground">Change</button>
              </div>
            ) : (
              <RecordPicker object="account" label="Search companies" onPick={setCompany} />
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className={label}>Pipeline *</span>
            <SelectField aria-label="Pipeline" className="w-full" value={String(pipeline)} onValueChange={(v) => { setPipeline(Number(v)); setStage(null); }}
              options={(pipelines ?? []).map((p, i) => ({ value: String(i), label: p.name }))} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Stage *</span>
            <SelectField aria-label="Stage" className="w-full" value={chosenStage ?? ""} onValueChange={setStage}
              options={(pipelines?.[pipeline]?.stages ?? []).filter((s) => s.active).map((s) => ({ value: s.value, label: s.label }))} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <button type="button" onClick={onClose} className={btn}>Cancel</button>
            <button type="submit" disabled={busy || !pipelines} className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}>{busy ? "Saving…" : "Create"}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
