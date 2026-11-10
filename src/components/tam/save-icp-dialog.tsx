"use client";

/**
 * "Save as ICP" from a treemap drill (docs/tam-and-icps.md, step 1): the drill's
 * filters become the ICP's company criteria. The dialog shows what each filter
 * becomes, how big the pocket is now, and what an ICP can't hold yet.
 */
import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { COUNTRIES } from "../../../convex/lib/addRecords";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { drillToSpec } from "@/lib/drill-to-icp";
import { industryLabel } from "../../../modules/kernel/industries";
import type { Pivot } from "@/lib/tam-levels";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const label = "text-xs font-medium text-muted-foreground";
const countryName = (iso: string) => COUNTRIES.find((c) => c.value === iso)?.label ?? iso.toUpperCase();

export function SaveIcpDialog({ open, onOpenChange, pivot, labelOf, valueLabel, pocketCount, hasActive, isFirst, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pivot: Pivot;
  labelOf: (dim: string) => string;
  valueLabel: (dim: string, value: string) => string;
  pocketCount: number;
  hasActive: boolean;
  /** The workspace's first ICP is always on (convex/icps.ts). */
  isFirst: boolean;
  onSaved: (icpId: Id<"icps">, active: boolean) => void;
}) {
  const create = useMutation(api.icps.create);
  const { spec, unsaved, empty } = useMemo(() => drillToSpec(pivot, labelOf), [pivot, labelOf]);
  const drillName = pivot.filters.map((f) => f.values.map((v) => valueLabel(f.dim, v)).join(" + ")).join(" · ");
  const [name, setName] = useState(drillName.slice(0, 80));
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const on = isFirst || active;
      const icpId = await create({ name, spec, active: on });
      void toast.success(on ? `Saved ${name}. Fit scores are updating.` : `Saved ${name}. It's off until you switch it on.`);
      onSaved(icpId, on);
      onOpenChange(false);
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
    // AI-field answers the ICP requires, from a drill through AI-field levels.
    ...(spec.custom ?? []).map((c): [string, string[]] => [labelOf(`field:${c.slug}`), (c.values ?? []).map((v) => valueLabel(`field:${c.slug}`, v))]),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Save this pocket as an ICP</DialogTitle>
        <DialogDescription className="text-sm">
          <span className="text-foreground">{pocketCount.toLocaleString()}</span> accounts in your TAM sit in this pocket now. As an ICP, an account is in it only when it matches every criterion below.
        </DialogDescription>
        <label className="grid gap-1">
          <span className={label}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
        </label>
        <div className="grid gap-2 border border-border p-3 text-sm">
          {rows.map(([title, values]) => (
            <div key={title} className="grid grid-cols-[110px_1fr] gap-2">
              <span className={label}>{title}</span>
              <span className={values.length ? "" : "text-muted-foreground"}>{values.length ? values.join(", ") : "Any"}</span>
            </div>
          ))}
        </div>
        {unsaved.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Not saved: {unsaved.join(", ")}. An ICP keeps company criteria and AI-field answers; these filters stay on this view only.
          </p>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Turn on now
            <span className="block text-xs text-muted-foreground">
              {isFirst ? "Your first ICP is always on: it sets fit scores." : hasActive ? "Its accounts join fit scoring alongside your other active ICPs." : "It becomes your active ICP and sets fit scores."}
            </span>
          </span>
          <Switch checked={isFirst || active} disabled={isFirst} onCheckedChange={setActive} aria-label="Turn on now" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="border border-border px-3 py-1.5 text-xs font-medium">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || empty || !name.trim()} className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
            {busy && <Loader2 className="size-3 animate-spin" />} Save ICP
          </button>
        </div>
        {empty && <p className="text-xs text-destructive">Drill into an industry, size or location first: those are what an ICP is made of.</p>}
      </DialogContent>
    </Dialog>
  );
}
