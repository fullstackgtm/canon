"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, getErrorMessage } from "@/lib/utils";
import { FieldInput, type CellValue } from "./fields";
import { recordHref } from "./lookup-field";
import { SelectField } from "@/components/ui/select";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const label = "text-xs font-medium text-muted-foreground";
const inputClass = "w-full border border-border bg-background px-2 py-1 text-sm";
const DEBOUNCE_MS = 400;

export type Converted = FunctionReturnType<typeof api.leadConversion.convert>;
type Preview = FunctionReturnType<typeof api.leadConversion.preview>;

const today = () => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

/**
 * Convert a lead (convex/leadConversion.ts): the company is matched by domain
 * and the person by email, each created only when new, and the dialog says
 * which is which before anything is written. Admins and managers can also
 * create a deal in a chosen pipeline and stage.
 */
export function ConvertLeadDialog({ leadId, open, onClose, onConverted }: {
  leadId: string;
  open: boolean;
  onClose: () => void;
  onConverted: (done: Converted) => void;
}) {
  const names = useObjectLabels();
  const preview = useAction(api.leadConversion.preview);
  const convert = useAction(api.leadConversion.convert);
  const me = useQuery(api.users.me, open ? {} : "skip");
  const dealDesc = useQuery(api.objects.describe, open ? { object: "deal" } : "skip");
  const pipelines = useQuery(api.pipelines.list, open ? {} : "skip") ?? undefined;
  const mayDeal = me?.role === "admin" || me?.role === "manager";

  const [domain, setDomain] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [withDeal, setWithDeal] = useState(false);
  const [deal, setDeal] = useState<Record<string, CellValue>>({ currency: "USD", dealType: "new_business", closeDate: today() });
  const [pipeline, setPipeline] = useState(0);
  const [stage, setStage] = useState<string | null>(null);
  const [plan, setPlan] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Converted | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      preview({ leadId, ...(domain !== null ? { domain } : {}), createsDeal: withDeal })
        .then((p) => {
          if (!live) return;
          setPlan(p);
          setDomain((cur) => cur ?? p.company.domain ?? "");
          setCompanyName((cur) => cur ?? p.company.name);
          setDeal((cur) => (typeof cur.name === "string" && cur.name ? cur : { ...cur, name: `${p.company.name || "Deal"} - ${p.person.fullName}` }));
        })
        .catch((cause) => { if (live) setError(getErrorMessage(cause)); });
    }, plan ? DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [open, leadId, domain, withDeal, preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = pipelines?.[pipeline];
  const chosenStage = stage ?? chosen?.stages.find((s) => s.active)?.value ?? "";
  const dealField = (name: string) => dealDesc?.fields.find((f) => f.apiName === name);
  const existingCompany = plan?.company.existing ?? null;

  async function submit() {
    setError(null);
    const amount = deal.amount;
    if (withDeal && amount !== undefined && amount !== null && amount !== "" && typeof amount !== "number") return setError("Amount must be a number, for example 42000");
    setBusy(true);
    try {
      const out = await convert({
        leadId,
        domain: domain ?? "",
        ...(companyName ? { companyName } : {}),
        ...(withDeal && chosen ? {
          deal: {
            name: String(deal.name ?? ""), ...(typeof amount === "number" ? { amount } : {}), currency: String(deal.currency ?? "USD"),
            closeDate: String(deal.closeDate ?? ""), dealType: String(deal.dealType ?? "new_business"), pipelineId: chosen.id, stage: chosenStage,
          },
        } : {}),
      });
      setDone(out);
      onConverted(out);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setDone(null);
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{done ? "Lead converted" : `Convert ${plan?.title ?? "lead"}`}</DialogTitle>
          <DialogDescription>
            {done ? "The lead stays in Canon, marked converted, with links to what it became." : "Creates the company and person unless they already exist, and moves the lead's activities to the person."}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col gap-2 text-sm">
            <Result what={names("account")!.label} created={done.company.created} href={recordHref("account", done.company.id)} name={done.company.name} />
            <Result what={names("contact")!.label} created={done.person.created} href={recordHref("contact", done.person.id)} name={done.person.name} />
            {done.deal && <Result what={names("deal")!.label} created href={recordHref("deal", done.deal.streamId)} name={done.deal.name} />}
            {done.lifecycleStage && <p className="text-xs text-muted-foreground">Lifecycle stage set to {done.lifecycleStage === "sql" ? "Sales qualified" : "Opportunity"}.</p>}
            {done.activitiesMoved > 0 && <p className="text-xs text-muted-foreground">{done.activitiesMoved} {done.activitiesMoved === 1 ? "activity" : "activities"} now also on the person&apos;s timeline.</p>}
            <DialogFooter><button type="button" onClick={close} className={btn}>Done</button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-4">
            {!plan ? <p className="text-sm text-muted-foreground">{error ?? "Reading the lead…"}</p> : (
              <>
                <section className="flex flex-col gap-2 border border-border p-3">
                  <div className="flex items-center justify-between"><span className={label}>Company</span><Badge existing={existingCompany !== null} /></div>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Website domain (a company with it is joined, not duplicated)</span>
                    <input aria-label="Company domain" className={inputClass} value={domain ?? ""} placeholder="acme.com" onChange={(e) => setDomain(e.target.value)} />
                  </label>
                  {existingCompany ? (
                    <p className="text-sm">Joins <span className="font-medium">{existingCompany.name}</span>, which is already in your workspace. Its fields are kept as they are.</p>
                  ) : (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">New company name</span>
                      <input aria-label="Company name" className={inputClass} value={companyName ?? ""} onChange={(e) => setCompanyName(e.target.value)} />
                    </label>
                  )}
                </section>

                <section className="flex flex-col gap-1 border border-border p-3">
                  <div className="flex items-center justify-between"><span className={label}>Person</span><Badge existing={plan.person.existing !== null} /></div>
                  <p className="text-sm"><span className="font-medium">{plan.person.fullName}</span>{plan.person.email ? ` · ${plan.person.email}` : " · no email, so a person with this name at the company is matched"}</p>
                  {plan.person.existing && <p className="text-xs text-muted-foreground">Already in your workspace as {plan.person.existing.name}. Its fields are kept as they are.</p>}
                  <p className="text-xs text-muted-foreground">
                    Lifecycle stage: {plan.lifecycle.to ? `${plan.lifecycle.from ?? "none"} → ${plan.lifecycle.to === "sql" ? "Sales qualified" : "Opportunity"}` : `stays ${plan.lifecycle.from ?? "as it is"}`}
                  </p>
                </section>

                <section className="border border-border p-3">
                  <div className={cn(label, "mb-1")}>Where the lead&apos;s fields go</div>
                  {plan.fields.length === 0 && plan.skipped.length === 0 ? <p className="text-xs text-muted-foreground">Name and email only.</p> : (
                    <ul className="space-y-0.5 text-xs">
                      {plan.fields.map((f) => (
                        <li key={`${f.target}:${f.label}`} className={cn(f.keptAsIs && "text-muted-foreground line-through")}>
                          {f.from} → {names(f.target === "contact" ? "contact" : "account")!.label} {f.label}: {f.shown}{f.keptAsIs ? " (record exists, kept as is)" : ""}
                        </li>
                      ))}
                      {plan.skipped.map((s) => <li key={s.from} className="text-muted-foreground">Not carried over: {s.from} ({s.reason})</li>)}
                    </ul>
                  )}
                </section>

                {mayDeal && (
                  <section className="flex flex-col gap-2 border border-border p-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} /> Also create a deal
                    </label>
                    {withDeal && (
                      <>
                        {["name", "amount", "closeDate"].map((name) => {
                          const f = dealField(name);
                          return f && (
                            <label key={name} className="flex flex-col gap-1">
                              <span className={label}>{f.label}{name !== "amount" ? " *" : ""}</span>
                              <FieldInput field={f} value={deal[name] ?? null} onChange={(next) => setDeal((cur) => ({ ...cur, [name]: next }))} />
                            </label>
                          );
                        })}
                        <label className="flex flex-col gap-1">
                          <span className={label}>Pipeline *</span>
                          <SelectField aria-label="Pipeline" className="w-full" value={String(pipeline)} onValueChange={(v) => { setPipeline(Number(v)); setStage(null); }}
                            options={(pipelines ?? []).map((p, i) => ({ value: String(i), label: p.name }))} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className={label}>Stage *</span>
                          <SelectField aria-label="Stage" className="w-full" value={chosenStage ?? ""} onValueChange={setStage}
                            options={(chosen?.stages ?? []).filter((s) => s.active).map((s) => ({ value: s.value, label: s.label }))} />
                        </label>
                      </>
                    )}
                  </section>
                )}
              </>
            )}
            {error && plan && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <button type="button" onClick={close} className={btn}>Cancel</button>
              <button type="submit" disabled={busy || !plan || plan.convertedAt !== null} className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}>{busy ? "Converting…" : "Convert"}</button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Badge({ existing }: { existing: boolean }) {
  return <span className={cn("border px-1.5 py-0.5 text-xs font-medium", existing ? "border-border text-muted-foreground" : "border-primary text-primary")}>{existing ? "Existing" : "New"}</span>;
}

function Result({ what, created, href, name }: { what: string; created: boolean; href: string; name: string }) {
  return (
    <div className="flex items-center justify-between border border-border px-3 py-2">
      <span><span className={label}>{what}</span> <Link href={href} className="font-medium underline">{name}</Link></span>
      <Badge existing={!created} />
    </div>
  );
}
