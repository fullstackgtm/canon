"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAction, useMutation } from "convex/react";
import { ArrowDown, ArrowUp, Eye, GripVertical, Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { COLUMN_OBJECTS, COMBINE_LABEL, DEFAULT_TOLERANCE, parseColumnKey, sourceFits, type Column, type Combine, type Policy } from "../../../convex/lib/consolidate";
import { SelectField } from "@/components/ui/select";
import { Panel } from "@/components/salesforce-sync/ui";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { coverageFor, destinationColumns, fillOf, num, paint, pct, primary, small, sourceColor, type Consolidation, type Coverage } from "./shared";

const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(45deg, var(--muted-foreground) 0 1.5px, transparent 1.5px 5px)", opacity: 0.45 };

/**
 * The field's sources in priority order, across every CRM, then how each destination column gets filled: a stacked
 * bar per destination of what each source adds after the ones above it. Reordering or switching a source off saves
 * and recomputes at once.
 */
export function SourcesView({ c, onPreview }: { c: Consolidation; onPreview: () => void }) {
  const setSourcesMutation = useMutation(api.fieldConsolidations.setSources);
  const rediscover = useMutation(api.fieldConsolidations.rediscover);
  const runPreview = useAction(api.fieldConsolidationActions.preview);
  const [sources, setSources] = useState<string[]>(c.sources ?? []);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const [busy, setBusy] = useState(false);
  const savedKey = (c.sources ?? []).join("|");
  useEffect(() => setSources(savedKey ? savedKey.split("|") : []), [savedKey]);

  const field = c.field!;
  const destinations = destinationColumns(c).filter((d) => d.mode !== "off").map((d) => d.column);
  const elsewhere = c.columns.filter((col) => !sourceFits(col, field));

  function save(next: string[]) {
    setSources(next);
    saving.current = setSourcesMutation({ id: c._id, sources: next }).catch((error) => {
      toast.error(getErrorMessage(error));
      setSources(c.sources ?? []);
    });
  }

  async function preview() {
    setBusy(true);
    await saving.current;
    onPreview();
    try {
      await runPreview({ id: c._id });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const stale = destinations.some((d) => !c.profiles.find((p) => p.object === d.object && p.profile && (p.profile as { signatures?: unknown }).signatures));
  // Values read before coverage was recorded are read again once, on opening this tab, rather than asking.
  const reread = useRef(false);
  useEffect(() => {
    if (!stale || c.stage !== "ready" || reread.current) return;
    reread.current = true;
    rediscover({ id: c._id, keywords: c.keywords }).catch((error) => toast.error(getErrorMessage(error)));
  }, [stale, c.stage, c._id, c.keywords, rediscover]);

  return (
    <div>
      <PolicyPanel c={c} />
      {stale && (
        <p className="mb-4 flex items-center gap-2 border border-border bg-card p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading the columns again to measure coverage. The bars appear when it finishes; nothing is written.
        </p>
      )}
      <SourceList c={c} sources={sources} onChange={save} />
      {destinations.map((d) => (
        <CoverageBlock key={d.key} c={c} destination={d} sources={sources} />
      ))}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-xs text-muted-foreground">
          {field.measure === "quantity"
            ? `For each record, the sources with an amount combine by "${COMBINE_LABEL[c.policy.combine ?? "first"].toLowerCase()}".`
            : "For each record, the first source with a mapped value decides."}{" "}
          Sources are only read; Canon writes only the destination columns.
        </p>
        <button type="button" onClick={() => void preview()} disabled={busy || c.run?.status === "applying" || c.run?.status === "undoing"} className={primary}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          Preview with this order
        </button>
      </div>
      {elsewhere.length > 0 && (
        <Panel title="Not usable here">
          <p className="text-xs text-muted-foreground">
            These columns sit on {field.level === "account" ? "people" : "companies"}, not on the records this field describes:{" "}
            {elsewhere.map((col) => `${col.label} (${COLUMN_OBJECTS[col.object].label})`).join(", ")}.
          </p>
        </Panel>
      )}
    </div>
  );
}

/** Every column that can feed the field, in any CRM: the used ones in priority order, then the rest, switched off. */
function SourceList({ c, sources, onChange }: { c: Consolidation; sources: string[]; onChange: (next: string[]) => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const field = c.field!;
  const written = new Set(c.destinations.map((d) => d.column));
  const byKey = new Map(c.columns.map((col) => [col.key, col]));
  const fill = (col: Column) => fillOf(c, col)?.filled ?? 0;
  const unused = c.columns.filter((col) => sourceFits(col, field) && !written.has(col.key) && !sources.includes(col.key)).sort((a, b) => fill(b) - fill(a));

  function move(key: string, to: number) {
    const from = sources.indexOf(key);
    if (from < 0 || to < 0 || to >= sources.length || from === to) return;
    const next = [...sources];
    next.splice(from, 1);
    next.splice(to, 0, key);
    onChange(next);
  }

  return (
    <Panel title="Sources, in priority order">
      <ul>
        {[...sources.map((k) => byKey.get(k)).filter((col): col is Column => Boolean(col)), ...unused].map((col) => {
          const used = sources.includes(col.key);
          const i = sources.indexOf(col.key);
          const f = fillOf(c, col);
          return (
            <li
              key={col.key}
              draggable={used}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragging(col.key);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging && used) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) move(dragging, i);
                setDragging(null);
              }}
              className={cn(
                "grid grid-cols-[1rem_1rem_minmax(10rem,1fr)_5rem_auto] items-center gap-2 border-b border-dashed border-border py-1.5 text-sm",
                !used && "opacity-55",
                dragging === col.key && "opacity-40",
              )}
            >
              <GripVertical className={cn("h-4 w-4 text-muted-foreground", used ? "cursor-grab" : "invisible")} aria-hidden="true" />
              <input
                type="checkbox"
                aria-label={`Use ${col.label} as a source`}
                checked={used}
                onChange={() => onChange(used ? sources.filter((k) => k !== col.key) : [...sources, col.key])}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 truncate">
                  {used && <i className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-[color:var(--c)]", paint)} style={sourceColor(i)} aria-hidden="true" />}
                  {used && <span className="text-xs tabular-nums text-muted-foreground">#{i + 1}</span>}
                  <span className="truncate">{col.label}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {col.enrichment ? "Enrichment" : COLUMN_OBJECTS[col.object].label} · {col.kind === "picklist" ? "picklist" : col.kind === "number" ? "number" : "free text"}
                </span>
              </span>
              <span className="text-right text-xs tabular-nums text-muted-foreground">{f ? `${pct(f.filled, f.read)}% filled` : "reading…"}</span>
              <span className="flex gap-1">
                <button type="button" aria-label={`Trust ${col.label} more`} onClick={() => move(col.key, i - 1)} disabled={!used || i === 0} className={small}>
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button type="button" aria-label={`Trust ${col.label} less`} onClick={() => move(col.key, i + 1)} disabled={!used || i === sources.length - 1} className={small}>
                  <ArrowDown className="h-3 w-3" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {sources.length === 0 && unused.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No other column holds {c.concept}.</p>}
      <p className="mt-3 text-xs text-muted-foreground">
        Sources can live in any CRM. A HubSpot record linked to Salesforce reads both; the first source, in this order, with a value decides. Drag a row or use
        the arrows to change the order.
      </p>
    </Panel>
  );
}

/** How one destination column gets filled: what is already set, what each source adds, and what stays blank. */
function CoverageBlock({ c, destination, sources }: { c: Consolidation; destination: Column; sources: string[] }) {
  const object = destination.object;
  const byKey = new Map(c.columns.map((col) => [col.key, col]));
  const coverage = coverageFor(c, destination, sources);
  const elsewhere = sources.some((k) => parseColumnKey(k).object !== object);
  return (
    <Panel title={`${destination.label} (${COLUMN_OBJECTS[object].label}): how it gets filled`}>
      {!coverage ? (
        <p className="text-sm text-muted-foreground">Coverage appears once the values are read.</p>
      ) : (
        <>
          <StackedBar
            coverage={coverage}
            standard={destination.label}
            labelOf={(k) => {
              const col = byKey.get(k);
              return col ? (col.object === object ? col.label : `${col.label} (${COLUMN_OBJECTS[col.object].label})`) : k;
            }}
            priority={(k) => sources.indexOf(k)}
            hubspot={COLUMN_OBJECTS[object].system === "hubspot"}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            {coverage.exactAt
              ? `Exact counts from the preview of ${new Date(coverage.exactAt).toLocaleString()}.`
              : `Estimate from the values read${elsewhere ? `, counting only sources on ${COLUMN_OBJECTS[object].label}; sources on linked records add more` : ""}${c.policy.mode === "overwrite" ? "; with overwrite, a source's share includes records it would leave unchanged" : ""}. Preview for exact counts.`}
          </p>
        </>
      )}
    </Panel>
  );
}

type Segment = { key: string; label: string; value: number; className?: string; style?: CSSProperties };

function StackedBar({ coverage, standard, labelOf, priority, hubspot }: { coverage: Coverage; standard: string; labelOf: (key: string) => string; priority: (key: string) => number; hubspot: boolean }) {
  const segments: Segment[] = [
    { key: "set", label: `${standard} (already set)`, value: coverage.alreadySet, className: "bg-primary text-primary-foreground" },
    ...coverage.bySource.map((s) => ({ key: s.key, label: labelOf(s.key), value: s.adds, className: cn("bg-[color:var(--c)] text-white", paint), style: sourceColor(priority(s.key)) })),
    ...(hubspot && coverage.owned > 0 ? [{ key: "owned", label: "Owned by Salesforce", value: coverage.owned, style: HATCH }] : []),
    { key: "blank", label: "Blank", value: coverage.blank, className: "bg-muted text-muted-foreground" },
  ];
  const share = (v: number) => (coverage.total ? (v / coverage.total) * 100 : 0);
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div>
      <div
        className="flex h-7 gap-[2px]"
        role="img"
        aria-label={visible.map((s) => `${s.label} ${Math.round(share(s.value))}%`).join(", ")}
      >
        {visible.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${num(Math.round(s.value))} of ${num(Math.round(coverage.total))} records`}
            className={cn("flex min-w-[2px] items-center justify-center overflow-hidden rounded-sm text-[10px] font-semibold", s.className)}
            style={{ ...s.style, flexGrow: s.value, flexBasis: 0 }}
          >
            {share(s.value) >= 6 && `${Math.round(share(s.value))}%`}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <i className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.className)} style={s.style} aria-hidden="true" />
            {s.label} <span className="tabular-nums">{num(Math.round(s.value))}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PolicyPanel({ c }: { c: Consolidation }) {
  const setPolicy = useMutation(api.fieldConsolidations.setPolicy);
  const field = c.field!;
  const policy = c.policy;
  const quantity = field.measure === "quantity";
  const tolerance = Math.round((policy.tolerance ?? DEFAULT_TOLERANCE) * 100);

  async function update(patch: Partial<Policy>) {
    try {
      await setPolicy({ id: c._id, policy: { ...policy, ...patch } });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  return (
    <Panel title="Fill policy">
      <div className="grid gap-5 text-sm lg:grid-cols-3">
        <fieldset>
          <legend className="mb-1 text-xs text-muted-foreground">Which records</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={policy.mode === "blanks"} onChange={() => void update({ mode: "blanks" })} />
            Fill blanks only
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={policy.mode === "overwrite"} onChange={() => void update({ mode: "overwrite" })} />
            Also change values the sources disagree with
          </label>
        </fieldset>
        <label className="grid content-start gap-1">
          <span className="text-xs text-muted-foreground">{quantity ? "Use amounts read with confidence of at least" : "Use mappings with confidence of at least"}</span>
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              aria-label="Confidence threshold"
              value={Math.round(policy.minConfidence * 100)}
              onChange={(event) => void update({ minConfidence: Number(event.target.value) / 100 })}
              className="w-40"
            />
            <span className="tabular-nums">{Math.round(policy.minConfidence * 100)}%</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {quantity
              ? "Plain numbers count as 100%, ranges (10M–50M, read as the midpoint) 90%, numbers in other words 80%, open bounds (5,000+) 60%."
              : "Exact matches and your own mappings count as 100%."}
          </span>
        </label>
        {quantity ? (
          <div className="grid content-start gap-3">
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Combine the sources by</span>
              <SelectField
                aria-label="Combine the sources by"
                value={policy.combine ?? "first"}
                onValueChange={(combine) => void update({ combine: combine as Combine })}
                className="w-64"
                options={(Object.keys(COMBINE_LABEL) as Combine[]).map((k) => ({ value: k, label: COMBINE_LABEL[k] }))}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">A current value agrees when it is within</span>
              <span className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={5}
                  aria-label="Agreement tolerance"
                  value={tolerance}
                  onChange={(event) => void update({ tolerance: Number(event.target.value) / 100 })}
                  className="w-40"
                />
                <span className="tabular-nums">{tolerance}%</span>
              </span>
              <span className="text-xs text-muted-foreground">of the combined amount. Closer values are left alone, even when changing values.</span>
            </label>
          </div>
        ) : (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Protected values, never changed</p>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {field.options.map((o) => {
              const on = policy.protectedValues.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => void update({ protectedValues: on ? policy.protectedValues.filter((v) => v !== o.value) : [...policy.protectedValues, o.value] })}
                  className={cn("border px-2 py-0.5 text-xs", on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        )}
      </div>
    </Panel>
  );
}

