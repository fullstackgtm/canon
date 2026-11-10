"use client";

import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { Loader2, Wand2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import {
  COLUMN_OBJECTS, DEFAULT_TOLERANCE, SCALE_FACTORS, compactAmount, pairKey, quantile, quantityShare, ratioAgreement, scaleOf, type Column, type ScaleEntry,
} from "../../../convex/lib/consolidate";
import { Panel } from "@/components/salesforce-sync/ui";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { destinationColumns, num, paint, pct, profileOf, secondary, sourceColor, type Consolidation } from "./shared";

const SCALE_LABEL: Record<number, string> = { 1e-6: "÷ 1,000,000", 1e-3: "÷ 1,000", 1: "× 1", 1e3: "× 1,000", 1e6: "× 1,000,000", 1e9: "× 1,000,000,000" };

/**
 * A quantity's Values tab: in place of a value map, each source's amounts against the destinations', and the scale that
 * puts them in the destinations' units. "Suggest scales" proposes one wherever a source sits a power of 1,000 away.
 */
export function QuantityView({ c }: { c: Consolidation }) {
  const setScales = useMutation(api.fieldConsolidations.setScales);
  const suggest = useAction(api.fieldConsolidationActions.suggest);
  const [busy, setBusy] = useState(false);
  const byKey = new Map(c.columns.map((col) => [col.key, col]));
  // Amounts scale into the destinations' units; a field with none uses the column it was defined from.
  const reference = byKey.get(c.optionsFrom ?? c.target ?? "");
  const written = destinationColumns(c).map((d) => d.column);
  const destinations = written.length ? written : reference ? [reference] : [];
  const sources = (c.sources ?? []).flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
  const tolerance = c.policy.tolerance ?? DEFAULT_TOLERANCE;
  const reading = c.stage === "discovering" || c.stage === "profiling";

  async function setScale(column: string, factor: number) {
    const next: ScaleEntry[] = [...c.scales.filter((e) => e.column !== column), { column, factor, origin: "user" }];
    try {
      await setScales({ id: c._id, scales: next });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function runSuggest() {
    setBusy(true);
    try {
      const result = await suggest({ id: c._id, ai: false });
      toast.success(result.added ? `Suggested ${num(result.added)} scale${result.added === 1 ? "" : "s"}. Review them below.` : "Every source already looks like it's in the destinations' units.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Panel title={`Sources and scales for ${c.concept}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[70ch] text-sm">
            <p className="text-lg font-medium">
              {reading ? "Reading the columns…" : `${num(sources.length)} source${sources.length === 1 ? "" : "s"}, read as amounts and scaled into the destinations' units.`}
            </p>
            <p className="mt-1 text-muted-foreground">
              A source that records revenue in thousands needs × 1,000. Agreement compares each source with a destination on the records that hold both,
              within {Math.round(tolerance * 100)}% (set on the Sources tab).
            </p>
          </div>
          <button type="button" onClick={() => void runSuggest()} disabled={busy || reading} className={secondary}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Suggest scales
          </button>
        </div>
      </Panel>
      <div className="overflow-x-auto border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Column</th>
              <th className="px-3 py-2 text-right font-medium">Read as amounts</th>
              <th className="px-3 py-2 text-right font-medium">Median</th>
              <th className="px-3 py-2 text-right font-medium">Middle 80%</th>
              <th className="px-3 py-2 font-medium">Agrees with a destination</th>
              <th className="px-3 py-2 font-medium">Scale</th>
            </tr>
          </thead>
          <tbody>
            {destinations.map((d) => (
              <AmountRow key={d.key} c={c} column={d} destination={null} />
            ))}
            {sources.map((col, i) => {
              const entry = c.scales.find((e) => e.column === col.key);
              return (
                <AmountRow key={col.key} c={c} column={col} destination={destinations.find((d) => d.object === col.object) ?? null} priority={i}>
                  <SelectField
                    aria-label={`Scale for ${col.label}`}
                    value={String(entry?.factor ?? 1)}
                    onValueChange={(factor) => void setScale(col.key, Number(factor))}
                    className="w-40"
                    options={SCALE_FACTORS.map((f) => ({ value: String(f), label: SCALE_LABEL[f]! }))}
                  />
                  {entry?.origin === "auto" && <span className="ml-2 text-xs text-muted-foreground">Suggested</span>}
                </AmountRow>
              );
            })}
          </tbody>
        </table>
        {sources.length === 0 && <p className="p-4 text-sm text-muted-foreground">No sources yet. Choose them on the Sources tab.</p>}
      </div>
    </div>
  );
}

function AmountRow({ c, column, destination, priority, children }: {
  c: Consolidation;
  column: Column;
  destination: Column | null;
  priority?: number;
  children?: ReactNode;
}) {
  const profile = profileOf(c, column.object);
  const stats = profile?.columns[column.name];
  const q = stats?.quantity;
  const scale = scaleOf(c.scales, column.key);
  const at = (x: number) => {
    const v = q ? quantile(q, x) : null;
    return v === null ? "–" : compactAmount(v * scale);
  };
  const pair = destination && profile?.pairs[pairKey(column.name, destination.name)];
  const [a, b] = destination && column.name < destination.name ? [column, destination] : [destination, column];
  const agree = pair && a && b ? ratioAgreement(pair.ratios ?? [], scaleOf(c.scales, a.key) / scaleOf(c.scales, b.key), c.policy.tolerance ?? DEFAULT_TOLERANCE) : null;
  const rate = agree?.compared ? agree.agree / agree.compared : null;
  return (
    <tr className="border-b border-border/60">
      <td className="px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5">
          {priority !== undefined && <i className={cn("inline-block h-2 w-2 shrink-0 rounded-sm bg-[color:var(--c)]", paint)} style={sourceColor(priority)} aria-hidden="true" />}
          {column.label}
          {!destination && priority === undefined && <span className="text-xs text-primary">destination</span>}
        </span>
        <span className="block text-xs text-muted-foreground">
          {COLUMN_OBJECTS[column.object].label} · {column.kind === "number" ? "number" : column.kind === "picklist" ? "picklist" : "free text"}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {stats ? (
          <>
            {num(q?.read ?? 0)} <span className="text-muted-foreground">of {num(stats.filled)}</span>
            {q && quantityShare(q, stats.filled, 1) < quantityShare(q, stats.filled, 0) && (
              <span className="block text-xs text-muted-foreground">{pct(quantityShare(q, stats.filled, 1) * stats.filled, q.read)}% plain numbers</span>
            )}
          </>
        ) : (
          "–"
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{at(0.5)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
        {at(0.1)}–{at(0.9)}
      </td>
      <td className="px-3 py-1.5 text-xs">
        {!destination ? (
          ""
        ) : rate === null ? (
          <span className="text-muted-foreground">No records hold both</span>
        ) : (
          <>
            <span className={cn("font-medium tabular-nums", rate < 0.5 ? "text-destructive" : rate < 0.8 ? "text-warning" : "text-foreground")}>{Math.round(rate * 100)}%</span>{" "}
            <span className="text-muted-foreground">of {num(agree!.compared)}</span>
          </>
        )}
      </td>
      <td className="px-3 py-1.5">{children ?? <span className="text-xs text-muted-foreground">its own units</span>}</td>
    </tr>
  );
}
