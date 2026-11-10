"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { Loader2, Save, Sparkles, Wand2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { COLUMN_OBJECTS, isCatchAll, type ColumnObject, type MapEntry } from "../../../convex/lib/consolidate";
import { Panel } from "@/components/salesforce-sync/ui";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { mapCoverage, measureOfC, num, paint, pct, primary, secondary, small, sourceColor, valueRows, type Consolidation } from "./shared";
import { JobProgress } from "./job-progress";
import { QuantityView } from "./quantity-view";

type Filter = "all" | "unmapped" | "ai" | "catchAll" | "low";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unmapped", label: "Unmapped" },
  { id: "ai", label: "AI suggestions" },
  { id: "low", label: "Below threshold" },
  { id: "catchAll", label: "Into catch-all" },
];
const ORIGIN_LABEL = { auto: "Exact match", ai: "AI", user: "You", self: "Names an option" } as const;
const PAGE = 150;

/**
 * Many source values → one standard value. Every distinct value across the source columns, with how many
 * records carry it. Exact matches and AI suggestions start the map; every row stays editable. Values mapped into a
 * catch-all option ("Other") are called out, because each one hides a real value.
 */
export function ValuesView({ c }: { c: Consolidation }) {
  return measureOfC(c) === "quantity" ? <QuantityView c={c} /> : <ValueMapView c={c} />;
}

function ValueMapView({ c }: { c: Consolidation }) {
  const setMap = useMutation(api.fieldConsolidations.setMap);
  const suggest = useAction(api.fieldConsolidationActions.suggest);
  const [entries, setEntries] = useState<MapEntry[]>(c.valueMap);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "auto" | "ai" | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  // Server changes (a suggestion pass) replace the local copy unless the user has unsaved edits.
  useEffect(() => {
    if (!dirty) setEntries(c.valueMap);
  }, [c.valueMap, dirty]);
  // Leaving the tab keeps unsaved edits: the preview reads the saved map.
  const unsaved = useRef<MapEntry[] | null>(null);
  unsaved.current = dirty ? entries : null;
  useEffect(
    () => () => {
      if (unsaved.current) void setMap({ id: c._id, entries: unsaved.current }).catch((error) => toast.error(getErrorMessage(error)));
    },
    [c._id, setMap],
  );

  const options = c.field!.options;
  const threshold = c.policy.minConfidence;
  const labelOf = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);
  const catchAll = useMemo(() => new Set(options.filter(isCatchAll).map((o) => o.value)), [options]);

  // While the columns are read again their profile is empty: say so rather than "0 of 0", and hold suggestions until
  // there are values to suggest for.
  const reading = c.stage === "discovering" || c.stage === "profiling";
  const readSoFar = c.profiles.filter((p) => p.stage === "reading").map((p) => `${COLUMN_OBJECTS[p.object as ColumnObject]?.label ?? p.object} ${num(p.read)}`).join(", ");
  const rows = useMemo(() => valueRows(c, entries), [c, entries]);
  const { mapped, records: total, mappedRecords } = mapCoverage(rows, threshold);
  const priority = (key: string) => (c.sources ?? []).indexOf(key);
  const intoCatchAll = mapped.filter((r) => catchAll.has(r.to!));
  const catchAllRecords = intoCatchAll.reduce((s, r) => s + r.count, 0);

  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (q && !r.value.toLowerCase().includes(q) && !(r.to && (labelOf.get(r.to) ?? r.to).toLowerCase().includes(q))) return false;
    if (filter === "unmapped") return r.to === null;
    if (filter === "ai") return r.origin === "ai";
    if (filter === "low") return r.to !== null && (r.confidence ?? 0) < threshold;
    if (filter === "catchAll") return r.to !== null && catchAll.has(r.to);
    return true;
  });

  function edit(key: string, to: string) {
    const next = entries.filter((e) => e.from !== key);
    next.push({ from: key, to: to || null, origin: "user", confidence: 1 });
    setEntries(next);
    setDirty(true);
  }

  async function save() {
    setBusy("save");
    try {
      await setMap({ id: c._id, entries });
      setDirty(false);
      toast.success("Map saved.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function runSuggest(ai: boolean) {
    setBusy(ai ? "ai" : "auto");
    try {
      if (dirty) {
        await setMap({ id: c._id, entries });
        setDirty(false);
      }
      const result = await suggest({ id: c._id, ai });
      if (result.ai === "no_llm") toast.info(`Added ${num(result.added)} exact matches. Connect ChatGPT in Integrations for AI suggestions on the rest.`);
      else if (result.ai === "failed") toast.error(`Added ${num(result.added)} suggestions; the AI pass failed: ${result.detail ?? "unknown error"}`);
      else toast.success(result.added ? `Added ${num(result.added)} suggestions. Review them below.` : "Nothing left to suggest.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <Panel title={`Map values into ${c.concept}'s options`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[70ch] text-sm">
            {reading ? (
              <p className="flex items-center gap-2 text-lg font-medium" role="status">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading the columns{readSoFar ? ` (${readSoFar} read)` : ""}…
              </p>
            ) : (
              <p className="text-lg font-medium">
                {num(mapped.length)} of {num(rows.length)} source values are mapped, covering {pct(mappedRecords, total)}% of source records.
              </p>
            )}
            <p className="mt-1 text-muted-foreground">
              Mappings below the {Math.round(threshold * 100)}% confidence threshold aren&apos;t used. Set the threshold on the Sources tab.
            </p>
            {catchAllRecords > 0 && (
              <p className="mt-2 border border-warning/40 bg-warning/15 p-2 text-warning">
                {num(catchAllRecords)} records ({pct(catchAllRecords, mappedRecords)}% of mapped) go into catch-all values
                {" "}({[...new Set(intoCatchAll.map((r) => labelOf.get(r.to!) ?? r.to))].join(", ")}).{" "}
                <button type="button" className="underline" onClick={() => setFilter("catchAll")}>
                  Review them
                </button>{" "}
                and map what you can to a specific value.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void runSuggest(false)} disabled={busy !== null || reading} title={reading ? "Wait for the columns to be read" : undefined} className={secondary}>
              {busy === "auto" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Suggest exact matches
            </button>
            <button type="button" onClick={() => void runSuggest(true)} disabled={busy !== null || reading} title={reading ? "Wait for the columns to be read" : undefined} className={secondary}>
              {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Suggest with AI
            </button>
            <button type="button" onClick={() => void save()} disabled={busy !== null || !dirty} className={primary}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {dirty ? "Save map" : "Saved"}
            </button>
          </div>
        </div>
        <JobProgress c={c} task="suggest" busy={busy === "ai"} />
      </Panel>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setShown(PAGE);
              }}
              className={cn("border border-border px-3 py-1 text-xs font-medium -ml-px", filter === f.id ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search values"
          aria-label="Search values"
          className="h-8 w-56 border border-input bg-background px-2 text-sm outline-none focus:border-primary"
        />
        <span className="text-xs text-muted-foreground">{num(visible.length)} values</span>
      </div>

      <div className="overflow-x-auto border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Source value</th>
              <th className="px-3 py-2 text-right font-medium">Records</th>
              <th className="px-3 py-2 font-medium">Maps to</th>
              <th className="px-3 py-2 font-medium">From</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, shown).map((r) => {
              const low = r.to !== null && (r.confidence ?? 0) < threshold;
              const toCatchAll = r.to !== null && catchAll.has(r.to);
              return (
                <tr key={r.key} className={cn("border-b border-border/60", toCatchAll && "bg-warning/10")}>
                  <td className="px-3 py-1.5">
                    {r.value}
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      {r.columns.map((col) => (
                        <span key={col.key} className="inline-flex items-center gap-1">
                          <i className={cn("inline-block h-2 w-2 shrink-0 rounded-sm bg-[color:var(--c)]", paint)} style={sourceColor(priority(col.key))} aria-hidden="true" />
                          {col.label}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(r.count)}</td>
                  <td className="px-3 py-1.5">
                    <SelectField
                      aria-label={`Map ${r.value}`}
                      value={r.to ?? ""}
                      onValueChange={(to) => edit(r.key, to)}
                      className={cn("w-64", low && "opacity-60")}
                      options={[
                        { value: "", label: "Leave unmapped" },
                        ...options.map((o) => ({ value: o.value, label: `${o.label}${isCatchAll(o) ? " (catch-all)" : ""}` })),
                      ]}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {r.origin ? ORIGIN_LABEL[r.origin] : <span className="text-muted-foreground">none</span>}
                    {r.origin === "ai" && r.confidence !== null && (
                      <span className={cn("ml-1 tabular-nums", low ? "text-warning" : "text-muted-foreground")}>{Math.round(r.confidence * 100)}%</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length > shown && (
          <div className="p-2 text-center">
            <button type="button" onClick={() => setShown(shown + PAGE)} className={small}>
              Show {num(Math.min(PAGE, visible.length - shown))} more
            </button>
          </div>
        )}
        {rows.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {reading ? "The source values appear here once the columns are read. The map you saved is kept." : "The source columns have no values on the records read."}
          </p>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Values are matched ignoring case and punctuation, so &quot;Food &amp; Beverage&quot; and &quot;food and beverage&quot; map together. To add a new picklist value,
        create it in the CRM, then search for columns again.
      </p>
    </div>
  );
}
