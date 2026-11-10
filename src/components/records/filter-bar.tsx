"use client";

import type { ViewFilter } from "../../../convex/lib/objects/validators";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { OPS_OF, type FilterOp, type ListColumn } from "../../../convex/lib/objects/listSpec";
import { DAY_OPS } from "../../../convex/lib/objects/views";
import type { FieldDescription, TeamMember } from "./fields";
import { SelectField } from "@/components/ui/select";

const OP_LABEL: Record<FilterOp, string> = {
  eq: "is", neq: "is not", in: "is any of", contains: "contains", startsWith: "starts with",
  gt: "is after / above", gte: "is on or after / at least", lt: "is before / below", lte: "is on or before / at most",
  hasAny: "has any of", hasAll: "has all of", empty: "is empty", notEmpty: "is not empty",
};

const LIST_OPS: readonly FilterOp[] = ["in", "hasAny", "hasAll"];
const CHOICE_OPS: readonly FilterOp[] = ["eq", "neq", "in", "empty", "notEmpty"];
const NO_VALUE: readonly FilterOp[] = ["empty", "notEmpty"];

const DAY_LABEL: Partial<Record<FilterOp, string>> = { eq: "is on", gt: "is after", gte: "is on or after", lt: "is before", lte: "is on or before" };


/** A filter the list can run: ops that take a value have one. Incomplete rows stay on screen but are not sent. */
export function isComplete(f: ViewFilter): boolean {
  if (NO_VALUE.includes(f.op)) return f.value === undefined;
  if (LIST_OPS.includes(f.op)) return Array.isArray(f.value) && f.value.length > 0;
  return f.value !== undefined && f.value !== "" && !(typeof f.value === "number" && !Number.isFinite(f.value));
}

const control = "border border-border bg-background px-2 py-1 text-xs";

function ValueInput({ filter, column, field, team, day, onChange }: {
  filter: ViewFilter;
  /** A timestamp column picked by calendar day: the value is `YYYY-MM-DD`. */
  day: boolean;
  column: ListColumn;
  field: FieldDescription | undefined;
  team?: readonly TeamMember[];
  onChange: (value: ViewFilter["value"]) => void;
}) {
  if (NO_VALUE.includes(filter.op)) return null;
  const label = `${column.field} value`;
  // An owner's choices are the team.
  const options = field && "options" in field ? field.options : field?.type === "user" ? (team ?? []).map((u) => ({ value: u._id, label: u.name })) : null;
  if (LIST_OPS.includes(filter.op)) {
    const chosen = new Set(Array.isArray(filter.value) ? filter.value.map(String) : []);
    if (options) {
      return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-1">
          {options.map((o) => (
            <label key={o.value} className={`border border-border px-2 py-0.5 text-xs ${chosen.has(o.value) ? "bg-primary text-primary-foreground" : ""}`}>
              <input
                type="checkbox"
                className="sr-only"
                checked={chosen.has(o.value)}
                onChange={() => {
                  const next = new Set(chosen);
                  if (next.has(o.value)) next.delete(o.value);
                  else next.add(o.value);
                  onChange([...next]);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    return (
      <input
        aria-label={label}
        className={control}
        placeholder="comma separated"
        defaultValue={[...chosen].map((v) => (field?.type === "currency" ? String(Number(v) / 100) : v)).join(", ")}
        onBlur={(e) => {
          const parts = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
          const scale = field?.type === "currency" ? 100 : 1;
          const toValue = (p: string) => (scale === 100 ? Math.round(Number(p.replace(/[$,]/g, "")) * 100) : Number(p));
          onChange(column.kind === "number" ? parts.map(toValue).filter(Number.isFinite) : parts);
        }}
      />
    );
  }
  if (options) {
    return (
      <SelectField aria-label={label} value={typeof filter.value === "string" ? filter.value : ""} onValueChange={(v) => onChange(v || undefined)}
        options={[{ value: "", label: "Choose…" }, ...options.map((o) => ({ value: o.value, label: o.label }))]} />
    );
  }
  if (day) {
    return <input aria-label={label} type="date" className={control} value={typeof filter.value === "string" ? filter.value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
  switch (column.kind) {
    case "checkbox":
      return (
        <SelectField aria-label={label} value={filter.value === true ? "true" : filter.value === false ? "false" : ""} onValueChange={(v) => onChange(v === "" ? undefined : v === "true")}
          options={[{ value: "", label: "Choose…" }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
      );
    case "date":
      return <input aria-label={label} type="date" className={control} value={typeof filter.value === "string" ? filter.value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "number": {
      // Currency is stored in cents; people type dollars.
      const scale = field?.type === "currency" ? 100 : 1;
      return (
        <input
          aria-label={label}
          inputMode="decimal"
          className={control}
          placeholder={scale === 100 ? "$" : undefined}
          defaultValue={typeof filter.value === "number" ? String(filter.value / scale) : ""}
          onBlur={(e) => {
            const raw = e.target.value.trim().replace(/[$,]/g, "");
            // Only money rounds (to whole cents); other numbers keep their decimals.
            onChange(raw === "" ? undefined : scale === 100 ? Math.round(Number(raw) * 100) : Number(raw));
          }}
        />
      );
    }
    default:
      return (
        <input
          aria-label={label}
          className={control}
          defaultValue={typeof filter.value === "string" ? filter.value : ""}
          onBlur={(e) => onChange(e.target.value.trim() || undefined)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      );
  }
}

/** The filter rows of a list view. Every change hands back the whole list. */
export function FilterBar({ filters, columns, dayColumns, fields, team, canAdd, resetKey, onChange }: {
  filters: ViewFilter[];
  /** Changes when the filters are replaced from outside (a saved view opened). */
  resetKey: number;
  /** False once the list request is at its filter limit. */
  canAdd: boolean;
  /** Timestamp columns filtered by calendar day (lib/objects/views.ts dayColumnsOf). */
  dayColumns: ReadonlySet<string>;
  columns: ReadonlyMap<string, ListColumn>;
  fields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  onChange: (next: ViewFilter[]) => void;
}) {
  const labelOf = (name: string) => (name === "recordTitle" ? "Name" : name === "id" ? "Id" : fields.find((f) => f.apiName === name)?.label ?? name);
  const choices = [...columns.values()].filter((c) => c.field !== "id");
  const [removals, setRemovals] = useState(0);
  const opsFor = (name: string, kind: ListColumn["kind"]): readonly FilterOp[] => {
    if (dayColumns.has(name)) return DAY_OPS;
    // A picklist or owner holds a code (in_progress, a user id): pick whole values, never match substrings of them.
    const type = fields.find((f) => f.apiName === name)?.type;
    if (type === "picklist" || type === "user") return CHOICE_OPS;
    return OPS_OF[kind];
  };
  const set = (i: number, next: ViewFilter) => onChange(filters.map((f, j) => (j === i ? next : f)));
  return (
    <div className="flex flex-col gap-2">
      {filters.map((filter, i) => {
        const column = columns.get(filter.field);
        if (!column) return null;
        const field = fields.find((f) => f.apiName === filter.field);
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <SelectField
              aria-label="Filter field"
              value={filter.field}
              onValueChange={(v) => {
                const col = columns.get(v)!;
                set(i, { field: col.field, op: opsFor(col.field, col.kind)[0] });
              }}
              options={choices.map((c) => ({ value: c.field, label: labelOf(c.field) }))}
            />
            <SelectField
              aria-label="Filter operator"
              value={filter.op}
              onValueChange={(v) => {
                const op = v as FilterOp;
                const keep = !NO_VALUE.includes(op) && LIST_OPS.includes(op) === LIST_OPS.includes(filter.op);
                set(i, { field: filter.field, op, ...(keep && filter.value !== undefined ? { value: filter.value } : {}) });
              }}
              options={opsFor(column.field, column.kind).map((op) => ({ value: op, label: (dayColumns.has(column.field) && DAY_LABEL[op]) || OP_LABEL[op] }))}
            />
            <ValueInput
              // Typed drafts are uncontrolled: remount them when a saved view replaces the filters, never while the user edits.
              key={`${filter.field}:${filter.op}:${resetKey}:${removals}`}
              filter={filter}
              column={column}
              field={field}
              day={dayColumns.has(column.field)}
              team={team}
              onChange={(value) => {
                const { value: _old, ...rest } = filter;
                void _old;
                set(i, value === undefined ? rest : { ...rest, value });
              }}
            />
            <button
              type="button"
              aria-label="Remove filter"
              onClick={() => {
                // Rows are keyed by position: remount the drafts so a later row never inherits a removed row's text.
                setRemovals((n) => n + 1);
                onChange(filters.filter((_, j) => j !== i));
              }} className="p-1 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={!canAdd}
        title={canAdd ? undefined : "This view has as many filters as a list can take"}
        onClick={() => {
          const first = choices.find((c) => c.field === "recordTitle") ?? choices[0];
          if (first) onChange([...filters, { field: first.field, op: first.kind === "text" ? "contains" : opsFor(first.field, first.kind)[0] }]);
        }}
        className="inline-flex w-fit items-center gap-1 border border-dashed border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3 w-3" /> Add filter
      </button>
    </div>
  );
}
