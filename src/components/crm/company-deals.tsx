"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useState } from "react";
import { RecordLink } from "@/components/records/record-context";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { offered, type Context, type PageAction } from "../../../recipes";
import { DealCreateDialog } from "@/components/records/deal-create";
import { toast } from "@/lib/toast";
import { formatCurrency } from "@/lib/utils";

const head = "text-xs font-medium text-muted-foreground";

/** A company's deals on its account page, with the page's "New deal" prefilled with the company. */
export function CompanyDeals({ companyId, name, domain, stream, title, actions, ctx }: {
  companyId: string; name: string; domain: string; stream?: string; title?: string; actions: readonly PageAction[]; ctx: Context;
}) {
  const names = useObjectLabels();
  const deals = useQuery(api.deals.forCompany, { companyId, domain, ...(stream ? { stream } : {}) });
  const desc = useQuery(api.objects.describe, { object: "deal" });
  const [creating, setCreating] = useState(false);
  const stageField = desc?.fields.find((f) => f.apiName === "stage");
  const stageLabel = (value: string) => (stageField && "options" in stageField ? stageField.options.find((o) => o.value === value)?.label : undefined) ?? value;
  const canCreate = Boolean(desc?.canCreate);
  const newDeal = offered(actions, "companyDeals", ["kernel.newDeal"], { ...ctx, "deal.canCreate": canCreate }, {}, "account")[0];

  return (
    <section className="border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">{title ?? names("deal")!.pluralLabel}{deals ? ` (${deals.length})` : ""}</h2>
        {newDeal && (
          <button type="button" disabled={newDeal.disabled} onClick={() => setCreating(true)} className="border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
            {newDeal.label}
          </button>
        )}
      </div>
      {deals === undefined ? null : deals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deals yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className={head}>
            <tr><th className="py-1 text-left">Deal</th><th className="py-1 text-left">Stage</th><th className="py-1 text-right">Amount</th><th className="py-1 text-right">Close date</th></tr>
          </thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.dealId} className="border-t border-border">
                <td className="py-2">
                  {d.streamId ? <RecordLink object="deal" id={d.streamId} className="underline">{d.name}</RecordLink> : d.name}
                </td>
                <td className="py-2">{d.isClosed ? (d.isWon ? "Closed won" : "Closed lost") : d.stage ? stageLabel(d.stage) : "—"}</td>
                <td className="py-2 text-right tabular-nums">{d.amount === null ? "—" : formatCurrency(d.amount, d.currency)}</td>
                <td className="py-2 text-right tabular-nums">{d.closeDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {desc && newDeal && (
        <DealCreateDialog
          desc={desc}
          open={creating}
          company={{ id: companyId, title: name }}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void toast.success("Created deal");
          }}
        />
      )}
    </section>
  );
}
