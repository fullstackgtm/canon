"use client";

/**
 * "Fill this pocket" from a ghost tile (docs/tam-and-icps.md, step 2): a part of
 * the market with no accounts in the CRM. Starts a free market fill of the
 * pocket, held for review like every fill, finding the default ICP's buyers.
 */
import { useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { COUNTRIES, LEVELS } from "../../../convex/lib/addRecords";
import { industryLabel } from "../../../modules/kernel/industries";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { drillToSpec } from "@/lib/drill-to-icp";
import type { Pivot } from "@/lib/tam-levels";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const label = "text-xs font-medium text-muted-foreground";
const countryName = (iso: string) => COUNTRIES.find((c) => c.value === iso)?.label ?? iso.toUpperCase();

export function FillPocketDialog({ open, onOpenChange, pivot, labelOf, pocketLabel, market }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The view drilled into the pocket. */
  pivot: Pivot;
  labelOf: (dim: string) => string;
  pocketLabel: string;
  market: number;
}) {
  const ctx = useQuery(api.addRecords.context);
  const start = useAction(api.addRecords.startMarket);
  const router = useRouter();
  const { spec, unsaved, empty } = useMemo(() => drillToSpec(pivot, labelOf), [pivot, labelOf]);
  const [busy, setBusy] = useState(false);
  const persona = ctx?.start.spec.persona ?? { levels: [], departments: [], titles: [] };
  const buyers = [...persona.levels.map((l) => LEVELS.find((x) => x.value === l)?.label ?? l), ...persona.departments, ...persona.titles];

  async function fill() {
    setBusy(true);
    try {
      const { jobId } = await start({ market: spec.market, persona });
      void toast.success(`Filling ${pocketLabel}. Review what it finds before anything is added.`);
      onOpenChange(false);
      router.push(`/dashboard/imports/${jobId}`);
    } catch (e) {
      void toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<[string, string[]]> = [
    ["Industries", spec.market.industries.map(industryLabel)],
    ["Company size", spec.market.employeeBands],
    ["Locations", spec.market.countries.map(countryName)],
    ["Buyers", buyers.length ? buyers : ["C-suite, VP, Head, Director"]],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Fill {pocketLabel}</DialogTitle>
        <DialogDescription className="text-sm">
          About <span className="text-foreground">{market.toLocaleString()}</span> companies exist in this pocket and none are in your CRM yet.
          A fill finds them and their buyers from the free source, then waits for your review before anything is added.
        </DialogDescription>
        <div className="grid gap-2 border border-border p-3 text-sm">
          {rows.map(([title, values]) => (
            <div key={title} className="grid grid-cols-[110px_1fr] gap-2">
              <span className={label}>{title}</span>
              <span className={values.length ? "" : "text-muted-foreground"}>{values.length ? values.join(", ") : "Any"}</span>
            </div>
          ))}
        </div>
        {unsaved.length > 0 && <p className="text-xs text-muted-foreground">Not used by the fill: {unsaved.join(", ")}.</p>}
        {ctx && !ctx.canRun && <p className="text-xs text-muted-foreground">Ask an admin or manager to fill this pocket.</p>}
        {ctx && ctx.canRun && !ctx.configured && <p className="text-xs text-muted-foreground">Data sources aren&apos;t configured on this deployment.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="border border-border px-3 py-1.5 text-xs font-medium">Cancel</button>
          <button type="button" onClick={() => void fill()} disabled={busy || empty || !ctx?.canRun || !ctx.configured}
            className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
            {busy && <Loader2 className="size-3 animate-spin" />} Fill this pocket
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
