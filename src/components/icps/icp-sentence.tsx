"use client";

import { IcpViewer } from "./icp-viewer";
import { useState } from "react";
import { X } from "lucide-react";
import { COUNTRIES, DEPARTMENTS, EMPLOYEE_BANDS, LEVELS } from "../../../convex/lib/addRecords";
import { parseQuery, type Clause, type IcpQuery, type NodeKind } from "../../../modules/kernel/icpQuery";
import { INDUSTRIES } from "../../../modules/kernel/industries";
import { REGIONS } from "../../../modules/kernel/dimensions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { bandsLabel, sentence, withClause, withValues, type AiField, type ClausePath } from "../../../modules/kernel/icpSentence";
import { cn } from "@/lib/utils";

const input = "w-full border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary";

type ListKey = Exclude<Clause["key"], "field">;
// Keys whose values are typed rather than picked: words in a title, a city, a member's id, a revenue band.
type Typed = "title" | "city" | "owner" | "revenue";
const OPTIONS: Record<Exclude<ListKey, Typed>, Array<{ value: string; label: string }>> = {
  industry: INDUSTRIES.map((i) => ({ value: i.key, label: i.label })),
  region: REGIONS.filter((r) => r.key !== "other").map((r) => ({ value: r.key, label: r.label })),
  size: EMPLOYEE_BANDS.map((b) => ({ value: b, label: bandsLabel([b]) })),
  country: COUNTRIES,
  location: COUNTRIES,
  level: LEVELS,
  dept: DEPARTMENTS.map((d) => ({ value: d, label: d })),
};

/** Values of one clause: a checklist over its vocabulary, typed words for titles and free answers, a range for numbers. */
function ValuePicker({ clause, field, onChange, onRemove }: {
  clause: Clause; field?: AiField; onChange: (next: { values?: string[]; min?: number; max?: number }) => void; onRemove?: () => void;
}) {
  const [q, setQ] = useState("");
  const [lo, setLo] = useState(clause.key === "field" && clause.min !== undefined ? String(clause.min) : "");
  const [hi, setHi] = useState(clause.key === "field" && clause.max !== undefined ? String(clause.max) : "");
  const values = clause.values ?? [];
  const toggle = (v: string) => onChange({ values: values.includes(v) ? values.filter((x) => x !== v) : [...values, v] });
  const numeric = clause.key === "field" && (field?.answerType === "number" || (!clause.values && (clause.min !== undefined || clause.max !== undefined)));
  const options = clause.key === "field"
    ? (field?.options ?? (field?.answerType === "boolean" ? [{ key: "true", label: "Yes" }, { key: "false", label: "No" }] : null))?.map((o) => ({ value: o.key, label: o.label })) ?? null
    : clause.key === "title" || clause.key === "city" || clause.key === "owner" || clause.key === "revenue" ? null : OPTIONS[clause.key];
  let body;
  if (numeric) {
    const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
    body = (
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); onChange({ values: undefined, min: num(lo), max: num(hi) }); }}>
        <input value={lo} onChange={(e) => setLo(e.target.value)} placeholder="Min" aria-label="Minimum" className={cn(input, "w-20")} />
        <span className="text-xs text-muted-foreground">to</span>
        <input value={hi} onChange={(e) => setHi(e.target.value)} placeholder="Max" aria-label="Maximum" className={cn(input, "w-20")} />
        <button type="submit" className="border border-border px-2 py-1 text-xs hover:bg-muted">Set</button>
      </form>
    );
  } else if (options) {
    const needle = q.trim().toLowerCase();
    const shown = options.filter((o) => values.includes(o.value) || !needle || o.label.toLowerCase().includes(needle));
    shown.sort((a, b) => Number(values.includes(b.value)) - Number(values.includes(a.value)));
    body = (
      <div className="grid gap-1">
        {options.length > 12 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search values" className={input} autoFocus />}
        <div className="grid max-h-64 overflow-auto">
          {shown.slice(0, 60).map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-sm hover:bg-muted">
              <input type="checkbox" checked={values.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t && !values.includes(t)) onChange({ values: [...values, t] }); setQ(""); }}>
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span key={v} className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-xs">
              {v}
              <button type="button" aria-label={`Remove ${v}`} onClick={() => toggle(v)}><X className="size-3" /></button>
            </span>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={clause.key === "title" ? (clause.neg ? "A word to never match, e.g. intern" : "A word in the title, then Enter") : "An answer, then Enter"} className={input} autoFocus />
      </form>
    );
  }
  return (
    <div className="grid gap-2">
      {body}
      {onRemove && <button type="button" onClick={onRemove} className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline">Remove this condition</button>}
    </div>
  );
}

type Addable = { label: string; clause: Clause; where: { has?: number; newHas?: { neg: boolean } } };

/** The conditions a node can still take, by kind. */
function addable(kind: NodeKind, q: IcpQuery, fields: readonly AiField[]): Addable[] {
  const has = (cs: readonly Clause[], key: string, neg = false) => cs.some((c) => (c.key === "field" ? `field.${c.slug}` : c.key) === key && c.neg === neg);
  const list = (key: ListKey, neg = false): Clause => ({ key, neg, values: [] });
  const person = (cs: readonly Clause[], where: Addable["where"], prefix: string): Addable[] => ([
    ["level", false, "seniority"], ["dept", false, "department"], ["title", false, "title contains"], ["title", true, "never titled"], ["location", false, "located in"],
  ] as const).filter(([k, neg]) => !has(cs, k, neg)).map(([k, neg, label]) => ({ label: `${prefix}${label}`, clause: list(k, neg), where }));
  if (kind === "persona") return person(q.clauses, {}, "");
  const company: Addable[] = [
    ...([["industry", false, "Industry"], ["size", false, "Employees"], ["country", false, "Based in"], ["industry", true, "Never these industries"], ["country", true, "Never based in"]] as const)
      .filter(([k, neg]) => !has(q.clauses, k, neg)).map(([k, neg, label]) => ({ label, clause: list(k, neg), where: {} })),
    ...fields.filter((f) => !has(q.clauses, `field.${f.slug}`)).map((f) => ({ label: f.label, clause: { key: "field" as const, slug: f.slug, neg: false as const, ...(f.answerType === "number" ? {} : { values: [] }) }, where: {} })),
  ];
  if (kind === "segment") return [...company, { label: "Employs someone who is…", clause: list("level"), where: { newHas: { neg: false } } }, { label: "Employs no one in…", clause: list("dept"), where: { newHas: { neg: true } } }];
  const buyer = q.has.findIndex((h) => !h.neg);
  return [...company, ...person(buyer >= 0 ? q.has[buyer].clauses : [], buyer >= 0 ? { has: buyer } : { newHas: { neg: false } }, "Buyer: ")];
}

function AddCondition({ kind, q, fields, onSave }: { kind: NodeKind; q: IcpQuery; fields: readonly AiField[]; onSave: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<Addable | null>(null);
  const options = addable(kind, q, fields);
  if (!options.length) return null;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPick(null); }}>
      <PopoverTrigger asChild><button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">+ condition</button></PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-none p-2">
        {pick ? (
          <div className="grid gap-2">
            <span className="text-xs text-muted-foreground">{pick.label}</span>
            <ValuePicker
              clause={pick.clause}
              field={pick.clause.key === "field" ? fields.find((f) => f.slug === (pick.clause as { slug: string }).slug) : undefined}
              onChange={(next) => { onSave(withClause(q, { ...pick.clause, ...next } as Clause, pick.where)); setOpen(false); setPick(null); }}
            />
          </div>
        ) : (
          <div className="grid max-h-72 overflow-auto">
            {options.map((o) => <button key={o.label} type="button" onClick={() => setPick(o)} className="px-2 py-1 text-left text-sm hover:bg-muted">{o.label}</button>)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A node's query as its sentence. With `onSave`, every token opens a picker for its values and "+ condition" adds
 * one; each change saves the node's new query line.
 */
export function IcpSentence({ kind, query, fields, onSave, className }: {
  kind: NodeKind; query: string; fields: readonly AiField[]; onSave?: (query: string) => void; className?: string;
}) {
  const { query: q, errors } = parseQuery(query, kind);
  if (errors.length) return <IcpViewer query={query} kind={kind} className={className} />;
  const save = (path: ClausePath, next: Parameters<typeof withValues>[2]) => onSave?.(withValues(q, path, next));
  return (
    <p className={className}>
      {sentence(kind, q, fields).map((p, i) => {
        if (typeof p === "string") return <span key={i}>{p}</span>;
        // A "never" value is a choice, not an error: dashed, not the destructive (error) colour.
        const tone = cn("border-b-[1.5px] border-primary px-0.5", p.clause.neg ? "border-dashed bg-muted" : "bg-primary/10");
        if (!onSave) return <span key={i} className={tone}>{p.text}</span>;
        return (
          <Popover key={i}>
            {/* A span, not a button: a long value wraps with the sentence instead of breaking it as a block. */}
            <PopoverTrigger asChild><span role="button" tabIndex={0} className={cn(tone, "cursor-pointer [box-decoration-break:clone] hover:bg-primary/20")}>{p.text}</span></PopoverTrigger>
            <PopoverContent align="start" className="w-72 rounded-none p-2">
              <ValuePicker
                clause={p.clause}
                field={p.clause.key === "field" ? fields.find((f) => f.slug === (p.clause as { slug: string }).slug) : undefined}
                onChange={(next) => save(p.path, next)}
                onRemove={() => save(p.path, p.clause.key === "field" ? { values: undefined, min: undefined, max: undefined } : { values: [] })}
              />
            </PopoverContent>
          </Popover>
        );
      })}
      {onSave && <> <AddCondition kind={kind} q={q} fields={fields} onSave={onSave} /></>}
    </p>
  );
}
