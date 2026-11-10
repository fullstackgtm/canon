"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  METRICS,
  METRIC_LABEL,
  FIRMOGRAPHIC,
  MAX_FILTER_VALUES,
  dimensionLabel,
  placeValue,
  removeValue,
  setFilter,
  setGroup,
  valueLabel,
  type Dimension,
  type Pivot,
  type SegmentMeta,
} from "@/lib/tam-levels";
import { cn } from "@/lib/utils";

type LabelCtx = { segments: SegmentMeta[]; starterSegments: Array<{ id: string; name: string }> };
export type FilterOption = { key: string; count: number };
/** A filter's values, largest first. `truncated`: more values exist than were returned. */
export type FilterOptions = { options: FilterOption[]; truncated: boolean };

/** The treemap's controls: Group by, Filter and Values, as chip dropdowns. */
export function ViewControls({
  pivot,
  levels,
  current,
  onPivot,
  segments,
  starterSegments,
  jtbdAvailable,
  loadOptions,
  onNewSegment,
  onSuggest,
  onChallenge,
}: {
  pivot: Pivot;
  /** Every level, in drill order. */
  levels: Dimension[];
  /** The level the treemap shows. */
  current: Dimension | null;
  onPivot: (pivot: Pivot) => void;
  segments: SegmentMeta[];
  starterSegments: Array<{ id: string; name: string }>;
  jtbdAvailable: boolean;
  /** Values for a filter, counted under the other filters. */
  loadOptions: (dim: Dimension) => Promise<FilterOptions>;
  onNewSegment: () => void;
  onSuggest: () => void;
  onChallenge: () => void;
}) {
  const [openFilter, setOpenFilter] = useState<Dimension | null>(null);
  const ctx: LabelCtx = { segments, starterSegments };
  const label = (d: Dimension) => dimensionLabel(d, segments);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <GroupByChip
        pivot={pivot}
        onPivot={onPivot}
        levels={levels}
        current={current}
        jtbdAvailable={jtbdAvailable}
        label={label}
        onNewSegment={onNewSegment}
        onSuggest={onSuggest}
        onChallenge={onChallenge}
      />
      <ValuesChip pivot={pivot} onPivot={onPivot} />
      {pivot.filters.map((f) => (
        <FilterChip
          key={f.dim}
          dim={f.dim}
          values={f.values}
          label={label(f.dim)}
          ctx={ctx}
          open={openFilter === f.dim}
          onOpenChange={(open) => setOpenFilter(open ? f.dim : null)}
          loadOptions={loadOptions}
          onChange={(values) => onPivot(setFilter(pivot, f.dim, values))}
          onRemove={() => onPivot(setFilter(pivot, f.dim, null))}
        />
      ))}
      <AddFilterChip
        fields={levels.filter((d) => !pivot.filters.some((f) => f.dim === d))}
        label={label}
        onPick={(d) => {
          onPivot(setFilter(pivot, d, []));
          setOpenFilter(d);
        }}
      />
    </div>
  );
}

const chip = "inline-flex h-8 items-center gap-2 border px-2.5 text-xs transition-colors data-[state=open]:border-primary";
const chipIdle = "border-border bg-card hover:border-primary/60";

function ChipLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{children}</div>;
}

function GroupByChip({
  pivot,
  onPivot,
  levels,
  current,
  jtbdAvailable,
  label,
  onNewSegment,
  onSuggest,
  onChallenge,
}: {
  pivot: Pivot;
  onPivot: (pivot: Pivot) => void;
  levels: Dimension[];
  current: Dimension | null;
  jtbdAvailable: boolean;
  label: (d: Dimension) => string;
  onNewSegment: () => void;
  onSuggest: () => void;
  onChallenge: () => void;
}) {
  const [open, setOpen] = useState(false);
  const start = Math.max(0, levels.indexOf(pivot.group));
  const item = (dim: Dimension) => {
    const i = levels.indexOf(dim);
    const before = i < start;
    return (
      <button
        key={dim}
        type="button"
        onClick={() => (setOpen(false), onPivot(setGroup(pivot, dim)))}
        className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted", before && "text-muted-foreground")}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center border font-mono text-[10px]",
            i === start ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
          )}
        >
          {i + 1}
        </span>
        <span className="flex-1 truncate">{label(dim)}</span>
        {dim === current && <span className="shrink-0 text-xs font-medium text-primary">showing</span>}
      </button>
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, chipIdle)}>
          <ChipLabel>Group by</ChipLabel>
          <span className="max-w-64 truncate text-foreground">{label(levels[start] ?? pivot.group)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <p className="border-b border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          Pick where to start. Clicking a tile drills to the next level down this list.
        </p>
        <MenuHeading>Firmographics</MenuHeading>
        <div className="pb-1">{levels.filter((d) => FIRMOGRAPHIC.includes(d)).map(item)}</div>
        <MenuHeading>AI segments · Jev</MenuHeading>
        <div className="pb-1">
          {levels.filter((d) => !FIRMOGRAPHIC.includes(d) && !d.startsWith("field:")).map(item)}
          {!jtbdAvailable && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground/60" title="Needs your company's homepage research">
              <span className="size-4 shrink-0 border border-dashed border-border" />
              <span className="flex-1">Jobs to be done</span>
              <span className="text-[11px]">needs research</span>
            </div>
          )}
        </div>
        {levels.some((d) => d.startsWith("field:")) && (
          <>
            <MenuHeading>AI fields</MenuHeading>
            <div className="pb-1">{levels.filter((d) => d.startsWith("field:")).map(item)}</div>
          </>
        )}
        <div className="border-t border-border p-1">
          <IntegrationGate feature="jev"><MenuAction onClick={() => (setOpen(false), onNewSegment())}>New AI segment…</MenuAction></IntegrationGate>
          <IntegrationGate feature="chatgpt"><MenuAction onClick={() => (setOpen(false), onSuggest())}>Recommend segments…</MenuAction></IntegrationGate>
          <IntegrationGate feature="chatgpt"><MenuAction onClick={() => (setOpen(false), onChallenge())}>Challenge my ICP…</MenuAction></IntegrationGate>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MenuAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-primary hover:bg-muted">
      <Sparkles className="size-3.5" /> {children}
    </button>
  );
}

function ValuesChip({ pivot, onPivot }: { pivot: Pivot; onPivot: (pivot: Pivot) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, chipIdle)}>
          <ChipLabel>Values</ChipLabel>
          <span className="text-foreground">{pivot.values.map((m) => METRIC_LABEL[m]).join(" + ")}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="p-1">
          {METRICS.map((m) => {
            const at = pivot.values.indexOf(m);
            return (
              <div key={m} className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted">
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={at !== -1}
                    disabled={at !== -1 && pivot.values.length === 1}
                    onCheckedChange={() => onPivot(at === -1 ? placeValue(pivot, m) : removeValue(pivot, m))}
                  />
                  {METRIC_LABEL[m]}
                </label>
                {at === 0 ? (
                  <span className="text-xs font-medium text-primary">tile size</span>
                ) : at > 0 ? (
                  <button type="button" onClick={() => onPivot(placeValue(pivot, m, 0))} className="text-[11px] text-muted-foreground hover:text-foreground">
                    Size by this
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          The first value sizes the tiles; the others show on each tile.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({
  dim,
  values,
  label,
  ctx,
  open,
  onOpenChange,
  loadOptions,
  onChange,
  onRemove,
}: {
  dim: Dimension;
  values: string[];
  label: string;
  ctx: LabelCtx;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadOptions: (dim: Dimension) => Promise<FilterOptions>;
  onChange: (values: string[]) => void;
  onRemove: () => void;
}) {
  const [loaded, setLoaded] = useState<FilterOptions | null>(null);
  const options = loaded?.options ?? null;
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    loadOptions(dim)
      .then((o) => live && setLoaded(o))
      .catch(() => live && setLoaded({ options: [], truncated: false }));
    return () => {
      live = false;
    };
  }, [open, dim, loadOptions]);

  const summary = values.length === 0 ? "Any" : values.length === 1 ? valueLabel(dim, values[0], ctx) : `${values.length} selected`;
  const full = values.length >= MAX_FILTER_VALUES;
  const toggle = (key: string) => {
    if (values.includes(key)) onChange(values.filter((v) => v !== key));
    else if (!full) onChange([...values, key]);
  };
  const shown = (options ?? []).filter((o) => !query || valueLabel(dim, o.key, ctx).toLowerCase().includes(query.toLowerCase()));
  // Keep picked values visible even when they no longer match the other filters.
  const missing = values.filter((v) => options && !options.some((o) => o.key === v));

  return (
    <div className={cn("inline-flex h-8 items-center border text-xs", values.length ? "border-primary/50 bg-primary/10" : "border-border bg-card")}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setLoaded(null);
          onOpenChange(next);
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className="flex h-full items-center gap-2 pl-2.5 pr-1.5">
            <ChipLabel>{label}</ChipLabel>
            <span className={cn("max-w-48 truncate", values.length ? "text-foreground" : "text-muted-foreground")}>{summary}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <div className="border-b border-border p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              className="w-full border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {options === null ? (
              <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
            ) : (
              <>
                {[...missing.map((key) => ({ key, count: 0 })), ...shown].map((o) => (
                  <label key={o.key} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted">
                    <Checkbox checked={values.includes(o.key)} disabled={full && !values.includes(o.key)} onCheckedChange={() => toggle(o.key)} />
                    <span className="flex-1 truncate">{valueLabel(dim, o.key, ctx)}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">{o.count.toLocaleString()}</span>
                  </label>
                ))}
                {shown.length === 0 && missing.length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    {loaded?.truncated && query ? "No match among the largest values. Narrow the other filters to see more." : "No values."}
                  </p>
                )}
              </>
            )}
          </div>
          {(full || loaded?.truncated) && (
            <p className="border-t border-border px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
              {full ? `Up to ${MAX_FILTER_VALUES} values per filter.` : `Showing the ${options?.length.toLocaleString()} largest values.`}
            </p>
          )}
          <div className="flex justify-between border-t border-border px-3 py-1.5 text-[11px]">
            <button type="button" onClick={() => onChange([])} className="text-muted-foreground hover:text-foreground">Clear selection</button>
            <button type="button" onClick={() => onOpenChange(false)} className="flex items-center gap-1 text-primary">
              <Check className="size-3" /> Done
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <button type="button" aria-label={`Remove ${label} filter`} onClick={onRemove} className="flex h-full items-center pl-0.5 pr-2 text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </div>
  );
}

function AddFilterChip({ fields, label, onPick }: { fields: Dimension[]; label: (d: Dimension) => string; onPick: (d: Dimension) => void }) {
  const [open, setOpen] = useState(false);
  if (!fields.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chip, "border-dashed border-border text-muted-foreground hover:border-primary/60 hover:text-foreground")}>
          <Plus className="size-3" />
          <span className="text-xs font-medium">Filter</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {fields.map((d) => (
          <button key={d} type="button" onClick={() => (setOpen(false), onPick(d))} className="flex w-full px-2 py-1.5 text-left text-sm hover:bg-muted">
            {label(d)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
