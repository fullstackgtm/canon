"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import {
  COLUMN_OBJECTS, COMBINE_LABEL, DESTINATION_MODE_LABEL, compactAmount, destinationFits, picklistParity, quantile, quantityShare, sourceFits,
  type Column, type ColumnObject, type ColumnOption, type DestinationMode, type FieldDefinition,
} from "../../../convex/lib/consolidate";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { RunBar } from "./run-bar";
import { RunDetails } from "./run-details";
import {
  STAGE_LABEL, agreementsFor, day, defaultSources, destinationChoices, destinationColumns, fillOf, likelyCounterpart, mapCoverage, measureOfC, num, outcomeText, paint,
  pct, primary, profileOf, small, sourceColor, storedText, systemLabel, valueRows, attributeLabel, type Agreement, type Consolidation,
} from "./shared";

export type Tab = "lineage" | "sources" | "values";

/**
 * Where the concept comes from and where it goes: the source columns in priority order on the left, the Canon field
 * in the middle, the columns it writes on the right; then one line for the run, with its details in a drawer.
 */
export function LineageView({ c, onTab }: { c: Consolidation; onTab: (tab: Tab) => void }) {
  const reading = c.profiles.filter((p) => p.stage === "reading");
  // false: closed; null: open at the top; a column key: open at that destination's results.
  const [details, setDetails] = useState<string | null | false>(false);
  return (
    <div>
      <Keywords c={c} />
      {(c.stage === "discovering" || reading.length > 0) && (
        <p className="mb-3 inline-flex items-center gap-2 border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {c.stage === "discovering"
            ? "Finding columns in your connected CRMs…"
            : `${STAGE_LABEL.profiling}: ${reading.map((p) => `${COLUMN_OBJECTS[p.object as ColumnObject]?.label ?? p.object} ${num(p.read)} read`).join(", ")}`}
        </p>
      )}
      {c.systems?.some((s) => s.status === "error") && (
        <div className="mb-3 border border-warning/40 bg-warning/15 p-2 text-sm text-warning">
          {c.systems
            .filter((s) => s.status === "error")
            .map((s) => (
              <p key={s.system}>
                {s.system === "hubspot" ? "HubSpot" : "Salesforce"} columns couldn&apos;t be read: {s.detail}
              </p>
            ))}
        </div>
      )}
      {c.stage !== "discovering" && c.columns.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">No column&apos;s name or label matches these keywords. Add a keyword above and search again.</p>
      ) : (
        c.columns.length > 0 && <Diagram c={c} onTab={onTab} onDetails={(key) => setDetails(key)} />
      )}
      <RunBar c={c} onDetails={() => setDetails(null)} />
      <RunDetails c={c} open={details !== false} focus={details || null} onClose={() => setDetails(false)} />
    </div>
  );
}

function Keywords({ c }: { c: Consolidation }) {
  const rediscover = useMutation(api.fieldConsolidations.rediscover);
  const [keywords, setKeywords] = useState<string[]>(c.keywords);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const changed = keywords.join("|") !== c.keywords.join("|");

  async function search() {
    setBusy(true);
    try {
      await rediscover({ id: c._id, keywords });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs text-muted-foreground">Columns whose name or label contains</span>
      {keywords.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 border border-border bg-muted/50 px-2 py-0.5 text-xs">
          {k}
          <button type="button" aria-label={`Remove ${k}`} onClick={() => setKeywords(keywords.filter((x) => x !== k))} disabled={keywords.length === 1}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const k = draft.trim().toLowerCase();
          if (k && !keywords.includes(k)) setKeywords([...keywords, k]);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="add a keyword"
          aria-label="Add a keyword"
          className="h-7 w-32 border border-input bg-background px-2 text-xs outline-none focus:border-primary"
        />
      </form>
      <button type="button" onClick={() => void search()} disabled={busy || c.stage === "discovering" || (!changed && c.stage !== "error")} className={small}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        Search again
      </button>
    </div>
  );
}

type Wire = { key: string; d: string; priority: number | null; dashed?: boolean };

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

function Diagram({ c, onTab, onDetails }: { c: Consolidation; onTab: (tab: Tab) => void; onDetails: (key: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Wire[]>([]);
  const [expanded, setExpanded] = useState(false);
  // Sections the user opened or closed; the rest start closed when more than one record type holds the concept.
  const [toggled, setToggled] = useState<Partial<Record<ColumnObject, boolean>>>({});
  const field = c.field;
  const sources = c.sources ?? [];
  const destinationList = destinationColumns(c);
  const destinationKeys = new Set(c.destinations.map((d) => d.column));
  // Sources can be any column on the field's kind of record, in any CRM; before it is defined, every column.
  const fits = (col: Column) => !field || sourceFits(col, field);
  const left = c.columns.filter((col) => fits(col) && !destinationKeys.has(col.key));
  const elsewhere = c.columns.filter((col) => !fits(col));
  // Wired destinations: those the field writes, and dashed, those it shadows.
  const destinations = destinationList.filter((d) => d.mode !== "off");
  const filled = (col: Column) => fillOf(c, col)?.filled ?? 0;
  const byFill = (a: Column, b: Column) => Number(b.kind === "picklist") - Number(a.kind === "picklist") || filled(b) - filled(a);

  // The visible stack: used sources that hold values, in priority order (before the field is defined, every filled column).
  const shown = field
    ? sources.flatMap((key) => left.filter((col) => col.key === key && filled(col) > 0))
    : left.filter((col) => filled(col) > 0).sort(byFill);
  const more = [
    ...sources.flatMap((key) => left.filter((col) => col.key === key && !shown.includes(col))),
    ...left.filter((col) => !sources.includes(col.key) && !shown.includes(col)).sort(byFill),
  ];
  const stack = expanded ? [...shown, ...more] : shown;
  const objects = [...new Set(left.map((col) => col.object))];
  const isOpen = (object: ColumnObject) => toggled[object] ?? objects.length <= 1;
  const hiddenMore = more.filter((col) => isOpen(col.object)).length;

  const ref = (key: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(key, el);
    else nodes.current.delete(key);
  };

  const layoutKey = [
    stack.map((col) => col.key).join("|"),
    sources.join("|"),
    destinations.map((d) => `${d.column.key}:${d.mode}`).join("|"),
    objects.filter(isOpen).join("|"),
  ].join("/");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      const canon = nodes.current.get("canon")?.getBoundingClientRect();
      if (!canon) return setWires([]);
      const cy = canon.top - b.top + canon.height / 2;
      const out: Wire[] = [];
      sources.forEach((key, priority) => {
        const r = nodes.current.get(key)?.getBoundingClientRect();
        if (r) out.push({ key, priority, d: curve(r.right - b.left, r.top - b.top + r.height / 2, canon.left - b.left, cy) });
      });
      for (const { column, mode } of destinations) {
        const r = nodes.current.get(`dest:${column.key}`)?.getBoundingClientRect();
        if (r) out.push({ key: `dest:${column.key}`, priority: null, dashed: mode === "shadow", d: curve(canon.right - b.left, cy, r.left - b.left, r.top - b.top + r.height / 2) });
      }
      setWires(out);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
    // layoutKey stands for the sources and destinations measured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const rows = valueRows(c, c.valueMap);
  const coverage = mapCoverage(rows, c.policy.minConfidence);
  const quantity = measureOfC(c) === "quantity";

  return (
    <div ref={box} className="relative mb-3 grid items-center gap-x-16 gap-y-4 border border-border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,1fr)]">
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" aria-hidden="true">
        {wires.map((w) =>
          w.priority === null ? (
            <path key={w.key} d={w.d} fill="none" strokeWidth={2} stroke="var(--primary)" strokeDasharray={w.dashed ? "5 4" : undefined} />
          ) : (
            <path key={w.key} d={w.d} fill="none" strokeWidth={2} strokeOpacity={0.8} className={paint} style={sourceColor(w.priority)} stroke="var(--c)" />
          ),
        )}
      </svg>

      <div className="grid min-w-0 gap-1.5">
        <p className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>{!field ? "Columns that hold it" : quantity ? `Sources: ${COMBINE_LABEL[c.policy.combine ?? "first"].toLowerCase()}` : "Sources, first match wins"}</span>
          {field && (
            <button type="button" onClick={() => onTab("sources")} className="text-primary hover:underline">
              edit order
            </button>
          )}
        </p>
        {objects.map((object) => {
          const here = stack.filter((col) => col.object === object);
          const open = isOpen(object);
          // A closed section stands in for its sources, so their wires start at its header.
          const hidden = open ? [] : sources.filter((key) => left.some((col) => col.key === key && col.object === object));
          return (
            <div key={object} className="grid gap-1">
              <ObjectHeader
                c={c}
                object={object}
                open={open}
                columns={left.filter((col) => col.object === object).length}
                used={sources.filter((key) => left.some((col) => col.key === key && col.object === object)).length}
                nodeRef={(el) => hidden.forEach((key) => ref(key)(el))}
                onToggle={() => setToggled({ ...toggled, [object]: !open })}
              />
              {open &&
                here.map((col) => (
                  <SourceRow key={col.key} c={c} column={col} priority={sources.indexOf(col.key)} nodeRef={ref(col.key)} onTab={onTab} />
                ))}
            </div>
          );
        })}
        {hiddenMore > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex h-7 items-center gap-1.5 border border-dashed border-border px-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? `Hide ${hiddenMore} unused or empty` : `${hiddenMore} more column${hiddenMore === 1 ? "" : "s"}, unused or empty`}
          </button>
        )}
        {elsewhere.length > 0 && (
          <p
            className="truncate text-xs text-muted-foreground/80"
            title={elsewhere.map((col) => `${col.label} (${COLUMN_OBJECTS[col.object].label})`).join(", ")}
          >
            {elsewhere.length} on other records, not usable: {elsewhere.map((col) => `${col.label} (${COLUMN_OBJECTS[col.object].label})`).join(", ")}
          </p>
        )}
      </div>

      <div ref={ref("canon")} className="relative border-2 border-primary bg-primary/5 p-3 text-center">
        <p className="text-xs text-muted-foreground">Canon field</p>
        <p className="text-lg font-medium capitalize">{c.concept}</p>
        {field && quantity ? (
          <>
            <p className="text-xs text-muted-foreground">An amount</p>
            <SavedAs c={c} />
            <button type="button" onClick={() => onTab("values")} className="mt-1.5 text-xs text-primary hover:underline">
              Review sources and scales
            </button>
          </>
        ) : field ? (
          <>
            <p className="text-xs text-muted-foreground">
              {num(field.options.length)} options · {pct(coverage.mappedRecords, coverage.records)}% of source records mapped
            </p>
            <SavedAs c={c} />
            {coverage.unmapped > 0 ? (
              <button type="button" onClick={() => onTab("values")} className="mt-1.5 border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs text-warning hover:underline">
                {num(coverage.unmapped)} unmapped values
              </button>
            ) : (
              <button type="button" onClick={() => onTab("values")} className="mt-1.5 text-xs text-primary hover:underline">
                Review the value map
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Define what it holds: a list of options or an amount.</p>
        )}
      </div>

      <div className="grid min-w-0 gap-2">
        {field ? (
          <>
            {destinationList.length === 0 && (
              <p className="border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">No destinations yet: the field has a value in Canon but writes no CRM column.</p>
            )}
            {destinationList.map((d) => (
              <DestinationNode key={d.column.key} c={c} column={d.column} mode={d.mode} nodeRef={ref(`dest:${d.column.key}`)} onDetails={onDetails} />
            ))}
            <AddDestination c={c} field={field} />
          </>
        ) : (
          <DefineField c={c} />
        )}
      </div>
    </div>
  );
}

/** Where the field's values live in Canon, and what the latest preview saved there. */
function SavedAs({ c }: { c: Consolidation }) {
  const label = attributeLabel(c);
  const stored = c.run?.stored;
  return (
    <p className="text-xs text-muted-foreground" title={stored ? storedText(stored) : undefined}>
      {label ? `Saved in Canon as ${label}` : "Saved in Canon by each preview"}
      {stored && `: ${num(stored.written + stored.unchanged)} records`}
    </p>
  );
}

/** One record type's heading in the source stack; click to show or hide its columns. */
function ObjectHeader({
  c, object, open, columns, used, nodeRef, onToggle,
}: {
  c: Consolidation;
  object: ColumnObject;
  open: boolean;
  columns: number;
  used: number;
  nodeRef: (el: HTMLElement | null) => void;
  onToggle: () => void;
}) {
  const row = c.profiles.find((p) => p.object === object);
  const profile = profileOf(c, object);
  const meta = COLUMN_OBJECTS[object];
  const detail =
    row?.stage === "error"
      ? `couldn't read these records: ${row.error}`
      : profile
        ? [
            `${num(profile.read)} read${profile.total ? ` of ${num(profile.total)}` : ""}${profile.capped ? " (stopped at the read limit)" : ""}`,
            profile.linked > 0 && `${num(profile.linked)} linked to Salesforce`,
            !meta.writable && "read-only",
          ]
            .filter(Boolean)
            .join(" · ")
        : `reading… ${num(row?.read ?? 0)} so far`;
  return (
    <button
      ref={nodeRef}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn("flex min-w-0 items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground", !open && "h-[34px] border border-border bg-background px-2 hover:border-primary/60")}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={`${meta.label} · ${detail}`}>
        <span className="font-medium text-foreground">{meta.label}</span>
        <span className={cn(row?.stage === "error" && "text-destructive")}> · {detail}</span>
      </span>
      {!open && (
        <span className="shrink-0 tabular-nums">
          {num(columns)} column{columns === 1 ? "" : "s"}
          {used > 0 && ` · ${num(used)} used`}
        </span>
      )}
    </button>
  );
}

const agreeTone = (rate: number) =>
  rate < 0.5 ? "border-destructive/40 bg-destructive/10 text-destructive" : rate < 0.8 ? "border-warning/40 bg-warning/15 text-warning" : "border-border bg-muted text-foreground";

/** A source column in one row: priority, label, how full it is and how often it agrees with a destination. Click for the rest. */
function SourceRow({ c, column, priority, nodeRef, onTab }: { c: Consolidation; column: Column; priority: number; nodeRef: (el: HTMLElement | null) => void; onTab: (tab: Tab) => void }) {
  const fill = fillOf(c, column);
  const used = priority >= 0;
  const agreements = agreementsFor(c, column, c.valueMap);
  const standard = agreements.find((a) => c.destinations.some((d) => d.column === a.other.key && d.mode !== "off"));
  const share = fill ? pct(fill.filled, fill.read) : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          ref={nodeRef}
          type="button"
          className={cn(
            "relative flex h-[34px] w-full min-w-0 items-center gap-2 border border-border bg-background px-2 text-left text-xs hover:border-primary/60",
            !used && "opacity-55",
          )}
        >
          {used ? <i className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-[color:var(--c)]", paint)} style={sourceColor(priority)} aria-hidden="true" /> : <i className="h-2.5 w-2.5 shrink-0" />}
          <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{used ? `#${priority + 1}` : ""}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={column.label}>{column.label}</span>
          {column.enrichment && <span className="shrink-0 border border-border px-1 text-[10px] text-muted-foreground">enrichment</span>}
          <span className="flex shrink-0 items-center gap-1" title={share === null ? "Reading…" : `${share}% of records filled`}>
            <span className="block h-1.5 w-10 overflow-hidden rounded-full bg-muted">
              <span className="block h-full bg-foreground/50" style={{ width: `${share ?? 0}%` }} />
            </span>
            <span className="w-8 text-right tabular-nums text-muted-foreground">{share === null ? "…" : `${share}%`}</span>
          </span>
          {standard ? (
            <span className={cn("w-[4.5rem] shrink-0 whitespace-nowrap border px-1 text-center text-[10px] font-medium tabular-nums", agreeTone(standard.rate))} title={`Agrees with ${standard.other.label} on ${Math.round(standard.rate * 100)}% of ${num(standard.compared)} records compared`}>
              {Math.round(standard.rate * 100)}% agree
            </span>
          ) : (
            <span className="w-[4.5rem] shrink-0" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-80 p-3 text-xs">
        <ColumnDetails c={c} column={column} agreements={agreements}>
          {used ? (
            <p className="mt-2 border-t border-border pt-2">
              Source #{priority + 1}.{" "}
              <button type="button" onClick={() => onTab("sources")} className="text-primary hover:underline">
                Edit the order
              </button>
            </p>
          ) : (
            <p className="mt-2 border-t border-border pt-2 text-muted-foreground">
              Not used as a source.{" "}
              {c.target && (
                <button type="button" onClick={() => onTab("sources")} className="text-primary hover:underline">
                  Turn it on
                </button>
              )}
            </p>
          )}
        </ColumnDetails>
      </PopoverContent>
    </Popover>
  );
}

/** Everything about one column: its API name, type, fill, agreement with the others and its values. */
function ColumnDetails({ c, column, agreements, children }: { c: Consolidation; column: Column; agreements: Agreement[]; children?: ReactNode }) {
  const fill = fillOf(c, column);
  return (
    <div>
      <p className="text-sm font-medium">{column.label}</p>
      {column.enrichment ? (
        <p className="text-muted-foreground">
          Matched by free fill&apos;s coverage check, read-only. Run the check from this page or the Fields tab to refresh, then preview again.
        </p>
      ) : (
        <p className="font-mono text-muted-foreground">
          {column.name}
          {column.standard ? "" : " · custom"}
        </p>
      )}
      <p className="text-muted-foreground">
        {COLUMN_OBJECTS[column.object].label} · {column.kind === "picklist" ? `picklist, ${column.options.length} options` : column.kind === "number" ? "number" : "free text"}
        {column.readOnly && " · read-only"}
        {fill ? ` · ${pct(fill.filled, fill.read)}% filled · ${num(fill.distinct)} values` : " · reading…"}
      </p>
      {agreements.length > 0 && (
        <ul className="mt-2">
          {agreements.slice(0, 4).map((a) => (
            <li key={a.other.key}>
              <span className={cn("font-medium tabular-nums", a.rate < 0.5 ? "text-destructive" : a.rate < 0.8 ? "text-warning" : "text-foreground")}>{Math.round(a.rate * 100)}%</span> agree
              with {a.other.label} <span className="text-muted-foreground">({num(a.compared)} compared)</span>
            </li>
          ))}
        </ul>
      )}
      {(measureOfC(c) === "quantity" || column.kind === "number") && <ColumnAmounts c={c} column={column} />}
      {column.kind !== "number" && <ColumnValues c={c} column={column} />}
      {children}
    </div>
  );
}

/** A column's values read as amounts: how many read, and their spread. */
function ColumnAmounts({ c, column }: { c: Consolidation; column: Column }) {
  const stats = profileOf(c, column.object)?.columns[column.name];
  if (!stats) return null;
  const q = stats.quantity;
  if (!q) return <p className="mt-2 text-muted-foreground">No values read as amounts.</p>;
  const at = (x: number) => {
    const v = quantile(q, x);
    return v === null ? "–" : compactAmount(v);
  };
  return (
    <p className="mt-2">
      {pct(q.read, stats.filled)}% read as amounts ({pct(quantityShare(q, stats.filled, 1) * stats.filled, stats.filled)}% exact numbers) · median {at(0.5)} ·
      middle 80% {at(0.1)}–{at(0.9)}
    </p>
  );
}

function ColumnValues({ c, column }: { c: Consolidation; column: Column }) {
  const stats = profileOf(c, column.object)?.columns[column.name];
  if (!stats) return null;
  const labelOf = new Map(column.options.map((o) => [o.value, o.label]));
  return (
    <div className="mt-2 max-h-56 overflow-y-auto border-t border-border pt-1">
      {column.kind === "picklist" && stats.distinct > column.options.length && <p className="text-warning">Includes values not in the picklist.</p>}
      {stats.values.length === 0 && <p className="text-muted-foreground">No values on the records read.</p>}
      <ul>
        {stats.values.slice(0, 90).map(([value, n]) => (
          <li key={value} className="flex justify-between gap-2">
            <span className="truncate">
              {labelOf.get(value) ?? value}
              {labelOf.has(value) && labelOf.get(value) !== value && <span className="ml-1 font-mono text-muted-foreground">{value}</span>}
              {column.kind === "picklist" && !labelOf.has(value) && <span className="ml-1 text-warning">not an option</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {num(n)} · {pct(n, stats.filled)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the latest run did, or will do, to one destination column. */
function runNote(c: Consolidation, column: Column, mode: DestinationMode): string {
  const run = c.run;
  const section = run?.sections.find((s) => s.column.key === column.key);
  if (mode === "off") return "Off: not written";
  if (!run) return "Not previewed yet";
  const all = run.sections.length > 1 ? " across all destinations" : "";
  if (run.status === "previewing") return "Previewing…";
  if (section && (section.mode ?? "review") === "shadow") {
    return `Shadow, previewed ${day(run.createdAt)}: ${num(section.counts.fill)} would fill, ${num(section.counts.change)} would change${run.stale ? " (settings changed since)" : ""}`;
  }
  if (run.status === "applying") return "Applying…";
  if (run.status === "undoing") return "Undoing…";
  if (run.status === "undone" && run.undone) return `Undone ${run.undoneAt ? day(run.undoneAt) : ""}: ${outcomeText(run.undone, "put back")}${all}`;
  if (run.applied) return `Applied ${run.appliedAt ? day(run.appliedAt) : ""}: ${outcomeText(run.applied, "written")}${all}`;
  if (run.status === "failed") return `Stopped during the ${run.failedDuring ?? "run"}`;
  if (!section) return "Not previewed yet";
  return `Previewed ${day(run.createdAt)}: ${num(section.counts.fill)} to fill, ${num(section.counts.change)} to change${run.stale ? " (settings changed since)" : ""}`;
}

const MODE_HELP: Record<DestinationMode, string> = {
  review: "A run writes it once you apply.",
  shadow: "A run shows what it would write and writes nothing.",
  off: "Not written or compared.",
  auto: "Writes as soon as the value changes (comes with continuous updates).",
};
const MODE_CHOICES = (["review", "shadow", "off"] as const).map((m) => ({ value: m, label: DESTINATION_MODE_LABEL[m] }));

/** A column the field writes: where it lives, how full it is, its mode and the latest run's result for it. */
function DestinationNode({ c, column, mode, nodeRef, onDetails }: {
  c: Consolidation; column: Column; mode: DestinationMode; nodeRef: (el: HTMLElement | null) => void; onDetails: (key: string) => void;
}) {
  const setDestinations = useMutation(api.fieldConsolidations.setDestinations);
  const [busy, setBusy] = useState(false);
  const fill = fillOf(c, column);
  const section = c.run?.sections.find((s) => s.column.key === column.key);
  const outcome = runNote(c, column, mode);
  const locked = c.run?.status === "applying" || c.run?.status === "undoing";

  async function save(destinations: Consolidation["destinations"]) {
    setBusy(true);
    try {
      await setDestinations({ id: c._id, destinations });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={nodeRef} className={cn("relative border bg-background px-2.5 py-2 text-xs", mode === "off" ? "border-dashed border-border opacity-60" : "border-border")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground" title={MODE_HELP[mode]}>{systemLabel(column)} destination</span>
        <span className="flex items-center gap-1">
          <SelectField
            aria-label={`How ${column.label} is written`}
            value={mode}
            onValueChange={(next) => void save(c.destinations.map((d) => (d.column === column.key ? { ...d, mode: next as DestinationMode } : d)))}
            disabled={busy || locked}
            className="h-6 w-24 text-xs"
            options={MODE_CHOICES}
          />
          <button
            type="button"
            aria-label={`Remove ${column.label}`}
            title="Remove this destination"
            disabled={busy || locked}
            onClick={() => void save(c.destinations.filter((d) => d.column !== column.key))}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="block w-full min-w-0 truncate text-left text-sm hover:underline">
            <span className="font-medium">{column.label}</span> <span className="font-mono text-xs text-muted-foreground">{column.name}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" className="w-80 p-3 text-xs">
          <ColumnDetails c={c} column={column} agreements={agreementsFor(c, column, c.valueMap)} />
        </PopoverContent>
      </Popover>
      <p className="text-muted-foreground">
        {COLUMN_OBJECTS[column.object].label}
        {fill ? ` · ${pct(fill.filled, fill.read)}% filled now` : ""}
      </p>
      {section && c.run?.status !== "previewing" ? (
        <button type="button" onClick={() => onDetails(column.key)} className="mt-0.5 block w-full truncate text-left font-medium text-primary hover:underline" title={outcome}>
          {outcome}
        </button>
      ) : (
        <p className="mt-0.5 truncate font-medium" title={outcome}>{outcome}</p>
      )}
    </div>
  );
}

/** Add a column the field writes: any writable column of its kind on its records, in any connected CRM. */
function AddDestination({ c, field }: { c: Consolidation; field: FieldDefinition }) {
  const setDestinations = useMutation(api.fieldConsolidations.setDestinations);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<DestinationMode>("review");
  const [busy, setBusy] = useState(false);
  const choices = destinationChoices(c, field);
  const column = choices.find((col) => col.key === key);
  if (!choices.length) return null;

  async function save() {
    if (!column) return;
    setBusy(true);
    try {
      await setDestinations({ id: c._id, destinations: [...c.destinations, { column: column.key, mode }] });
      setOpen(false);
      setKey("");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex h-8 items-center gap-1.5 border border-dashed border-border px-2.5 text-left text-xs text-muted-foreground hover:bg-muted/50">
        <Plus className="h-3.5 w-3.5" /> Add a destination
      </button>
    );
  }
  return (
    <div className="border border-dashed border-primary/60 px-2.5 py-2 text-xs">
      <p className="mb-2 text-muted-foreground">
        A {field.measure === "quantity" ? "number" : "picklist"} column on {field.level === "account" ? "companies" : "people"} in any connected CRM. HubSpot
        records linked to Salesforce are fixed in Salesforce, and your CRMs&apos; sync carries the value over.
      </p>
      <SelectField
        aria-label="Destination column"
        value={key}
        onValueChange={setKey}
        className="w-full"
        options={[{ value: "", label: "Choose a column" }, ...choices.map((col) => ({ value: col.key, label: `${col.label} (${COLUMN_OBJECTS[col.object].label})` }))]}
      />
      <div className="mt-2 flex items-center gap-2">
        <SelectField aria-label="How it is written" value={mode} onValueChange={(next) => setMode(next as DestinationMode)} className="h-7 w-28 text-xs" options={MODE_CHOICES.filter((m) => m.value !== "off")} />
        <span className="text-muted-foreground">{MODE_HELP[mode]}</span>
      </div>
      {column && field.measure === "category" && <Parity options={field.options} name={c.concept} column={column} />}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !column} className={cn(primary, "px-3 py-1.5")}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)} className={small}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Define the field from a column: a picklist gives it that column's options, a number makes it an amount. Any such
 * column works, in either CRM. The column, if Canon can write it, and its likely counterpart in the other CRM become
 * destinations; the other filled columns on the same kind of record become sources.
 */
function DefineField({ c }: { c: Consolidation }) {
  const define = useMutation(api.fieldConsolidations.define);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const filled = (col: Column) => fillOf(c, col)?.filled ?? 0;
  const choices = c.columns.filter((col) => (col.kind === "picklist" || col.kind === "number") && !col.enrichment).sort((a, b) => filled(b) - filled(a));

  async function save() {
    const from = c.columns.find((col) => col.key === key);
    if (!from) return;
    const field: FieldDefinition = { measure: from.kind === "number" ? "quantity" : "category", level: COLUMN_OBJECTS[from.object].level, options: from.kind === "picklist" ? from.options : [] };
    const counterpart = likelyCounterpart(c.columns, from);
    const destinations = [from, counterpart].filter((col): col is Column => Boolean(col) && destinationFits(col!, field)).map((col) => ({ column: col.key, mode: "review" as const }));
    setBusy(true);
    try {
      await define({ id: c._id, from: from.key, destinations, sources: defaultSources(c, field, destinations.map((d) => d.column)) });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (choices.length === 0) {
    return <p className="text-sm text-warning">None of these columns is a picklist or a number, so there are no options or amounts to start from. Add a keyword and search again.</p>;
  }
  return (
    <div className="border border-dashed border-primary/60 p-3 text-sm">
      <p className="font-medium">Define the field</p>
      <p className="mb-2 text-xs text-muted-foreground">
        Start from a column in either CRM: a picklist gives the field its options, a number makes it an amount. The field lives in Canon; you choose which CRM
        columns it writes next.
      </p>
      <fieldset className="grid max-h-64 gap-1 overflow-y-auto">
        <legend className="sr-only">Start from</legend>
        {choices.map((col) => {
          const fill = fillOf(c, col);
          return (
            <label key={col.key} className={cn("flex cursor-pointer items-center gap-2 border px-2 py-1 text-xs", key === col.key ? "border-primary bg-primary/5" : "border-border")}>
              <input type="radio" name="from" checked={key === col.key} onChange={() => setKey(col.key)} />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium">{col.label}</span> <span className="font-mono text-muted-foreground">{col.name}</span>
                <span className="block text-muted-foreground">
                  {COLUMN_OBJECTS[col.object].label} · {col.kind === "number" ? "number" : `${col.options.length} options`}
                  {fill ? ` · ${pct(fill.filled, fill.read)}% filled` : ""}
                  {(col.readOnly || !COLUMN_OBJECTS[col.object].writable) && " · read-only"}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="mt-2 text-xs text-muted-foreground">
        It and its likely counterpart in the other CRM become destinations, written once you review a run; the other filled columns become sources.
      </p>
      <button type="button" onClick={() => void save()} disabled={busy || !key} className={cn(primary, "mt-2 px-3 py-1.5")}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Define the field
      </button>
    </div>
  );
}

/**
 * The field's options against a destination column's. A label that matches under a different internal value is the
 * quiet failure: score rules and HubSpot writes use the internal value.
 */
function Parity({ options, name, column: mirror }: { options: readonly ColumnOption[]; name: string; column: Column }) {
  const { rows, mirrorOnly } = picklistParity(options, mirror.options);
  const differs = rows.filter((r) => r.status === "valueDiffers");
  const missing = rows.filter((r) => r.status === "missing");
  return (
    <div className="mt-3">
      <p>
        {rows.length - differs.length - missing.length} of {rows.length} options match exactly.
        {differs.length > 0 && <span className="text-warning"> {differs.length} match by label but use a different internal value.</span>}
        {missing.length > 0 && <span className="text-destructive"> {missing.length} are missing from {mirror.label}; records needing them are skipped there.</span>}
        {mirrorOnly.length > 0 && <span className="text-muted-foreground"> {mirrorOnly.length} exist only in {mirror.label}.</span>}
      </p>
      {(differs.length > 0 || missing.length > 0 || mirrorOnly.length > 0) && (
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{name}: label / internal value</th>
                <th className="py-1 pr-3 font-medium">{mirror.label}: label / internal value</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...differs, ...missing].map((r) => (
                <tr key={r.target.value} className="border-b border-border/60">
                  <td className="py-1 pr-3">
                    {r.target.label} <span className="font-mono text-muted-foreground">{r.target.value}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {r.mirror ? (
                      <>
                        {r.mirror.label} <span className="font-mono text-muted-foreground">{r.mirror.value}</span>
                      </>
                    ) : (
                      "none"
                    )}
                  </td>
                  <td className={cn("py-1", r.status === "missing" ? "text-destructive" : "text-warning")}>
                    {r.status === "missing" ? "Missing" : "Internal value differs: writes use this column's value"}
                  </td>
                </tr>
              ))}
              {mirrorOnly.map((m) => (
                <tr key={`only-${m.value}`} className="border-b border-border/60 text-muted-foreground">
                  <td className="py-1 pr-3">none</td>
                  <td className="py-1 pr-3">
                    {m.label} <span className="font-mono">{m.value}</span>
                  </td>
                  <td className="py-1">Only in {mirror.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
