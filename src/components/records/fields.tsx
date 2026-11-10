"use client";

import { useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { useRecordDraft } from "./record-context";
import { cn } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import type { FieldValue } from "../../../convex/lib/objects/registry";
import type { Stored } from "../../../convex/lib/objects/validators";
import { MAX_SPLITS, parseSplits, type SplitAllocation } from "../../../modules/kernel/splits";
import { contactHref } from "@/lib/contact-href";
import { LookupInput } from "./lookup-field";

export type ObjectDescription = NonNullable<FunctionReturnType<typeof api.objects.describe>>;
export type FieldDescription = ObjectDescription["fields"][number];
export type CellValue = Stored<FieldValue>;
export type TeamMember = { _id: string; name: string; isActive?: boolean };

/** Text fields that hold prose. A value that already has line breaks is edited as prose too, so saving never flattens it. */
const PROSE_FIELDS = new Set(["description", "body", "notes", "bodyText"]);
const isMultiline = (field: FieldDescription, value: CellValue | undefined) =>
  field.type === "text" && (PROSE_FIELDS.has(field.apiName) || (typeof value === "string" && value.includes("\n")));

/** Fields a person can type into: not timestamps, not formulas. */
export const isEditable = (field: FieldDescription) => !field.system && field.type !== "formula";

const optionsOf = (field: FieldDescription) => ("options" in field ? field.options : []);
const stringsOf = (value: CellValue | undefined) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" && value ? [value] : [];
const splitsOf = (value: CellValue | undefined): SplitAllocation[] => Array.isArray(value) ? value.filter((v): v is SplitAllocation => typeof v !== "string") : [];

/** Chip classes per picklist colour (convex/lib/objects/registry.ts PICKLIST_COLORS). */
export const OPTION_CHIP: Readonly<Record<string, string>> = {
  gray: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200",
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200",
};

/** A picklist value as coloured chips, when its options have colours; null for any other field or uncoloured options. */
export function optionChips(field: FieldDescription, value: CellValue | undefined): React.ReactNode | null {
  if (field.type !== "picklist" && field.type !== "multipicklist") return null;
  const values = stringsOf(value);
  const opts = values.map((v) => optionsOf(field).find((o) => o.value === v) ?? { value: v, label: v, color: undefined });
  if (!opts.length || !opts.some((o) => o.color)) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {opts.map((o) => <span key={o.value} className={cn("px-1.5 py-0.5 text-xs", OPTION_CHIP[o.color ?? "gray"])}>{o.label}</span>)}
    </span>
  );
}

/** An email, phone or web address field's values as links (mailto, tel, a new tab); a value unsafe to open stays text. Null for other fields. */
export function contactLinks(field: FieldDescription, value: CellValue | undefined): React.ReactNode | null {
  if (field.type !== "emails" && field.type !== "phones" && field.type !== "links") return null;
  const values = stringsOf(value);
  if (!values.length) return null;
  const kind = field.type;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      {values.map((v, i) => {
        const href = contactHref(kind, v);
        const text = <>{v}{i < values.length - 1 ? "," : ""}</>;
        if (!href) return <span key={v}>{text}</span>;
        return kind === "links"
          ? <a key={v} href={href} target="_blank" rel="noopener noreferrer" className="truncate text-primary underline">{text}</a>
          : <a key={v} href={href} className="truncate text-primary underline">{text}</a>;
      })}
    </span>
  );
}

const MULTI_PLACEHOLDER: Record<string, string> = { emails: "name@company.com", phones: "+1 555 0100", links: "https://…" };

/** Several emails, phones or links; the first is the primary. */
function MultiValueInput({ field, value, disabled, autoFocus, onChange, onCommit, onCancel }: {
  field: FieldDescription; value: CellValue | undefined; disabled?: boolean; autoFocus?: boolean;
  onChange: (next: CellValue) => void; onCommit?: () => void; onCancel?: () => void;
}) {
  const items = stringsOf(value);
  const rows = items.length ? items : [""];
  const set = (next: string[]) => onChange(next.some((s) => s.trim()) ? next : null);
  return (
    <div
      role="group"
      aria-label={field.label}
      className="grid gap-1"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCommit?.(); }}
    >
      {rows.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            aria-label={`${field.label} ${i === 0 ? "primary" : i + 1}`}
            autoFocus={autoFocus && i === 0}
            disabled={disabled}
            placeholder={MULTI_PLACEHOLDER[field.type]}
            value={item}
            onChange={(e) => set(rows.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit?.();
              if (e.key === "Escape") onCancel?.();
            }}
            className={inputClass}
          />
          {i === 0 ? (
            <span className="shrink-0 text-xs font-medium text-muted-foreground">Primary</span>
          ) : (
            <button type="button" disabled={disabled} onClick={() => set([item, ...rows.filter((_, j) => j !== i)])} className="shrink-0 text-xs text-muted-foreground underline">Make primary</button>
          )}
          {rows.length > 1 && <button type="button" aria-label={`Remove ${item || "value"}`} disabled={disabled} onClick={() => set(rows.filter((_, j) => j !== i))} className="shrink-0 px-1 text-xs text-muted-foreground">×</button>}
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...rows, ""])} className="justify-self-start text-xs text-muted-foreground underline">Add another</button>
    </div>
  );
}

/**
 * A person's email and phone with their others (convex/lib/objects/registry.ts PRIMARY_LISTS): edited as one
 * list, the first primary. The list fields themselves stay off the page; the primary's row edits both.
 */
const PRIMARY_LISTS: Readonly<Record<string, { others: string; type: "emails" | "phones" }>> = {
  email: { others: "additionalEmails", type: "emails" },
  phone: { others: "additionalPhones", type: "phones" },
};
const OTHERS_FIELDS = new Set(Object.values(PRIMARY_LISTS).map((p) => p.others));

/** Whether a contact field is shown on its own row: not a list its primary's row edits. */
export const hasOwnRow = (object: string, field: FieldDescription) => object !== "contact" || !OTHERS_FIELDS.has(field.apiName);

/** The field and value a contact's primary row edits: the primary and its others as one list. */
export function primaryListOf(object: string, field: FieldDescription, values: Readonly<Record<string, unknown>>): { field: FieldDescription; value: CellValue } | null {
  const pair = object === "contact" ? PRIMARY_LISTS[field.apiName] : undefined;
  if (!pair) return null;
  const items: string[] = [];
  for (const v of [values[field.fieldId], ...(Array.isArray(values[pair.others]) ? (values[pair.others] as unknown[]) : [])]) {
    if (typeof v === "string" && v.trim() && !items.some((x) => x.toLowerCase() === v.trim().toLowerCase())) items.push(v.trim());
  }
  return { field: { ...field, type: pair.type } as FieldDescription, value: items.length ? items : null };
}

/** The patch a field's edit writes: a primary row writes its primary and its others together. */
export function fieldPatch(object: string, field: FieldDescription, value: CellValue): Record<string, CellValue> {
  const pair = object === "contact" ? PRIMARY_LISTS[field.apiName] : undefined;
  if (!pair) return { [field.apiName]: value };
  const items = stringsOf(value);
  return { [field.apiName]: items[0] ?? null, [pair.others]: items.length > 1 ? items.slice(1) : null };
}

/** Multi-value fields: emails, phones and links, the first one primary. */
const isMultiValue = (field: FieldDescription) => field.type === "emails" || field.type === "phones" || field.type === "links";

/** A stored value as a person reads it. */
export function formatValue(field: FieldDescription, value: CellValue | undefined, team?: readonly TeamMember[]): string {
  if (value === null || value === undefined || value === "") return "";
  // A formula or rollup (CP7c) reads as the type it gives.
  if (field.type === "formula" && "returns" in field) return formatValue({ ...field, type: field.returns } as FieldDescription, value, team);
  switch (field.type) {
    case "splits":
      return splitsOf(value).map((s) => `${team?.find((u) => u._id === s.userId)?.name ?? s.userId} · ${s.percentage}% ${s.kind}`).join("; ");
    case "currency":
      // Money is stored in cents across the app (convex/schema.ts). No symbol: a deal's currency is its own field.
      return typeof value === "number" ? (value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    case "datetime":
      return typeof value === "number" ? new Date(value).toLocaleString() : String(value);
    case "checkbox":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "picklist":
      return optionsOf(field).find((o) => o.value === value)?.label ?? String(value);
    case "multipicklist":
      return (Array.isArray(value) ? value : [String(value)]).map((v) => optionsOf(field).find((o) => o.value === v)?.label ?? v).join(", ");
    case "user":
      return team?.find((u) => u._id === value)?.name ?? String(value);
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** `datetime` values are epoch ms; a datetime-local input wants local wall time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputClass = "w-full border border-border bg-background px-2 py-1 text-sm";

export const FIELD_EDITOR = "[data-field-editor]";

function SplitInput({ value, team, disabled, onChange, onCommit, onCancel }: {
  value: CellValue | undefined; team?: readonly TeamMember[]; disabled?: boolean;
  onChange: (next: CellValue) => void; onCommit?: () => void; onCancel?: () => void;
}) {
  const rows = splitsOf(value);
  const checked = parseSplits(rows);
  const change = (index: number, patch: Partial<SplitAllocation>) => onChange(rows.map((r, i) => i === index ? { ...r, ...patch } : r));
  return <div role="group" aria-label="Credit splits" className="grid gap-2">
    <p className="text-xs text-muted-foreground">Revenue credit must total 100%. Overlay credit is additional.</p>
    {rows.map((row, i) => <div key={i} className="flex flex-wrap gap-1">
      <select aria-label={`Split ${i + 1} member`} disabled={disabled} value={row.userId} onChange={(e) => change(i, { userId: e.target.value })} className={inputClass}>
        <option value="">Choose member</option>
        {(team ?? []).filter((u) => u.isActive !== false || u._id === row.userId).map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
      </select>
      <select aria-label={`Split ${i + 1} kind`} disabled={disabled} value={row.kind} onChange={(e) => change(i, { kind: e.target.value === "overlay" ? "overlay" : "revenue" })} className={inputClass}>
        <option value="revenue">Revenue</option><option value="overlay">Overlay</option>
      </select>
      <input aria-label={`Split ${i + 1} percentage`} type="number" min="0" max="100" step="0.01" disabled={disabled} value={Number.isFinite(row.percentage) ? row.percentage : ""} onChange={(e) => change(i, { percentage: e.target.value === "" ? NaN : Number(e.target.value) })} className={inputClass} />
      <button type="button" disabled={disabled} onClick={() => onChange(rows.filter((_, j) => i !== j))} className="text-xs underline">Remove split</button>
    </div>)}
    {!checked.ok && <p role="status" className="text-xs text-destructive">{checked.message}</p>}
    <div className="flex gap-3">
      <button type="button" disabled={disabled || rows.length >= MAX_SPLITS} onClick={() => onChange([...rows, { userId: "", percentage: rows.length ? 0 : 100, kind: "revenue" }])} className="text-xs underline">Add split</button>
      {onCommit && <button type="button" disabled={disabled || !checked.ok} onClick={onCommit} className="text-xs underline">Save splits</button>}
      {onCancel && <button type="button" disabled={disabled} onClick={onCancel} className="text-xs underline">Cancel</button>}
    </div>
  </div>;
}

/**
 * An input for one field. `onChange` receives what `objects.write` accepts:
 * text for text-like fields, a number, a boolean, epoch ms, a list of options,
 * or null for empty.
 */
export function FieldInput({
  field,
  value,
  team,
  onChange,
  autoFocus,
  onCommit,
  onCancel,
  disabled,
}: {
  field: FieldDescription;
  value: CellValue | undefined;
  team?: readonly TeamMember[];
  onChange: (next: CellValue) => void;
  autoFocus?: boolean;
  /** Called on Enter or blur, for inline edits. */
  onCommit?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && field.type !== "text") onCommit?.();
    if (event.key === "Escape") onCancel?.();
  };
  const common = { "aria-label": field.label, autoFocus, disabled, onKeyDown: keys, onBlur: onCommit, className: inputClass };
  // The dropdown's menu takes focus, so an inline edit opens it straight away and commits when it closes.
  const select = {
    "aria-label": field.label,
    disabled,
    className: "w-full",
    defaultOpen: autoFocus,
    onOpenChange: (open: boolean) => { if (!open) onCommit?.(); },
  };
  if (isMultiValue(field)) return <MultiValueInput field={field} value={value} disabled={disabled} autoFocus={autoFocus} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  if (field.type === "splits") return <SplitInput value={value} team={team} disabled={disabled} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />;
  switch (field.type) {
    case "checkbox":
      return (
        <SelectField
          {...select}
          value={value === true ? "true" : value === false ? "false" : ""}
          onValueChange={(v) => onChange(v === "" ? null : v === "true")}
          options={[{ value: "", label: "—" }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]}
        />
      );
    case "picklist":
      return (
        <SelectField
          {...select}
          value={typeof value === "string" ? value : ""}
          onValueChange={(v) => onChange(v || null)}
          options={[{ value: "", label: "—" }, ...optionsOf(field).filter((o) => o.active || o.value === value).map((o) => ({ value: o.value, label: o.label }))]}
        />
      );
    case "multipicklist": {
      const selected = new Set(stringsOf(value));
      return (
        <div
          role="group"
          aria-label={field.label}
          className="flex flex-wrap gap-1"
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCommit?.(); }}
        >
          {optionsOf(field).filter((o) => o.active || selected.has(o.value)).map((o) => (
            <label key={o.value} className={cn("flex items-center gap-1 border border-border px-2 py-0.5 text-xs", selected.has(o.value) && "bg-primary text-primary-foreground")}>
              <input
                type="checkbox"
                className="sr-only"
                checked={selected.has(o.value)}
                disabled={disabled}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(o.value)) next.delete(o.value);
                  else next.add(o.value);
                  onChange(next.size ? [...next].sort() : null);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case "user":
      return (
        <SelectField
          {...select}
          value={typeof value === "string" ? value : ""}
          onValueChange={(v) => onChange(v || null)}
          options={[{ value: "", label: "Unassigned" }, ...(team ?? []).filter((u) => u.isActive !== false || u._id === value).map((u) => ({ value: u._id, label: u.name }))]}
        />
      );
    case "lookup":
      return <LookupInput field={field} value={value} onChange={onChange} />;
    case "date":
      return <input {...common} type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "datetime":
      return (
        <input
          {...common}
          type="datetime-local"
          value={typeof value === "number" ? toLocalInput(value) : ""}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : null)}
        />
      );
    case "currency":
      return <CurrencyInput common={common} value={value} onChange={onChange} />;
    case "number":
      return (
        <input
          {...common}
          inputMode="decimal"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    default:
      if (isMultiline(field, value)) {
        return (
          <textarea
            aria-label={field.label}
            autoFocus={autoFocus}
            disabled={disabled}
            rows={4}
            onBlur={onCommit}
            // Enter is a new line; Cmd/Ctrl+Enter saves.
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onCommit?.();
              if (event.key === "Escape") onCancel?.();
            }}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
        );
      }
      return (
        <input
          {...common}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit?.();
            if (event.key === "Escape") onCancel?.();
          }}
          value={typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Dollars on screen, cents in the value: a typed amount that isn't a number passes through as text for the server to refuse. */
function CurrencyInput({ common, value, onChange }: {
  common: Record<string, unknown>;
  value: CellValue | undefined;
  onChange: (next: CellValue) => void;
}) {
  const [text, setText] = useState(typeof value === "number" ? String(value / 100) : "");
  return (
    <input
      {...common}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const dollars = next.trim().replace(/[$,]/g, "");
        if (dollars === "") onChange(null);
        else onChange(Number.isFinite(Number(dollars)) ? Math.round(Number(dollars) * 100) : next);
      }}
    />
  );
}

/** Click to edit; saves on Enter or blur, Escape cancels. */
export function InlineField({
  field,
  value,
  version,
  team,
  readOnly,
  onSave,
}: {
  field: FieldDescription;
  value: CellValue | undefined;
  /** The record's version; the save carries the one the edit started from, so a change made meanwhile conflicts. */
  version: number;
  team?: readonly TeamMember[];
  readOnly?: boolean;
  onSave: (next: CellValue, expectedVersion: number) => Promise<boolean>;
}) {
  const [editDraft, setEditDraft] = useRecordDraft<{ value: CellValue | undefined; version: number }>(`field:${field.fieldId}`, { value: undefined, version });
  const draft = editDraft.value;
  // A dropdown commits as it closes, in the same event that set the draft, so commit reads this ref.
  const draftRef = useRef<CellValue | undefined>(draft);
  const setDraft = (next: CellValue | undefined) => {
    draftRef.current = next;
    setEditDraft({ value: next, version: startedAt.current });
  };
  const startedAt = useRef(editDraft.version);
  const [saving, setSaving] = useState(false);
  // Enter commits and the input's blur commits again before React re-renders.
  const inFlight = useRef(false);
  const editing = draft !== undefined;
  const shown = formatValue(field, value, team);

  async function commit() {
    const draft = draftRef.current;
    if (draft === undefined || inFlight.current) return;
    const same = JSON.stringify(draft ?? null) === JSON.stringify(value ?? null) || (draft === "" && (value ?? null) === null);
    if (same) {
      setDraft(undefined);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const ok = await onSave(draft === "" ? null : draft, startedAt.current).finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
    if (ok) setDraft(undefined);
  }

  let linkedinHref: string | undefined;
  if (field.apiName === "linkedinUrl" && typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") linkedinHref = url.href;
    } catch {
      // Invalid stored values remain editable, but are not navigation targets.
    }
  }
  const linkedinLink = linkedinHref && (
    <a href={linkedinHref} target="_blank" rel="noopener noreferrer" className="shrink-0 px-2 py-1 text-sm underline">Open LinkedIn</a>
  );
  const chips = optionChips(field, value);
  const links = contactLinks(field, value);
  if (readOnly || !isEditable(field)) {
    return <div className="flex items-start gap-1"><span className={cn("block min-w-0 whitespace-pre-wrap break-words px-2 py-1 text-sm", !shown && "text-muted-foreground")}>{links || (shown && chips) || shown || "—"}</span>{linkedinLink}</div>;
  }
  if (editing) {
    return (
      <div data-field-editor className="contents" onKeyDown={(event) => { if (event.key === "Escape") setDraft(undefined); }}>
        <FieldInput
          field={field}
          value={draft}
          team={team}
          autoFocus
          disabled={saving}
          onChange={setDraft}
          onCommit={() => void commit()}
          onCancel={() => setDraft(undefined)}
        />
      </div>
    );
  }
  const startEdit = () => {
    startedAt.current = version;
    setDraft(value ?? null);
  };
  // Links can't sit inside the edit button: they show as links, with Change beside them, as a lookup does.
  if (links) {
    return (
      <div className="flex items-start gap-3 px-2 py-1 text-sm">
        {links}
        <button type="button" onClick={startEdit} className="shrink-0 text-xs text-muted-foreground underline hover:text-foreground">Change</button>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={startEdit}
        className="min-w-0 w-full whitespace-pre-wrap break-words px-2 py-1 text-left text-sm hover:bg-muted"
        title="Click to edit"
      >
        {(shown && chips) || shown || <span className="text-muted-foreground">—</span>}
      </button>
      {linkedinLink}
    </div>
  );
}
